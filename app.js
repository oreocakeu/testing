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

// ── Platform hints ──
var platformsOpen = false;
function togglePlatforms() {
  platformsOpen = !platformsOpen;
  var grid = getEl('platformsGrid');
  var btn  = document.querySelector('.platforms-toggle');
  var hint = getEl('platformHintBox');
  grid.style.display = platformsOpen ? 'grid' : 'none';
  if (btn) btn.classList.toggle('open', platformsOpen);
  if (!platformsOpen && hint) hint.style.display = 'none';
}

var platformHints = {
  youtube:     '🔴 <b>YouTube</b> — Paste any youtube.com or youtu.be link. Full sync support.',
  vimeo:       '🔵 <b>Vimeo</b> — Paste any vimeo.com video link. Full sync support.',
  dailymotion: '🔵 <b>Dailymotion</b> — Paste any dailymotion.com video link. Full sync support.',
  twitch:      '🟣 <b>Twitch VOD</b> — Paste a twitch.tv/videos/... link. Full sync support.',
  onedrive:    '🔵 <b>OneDrive</b> — Share the file → Copy link → paste here. Full sync support.',
  archive:     '📚 <b>Internet Archive</b> — Paste the archive.org/details/... page link. Full sync support.',
  dropbox:     '📦 <b>Dropbox</b> — Share the file → Copy link → paste here. Full sync support.',
  drive:       '🟢 <b>Google Drive</b> — Share → Anyone with link → Copy link → paste here. Sync may be limited by browser.',
  mp4:         '▤ <b>Direct .mp4</b> — Any public direct video URL ending in .mp4, .webm, or .ogg.'
};

function setPlatformHint(key) {
  var box = getEl('platformHintBox');
  if (!box) return;
  box.innerHTML = platformHints[key] || '';
  box.style.display = 'block';
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

  var expected = calcExpectedTime(state);
  var drift    = Math.abs(currentRawTime - expected);

  log('Apply: expected=' + expected.toFixed(1) + ' current=' + currentRawTime.toFixed(1) + ' drift=' + drift.toFixed(1));

  // Always seek first, then play/pause
  if (drift > 1) {
    log('Seeking to ' + expected.toFixed(1));
    rawSeek(expected);
    // Small delay after seek before play to let seek settle
    setTimeout(function() {
      if (state.playing && !isPlaying) { log('Remote → play'); rawPlay(); }
      else if (!state.playing && isPlaying) { log('Remote → pause'); rawPause(); }
    }, 300);
  } else {
    if (state.playing && !isPlaying) { log('Remote → play'); rawPlay(); }
    else if (!state.playing && isPlaying) { log('Remote → pause'); rawPause(); }
  }

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
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (!v) return;
    // Wait for enough data before playing
    function tryPlay() {
      applyingRemote = true;
      v.play().then(function() {
        setTimeout(function() { applyingRemote = false; }, 800);
      }).catch(function(err) {
        applyingRemote = false;
        log('play() blocked: ' + err.message + ' — user must interact first');
        // Show a visible nudge in chat if autoplay is blocked
        addLocalMsg('system', '', '▶ Tab synced — tap play to start');
      });
    }
    if (v.readyState >= 2) {
      tryPlay();
    } else {
      v.addEventListener('canplay', function onCanPlay() {
        v.removeEventListener('canplay', onCanPlay);
        tryPlay();
      });
    }
  }
}

function rawPause() {
  isPlaying = false;
  updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (!v) return;
    applyingRemote = true;
    v.pause();
    setTimeout(function() { applyingRemote = false; }, 500);
  }
}

