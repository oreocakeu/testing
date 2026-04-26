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
var roomRef         = null;
var chatRef         = null;
var membersRef      = null;
var presenceRef     = null;
var clockSyncTimer  = null;
var lastState       = null;
var applyingRemote  = false;  // true while we are applying a remote state change
var pushTimeout     = null;   // debounce local pushes

// ── Debug log ──
function log(msg) {
  console.log(msg);
  var box = document.getElementById('debugBox');
  if (!box) return;
  var line = document.createElement('div');
  line.textContent = new Date().toLocaleTimeString() + ' ' + msg;
  box.appendChild(line);
  while (box.children.length > 30) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ── Helpers ──
function getEl(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ── Virtual clock: where the video SHOULD be right now ──
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

  var debugBox = getEl('debugBox');
  if (debugBox) debugBox.style.display = 'block';

  addLocalMsg('system', '', 'Joined room #' + room);
  log('Joined as ' + name + ' id=' + myId);

  if (!db) { addLocalMsg('system', '', 'Firebase not connected.'); return; }

  roomRef    = db.ref('rooms/' + room + '/state');
  chatRef    = db.ref('rooms/' + room + '/chat');
  membersRef = db.ref('rooms/' + room + '/members');

  // ── Presence ──
  presenceRef = membersRef.child(myId);
  presenceRef.set({ name: myName, joinedAt: Date.now() });
  presenceRef.onDisconnect().remove();

  membersRef.on('value', function(snap) {
    var count = snap.numChildren();
    log('Members: ' + count);
    var el = getEl('memberCountNum');
    var badge = getEl('memberCount');
    if (el) el.textContent = count;
    if (badge) {
      if (count > 1) badge.classList.add('active');
      else badge.classList.remove('active');
    }
  });

  // ── Main state listener ──
  roomRef.on('value', function(snap) {
    var state = snap.val();
    if (!state) return;

    // Ignore our own pushes
    if (state.pushedBy === myId) {
      log('Own echo — skip');
      return;
    }

    lastState = state;
    log('Remote state: playing=' + state.playing + ' pos=' + (state.position||0).toFixed(1) + ' by=' + state.pushedBy);

    // Load video if changed
    if (state.video && state.video !== currentVideo) {
      getEl('videoInput').value = state.video;
      doLoadVideo(state.video, false);
      return;
    }

    applyRemoteState(state);
  });

  // ── Chat ──
  chatRef.limitToLast(80).on('child_added', function(snap) {
    var m = snap.val();
    if (!m) return;
    appendChatMsg(m.who, m.text);
  });
}

// ── Apply remote state to local player ──
function applyRemoteState(state) {
  if (!state) return;
  applyingRemote = true;

  var expected = calcExpectedTime(state);
  var drift    = Math.abs(currentRawTime - expected);

  log('Apply: expected=' + expected.toFixed(1) + ' current=' + currentRawTime.toFixed(1) + ' drift=' + drift.toFixed(1));

  // Always seek if drift > 1s
  if (drift > 1) {
    log('Seeking to ' + expected.toFixed(1));
    rawSeek(expected);
  }

  // Sync play/pause
  if (state.playing && !isPlaying) {
    log('Remote → play');
    rawPlay();
  } else if (!state.playing && isPlaying) {
    log('Remote → pause');
    rawPause();
  }

  setTimeout(function() { applyingRemote = false; }, 800);

  // Continuous drift correction while playing
  if (state.playing) {
    startClockSync(state);
  } else {
    stopClockSync();
  }
}

// ── Clock sync: correct drift every 5s while playing ──
function startClockSync(state) {
  stopClockSync();
  clockSyncTimer = setInterval(function() {
    if (!state || !state.playing) return;
    var expected = calcExpectedTime(state);
    var drift    = Math.abs(currentRawTime - expected);
    if (drift > 2 && drift < 60) {
      log('Drift correction: ' + drift.toFixed(1) + 's → seeking');
      rawSeek(expected);
    }
  }, 5000);
}

function stopClockSync() {
  if (clockSyncTimer) { clearInterval(clockSyncTimer); clockSyncTimer = null; }
}

// ── Raw player controls (no Firebase push, no echo) ──
function rawPlay() {
  isPlaying = true;
  updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'playVideo', args: '' }));
  } else if (videoType === 'drive') {
    var v = getEl('driveVideo');
    if (v && v.readyState >= 2) v.play().catch(function(){});
  }
}

function rawPause() {
  isPlaying = false;
  updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }));
  } else if (videoType === 'drive') {
    var v = getEl('driveVideo');
    if (v) v.pause();
  }
}

function rawSeek(t) {
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }));
  } else if (videoType === 'drive') {
    var v = getEl('driveVideo');
    if (v && v.readyState >= 1) v.currentTime = t;
  }
}

