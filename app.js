/* ── WatchTogether — app.js ── */
/*
  SYNC PHILOSOPHY (Rave-style):
  The site acts as the authority. When ANY person changes position/play/pause,
  Firebase updates and the site FORCES both players to that state — no exceptions.
  
  - applyingRemote flag ONLY prevents echo loops (our own push coming back)
  - Every incoming remote event is applied immediately and forcefully
  - Continuous clock correction every 3s keeps drift from creeping in
  - Seek from video controls is detected and instantly broadcast
*/

// ── Firebase ──
var db = null;
try { db = firebase.database(); } catch(e) { console.warn('Firebase error:', e); }

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
var applyingRemote  = false;
var pushTimeout     = null;
var platformsOpen   = false;
var seekDebounce    = null;
var prevTime        = 0;

// ── Helpers ──
function getEl(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function setSyncStatus(msg) {
  var el = getEl('syncStatus');
  if (!el) return;
  el.textContent = msg;
  if (msg) setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 2000);
}

// ── Virtual clock ──
function calcExpectedTime(state) {
  if (!state) return 0;
  if (!state.playing || !state.playedAt) return (state.position || 0);
  return (state.position || 0) + (Date.now() - state.playedAt) / 1000;
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

// ── Platform hints ──
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
  youtube:     '🔴 <b>YouTube</b> — Paste any youtube.com or youtu.be link. Full sync.',
  bilibili:    '🔵 <b>Bilibili</b> — Paste any bilibili.com or bilibili.tv link. Embed sync.',
  vimeo:       '🔵 <b>Vimeo</b> — Paste any vimeo.com video link. Embed sync.',
  dailymotion: '🔵 <b>Dailymotion</b> — Paste any dailymotion.com video link. Embed sync.',
  twitch:      '🟣 <b>Twitch VOD</b> — Paste a twitch.tv/videos/... link. Embed sync.',
  odysee:      '🔴 <b>Odysee</b> — Paste any odysee.com video link. Embed sync.',
  onedrive:    '🔵 <b>OneDrive</b> — Share → Copy link → paste here. Full sync.',
  archive:     '📚 <b>Internet Archive</b> — Paste archive.org/details/... link. Full sync.',
  dropbox:     '📦 <b>Dropbox</b> — Share → Copy link → paste here. Full sync.',
  drive:       '🟢 <b>Google Drive</b> — Share → Anyone with link → Copy → paste here.',
  mp4:         '▤ <b>Direct .mp4</b> — Any public direct video URL (.mp4, .webm, .ogg). Full sync.'
};
function setPlatformHint(key) {
  var box = getEl('platformHintBox');
  if (!box) return;
  box.innerHTML = platformHints[key] || '';
  box.style.display = 'block';
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

  addLocalMsg('system', '', 'Joined room #' + room);

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
    var el    = getEl('memberCountNum');
    var badge = getEl('memberCount');
    if (el) el.textContent = count;
    if (badge) {
      if (count > 1) badge.classList.add('active');
      else badge.classList.remove('active');
    }
  });

  // ── Main state listener — FORCE apply every remote change ──
  roomRef.on('value', function(snap) {
    var state = snap.val();
    if (!state) return;

    // Only skip our OWN echo — always apply the other person's changes
    if (state.pushedBy === myId) return;

    lastState = state;

    // Load video if changed
    if (state.video && state.video !== currentVideo) {
      getEl('videoInput').value = state.video;
      doLoadVideo(state.video, false);
      return;
    }

    // FORCE apply — no drift check, no conditions
    forceApplyState(state);
  });

  // ── Chat ──
  chatRef.limitToLast(80).on('child_added', function(snap) {
    var m = snap.val();
    if (!m) return;
    appendChatMsg(m.who, m.text);
  });
}

function copyRoom() {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom)
    .then(function()  { addLocalMsg('system', '', 'Room name "' + currentRoom + '" copied!'); })
    .catch(function() { addLocalMsg('system', '', 'Room: ' + currentRoom); });
}

// ── FORCE apply state — site takes control of the player ──
function forceApplyState(state) {
  if (!state) return;
  var expected = calcExpectedTime(state);

  // Set applyingRemote so our own player events don't echo back to Firebase
  applyingRemote = true;

  // Step 1: Seek to exact position
  forceSeek(expected);

  // Step 2: After seek settles, set play/pause state
  setTimeout(function() {
    if (state.playing) {
      forcePlay();
    } else {
      forcePause();
    }
    // Release echo guard after everything settles
    setTimeout(function() { applyingRemote = false; }, 600);
  }, 200);

  setSyncStatus('syncing...');
  setTimeout(function() { setSyncStatus(''); }, 1500);

  // Start continuous correction if playing
  if (state.playing) startClockSync(state);
  else stopClockSync();
}

// ── Continuous clock correction ──
function startClockSync(state) {
  stopClockSync();
  clockSyncTimer = setInterval(function() {
    if (!state || !state.playing) return;
    var expected = calcExpectedTime(state);
    var drift    = Math.abs(currentRawTime - expected);
    // Correct drift > 2s (normal buffering is ~0.5s)
    if (drift > 2 && drift < 120) {
      applyingRemote = true;
      forceSeek(expected);
      setTimeout(function() { applyingRemote = false; }, 500);
    }
  }, 3000);
}
function stopClockSync() {
  if (clockSyncTimer) { clearInterval(clockSyncTimer); clockSyncTimer = null; }
}

// ── Force player controls ──
function forcePlay() {
  isPlaying = true; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'playVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v && v.src) {
      v.play().catch(function() {
        // Browser blocked autoplay — nudge user
        isPlaying = false; updatePlayBtn();
        addLocalMsg('system', '', '▶ Tap Play — video position updated');
      });
    }
  }
}

function forcePause() {
  isPlaying = false; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v) v.pause();
  }
}

function forceSeek(t) {
  if (isNaN(t) || t < 0) return;
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v) {
      if (v.readyState >= 1) {
        v.currentTime = t;
      } else {
        v.addEventListener('loadedmetadata', function onMeta() {
          v.removeEventListener('loadedmetadata', onMeta);
          v.currentTime = t;
        });
      }
    }
  }
}

