/* ── WatchTogether — app.js ── */

// ── Firebase ──
var db = null;
try { db = firebase.database(); } catch(e) { log('Firebase error: ' + e.message); }

// ── State ──
var currentRoom     = null;
var currentVideo    = null;
var videoType       = null;
var isPlaying       = false;
var myName          = 'You';
var myId            = 'u_' + Math.random().toString(36).slice(2, 8);
var playerExpanded  = false;
var currentRawTime  = 0;
var timeUpdateTimer = null;
var isSyncing       = false;
var roomRef         = null;
var chatRef         = null;
var membersRef      = null;
var presenceRef     = null;
var clockSyncTimer  = null;
var lastState       = null;

// ── On-screen debug log (so we can see what's happening on mobile) ──
function log(msg) {
  console.log(msg);
  var box = document.getElementById('debugBox');
  if (!box) return;
  var line = document.createElement('div');
  line.textContent = new Date().toLocaleTimeString() + ' ' + msg;
  box.appendChild(line);
  while (box.children.length > 20) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ── Helpers ──
function getEl(id) { return document.getElementById(id); }

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtTime(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ── Virtual clock ──
function calcExpectedTime(state) {
  if (!state) return 0;
  if (!state.playing || !state.playedAt) return (state.position || 0);
  var elapsed = (Date.now() - state.playedAt) / 1000;
  return (state.position || 0) + elapsed;
}

// ── Overlay ──
function openApp() {
  getEl('appOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(function() { getEl('roomInput').focus(); }, 120);
}

function closeApp() {
  getEl('appOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function scrollToHow() {
  getEl('how').scrollIntoView({ behavior: 'smooth' });
}

// ── Room ──
function joinRoom() {
  var name = getEl('nameInput').value.trim() || 'Anonymous';
  var room = getEl('roomInput').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!room) { alert('Please enter a room name.'); return; }

  myName      = name;
  currentRoom = room;

  getEl('roomBadge').style.display    = 'flex';
  getEl('roomBadgeLabel').textContent = '# ' + room;
  getEl('chatRoomTag').textContent    = '#' + room;

  // Show debug box
  var debugBox = getEl('debugBox');
  if (debugBox) debugBox.style.display = 'block';

  addLocalMsg('system', '', 'Joined room #' + room);
  log('Joined room: ' + room + ' as ' + name + ' id=' + myId);

  if (!db) {
    addLocalMsg('system', '', 'Firebase not connected.');
    log('ERROR: db is null');
    return;
  }

  roomRef    = db.ref('rooms/' + room + '/state');
  chatRef    = db.ref('rooms/' + room + '/chat');
  membersRef = db.ref('rooms/' + room + '/members');

  // ── Presence ──
  presenceRef = membersRef.child(myId);
  presenceRef.set({ name: myName, joinedAt: Date.now() });
  presenceRef.onDisconnect().remove();
  log('Presence set');

  membersRef.on('value', function(snap) {
    var count = snap.numChildren();
    log('Members: ' + count);
    var el    = getEl('memberCountNum');
    var badge = getEl('memberCount');
    if (el) el.textContent = count;
    if (badge) {
      if (count > 1) { badge.classList.add('active'); }
      else           { badge.classList.remove('active'); }
    }
  });

  // ── Room state listener ──
  roomRef.on('value', function(snap) {
    var state = snap.val();
    log('State update: ' + JSON.stringify(state));

    if (!state) return;

    // Only ignore if WE pushed this (echo), always apply if other person pushed
    if (isSyncing && state.pushedBy === myId) {
      log('Skipping own echo');
      return;
    }

    lastState = state;

    // Load video if changed
    if (state.video && state.video !== currentVideo) {
      log('Loading new video: ' + state.video);
      getEl('videoInput').value = state.video;
      doLoadVideo(state.video, false);
      return; // wait for video to load before seeking
    }

    applyVirtualClock(state);
  });

  // ── Chat ──
  chatRef.limitToLast(80).on('child_added', function(snap) {
    var m = snap.val();
    if (!m) return;
    appendChatMsg(m.who, m.text);
  });
}

// ── Apply virtual clock ──
function applyVirtualClock(state) {
  if (!state) return;

  var expected = calcExpectedTime(state);
  var drift    = Math.abs(currentRawTime - expected);

  log('Apply clock: playing=' + state.playing + ' expected=' + expected.toFixed(1) + ' current=' + currentRawTime.toFixed(1) + ' drift=' + drift.toFixed(1));

  // Sync seek first
  if (drift > 2) {
    log('Seeking to ' + expected.toFixed(1));
    seekTo(expected);
  }

  // Sync play/pause
  if (state.playing && !isPlaying) {
    log('Remote play');
    doPlayLocal();
  } else if (!state.playing && isPlaying) {
    log('Remote pause');
    doPauseLocal();
  }

  // Continuous drift correction
  if (state.playing) {
    startClockSync(state);
  } else {
    stopClockSync();
  }
}

function startClockSync(state) {
  stopClockSync();
  clockSyncTimer = setInterval(function() {
    if (!state || !state.playing || isSyncing) return;
    var expected = calcExpectedTime(state);
    var drift    = Math.abs(currentRawTime - expected);
    if (drift > 2 && drift < 30) {
      log('Clock correction: drift=' + drift.toFixed(1) + 's');
      seekTo(expected);
    }
  }, 5000);
}

function stopClockSync() {
  if (clockSyncTimer) { clearInterval(clockSyncTimer); clockSyncTimer = null; }
}

function pushState(updates) {
  if (!roomRef) { log('pushState: no roomRef'); return; }
  isSyncing = true;
  // tag the update with our ID so we can ignore our own echo
  var data = Object.assign({ updatedAt: Date.now(), pushedBy: myId }, updates);
  log('Pushing: ' + JSON.stringify(data));
  roomRef.update(data).then(function() {
    setTimeout(function() { isSyncing = false; }, 500);
  }).catch(function(e) {
    isSyncing = false;
    log('pushState error: ' + e.message);
  });
}

// ── Video loading ──
function loadVideo() {
  var url = getEl('videoInput').value.trim();
  if (!url) return;
  doLoadVideo(url, true);
}

function doLoadVideo(url, pushToRoom) {
  currentVideo = url;
  stopClockSync();

  getEl('videoFrame').style.display = 'none';
  getEl('driveVideo').style.display = 'none';
  getEl('driveVideo').src           = '';
  getEl('playerPlaceholder').style.display = 'none';

  var type = null;

  if (/youtube\.com|youtu\.be/.test(url)) {
    var vid = extractYTId(url);
    if (!vid) { alert('Could not parse YouTube video ID.'); return; }
    type = 'youtube';
    var frame = getEl('videoFrame');
    frame.src = 'https://www.youtube.com/embed/' + vid +
                '?enablejsapi=1&autoplay=0&controls=1&rel=0&modestbranding=1';
    frame.style.display = 'block';
    setupYTMessaging();
    log('YouTube loaded: ' + vid);

  } else if (/drive\.google\.com/.test(url)) {
    var fid = extractDriveId(url);
    if (!fid) { alert('Could not parse Google Drive file ID.'); return; }
    type = 'drive';
    setupDrivePlayer(fid);
    log('Drive loaded: ' + fid);

  } else {
    alert('Paste a YouTube URL or a Google Drive share link.');
    return;
  }

  videoType = type;
  getEl('playerControls').style.display = 'flex';
  getEl('driveNote').style.display = (type === 'drive') ? 'block' : 'none';
  getEl('playerContainer').classList.toggle('drive-player', type === 'drive');

  startTimeUpdate();

  if (pushToRoom && roomRef) {
    pushState({ video: url, playing: false, position: 0, playedAt: null });
    addLocalMsg('system', '', 'Video loaded for everyone in the room');
  } else if (lastState) {
    // Apply clock after video loads
    setTimeout(function() { applyVirtualClock(lastState); }, 1500);
  }
}

// ── Drive player ──
function setupDrivePlayer(fileId) {
  var video = getEl('driveVideo');
  video.src = 'https://drive.google.com/uc?export=download&id=' + fileId;
  video.style.display = 'block';
  video.load();

  video.onplay = function() {
    if (isSyncing) return;
    isPlaying = true;
    updatePlayBtn();
    log('Drive play at ' + video.currentTime.toFixed(1));
    if (roomRef) pushState({ playing: true, position: video.currentTime, playedAt: Date.now() });
  };

  video.onpause = function() {
    if (isSyncing) return;
    isPlaying = false;
    updatePlayBtn();
    log('Drive pause at ' + video.currentTime.toFixed(1));
    if (roomRef) pushState({ playing: false, position: video.currentTime, playedAt: null });
  };
  video.onseeked = function() { currentRawTime = video.currentTime; };

  video.ontimeupdate = function() {
    currentRawTime = video.currentTime;
    getEl('timeDisplay').textContent = fmtTime(video.currentTime);
  };

  video.onerror = function() {
    log('Drive direct URL failed, falling back to iframe');
    video.style.display = 'none';
    var frame = getEl('videoFrame');
    frame.src = 'https://drive.google.com/file/d/' + fileId + '/preview';
    frame.style.display = 'block';
    videoType = 'iframe';
    addLocalMsg('system', '', 'Drive preview mode — sync limited on this browser.');
  };
}

function extractYTId(url) {
  var m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function extractDriveId(url) {
  var m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── YouTube bridge ──
var ytListenerAdded = false;
function setupYTMessaging() {
  if (ytListenerAdded) return;
  ytListenerAdded = true;
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    try {
      var d = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data;
      if (d.event === 'onStateChange') {
        if (d.info === 1) { isPlaying = true;  updatePlayBtn(); }
        if (d.info === 2) { isPlaying = false; updatePlayBtn(); }
      }
      if (d.event === 'infoDelivery' && d.info && d.info.currentTime !== undefined) {
        currentRawTime = d.info.currentTime;
        getEl('timeDisplay').textContent = fmtTime(d.info.currentTime);
      }
    } catch(err) {}
  });
  setTimeout(function() { sendYT('{"event":"listening"}'); }, 800);
}

function sendYT(json) {
  var f = getEl('videoFrame');
  if (f && f.contentWindow) { try { f.contentWindow.postMessage(json, '*'); } catch(e) {} }
}

function startTimeUpdate() {
  if (timeUpdateTimer) clearInterval(timeUpdateTimer);
  timeUpdateTimer = setInterval(function() {
    if (videoType === 'youtube') {
      sendYT('{"event":"listening"}');
      sendYT(JSON.stringify({ event: 'command', func: 'getCurrentTime', args: '' }));
    }
  }, 1000);
}

// ── Playback ──
function togglePlay() {
  if (isPlaying) {
    doPauseLocal();
    if (roomRef) pushState({ playing: false, position: currentRawTime, playedAt: null });
  } else {
    doPlayLocal();
    if (roomRef) pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
  }
}

function doPlayLocal() {
  isPlaying = true; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'playVideo', args: '' }));
  } else if (videoType === 'drive') {
    var v = getEl('driveVideo');
    if (v && v.src) { isSyncing = true; v.play().catch(function(){}).finally(function(){ setTimeout(function(){ isSyncing = false; }, 500); }); }
  }
}