// ── Push to Firebase (debounced to avoid spam) ──
function pushState(data) {
  if (!roomRef) return;
  if (pushTimeout) clearTimeout(pushTimeout);
  pushTimeout = setTimeout(function() {
    var payload = Object.assign({ updatedAt: Date.now(), pushedBy: myId }, data);
    log('Push: ' + JSON.stringify(payload));
    roomRef.update(payload).catch(function(e) { log('Push error: ' + e.message); });
  }, 100);
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

  getEl('videoFrame').style.display        = 'none';
  getEl('driveVideo').style.display        = 'none';
  getEl('driveVideo').src                  = '';
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

  } else if (/drive\.google\.com/.test(url)) {
    var fid = extractDriveId(url);
    if (!fid) { alert('Could not parse Google Drive file ID.'); return; }
    type = 'drive';
    setupDrivePlayer(fid);

  } else {
    alert('Paste a YouTube URL or Google Drive share link.');
    return;
  }

  videoType = type;
  getEl('playerControls').style.display = 'flex';
  getEl('driveNote').style.display      = (type === 'drive') ? 'block' : 'none';
  getEl('playerContainer').classList.toggle('drive-player', type === 'drive');

  startTimeUpdate();

  if (pushToRoom && roomRef) {
    pushState({ video: url, playing: false, position: 0, playedAt: null });
    addLocalMsg('system', '', 'Video loaded for everyone in the room');
  } else if (lastState) {
    // New joiner — apply current room state after brief load delay
    setTimeout(function() { if (lastState) applyRemoteState(lastState); }, 1500);
  }
}

// ── Drive HTML5 player setup ──
function setupDrivePlayer(fileId) {
  var video = getEl('driveVideo');
  video.src = 'https://drive.google.com/uc?export=download&id=' + fileId;
  video.style.display = 'block';
  video.load();

  // User-initiated play
  video.addEventListener('play', function() {
    if (applyingRemote) return;  // ignore events we triggered
    isPlaying = true;
    updatePlayBtn();
    log('User play at ' + video.currentTime.toFixed(1));
    pushState({ playing: true, position: video.currentTime, playedAt: Date.now() });
  });

  // User-initiated pause
  video.addEventListener('pause', function() {
    if (applyingRemote) return;
    isPlaying = false;
    updatePlayBtn();
    log('User pause at ' + video.currentTime.toFixed(1));
    pushState({ playing: false, position: video.currentTime, playedAt: null });
  });

  // User-initiated seek (via Drive's own controls)
  video.addEventListener('seeked', function() {
    if (applyingRemote) return;
    currentRawTime = video.currentTime;
    log('User seek to ' + video.currentTime.toFixed(1));
    pushState({
      playing:  !video.paused,
      position: video.currentTime,
      playedAt: !video.paused ? Date.now() : null
    });
  });

  video.addEventListener('timeupdate', function() {
    currentRawTime = video.currentTime;
    getEl('timeDisplay').textContent = fmtTime(video.currentTime);
  });

  video.addEventListener('error', function() {
    log('Drive direct URL failed — falling back to iframe');
    video.style.display = 'none';
    var frame = getEl('videoFrame');
    frame.src = 'https://drive.google.com/file/d/' + fileId + '/preview';
    frame.style.display = 'block';
    videoType = 'iframe';
    addLocalMsg('system', '', 'Drive preview mode — limited sync on this browser.');
  });
}

function extractYTId(url) {
  var m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function extractDriveId(url) {
  var m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── YouTube iframe bridge ──
var ytListenerAdded = false;
function setupYTMessaging() {
  if (ytListenerAdded) return;
  ytListenerAdded = true;
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    try {
      var d = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data;
      if (d.event === 'onStateChange') {
        if (d.info === 1 && !applyingRemote) {
          isPlaying = true; updatePlayBtn();
          pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
        }
        if (d.info === 2 && !applyingRemote) {
          isPlaying = false; updatePlayBtn();
          pushState({ playing: false, position: currentRawTime, playedAt: null });
        }
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
  if (f && f.contentWindow) try { f.contentWindow.postMessage(json, '*'); } catch(e) {}
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

// ── Our play/pause buttons ──
function togglePlay() {
  if (isPlaying) {
    rawPause();
    pushState({ playing: false, position: currentRawTime, playedAt: null });
  } else {
    rawPlay();
    pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
  }
}

// Sync button — push your exact position to everyone
function syncNow() {
  if (!roomRef) { addLocalMsg('system', '', 'Join a room first!'); return; }
  pushState({ playing: isPlaying, position: currentRawTime, playedAt: isPlaying ? Date.now() : null });
  addLocalMsg('system', '', 'Synced everyone to your position (' + fmtTime(currentRawTime) + ')');
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