function rawSeek(t) {
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (!v) return;
    applyingRemote = true;
    function doSeek() {
      v.currentTime = t;
      setTimeout(function() { applyingRemote = false; }, 500);
    }
    if (v.readyState >= 1) {
      doSeek();
    } else {
      v.addEventListener('loadedmetadata', function onMeta() {
        v.removeEventListener('loadedmetadata', onMeta);
        doSeek();
      });
    }
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

  } else if (/vimeo\.com/.test(url)) {
    var vimeoId = url.match(/vimeo\.com\/(\d+)/);
    if (!vimeoId) { alert('Could not parse Vimeo video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.vimeo.com/video/' + vimeoId[1] + '?autoplay=0&controls=1';
    frame.style.display = 'block';

  } else if (/dailymotion\.com/.test(url)) {
    var dmId = url.match(/video\/([a-zA-Z0-9]+)/);
    if (!dmId) { alert('Could not parse Dailymotion video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://www.dailymotion.com/embed/video/' + dmId[1] + '?autoplay=0&controls=1';
    frame.style.display = 'block';

  } else if (/twitch\.tv\/videos/.test(url)) {
    var twitchId = url.match(/videos\/(\d+)/);
    if (!twitchId) { alert('Could not parse Twitch VOD ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.twitch.tv/?video=' + twitchId[1] +
                '&parent=' + window.location.hostname + '&autoplay=false';
    frame.style.display = 'block';

  } else if (/drive\.google\.com/.test(url)) {
    var fid = extractDriveId(url);
    if (!fid) { alert('Could not parse Google Drive file ID.'); return; }
    type = 'html5';
    var directUrl = 'https://drive.google.com/uc?export=download&id=' + fid;
    setupHtml5Player(directUrl);

  } else if (/dropbox\.com/.test(url)) {
    // Convert Dropbox share link to direct download URL
    var dropboxUrl = url
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('?dl=0', '')
      .replace('?raw=1', '');
    type = 'html5';
    setupHtml5Player(dropboxUrl);

  } else if (/1drv\.ms|onedrive\.live\.com|sharepoint\.com/.test(url)) {
    // OneDrive — convert share link to direct download
    type = 'html5';
    var oneDriveUrl = url
      .replace('redir?', 'download?')
      .replace('embed?', 'download?');
    // Handle 1drv.ms short links — append download param
    if (/1drv\.ms/.test(url)) {
      oneDriveUrl = url + (url.includes('?') ? '&' : '?') + 'download=1';
    }
    setupHtml5Player(oneDriveUrl);

  } else if (/archive\.org/.test(url)) {
    type = 'html5';
    var archiveUrl = url;
    if (url.includes('/details/')) {
      var itemId = url.split('/details/')[1].split('/')[0].split('?')[0];
      archiveUrl = 'https://archive.org/download/' + itemId + '/' + itemId + '.mp4';
      log('Archive.org: ' + itemId + ' → ' + archiveUrl);
    }
    setupHtml5Player(archiveUrl);

  } else if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) {
    type = 'html5';
    setupHtml5Player(url);

  } else {
    alert('Paste a YouTube, OneDrive, Internet Archive, Dropbox, Google Drive, or direct .mp4 link.');
    return;
  }

  videoType = type;
  getEl('playerControls').style.display = 'flex';
  getEl('driveNote').style.display      = (type === 'html5' || type === 'embed') ? 'block' : 'none';
  getEl('playerContainer').classList.toggle('drive-player', type === 'html5' || type === 'embed');

  startTimeUpdate();

  if (pushToRoom && roomRef) {
    pushState({ video: url, playing: false, position: 0, playedAt: null });
    addLocalMsg('system', '', 'Video loaded for everyone in the room');
  } else if (lastState) {
    // New joiner — apply current room state after brief load delay
    setTimeout(function() { if (lastState) applyRemoteState(lastState); }, 1500);
  }
}

// ── HTML5 video player (Dropbox, Drive direct, any .mp4) ──
function setupHtml5Player(src) {
  var video = getEl('driveVideo');
  video.src = src;
  video.style.display = 'block';
  video.load();
  log('HTML5 player src: ' + src);

  // User-initiated play
  video.addEventListener('play', function() {
    if (applyingRemote) return;  // ignore events we triggered
    isPlaying = true;
    updatePlayBtn();
    // If the room was playing while this tab was paused/inactive,
    // jump to where it should be now before pushing
    if (lastState && lastState.playing) {
      var expected = calcExpectedTime(lastState);
      if (Math.abs(video.currentTime - expected) > 1) {
        log('Auto-seek on play: ' + expected.toFixed(1));
        applyingRemote = true;
        video.currentTime = expected;
        setTimeout(function() { applyingRemote = false; }, 500);
      }
    }
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

// ── Auto-sync when tab becomes visible again ──
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && lastState && roomRef) {
    log('Tab visible — auto-syncing');
    var expected = calcExpectedTime(lastState);
    // Always seek to correct position when coming back
    if (Math.abs(currentRawTime - expected) > 1) {
      rawSeek(expected);
    }
    // If room was playing, resume playing
    if (lastState.playing) {
      rawPlay();
    }
  }
});

// ── Event listeners ──
document.getElementById('appOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeApp();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeApp();
});