// ── Push state to Firebase ──
function pushState(data) {
  if (!roomRef) return;
  if (pushTimeout) clearTimeout(pushTimeout);
  pushTimeout = setTimeout(function() {
    var payload = Object.assign({ updatedAt: Date.now(), pushedBy: myId }, data);
    roomRef.update(payload).catch(function(e) { console.warn('Push error:', e); });
  }, 80);
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

  getEl('videoFrame').src            = '';
  getEl('videoFrame').style.display  = 'none';
  getEl('driveVideo').style.display  = 'none';
  getEl('driveVideo').src            = '';
  getEl('playerPlaceholder').style.display = 'none';

  var type = null;

  if (/youtube\.com|youtu\.be/.test(url)) {
    var vid = extractYTId(url);
    if (!vid) { alert('Could not parse YouTube video ID.'); return; }
    type = 'youtube';
    var frame = getEl('videoFrame');
    frame.src = 'https://www.youtube.com/embed/' + vid +
                '?enablejsapi=1&autoplay=0&controls=1&rel=0&modestbranding=1&iv_load_policy=3';
    frame.style.display = 'block';
    setupYTMessaging();

  } else if (/vimeo\.com/.test(url)) {
    var vimeoId = url.match(/vimeo\.com\/(\d+)/);
    if (!vimeoId) { alert('Could not parse Vimeo video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.vimeo.com/video/' + vimeoId[1] + '?autoplay=0&controls=1&dnt=1';
    frame.style.display = 'block';

  } else if (/dailymotion\.com/.test(url)) {
    var dmId = url.match(/video\/([a-zA-Z0-9]+)/);
    if (!dmId) { alert('Could not parse Dailymotion video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://geo.dailymotion.com/player.html?video=' + dmId[1] +
                '&mute=false&sharing-enable=false&queue-enable=false';
    frame.style.display = 'block';

  } else if (/bilibili\.com|bilibili\.tv/.test(url)) {
    type = 'embed';
    var frame = getEl('videoFrame');
    var biliSrc = '';
    if (/bilibili\.tv/.test(url)) {
      var btvId = url.match(/\/video\/(\d+)/);
      if (!btvId) { alert('Could not parse Bilibili TV video ID.'); return; }
      biliSrc = 'https://player.bilibili.tv/player.html?aid=' + btvId[1] + '&autoplay=0';
    } else if (/\/bangumi\/play\/(ep|ss)(\d+)/.test(url)) {
      var bangumi = url.match(/\/bangumi\/play\/(ep|ss)(\d+)/);
      biliSrc = 'https://player.bilibili.com/player.html?' + bangumi[1] + 'id=' + bangumi[2] + '&autoplay=0&danmaku=0';
    } else {
      var bvid = url.match(/video\/(BV[a-zA-Z0-9]+|av\d+)/);
      if (!bvid) { alert('Could not parse Bilibili video ID.'); return; }
      biliSrc = 'https://player.bilibili.com/player.html?bvid=' + bvid[1] + '&autoplay=0&danmaku=0';
    }
    frame.src = biliSrc;
    frame.style.display = 'block';

  } else if (/twitch\.tv\/videos/.test(url)) {
    var twitchId = url.match(/videos\/(\d+)/);
    if (!twitchId) { alert('Could not parse Twitch VOD ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.twitch.tv/?video=' + twitchId[1] +
                '&parent=' + window.location.hostname + '&autoplay=false';
    frame.style.display = 'block';

  } else if (/odysee\.com|lbry\.tv/.test(url)) {
    type = 'embed';
    var frame = getEl('videoFrame');
    var odyseeUrl = url
      .replace('odysee.com/', 'odysee.com/$/embed/')
      .replace('lbry.tv/', 'odysee.com/$/embed/');
    frame.src = odyseeUrl + '?autoplay=0';
    frame.style.display = 'block';

  } else if (/drive\.google\.com/.test(url)) {
    var fid = extractDriveId(url);
    if (!fid) { alert('Could not parse Google Drive file ID.'); return; }
    type = 'html5';
    setupHtml5Player('https://drive.google.com/uc?export=download&id=' + fid, fid);

  } else if (/dropbox\.com/.test(url)) {
    var dropUrl = url
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('?dl=0', '').replace('?raw=1', '');
    type = 'html5';
    setupHtml5Player(dropUrl, null);

  } else if (/1drv\.ms|onedrive\.live\.com|sharepoint\.com/.test(url)) {
    type = 'html5';
    var odUrl = /1drv\.ms/.test(url)
      ? url + (url.includes('?') ? '&' : '?') + 'download=1'
      : url.replace('redir?', 'download?').replace('embed?', 'download?');
    setupHtml5Player(odUrl, null);

  } else if (/archive\.org/.test(url)) {
    type = 'html5';
    var archUrl = url;
    if (url.includes('/details/')) {
      var itemId = url.split('/details/')[1].split('/')[0].split('?')[0];
      archUrl = 'https://archive.org/download/' + itemId + '/' + itemId + '.mp4';
    }
    setupHtml5Player(archUrl, null);

  } else if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) {
    type = 'html5';
    setupHtml5Player(url, null);

  } else {
    alert('Unsupported link. Check supported platforms below.');
    return;
  }

  videoType = type;
  getEl('playerControls').style.display = 'flex';
  getEl('driveNote').style.display      = (type === 'html5') ? 'block' : 'none';
  // Hide our play button for html5 — video has its own controls
  // Keep it for youtube/embed where iframe controls may be small
  getEl('playPauseBtn').style.display   = (type === 'html5') ? 'none' : 'flex';

  startTimeUpdate();

  if (pushToRoom && roomRef) {
    pushState({ video: url, playing: false, position: 0, playedAt: null });
    addLocalMsg('system', '', 'Video loaded for everyone in the room');
  } else if (lastState) {
    setTimeout(function() { if (lastState) forceApplyState(lastState); }, 1500);
  }
}

function extractYTId(url) {
  var m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function extractDriveId(url) {
  var m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── HTML5 player ──
function setupHtml5Player(src, driveFileId) {
  var video = getEl('driveVideo');
  video.src = src;
  video.style.display = 'block';
  video.load();

  // Remove old listeners
  var fresh = video.cloneNode(false);
  fresh.src = src;
  fresh.controls = true;
  fresh.setAttribute('playsinline', '');
  fresh.setAttribute('preload', 'metadata');
  fresh.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; background:#000;';
  video.parentNode.replaceChild(fresh, video);
  fresh.load();

  // ── User plays ──
  fresh.addEventListener('play', function() {
    if (applyingRemote) return;
    isPlaying = true; updatePlayBtn();
    pushState({ playing: true, position: fresh.currentTime, playedAt: Date.now() });
  });

  // ── User pauses — ignore if tab is hidden (browser auto-pause) ──
  fresh.addEventListener('pause', function() {
    if (applyingRemote) return;
    if (document.visibilityState === 'hidden') return; // ignore tab-switch pause
    isPlaying = false; updatePlayBtn();
    pushState({ playing: false, position: fresh.currentTime, playedAt: null });
  });

  // ── User seeks — site broadcasts instantly to other person ──
  fresh.addEventListener('seeked', function() {
    if (applyingRemote) return;
    currentRawTime = fresh.currentTime;
    // Debounce rapid seeks
    if (seekDebounce) clearTimeout(seekDebounce);
    seekDebounce = setTimeout(function() {
      pushState({
        playing:  !fresh.paused,
        position: fresh.currentTime,
        playedAt: !fresh.paused ? Date.now() : null
      });
      setSyncStatus('position shared ✓');
    }, 200);
  });

  fresh.addEventListener('timeupdate', function() {
    currentRawTime = fresh.currentTime;
    getEl('timeDisplay').textContent = fmtTime(fresh.currentTime);
  });

  fresh.addEventListener('error', function() {
    if (driveFileId) {
      fresh.style.display = 'none';
      var frame = getEl('videoFrame');
      frame.src = 'https://drive.google.com/file/d/' + driveFileId + '/preview';
      frame.style.display = 'block';
      videoType = 'embed';
      addLocalMsg('system', '', 'Using Drive preview mode.');
    } else {
      addLocalMsg('system', '', 'Could not load video. Check the link is publicly accessible.');
    }
  });
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
        if (d.info === 1 && !applyingRemote) {
          isPlaying = true; updatePlayBtn();
          pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
        }
        // info === 2 is pause — ignore if tab is hidden (browser auto-pause)
        if (d.info === 2 && !applyingRemote && document.visibilityState !== 'hidden') {
          isPlaying = false; updatePlayBtn();
          pushState({ playing: false, position: currentRawTime, playedAt: null });
        }
      }

      if (d.event === 'infoDelivery' && d.info && d.info.currentTime !== undefined) {
        prevTime       = currentRawTime;
        currentRawTime = d.info.currentTime;
        getEl('timeDisplay').textContent = fmtTime(currentRawTime);

        // Detect user seek: time jumped more than expected (>2s beyond normal play)
        var expectedProgress = prevTime + 0.6; // ~0.5s polling interval
        var isSeek = Math.abs(currentRawTime - expectedProgress) > 2;
        if (!applyingRemote && isSeek) {
          if (seekDebounce) clearTimeout(seekDebounce);
          seekDebounce = setTimeout(function() {
            pushState({
              playing:  isPlaying,
              position: currentRawTime,
              playedAt: isPlaying ? Date.now() : null
            });
            setSyncStatus('position shared ✓');
          }, 200);
        }
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
  }, 500);
}

// ── Our Play/Pause button ──
function togglePlay() {
  if (isPlaying) {
    forcePause();
    pushState({ playing: false, position: currentRawTime, playedAt: null });
  } else {
    forcePlay();
    pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
  }
}

function updatePlayBtn() {
  getEl('playIcon').style.display  = isPlaying ? 'none'  : 'block';
  getEl('pauseIcon').style.display = isPlaying ? 'block' : 'none';
  getEl('playLabel').textContent   = isPlaying ? 'Pause' : 'Play';
}

// ── Tab visibility ──
// When switching back to tab, force apply current room state
// This handles the case where browser auto-paused the vivar prevTime        = 0;

// ── Helpers ──
function getEl(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function setSyncStatus(msg) {
  var el = getEl('syncStatus');
  if (!el) return;
  el.textContent = msg;
  if (msg) setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 2000);
}

// ── Virtual clock ──
function calcExpectedTime(state) {
  if (!state) return 0;
  if (!state.playing || !state.playedAt) return (state.position || 0);
  return (state.position || 0) + (Date.now() - state.playedAt) / 1000;
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

// ── Platform hints ──
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
  youtube:     '🔴 <b>YouTube</b> — Paste any youtube.com or youtu.be link. Full sync.',
  bilibili:    '🔵 <b>Bilibili</b> — Paste any bilibili.com or bilibili.tv link. Embed sync.',
  vimeo:       '🔵 <b>Vimeo</b> — Paste any vimeo.com video link. Embed sync.',
  dailymotion: '🔵 <b>Dailymotion</b> — Paste any dailymotion.com video link. Embed sync.',
  twitch:      '🟣 <b>Twitch VOD</b> — Paste a twitch.tv/videos/... link. Embed sync.',
  odysee:      '🔴 <b>Odysee</b> — Paste any odysee.com video link. Embed sync.',
  onedrive:    '🔵 <b>OneDrive</b> — Share → Copy link → paste here. Full sync.',
  archive:     '📚 <b>Internet Archive</b> — Paste archive.org/details/... link. Full sync.',
  dropbox:     '📦 <b>Dropbox</b> — Share → Copy link → paste here. Full sync.',
  drive:       '🟢 <b>Google Drive</b> — Share → Anyone with link → Copy → paste here.',
  mp4:         '▤ <b>Direct .mp4</b> — Any public direct video URL (.mp4, .webm, .ogg). Full sync.'
};
function setPlatformHint(key) {
  var box = getEl('platformHintBox');
  if (!box) return;
  box.innerHTML = platformHints[key] || '';
  box.style.display = 'block';
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

  addLocalMsg('system', '', 'Joined room #' + room);

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
    var el    = getEl('memberCountNum');
    var badge = getEl('memberCount');
    if (el) el.textContent = count;
    if (badge) {
      if (count > 1) badge.classList.add('active');
      else badge.classList.remove('active');
    }
  });

  // ── Main state listener — FORCE apply every remote change ──
  roomRef.on('value', function(snap) {
    var state = snap.val();
    if (!state) return;

    // Only skip our OWN echo — always apply the other person's changes
    if (state.pushedBy === myId) return;

    lastState = state;

    // Load video if changed
    if (state.video && state.video !== currentVideo) {
      getEl('videoInput').value = state.video;
      doLoadVideo(state.video, false);
      return;
    }

    // FORCE apply — no drift check, no conditions
    forceApplyState(state);
  });

  // ── Chat ──
  chatRef.limitToLast(80).on('child_added', function(snap) {
    var m = snap.val();
    if (!m) return;
    appendChatMsg(m.who, m.text);
  });
}

function copyRoom() {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom)
    .then(function()  { addLocalMsg('system', '', 'Room name "' + currentRoom + '" copied!'); })
    .catch(function() { addLocalMsg('system', '', 'Room: ' + currentRoom); });
}

// ── FORCE apply state — site takes control of the player ──
function forceApplyState(state) {
  if (!state) return;
  var expected = calcExpectedTime(state);

  // Set applyingRemote so our own player events don't echo back to Firebase
  applyingRemote = true;

  // Step 1: Seek to exact position
  forceSeek(expected);

  // Step 2: After seek settles, set play/pause state
  setTimeout(function() {
    if (state.playing) {
      forcePlay();
    } else {
      forcePause();
    }
    // Release echo guard after everything settles
    setTimeout(function() { applyingRemote = false; }, 600);
  }, 200);

  setSyncStatus('syncing...');
  setTimeout(function() { setSyncStatus(''); }, 1500);

  // Start continuous correction if playing
  if (state.playing) startClockSync(state);
  else stopClockSync();
}

// ── Continuous clock correction ──
function startClockSync(state) {
  stopClockSync();
  clockSyncTimer = setInterval(function() {
    if (!state || !state.playing) return;
    var expected = calcExpectedTime(state);
    var drift    = Math.abs(currentRawTime - expected);
    // Correct drift > 2s (normal buffering is ~0.5s)
    if (drift > 2 && drift < 120) {
      applyingRemote = true;
      forceSeek(expected);
      setTimeout(function() { applyingRemote = false; }, 500);
    }
  }, 3000);
}
function stopClockSync() {
  if (clockSyncTimer) { clearInterval(clockSyncTimer); clockSyncTimer = null; }
}

// ── Force player controls ──
function forcePlay() {
  isPlaying = true; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'playVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v && v.src) {
      v.play().catch(function() {
        // Browser blocked autoplay — nudge user
        isPlaying = false; updatePlayBtn();
        addLocalMsg('system', '', '▶ Tap Play — video position updated');
      });
    }
  }
}