function doPauseLocal() {
  isPlaying = false; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }));
  } else if (videoType === 'drive') {
    var v = getEl('driveVideo');
    if (v && v.src) { isSyncing = true; v.pause(); setTimeout(function(){ isSyncing = false; }, 500); }
  }
}

function doPlay()  { doPlayLocal(); }
function doPause() { doPauseLocal(); }

function seekTo(t) {
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }));
  } else if (videoType === 'drive') {
    var v = getEl('driveVideo');
    if (v && v.readyState >= 1) { isSyncing = true; v.currentTime = t; setTimeout(function(){ isSyncing = false; }, 500); }
  }
}

function syncNow() {
  if (!roomRef) { addLocalMsg('system', '', 'Join a room first!'); return; }
  pushState({ playing: isPlaying, position: currentRawTime, playedAt: isPlaying ? Date.now() : null });
  addLocalMsg('system', '', 'Synced everyone to your position');
}

function updatePlayBtn() {
  getEl('playIcon').style.display  = isPlaying ? 'none'  : 'block';
  getEl('pauseIcon').style.display = isPlaying ? 'block' : 'none';
  getEl('playLabel').textContent   = isPlaying ? 'Pause' : 'Play';
}

// ── Expand ──
function toggleExpand() {
  playerExpanded = !playerExpanded;
  getEl('playerContainer').classList.toggle('expanded', playerExpanded);
  var modal = document.querySelector('.app-modal');
  if (modal) modal.classList.toggle('player-expanded', playerExpanded);
  getEl('expandIcon').style.display   = playerExpanded ? 'none'  : 'block';
  getEl('collapseIcon').style.display = playerExpanded ? 'block' : 'none';
  getEl('expandLabel').textContent    = playerExpanded ? 'Collapse' : 'Expand';
}

// ── Chat ──
function sendChat() {
  var inp = getEl('chatInput');
  var txt = inp.value.trim();
  if (!txt) return;
  if (!chatRef) { addLocalMsg('system', '', 'Join a room first!'); return; }
  inp.value = '';
  myName = getEl('nameInput').value.trim() || 'Anonymous';
  chatRef.push({ who: myName, text: txt, id: myId, ts: Date.now() });
}

function appendChatMsg(who, text) {
  var box = getEl('chatBody');
  var div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = '<span class="who">' + esc(who) + '</span> ' + esc(text);
  box.appendChild(div);
  while (box.children.length > 80) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function addLocalMsg(type, who, text) {
  var box = getEl('chatBody');
  var div = document.createElement('div');
  if (type === 'system') {
    div.className = 'chat-system'; div.textContent = text;
  } else {
    div.className = 'chat-msg';
    div.innerHTML = '<span class="who">' + esc(who) + '</span> ' + esc(text);
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── Event listeners ──
document.getElementById('appOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeApp();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeApp();
});