function forcePause() {
  isPlaying = false; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v) v.pause();
  }
}

function forceSeek(t) {
  if (isNaN(t) || t < 0) return;
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v) {
      if (v.readyState >= 1) {
        v.currentTime = t;
      } else {
        v.addEventListener('loadedmetadata', function onMeta() {
          v.removeEventListener('loadedmetadata', onMeta);
          v.currentTime = t;
        });
      }
    }
  }
}

// ── Push state to Firebase ──
function pushState(data) {
  if (!roomRef) return;
  if (pushTimeout) clearTimeout(pushTimeout);
  pushTimeout = setTimeout(function() {
    var payload = Object.assign({ updatedAt: Date.now(), pushedBy: myId }, data);
    roomRef.update(payload).catch(function(e) { console.warn('Push error:', e); });
  }, 80);
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

  getEl('videoFrame').src            = '';
  getEl('videoFrame').style.display  = 'none';
  getEl('driveVideo').style.display  = 'none';
  getEl('driveVideo').src            = '';
  getEl('playerPlaceholder').style.display = 'none';

  var type = null;

  if (/youtube\.com|youtu\.be/.test(url)) {
    var vid = extractYTId(url);
    if (!vid) { alert('Could not parse YouTube video ID.'); return; }
    type = 'youtube';
    var frame = getEl('videoFrame');
    frame.src = 'https://www.youtube.com/embed/' + vid +
                '?enablejsapi=1&autoplay=0&controls=1&rel=0&modestbranding=1&iv_load_policy=3';
    frame.style.display = 'block';
    setupYTMessaging();

  } else if (/vimeo\.com/.test(url)) {
    var vimeoId = url.match(/vimeo\.com\/(\d+)/);
    if (!vimeoId) { alert('Could not parse Vimeo video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.vimeo.com/video/' + vimeoId[1] + '?autoplay=0&controls=1&dnt=1';
    frame.style.display = 'block';

  } else if (/dailymotion\.com/.test(url)) {
    var dmId = url.match(/-video\/([a-zA-Z0-9]+)/) || url.match(/video\/([a-zA-Z0-9]+)/);
    if (!dmId) { alert('Could not parse Dailymotion ID.'); return; }
    type = 'dailymotion'; // Change type from 'embed' to 'dailymotion'
    getEl('playerPlaceholder').style.display = 'none';
    setupDailymotionPlayer(dmId[1]);

  } else if (/bilibili\.com|bilibili\.tv/.test(url)) {
    type = 'embed';
    var frame = getEl('videoFrame');
    var biliSrc = '';
    if (/bilibili\.tv/.test(url)) {
      var btvId = url.match(/\/video\/(\d+)/);
      if (!btvId) { alert('Could not parse Bilibili TV video ID.'); return; }
      biliSrc = 'https://player.bilibili.tv/player.html?aid=' + btvId[1] + '&autoplay=0';
    } else if (/\/bangumi\/play\/(ep|ss)(\d+)/.test(url)) {
      var bangumi = url.match(/\/bangumi\/play\/(ep|ss)(\d+)/);
      biliSrc = 'https://player.bilibili.com/player.html?' + bangumi[1] + 'id=' + bangumi[2] + '&autoplay=0&danmaku=0';
    } else {
      var bvid = url.match(/video\/(BV[a-zA-Z0-9]+|av\d+)/);
      if (!bvid) { alert('Could not parse Bilibili video ID.'); return; }
      biliSrc = 'https://player.bilibili.com/player.html?bvid=' + bvid[1] + '&autoplay=0&danmaku=0';
    }
    frame.src = biliSrc;
    frame.style.display = 'block';

  } else if (/twitch\.tv\/videos/.test(url)) {
    var twitchId = url.match(/videos\/(\d+)/);
    if (!twitchId) { alert('Could not parse Twitch VOD ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.twitch.tv/?video=' + twitchId[1] +
                '&parent=' + window.location.hostname + '&autoplay=false';
    frame.style.display = 'block';

  } else if (/odysee\.com|lbry\.tv/.test(url)) {
    type = 'embed';
    var frame = getEl('videoFrame');
    var odyseeUrl = url
      .replace('odysee.com/', 'odysee.com/$/embed/')
      .replace('lbry.tv/', 'odysee.com/$/embed/');
    frame.src = odyseeUrl + '?autoplay=0';
    frame.style.display = 'block';

  } else if (/drive\.google\.com/.test(url)) {
    var fid = extractDriveId(url);
    if (!fid) { alert('Could not parse Google Drive file ID.'); return; }
    type = 'html5';
    setupHtml5Player('https://drive.google.com/uc?export=download&id=' + fid, fid);

  } else if (/dropbox\.com/.test(url)) {
    var dropUrl = url
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('?dl=0', '').replace('?raw=1', '');
    type = 'html5';
    setupHtml5Player(dropUrl, null);

  } else if (/1drv\.ms|onedrive\.live\.com|sharepoint\.com/.test(url)) {
    type = 'html5';
    var odUrl = /1drv\.ms/.test(url)
      ? url + (url.includes('?') ? '&' : '?') + 'download=1'
      : url.replace('redir?', 'download?').replace('embed?', 'download?');
    setupHtml5Player(odUrl, null);

  } else if (/archive\.org/.test(url)) {
    type = 'html5';
    var archUrl = url;
    if (url.includes('/details/')) {
      var itemId = url.split('/details/')[1].split('/')[0].split('?')[0];
      archUrl = 'https://archive.org/download/' + itemId + '/' + itemId + '.mp4';
    }
    setupHtml5Player(archUrl, null);

  } else if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) {
    type = 'html5';
    setupHtml5Player(url, null);

  } else {
    alert('Unsupported link. Check supported platforms below.');
    return;
  }

  videoType = type;
  getEl('playerControls').style.display = 'flex';
  getEl('driveNote').style.display      = (type === 'html5') ? 'block' : 'none';
  // Hide our play button for html5 — video has its own controls
  // Keep it for youtube/embed where iframe controls may be small
  getEl('playPauseBtn').style.display   = (type === 'html5') ? 'none' : 'flex';

  startTimeUpdate();

  if (pushToRoom && roomRef) {
    pushState({ video: url, playing: false, position: 0, playedAt: null });
    addLocalMsg('system', '', 'Video loaded for everyone in the room');
  } else if (lastState) {
    setTimeout(function() { if (lastState) forceApplyState(lastState); }, 1500);
  }
}

function extractYTId(url) {
  var m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function extractDriveId(url) {
  var m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── HTML5 player ──
function setupHtml5Player(src, driveFileId) {
  var video = getEl('driveVideo');
  video.src = src;
  video.style.display = 'block';
  video.load();

  // Remove old listeners
  var fresh = video.cloneNode(false);
  fresh.src = src;
  fresh.controls = true;
  fresh.setAttribute('playsinline', '');
  fresh.setAttribute('preload', 'metadata');
  fresh.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; background:#000;';
  video.parentNode.replaceChild(fresh, video);
  fresh.load();

  // ── User plays ──
  fresh.addEventListener('play', function() {
    if (applyingRemote) return;
    isPlaying = true; updatePlayBtn();
    pushState({ playing: true, position: fresh.currentTime, playedAt: Date.now() });
  });

  // ── User pauses — ignore if tab is hidden (browser auto-pause) ──
  fresh.addEventListener('pause', function() {
    if (applyingRemote) return;
    if (document.visibilityState === 'hidden') return; // ignore tab-switch pause
    isPlaying = false; updatePlayBtn();
    pushState({ playing: false, position: fresh.currentTime, playedAt: null });
  });

  // ── User seeks — site broadcasts instantly to other person ──
  fresh.addEventListener('seeked', function() {
    if (applyingRemote) return;
    currentRawTime = fresh.currentTime;
    // Debounce rapid seeks
    if (seekDebounce) clearTimeout(seekDebounce);
    seekDebounce = setTimeout(function() {
      pushState({
        playing:  !fresh.paused,
        position: fresh.currentTime,
        playedAt: !fresh.paused ? Date.now() : null
      });
      setSyncStatus('position shared ✓');
    }, 200);
  });

  fresh.addEventListener('timeupdate', function() {
    currentRawTime = fresh.currentTime;
    getEl('timeDisplay').textContent = fmtTime(fresh.currentTime);
  });

  fresh.addEventListener('error', function() {
    if (driveFileId) {
      fresh.style.display = 'none';
      var frame = getEl('videoFrame');
      frame.src = 'https://drive.google.com/file/d/' + driveFileId + '/preview';
      frame.style.display = 'block';
      videoType = 'embed';
      addLocalMsg('system', '', 'Using Drive preview mode.');
    } else {
      addLocalMsg('system', '', 'Could not load video. Check the link is publicly accessible.');
    }
  });
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
        if (d.info === 1 && !applyingRemote) {
          isPlaying = true; updatePlayBtn();
          pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
        }
        // info === 2 is pause — ignore if tab is hidden (browser auto-pause)
        if (d.info === 2 && !applyingRemote && document.visibilityState !== 'hidden') {
          isPlaying = false; updatePlayBtn();
          pushState({ playing: false, position: currentRawTime, playedAt: null });
        }
      }

      if (d.event === 'infoDelivery' && d.info && d.info.currentTime !== undefined) {
        prevTime       = currentRawTime;
        currentRawTime = d.info.currentTime;
        getEl('timeDisplay').textContent = fmtTime(currentRawTime);

        // Detect user seek: time jumped more than expected (>2s beyond normal play)
        var expectedProgress = prevTime + 0.6; // ~0.5s polling interval
        var isSeek = Math.abs(currentRawTime - expectedProgress) > 2;
        if (!applyingRemote && isSeek) {
          if (seekDebounce) clearTimeout(seekDebounce);
          seekDebounce = setTimeout(function() {
            pushState({
              playing:  isPlaying,
              position: currentRawTime,
              playedAt: isPlaying ? Date.now() : null
            });
            setSyncStatus('position shared ✓');
          }, 200);
        }
      }
    } catch(err) {}
  });
  setTimeout(function() { sendYT('{"event":"listening"}'); }, 800);
}

var dmPlayer = null;

function setupDailymotionPlayer(videoId) {
  // Clear the container
  const container = getEl('playerContainer');
  // Create a div for the DM player if it doesn't exist
  container.innerHTML = '<div id="dm-player-mount"></div>';
  
  dmPlayer = DM.player(getEl('dm-player-mount'), {
    video: videoId,
    width: "100%",
    height: "100%",
    params: { autoplay: false, controls: true }
  });

  // Listen for Play
  dmPlayer.addEventListener('play', function() {
    if (applyingRemote) return;
    isPlaying = true; updatePlayBtn();
    pushState({ playing: true, position: dmPlayer.currentTime, playedAt: Date.now() });
  });

  // Listen for Pause
  dmPlayer.addEventListener('pause', function() {
    if (applyingRemote) return;
    isPlaying = false; updatePlayBtn();
    pushState({ playing: false, position: dmPlayer.currentTime, playedAt: null });
  });

  // Listen for Seeks
  dmPlayer.addEventListener('seeked', function() {
    if (applyingRemote) return;
    pushState({
      playing: !dmPlayer.paused,
 var prevTime        = 0;

// ── Helpers ──
function getEl(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function setSyncStatus(msg) {
  var el = getEl('syncStatus');
  if (!el) return;
  el.textContent = msg;
  if (msg) setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 2000);
}

// ── Virtual clock ──
function calcExpectedTime(state) {
  if (!state) return 0;
  if (!state.playing || !state.playedAt) return (state.position || 0);
  return (state.position || 0) + (Date.now() - state.playedAt) / 1000;
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

// ── Platform hints ──
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
  youtube:     '🔴 <b>YouTube</b> — Paste any youtube.com or youtu.be link. Full sync.',
  bilibili:    '🔵 <b>Bilibili</b> — Paste any bilibili.com or bilibili.tv link. Embed sync.',
  vimeo:       '🔵 <b>Vimeo</b> — Paste any vimeo.com video link. Embed sync.',
  dailymotion: '🔵 <b>Dailymotion</b> — Paste any dailymotion.com video link. Embed sync.',
  twitch:      '🟣 <b>Twitch VOD</b> — Paste a twitch.tv/videos/... link. Embed sync.',
  odysee:      '🔴 <b>Odysee</b> — Paste any odysee.com video link. Embed sync.',
  onedrive:    '🔵 <b>OneDrive</b> — Share → Copy link → paste here. Full sync.',
  archive:     '📚 <b>Internet Archive</b> — Paste archive.org/details/... link. Full sync.',
  dropbox:     '📦 <b>Dropbox</b> — Share → Copy link → paste here. Full sync.',
  drive:       '🟢 <b>Google Drive</b> — Share → Anyone with link → Copy → paste here.',
  mp4:         '▤ <b>Direct .mp4</b> — Any public direct video URL (.mp4, .webm, .ogg). Full sync.'
};
function setPlatformHint(key) {
  var box = getEl('platformHintBox');
  if (!box) return;
  box.innerHTML = platformHints[key] || '';
  box.style.display = 'block';
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

  addLocalMsg('system', '', 'Joined room #' + room);

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
    var el    = getEl('memberCountNum');
    var badge = getEl('memberCount');
    if (el) el.textContent = count;
    if (badge) {
      if (count > 1) badge.classList.add('active');
      else badge.classList.remove('active');
    }
  });

  // ── Main state listener — FORCE apply every remote change ──
  roomRef.on('value', function(snap) {
    var state = snap.val();
    if (!state) return;

    // Only skip our OWN echo — always apply the other person's changes
    if (state.pushedBy === myId) return;

    lastState = state;

    // Load video if changed
    if (state.video && state.video !== currentVideo) {
      getEl('videoInput').value = state.video;
      doLoadVideo(state.video, false);
      return;
    }

    // FORCE apply — no drift check, no conditions
    forceApplyState(state);
  });

  // ── Chat ──
  chatRef.limitToLast(80).on('child_added', function(snap) {
    var m = snap.val();
    if (!m) return;
    appendChatMsg(m.who, m.text);
  });
}

function copyRoom() {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom)
    .then(function()  { addLocalMsg('system', '', 'Room name "' + currentRoom + '" copied!'); })
    .catch(function() { addLocalMsg('system', '', 'Room: ' + currentRoom); });
}

// ── FORCE apply state — site takes control of the player ──
function forceApplyState(state) {
  if (!state) return;
  var expected = calcExpectedTime(state);

  // Set applyingRemote so our own player events don't echo back to Firebase
  applyingRemote = true;

  // Step 1: Seek to exact position
  forceSeek(expected);

  // Step 2: After seek settles, set play/pause state
  setTimeout(function() {
    if (state.playing) {
      forcePlay();
    } else {
      forcePause();
    }
    // Release echo guard after everything settles
    setTimeout(function() { applyingRemote = false; }, 600);
  }, 200);

  setSyncStatus('syncing...');
  setTimeout(function() { setSyncStatus(''); }, 1500);

  // Start continuous correction if playing
  if (state.playing) startClockSync(state);
  else stopClockSync();
}

// ── Continuous clock correction ──
function startClockSync(state) {
  stopClockSync();
  clockSyncTimer = setInterval(function() {
    if (!state || !state.playing) return;
    var expected = calcExpectedTime(state);
    var drift    = Math.abs(currentRawTime - expected);
    // Correct drift > 2s (normal buffering is ~0.5s)
    if (drift > 2 && drift < 120) {
      applyingRemote = true;
      forceSeek(expected);
      setTimeout(function() { applyingRemote = false; }, 500);
    }
  }, 3000);
}
function stopClockSync() {
  if (clockSyncTimer) { clearInterval(clockSyncTimer); clockSyncTimer = null; }
}

// ── Force player controls ──
function forcePlay() {
  isPlaying = true; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'playVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v && v.src) {
      v.play().catch(function() {
        // Browser blocked autoplay — nudge user
        isPlaying = false; updatePlayBtn();
        addLocalMsg('system', '', '▶ Tap Play — video position updated');
      });
    }
  }
}

function forcePause() {
  isPlaying = false; updatePlayBtn();
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v) v.pause();
  }
}

function forceSeek(t) {
  if (isNaN(t) || t < 0) return;
  if (videoType === 'youtube') {
    sendYT(JSON.stringify({ event: 'command', func: 'seekTo', args: [t, true] }));
  } else if (videoType === 'html5') {
    var v = getEl('driveVideo');
    if (v) {
      if (v.readyState >= 1) {
        v.currentTime = t;
      } else {
        v.addEventListener('loadedmetadata', function onMeta() {
          v.removeEventListener('loadedmetadata', onMeta);
          v.currentTime = t;
        });
      }
    }
  }
}

// ── Push state to Firebase ──
function pushState(data) {
  if (!roomRef) return;
  if (pushTimeout) clearTimeout(pushTimeout);
  pushTimeout = setTimeout(function() {
    var payload = Object.assign({ updatedAt: Date.now(), pushedBy: myId }, data);
    roomRef.update(payload).catch(function(e) { console.warn('Push error:', e); });
  }, 80);
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

  getEl('videoFrame').src            = '';
  getEl('videoFrame').style.display  = 'none';
  getEl('driveVideo').style.display  = 'none';
  getEl('driveVideo').src            = '';
  getEl('playerPlaceholder').style.display = 'none';

  var type = null;

  if (/youtube\.com|youtu\.be/.test(url)) {
    var vid = extractYTId(url);
    if (!vid) { alert('Could not parse YouTube video ID.'); return; }
    type = 'youtube';
    var frame = getEl('videoFrame');
    frame.src = 'https://www.youtube.com/embed/' + vid +
                '?enablejsapi=1&autoplay=0&controls=1&rel=0&modestbranding=1&iv_load_policy=3';
    frame.style.display = 'block';
    setupYTMessaging();

  } else if (/vimeo\.com/.test(url)) {
    var vimeoId = url.match(/vimeo\.com\/(\d+)/);
    if (!vimeoId) { alert('Could not parse Vimeo video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.vimeo.com/video/' + vimeoId[1] + '?autoplay=0&controls=1&dnt=1';
    frame.style.display = 'block';

  } else if (/dailymotion\.com/.test(url)) {
    var dmId = url.match(/video\/([a-zA-Z0-9]+)/);
    if (!dmId) { alert('Could not parse Dailymotion video ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://geo.dailymotion.com/player.html?video=' + dmId[1] +
                '&mute=false&sharing-enable=false&queue-enable=false';
    frame.style.display = 'block';

  } else if (/bilibili\.com|bilibili\.tv/.test(url)) {
    type = 'embed';
    var frame = getEl('videoFrame');
    var biliSrc = '';
    if (/bilibili\.tv/.test(url)) {
      var btvId = url.match(/\/video\/(\d+)/);
      if (!btvId) { alert('Could not parse Bilibili TV video ID.'); return; }
      biliSrc = 'https://player.bilibili.tv/player.html?aid=' + btvId[1] + '&autoplay=0';
    } else if (/\/bangumi\/play\/(ep|ss)(\d+)/.test(url)) {
      var bangumi = url.match(/\/bangumi\/play\/(ep|ss)(\d+)/);
      biliSrc = 'https://player.bilibili.com/player.html?' + bangumi[1] + 'id=' + bangumi[2] + '&autoplay=0&danmaku=0';
    } else {
      var bvid = url.match(/video\/(BV[a-zA-Z0-9]+|av\d+)/);
      if (!bvid) { alert('Could not parse Bilibili video ID.'); return; }
      biliSrc = 'https://player.bilibili.com/player.html?bvid=' + bvid[1] + '&autoplay=0&danmaku=0';
    }
    frame.src = biliSrc;
    frame.style.display = 'block';

  } else if (/twitch\.tv\/videos/.test(url)) {
    var twitchId = url.match(/videos\/(\d+)/);
    if (!twitchId) { alert('Could not parse Twitch VOD ID.'); return; }
    type = 'embed';
    var frame = getEl('videoFrame');
    frame.src = 'https://player.twitch.tv/?video=' + twitchId[1] +
                '&parent=' + window.location.hostname + '&autoplay=false';
    frame.style.display = 'block';

  } else if (/odysee\.com|lbry\.tv/.test(url)) {
    type = 'embed';
    var frame = getEl('videoFrame');
    var odyseeUrl = url
      .replace('odysee.com/', 'odysee.com/$/embed/')
      .replace('lbry.tv/', 'odysee.com/$/embed/');
    frame.src = odyseeUrl + '?autoplay=0';
    frame.style.display = 'block';

  } else if (/drive\.google\.com/.test(url)) {
    var fid = extractDriveId(url);
    if (!fid) { alert('Could not parse Google Drive file ID.'); return; }
    type = 'html5';
    setupHtml5Player('https://drive.google.com/uc?export=download&id=' + fid, fid);

  } else if (/dropbox\.com/.test(url)) {
    var dropUrl = url
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('?dl=0', '').replace('?raw=1', '');
    type = 'html5';
    setupHtml5Player(dropUrl, null);

  } else if (/1drv\.ms|onedrive\.live\.com|sharepoint\.com/.test(url)) {
    type = 'html5';
    var odUrl = /1drv\.ms/.test(url)
      ? url + (url.includes('?') ? '&' : '?') + 'download=1'
      : url.replace('redir?', 'download?').replace('embed?', 'download?');
    setupHtml5Player(odUrl, null);

  } else if (/archive\.org/.test(url)) {
    type = 'html5';
    var archUrl = url;
    if (url.includes('/details/')) {
      var itemId = url.split('/details/')[1].split('/')[0].split('?')[0];
      archUrl = 'https://archive.org/download/' + itemId + '/' + itemId + '.mp4';
    }
    setupHtml5Player(archUrl, null);

  } else if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) {
    type = 'html5';
    setupHtml5Player(url, null);

  } else {
    alert('Unsupported link. Check supported platforms below.');
    return;
  }

  videoType = type;
  getEl('playerControls').style.display = 'flex';
  getEl('driveNote').style.display      = (type === 'html5') ? 'block' : 'none';
  // Hide our play button for html5 — video has its own controls
  // Keep it for youtube/embed where iframe controls may be small
  getEl('playPauseBtn').style.display   = (type === 'html5') ? 'none' : 'flex';

  startTimeUpdate();

  if (pushToRoom && roomRef) {
    pushState({ video: url, playing: false, position: 0, playedAt: null });
    addLocalMsg('system', '', 'Video loaded for everyone in the room');
  } else if (lastState) {
    setTimeout(function() { if (lastState) forceApplyState(lastState); }, 1500);
  }
}

function extractYTId(url) {
  var m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function extractDriveId(url) {
  var m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── HTML5 player ──
function setupHtml5Player(src, driveFileId) {
  var video = getEl('driveVideo');
  video.src = src;
  video.style.display = 'block';
  video.load();

  // Remove old listeners
  var fresh = video.cloneNode(false);
  fresh.src = src;
  fresh.controls = true;
  fresh.setAttribute('playsinline', '');
  fresh.setAttribute('preload', 'metadata');
  fresh.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; background:#000;';
  video.parentNode.replaceChild(fresh, video);
  fresh.load();

  // ── User plays ──
  fresh.addEventListener('play', function() {
    if (applyingRemote) return;
    isPlaying = true; updatePlayBtn();
    pushState({ playing: true, position: fresh.currentTime, playedAt: Date.now() });
  });

  // ── User pauses — ignore if tab is hidden (browser auto-pause) ──
  fresh.addEventListener('pause', function() {
    if (applyingRemote) return;
    if (document.visibilityState === 'hidden') return; // ignore tab-switch pause
    isPlaying = false; updatePlayBtn();
    pushState({ playing: false, position: fresh.currentTime, playedAt: null });
  });

  // ── User seeks — site broadcasts instantly to other person ──
  fresh.addEventListener('seeked', function() {
    if (applyingRemote) return;
    currentRawTime = fresh.currentTime;
    // Debounce rapid seeks
    if (seekDebounce) clearTimeout(seekDebounce);
    seekDebounce = setTimeout(function() {
      pushState({
        playing:  !fresh.paused,
        position: fresh.currentTime,
        playedAt: !fresh.paused ? Date.now() : null
      });
      setSyncStatus('position shared ✓');
    }, 200);
  });

  fresh.addEventListener('timeupdate', function() {
    currentRawTime = fresh.currentTime;
    getEl('timeDisplay').textContent = fmtTime(fresh.currentTime);
  });

  fresh.addEventListener('error', function() {
    if (driveFileId) {
      fresh.style.display = 'none';
      var frame = getEl('videoFrame');
      frame.src = 'https://drive.google.com/file/d/' + driveFileId + '/preview';
      frame.style.display = 'block';
      videoType = 'embed';
      addLocalMsg('system', '', 'Using Drive preview mode.');
    } else {
      addLocalMsg('system', '', 'Could not load video. Check the link is publicly accessible.');
    }
  });
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
        if (d.info === 1 && !applyingRemote) {
          isPlaying = true; updatePlayBtn();
          pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
        }
        // info === 2 is pause — ignore if tab is hidden (browser auto-pause)
        if (d.info === 2 && !applyingRemote && document.visibilityState !== 'hidden') {
          isPlaying = false; updatePlayBtn();
          pushState({ playing: false, position: currentRawTime, playedAt: null });
        }
      }

      if (d.event === 'infoDelivery' && d.info && d.info.currentTime !== undefined) {
        prevTime       = currentRawTime;
        currentRawTime = d.info.currentTime;
        getEl('timeDisplay').textContent = fmtTime(currentRawTime);

        // Detect user seek: time jumped more than expected (>2s beyond normal play)
        var expectedProgress = prevTime + 0.6; // ~0.5s polling interval
        var isSeek = Math.abs(currentRawTime - expectedProgress) > 2;
        if (!applyingRemote && isSeek) {
          if (seekDebounce) clearTimeout(seekDebounce);
          seekDebounce = setTimeout(function() {
            pushState({
              playing:  isPlaying,
              position: currentRawTime,
              playedAt: isPlaying ? Date.now() : null
            });
            setSyncStatus('position shared ✓');
          }, 200);
        }
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
  }, 500);
}

// ── Our Play/Pause button ──
function togglePlay() {
  if (isPlaying) {
    forcePause();
    pushState({ playing: false, position: currentRawTime, playedAt: null });
  } else {
    forcePlay();
    pushState({ playing: true, position: currentRawTime, playedAt: Date.now() });
  }
}

function updatePlayBtn() {
  getEl('playIcon').style.display  = isPlaying ? 'none'  : 'block';
  getEl('pauseIcon').style.display = isPlaying ? 'block' : 'none';
  getEl('playLabel').textContent   = isPlaying ? 'Pause' : 'Play';
}

// ── Tab visibility ──
// When switching back to tab, force apply current room state
// This handles the case where browser auto-paused the video
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && lastState) {
    // Small delay to let browser settle after tab switch
    setTimeout(function() {
      forceApplyState(lastState);
    }, 300);
  }
});

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
