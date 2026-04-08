import { ensureLoggedIn, redirectUnlessJukeboxEnabled } from '../js/auth-guard.js';
import { requestPin } from '../js/pin-modal.js';
import '../js/track-card-shared.js';
import {
  confirmJukeboxSearchAddTrack,
  jukeboxSearchRowStatusIconHtml,
  jukeboxSearchTrackBlockedFromQueue,
} from '../js/jukebox-search-queue-shared.js';
import * as JbCast from '../js/jukebox-cast.js';
import {
  installJukeboxGuestBackGuard,
  releaseJukeboxGuestBackGuard,
} from '../js/jukebox-guest-back-guard.js';

const RETURN_AFTER_JUKEBOX_KEY = 'tf-jukebox-return-href';

const params = new URLSearchParams(window.location.search);

function safeReturnPath(raw) {
  if (raw == null || typeof raw !== 'string') {
    return null;
  }
  let s;
  try {
    s = decodeURIComponent(raw.trim());
  } catch {
    return null;
  }
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('://')) {
    return null;
  }
  return s;
}

function returnAfterJukeboxHref() {
  const fromParam = safeReturnPath(params.get('return'));
  if (fromParam) {
    return fromParam;
  }
  try {
    const s = sessionStorage.getItem(RETURN_AFTER_JUKEBOX_KEY);
    if (s && s.startsWith('/') && !s.startsWith('//')) {
      return s;
    }
  } catch {
    /* ignore */
  }
  return '/jukebox.html';
}

function navigateAfterJukeboxClosed() {
  releaseJukeboxGuestBackGuard();
  const href = returnAfterJukeboxHref();
  try {
    sessionStorage.removeItem(RETURN_AFTER_JUKEBOX_KEY);
  } catch {
    /* ignore */
  }
  /* replace: drop guest from joint history so Back does not reopen guest after Close */
  window.location.replace(href);
}

const jukeboxId = params.get('id');

function hideJukeboxPageLoading() {
  const el = document.getElementById('jbLoadingOverlay');
  if (!el) {
    return;
  }
  el.hidden = true;
  el.removeAttribute('aria-busy');
}

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await redirectUnlessJukeboxEnabled(__tfMe);

let guestToken = (params.get('token') || '').trim();
if (jukeboxId && !guestToken) {
  const jbRes = await fetch(`/api/jukeboxes/${encodeURIComponent(jukeboxId)}`, { credentials: 'same-origin' });
  if (jbRes.ok) {
    const jb = await jbRes.json().catch(() => ({}));
    guestToken = String(jb.guest_token || '').trim();
  }
}

if (!jukeboxId || !guestToken) {
  const errEl = document.getElementById('globalErr');
  if (errEl) {
    errEl.hidden = false;
    errEl.textContent = !jukeboxId
      ? 'Missing jukebox id.'
      : 'Missing guest access. Open this page from TrackFlow (Launch) or use the guest link you were given.';
  }
  hideJukeboxPageLoading();
  await new Promise(() => {});
}

const base = `/api/jukeboxes/guest/${encodeURIComponent(jukeboxId)}`;

function qs() {
  return `token=${encodeURIComponent(guestToken)}`;
}

const audioEl = document.getElementById('audioEl');
const npCover = document.getElementById('npCover');
const npCoverBg = document.getElementById('npCoverBg');
const npTitle = document.getElementById('npTitle');
const npArtist = document.getElementById('npArtist');
const npProgressFill = document.getElementById('npProgressFill');
const npProgressRail = document.getElementById('npProgressRail');
const npTimeCur = document.getElementById('npTimeCur');
const npTimeDur = document.getElementById('npTimeDur');
const npPlayBtn = document.getElementById('npPlayBtn');
const npSkipBtn = document.getElementById('npSkipBtn');
const npPlayIcon = document.getElementById('npPlayIcon');
const volSlider = document.getElementById('volSlider');
const volToggleBtn = document.getElementById('volToggleBtn');
const volPanel = document.getElementById('volPanel');
const volToggleIcon = document.getElementById('volToggleIcon');
const queuePreview = document.getElementById('queuePreview');
const historyPreview = document.getElementById('historyPreview');
const topTracksList = document.getElementById('topTracksList');
const freshTracksList = document.getElementById('freshTracksList');
const recentMixList = document.getElementById('recentMixList');
const cardActionSheet = document.getElementById('cardActionSheet');
const cardActionTitle = document.getElementById('cardActionTitle');
const cardActionQueue = document.getElementById('cardActionQueue');
const cardActionNext = document.getElementById('cardActionNext');
const cardActionCancel = document.getElementById('cardActionCancel');
const cardActionBackdrop = document.getElementById('cardActionBackdrop');
const searchQ = document.getElementById('searchQ');
const searchSheet = document.getElementById('searchSheet');
const jbShell = document.querySelector('.jb-shell');
const sheetBody = document.getElementById('sheetBody');
const sheetTitle = document.getElementById('sheetTitle');
const sheetCloseBtn = document.getElementById('sheetCloseBtn');
const sheetBackBtn = document.getElementById('sheetBackBtn');
const globalErr = document.getElementById('globalErr');
const jbToast = document.getElementById('jbToast');
const menuBtn = document.getElementById('menuBtn');
const menuPanel = document.getElementById('menuPanel');
const castMainBtn = document.getElementById('castMainBtn');
const npCastLine = document.getElementById('npCastLine');

let ignoringMediaEvents = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let ignoreMediaEventsTimer = null;

/**
 * Suppress pause/play listeners while mutating `audioEl` (e.g. setting `src`), including async
 * load/pause emissions that happen after the synchronous block (microtask was too early).
 */
function withIgnoreMediaEvents(fn) {
  ignoringMediaEvents = true;
  if (ignoreMediaEventsTimer != null) {
    clearTimeout(ignoreMediaEventsTimer);
    ignoreMediaEventsTimer = null;
  }
  try {
    fn();
  } finally {
    ignoreMediaEventsTimer = setTimeout(() => {
      ignoringMediaEvents = false;
      ignoreMediaEventsTimer = null;
    }, 400);
  }
}

let lastServerPaused = null;
let lastQueueItemId = null;
let currentPlayingQueueItemId = null;
let volDebounceTimer;
/** @type {{ payload: ReturnType<typeof discoveryPayload> } | null} */
let pendingCardPayload = null;

let lastNpArtKey = '';
let lastCurrentQueueRowId = null;
/** From last guest state: server has a current queue row with a library file (streamable). */
let guestHasPlayableCurrent = false;
let lastQueueDisplaySig = '';
const discoveryStripSigs = { topTracks: '', freshTracks: '', recentMix: '' };
let lastHistoryDisplaySig = '';
let discoveryInteractUntil = 0;
/** Last queue row id successfully loaded on the Cast receiver (null when using local audio). */
let lastCastLoadedQueueItemId = null;
let castLoadSeq = 0;
/** Synced with server `host_seek_nonce` so we only apply each host seek once. */
let lastAppliedHostSeekNonce = 0;
let lastCastReportCur = 0;
let lastCastReportDur = 0;
let lastReportPlaybackAt = 0;

function markDiscoveryInteract() {
  discoveryInteractUntil = Date.now() + 15000;
}

const REPORT_PLAYBACK_MIN_MS = 800;

function queueItemIdForReport() {
  return currentPlayingQueueItemId != null ? Number(currentPlayingQueueItemId) : null;
}

async function postReportPlayback(positionSeconds, durationSeconds) {
  const qid = queueItemIdForReport();
  if (!jukeboxId || !guestToken || !qid) {
    return;
  }
  try {
    await fetch(`${base}/report-playback?${qs()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        queue_item_id: qid,
        position_seconds: positionSeconds,
        duration_seconds: durationSeconds,
      }),
    });
  } catch {
    /* ignore */
  }
}

function scheduleReportPlaybackFromLocalAudio() {
  if (!guestHasPlayableCurrent || guestCastingPlayback() || !audioEl) {
    return;
  }
  const now = Date.now();
  if (now - lastReportPlaybackAt < REPORT_PLAYBACK_MIN_MS) {
    return;
  }
  const qid = queueItemIdForReport();
  if (!qid) {
    return;
  }
  const dur = audioEl.duration;
  const cur = audioEl.currentTime;
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(cur)) {
    return;
  }
  lastReportPlaybackAt = now;
  void postReportPlayback(cur, dur);
}

function scheduleReportPlaybackFromCast() {
  if (!guestHasPlayableCurrent || !guestCastingPlayback()) {
    return;
  }
  const qid = queueItemIdForReport();
  if (!qid || !Number.isFinite(lastCastReportDur) || lastCastReportDur <= 0) {
    return;
  }
  const now = Date.now();
  if (now - lastReportPlaybackAt < REPORT_PLAYBACK_MIN_MS) {
    return;
  }
  lastReportPlaybackAt = now;
  void postReportPlayback(lastCastReportCur, lastCastReportDur);
}

function applyHostSeekFromJukeboxState(data) {
  if (!data?.jukebox || !guestHasPlayableCurrent || !data.current?.id) {
    return;
  }
  const sq = data.jukebox.host_seek_queue_item_id;
  if (sq == null || Number(sq) !== Number(data.current.id)) {
    return;
  }
  const n = Number(data.jukebox.host_seek_nonce);
  const posRaw = data.jukebox.host_seek_position_seconds;
  if (!Number.isFinite(n) || n === lastAppliedHostSeekNonce) {
    return;
  }
  const t = Number(posRaw);
  if (!Number.isFinite(t) || t < 0) {
    lastAppliedHostSeekNonce = n;
    return;
  }
  if (guestCastingPlayback()) {
    if (lastCastLoadedQueueItemId !== data.current.id) {
      return;
    }
    lastAppliedHostSeekNonce = n;
    JbCast.castSeekTo(t);
    return;
  }
  if (!audioEl) {
    return;
  }
  lastAppliedHostSeekNonce = n;
  const apply = () => {
    let cap = t;
    try {
      if (Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
        cap = Math.min(t, Math.max(0, audioEl.duration - 0.05));
      }
      withIgnoreMediaEvents(() => {
        try {
          audioEl.currentTime = cap;
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  };
  if (audioEl.readyState >= 1) {
    apply();
  } else {
    audioEl.addEventListener('loadedmetadata', apply, { once: true });
  }
}

const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';

const VOL_ICON_HIGH =
  '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
const VOL_ICON_LOW =
  '<path d="M5 9v6h4l5 5V4L9 9H5zm11.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>';
const VOL_ICON_MUTE =
  '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.92-2.25 1.18v2.06a8.99 8.99 0 0 0 3.46-1.85L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';

function setVolumeButtonIcon(vol01) {
  if (!volToggleIcon) {
    return;
  }
  const v = Number(vol01);
  if (!Number.isFinite(v) || v <= 0.001) {
    volToggleIcon.innerHTML = VOL_ICON_MUTE;
  } else if (v < 0.45) {
    volToggleIcon.innerHTML = VOL_ICON_LOW;
  } else {
    volToggleIcon.innerHTML = VOL_ICON_HIGH;
  }
}

function closeVolPanel() {
  if (volPanel) {
    volPanel.hidden = true;
  }
  volToggleBtn?.setAttribute('aria-expanded', 'false');
}

function toggleVolPanel() {
  if (!volPanel || !volToggleBtn) {
    return;
  }
  const open = volPanel.hidden;
  volPanel.hidden = !open;
  volToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

volToggleBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleVolPanel();
});

volPanel?.addEventListener('click', (e) => e.stopPropagation());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeVolPanel();
    menuPanel?.classList.remove('open');
    menuBtn?.setAttribute('aria-expanded', 'false');
  }
});

async function syncGuestPlaybackToServer(body) {
  if (!jukeboxId || !guestToken) {
    return;
  }
  try {
    await fetch(`${base}/pause?${qs()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    /* ignore */
  }
}

async function syncGuestPauseToServer(isPaused) {
  await syncGuestPlaybackToServer({ is_paused: isPaused });
}

if (audioEl) {
  try {
    audioEl.disableRemotePlayback = true;
  } catch {
    /* ignore */
  }
  audioEl.addEventListener('pause', () => {
    setPlayIcon(true);
    if (ignoringMediaEvents || audioEl.ended) {
      return;
    }
    void syncGuestPauseToServer(true);
  });
  audioEl.addEventListener('play', () => {
    setPlayIcon(false);
    if (ignoringMediaEvents) {
      return;
    }
    void syncGuestPauseToServer(false);
  });
  audioEl.addEventListener('timeupdate', () => {
    if (guestCastingPlayback()) {
      return;
    }
    if (!audioEl.duration || !Number.isFinite(audioEl.duration)) {
      return;
    }
    scheduleReportPlaybackFromLocalAudio();
    const pct = Math.round((audioEl.currentTime / audioEl.duration) * 1000);
    const clamped = Math.min(1000, Math.max(0, pct));
    if (npProgressFill) {
      npProgressFill.style.width = `${clamped / 10}%`;
    }
    if (npProgressRail) {
      npProgressRail.setAttribute('aria-valuenow', String(clamped));
    }
    if (npTimeCur) {
      npTimeCur.textContent = formatTime(audioEl.currentTime);
    }
  });
  audioEl.addEventListener('loadedmetadata', () => {
    if (npTimeDur) {
      npTimeDur.textContent = formatTime(audioEl.duration || 0);
    }
  });
  audioEl.addEventListener('durationchange', () => {
    if (npTimeDur) {
      npTimeDur.textContent = formatTime(audioEl.duration || 0);
    }
  });
  /** @type {ReturnType<typeof setTimeout> | null} */
  let audioRecoverTimer = null;
  audioEl.addEventListener('error', () => {
    if (ignoringMediaEvents || !jukeboxId || !guestToken) {
      return;
    }
    if (audioRecoverTimer != null) {
      clearTimeout(audioRecoverTimer);
    }
    audioRecoverTimer = setTimeout(() => {
      audioRecoverTimer = null;
      void refreshPlaybackOnly();
    }, 400);
  });
}

function formatTime(sec) {
  const s = Math.floor(Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function setPlayIcon(paused) {
  if (!npPlayIcon) {
    return;
  }
  npPlayIcon.innerHTML = `<path d="${paused ? PLAY_PATH : PAUSE_PATH}"/>`;
}

npPlayBtn?.addEventListener('click', () => {
  if (!audioEl) {
    return;
  }
  // Do not use `!audioEl.src`: after removeAttribute('src') many browsers still expose a resolved
  // absolute URL on `.src`, so the idle path would never run. Use last server state instead.
  if (!guestHasPlayableCurrent) {
    if (!jukeboxId || !guestToken) {
      return;
    }
    // Avoid `await` before play(): browsers often block audio.play() after an async gap (no user gesture).
    // Apply state from POST /pause body, then retry play on rAF if still paused.
    fetch(`${base}/pause?${qs()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ is_paused: false }),
    })
      .then((r) => {
        if (!r.ok) {
          return r.json().then((body) => {
            throw new Error(body?.error || `Could not start (${r.status})`);
          });
        }
        return r.json();
      })
      .then((payload) => {
        applyPlaybackState(payload);
        const hasTrack = playableLibraryTrackId(payload?.current);
        if (hasTrack && payload?.jukebox && !payload.jukebox.is_paused) {
          requestAnimationFrame(() => {
            if (audioEl.paused) {
              withIgnoreMediaEvents(() => {
                void audioEl.play().catch(() => {});
              });
            }
          });
        } else if (!hasTrack) {
          globalErr.hidden = false;
          const closedAt = payload?.jukebox?.closed_at;
          if (closedAt != null && String(closedAt).trim() !== '') {
            globalErr.textContent =
              'This jukebox session was closed. Queue another track to reopen it, or ask the host to start a new session.';
            return;
          }
          const rows = Array.isArray(payload?.queue) ? payload.queue : [];
          const anyPlayableInSlice = rows.some((item) => playableLibraryTrackId(item));
          if (rows.length && !anyPlayableInSlice) {
            globalErr.textContent =
              'These tracks are not in your library yet. Wait until downloads finish, then press play.';
          } else if (rows.length && anyPlayableInSlice) {
            globalErr.textContent =
              'Playback did not start. Refresh the page or queue the track again.';
          } else {
            globalErr.textContent = 'No playable track in queue yet.';
          }
        }
      })
      .catch((err) => {
        globalErr.hidden = false;
        globalErr.textContent = err?.message || 'Could not start playback';
      });
    return;
  }
  if (guestCastingPlayback()) {
    JbCast.castPlayPauseToggle();
    return;
  }
  if (audioEl.paused) {
    withIgnoreMediaEvents(() => {
      void audioEl.play().catch(() => {});
    });
  } else {
    withIgnoreMediaEvents(() => {
      audioEl.pause();
    });
  }
});

npSkipBtn?.addEventListener('click', () => void guestSkipTrack());

volSlider?.addEventListener('input', () => {
  if (volSlider?.disabled) {
    return;
  }
  const v = Number(volSlider.value) / 100;
  if (guestCastingPlayback()) {
    JbCast.castSetReceiverVolume(v);
  } else if (audioEl) {
    audioEl.volume = v;
  }
  setVolumeButtonIcon(v);
  clearTimeout(volDebounceTimer);
  volDebounceTimer = setTimeout(() => {
    void syncGuestPlaybackToServer({ volume: v });
  }, 200);
});

function toggleMenu() {
  menuPanel?.classList.toggle('open');
  menuBtn?.setAttribute('aria-expanded', menuPanel?.classList.contains('open') ? 'true' : 'false');
}

menuBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});

/** Avoid opening the Cast picker twice from the same mouse gesture (pointerdown then click). */
let __tfCastOpenAt = 0;
function openCastPickerFromGesture(e) {
  e.stopImmediatePropagation();
  e.stopPropagation();
  if (!JbCast.isCastFrameworkReady()) {
    return;
  }
  const now = Date.now();
  if (now - __tfCastOpenAt < 500) {
    return;
  }
  __tfCastOpenAt = now;
  JbCast.requestCastSessionFromUserGesture();
}

/**
 * Top-bar Cast: pointerdown + capture preserves user activation for Cast APIs; click handles keyboard.
 */
castMainBtn?.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) {
      return;
    }
    openCastPickerFromGesture(e);
  },
  true,
);
castMainBtn?.addEventListener('click', (e) => {
  openCastPickerFromGesture(e);
}, true);

document.addEventListener('click', () => {
  closeVolPanel();
  menuPanel?.classList.remove('open');
});

async function verifyGuestPin(pin) {
  const res = await fetch(`${base}/verify-pin?${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) {
    return false;
  }
  const j = await res.json().catch(() => ({}));
  return Boolean(j.valid);
}

/** @param {string} title */
async function askPin(title) {
  try {
    return await requestPin({ title: title || 'Enter PIN', verify: verifyGuestPin });
  } catch {
    return null;
  }
}

async function guestSkipTrack() {
  if (!jukeboxId || !guestToken) {
    return;
  }
  let pin = '';
  try {
    const st = await fetch(`${base}/state?${qs()}&discovery=0`, { credentials: 'same-origin' });
    const d = await st.json();
    if (d?.jukebox?.pin_require_skip) {
      const p = await askPin('Enter PIN to Skip Track');
      if (p == null) {
        return;
      }
      pin = p;
    }
  } catch {
    /* ignore */
  }
  let res = await fetch(`${base}/action?${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ action: 'skip', pin }),
  });
  if (res.status === 401) {
    const p2 = await askPin('Wrong PIN. Try again to skip');
    if (p2 == null) {
      return;
    }
    res = await fetch(`${base}/action?${qs()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'skip', pin: p2 }),
    });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not skip');
    return;
  }
  void refreshPlaybackOnly();
}

document.getElementById('closeJbBtn')?.addEventListener('click', async () => {
  menuPanel?.classList.remove('open');
  let pin = '';
  try {
    const st = await fetch(`${base}/state?${qs()}&discovery=0`, { credentials: 'same-origin' });
    const d = await st.json();
    if (d?.jukebox?.pin_require_close) {
      const p = await askPin('Enter PIN to Exit Jukebox');
      if (p == null) {
        return;
      }
      pin = p;
    }
  } catch {
    /* ignore */
  }
  let res = await fetch(`${base}/action?${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ action: 'close', pin }),
  });
  if (res.status === 401) {
    const p2 = await askPin('Wrong PIN. Try again to exit');
    if (p2 == null) {
      return;
    }
    res = await fetch(`${base}/action?${qs()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'close', pin: p2 }),
    });
  }
  if (res.ok) {
    navigateAfterJukeboxClosed();
    return;
  }
  globalErr.hidden = false;
  globalErr.textContent = 'Could not close jukebox.';
});

const PLACEHOLDER_IMG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect fill="%2327272a" width="128" height="128" rx="16"/><path fill="%2352525b" d="M56 40v48l32-24-32-24z"/></svg>',
  );

function discoveryPayload(t) {
  const hasDeezer = t.deezer_id != null && String(t.deezer_id).trim() !== '';
  if (hasDeezer) {
    return {
      id: String(t.deezer_id).trim(),
      title: t.title,
      artist: typeof t.artist === 'string' ? t.artist : t.artist?.name || '',
      album: (typeof t.album === 'string' ? t.album : t.album?.title) || '',
      duration: t.duration ?? null,
      isInUserLibrary: true,
    };
  }
  const lid = t.library_track_id;
  if (lid != null && String(lid).trim() !== '' && Number(lid) > 0) {
    return {
      library_track_id: Number(lid),
      title: t.title,
      artist: typeof t.artist === 'string' ? t.artist : t.artist?.name || '',
      album: (typeof t.album === 'string' ? t.album : t.album?.title) || '',
      duration: t.duration ?? null,
      isInUserLibrary: true,
    };
  }
  const id = t.id != null ? String(t.id).trim() : '';
  return {
    id,
    title: t.title,
    artist: typeof t.artist === 'string' ? t.artist : t.artist?.name || '',
    album: (typeof t.album === 'string' ? t.album : t.album?.title) || '',
    duration: t.duration ?? null,
    isInUserLibrary: true,
  };
}

function syncDiscoveryStrip(container, rows, stripKey) {
  if (!container) {
    return;
  }
  const list = rows || [];
  const sig = list.map((r) => r.library_track_id).join(',');
  if (discoveryStripSigs[stripKey] === sig) {
    return;
  }
  discoveryStripSigs[stripKey] = sig;
  container.replaceChildren();
  for (const t of list) {
    renderDiscoveryCard(container, t);
  }
}

function updateDiscoveryEmptyHint() {
  const hint = document.getElementById('jbDiscoveryEmpty');
  if (!hint) {
    return;
  }
  const n =
    (topTracksList?.childElementCount ?? 0) +
    (freshTracksList?.childElementCount ?? 0) +
    (recentMixList?.childElementCount ?? 0);
  hint.hidden = n > 0;
}

function applyDiscoverySections(data) {
  if (data.top_tracks == null && data.fresh_tracks == null && data.recent_mix == null) {
    updateDiscoveryEmptyHint();
    return;
  }
  syncDiscoveryStrip(topTracksList, data.top_tracks, 'topTracks');
  syncDiscoveryStrip(freshTracksList, data.fresh_tracks, 'freshTracks');
  syncDiscoveryStrip(recentMixList, data.recent_mix, 'recentMix');
  updateDiscoveryEmptyHint();
}

async function fetchGuestState(includeDiscovery) {
  const q = includeDiscovery ? qs() : `${qs()}&discovery=0`;
  const url = `${base}/state?${q}`;
  const res = await fetch(url, { credentials: 'same-origin' });
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, data: { error: 'Invalid response from server' } };
  }
  /* Only reject when the server omitted discovery keys entirely (not when arrays are empty). */
  if (
    res.ok &&
    includeDiscovery &&
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    data.jukebox &&
    !('top_tracks' in data) &&
    !('fresh_tracks' in data) &&
    !('recent_mix' in data)
  ) {
    return {
      ok: false,
      data: { ...(data || {}), error: 'Discover data missing from response' },
    };
  }
  return { ok: res.ok, data };
}

function updateNowPlayingArt(t) {
  if (!npCover) {
    return;
  }
  const cover = t?.album_cover || null;
  const key = t ? `${t.id}|${cover || ''}` : '__idle__';
  if (key === lastNpArtKey) {
    return;
  }
  lastNpArtKey = key;
  npCover.alt = t ? t.title || 'Cover' : '';
  if (cover && npCoverBg) {
    npCoverBg.classList.remove('is-empty');
    npCoverBg.style.backgroundImage = `url(${JSON.stringify(cover)})`;
    npCover.src = cover;
  } else {
    npCoverBg?.classList.add('is-empty');
    if (npCoverBg) {
      npCoverBg.style.backgroundImage = '';
    }
    npCover.src = PLACEHOLDER_IMG;
  }
}

function updateNowPlayingMeta(t) {
  const title = t ? t.title || 'Track' : 'Nothing playing';
  const artist = t ? t.artist || '' : 'Add from below';
  if (npTitle && npTitle.textContent !== title) {
    npTitle.textContent = title;
  }
  if (npArtist && npArtist.textContent !== artist) {
    npArtist.textContent = artist;
  }
}

function applyQueueFromState(qList) {
  const sig = JSON.stringify(
    (qList || []).map((q) => [
      q.id,
      q.album_cover || '',
      q.title,
      q.artist,
      q.library_ready ? 1 : 0,
      q.stream_ready ? 1 : 0,
      q.requestDisplayStatus || '',
    ]),
  );
  if (sig === lastQueueDisplaySig) {
    return;
  }
  lastQueueDisplaySig = sig;
  queuePreview.replaceChildren();
  (qList || []).forEach((q, i) => renderQueueRow(queuePreview, q, i));
}

function applyHistoryFromState(hList) {
  if (!historyPreview) {
    return;
  }
  const sig = JSON.stringify((hList || []).map((h) => [h.library_track_id, h.album_cover || '', h.title, h.artist]));
  if (sig === lastHistoryDisplaySig) {
    return;
  }
  lastHistoryDisplaySig = sig;
  historyPreview.replaceChildren();
  (hList || []).forEach((h) => renderHistoryRow(historyPreview, h));
}

function guestCastingPlayback() {
  return JbCast.isCastFrameworkReady() && JbCast.isCasting();
}

function updateJukeboxCastChrome() {
  if (npCastLine) {
    if (guestCastingPlayback()) {
      const name = JbCast.getCastReceiverLabel() || 'Chromecast';
      npCastLine.textContent = `Casting to ${name}`;
      npCastLine.hidden = false;
    } else {
      npCastLine.hidden = true;
    }
  }
  if (!castMainBtn) {
    return;
  }
  if (!JbCast.shouldOfferCastUi() || !JbCast.isCastFrameworkReady()) {
    castMainBtn.hidden = true;
    return;
  }
  castMainBtn.hidden = false;
  const connected = JbCast.isCasting();
  castMainBtn.classList.toggle('is-connected', connected);
  const dev = JbCast.getCastReceiverLabel();
  castMainBtn.setAttribute('aria-pressed', connected ? 'true' : 'false');
  castMainBtn.setAttribute(
    'aria-label',
    connected ? `Chromecast connected${dev ? ` to ${dev}` : ''}. Press to change or stop.` : 'Chromecast — pick a device',
  );
  castMainBtn.title = connected ? (dev ? `Casting to ${dev}` : 'Chromecast') : 'Chromecast';
}

function updateVolumeSliderState() {
  if (!volSlider) {
    return;
  }
  const ios = JbCast.isIOSDevice();
  const castUi = JbCast.shouldOfferCastUi() && JbCast.isCastFrameworkReady();
  const noCastSession = !guestCastingPlayback();
  volSlider.disabled = ios || (castUi && noCastSession);
}

function applyCastProgress(cur, dur) {
  if (!guestCastingPlayback() || !Number.isFinite(dur) || dur <= 0) {
    return;
  }
  if (Number.isFinite(cur)) {
    lastCastReportCur = cur;
  }
  lastCastReportDur = dur;
  const pct = Math.round((cur / dur) * 1000);
  const clamped = Math.min(1000, Math.max(0, pct));
  if (npProgressFill) {
    npProgressFill.style.width = `${clamped / 10}%`;
  }
  if (npProgressRail) {
    npProgressRail.setAttribute('aria-valuenow', String(clamped));
  }
  if (npTimeCur) {
    npTimeCur.textContent = formatTime(cur);
  }
  if (npTimeDur) {
    npTimeDur.textContent = formatTime(dur);
  }
  scheduleReportPlaybackFromCast();
}

function playableLibraryTrackId(cur) {
  if (!cur || typeof cur !== 'object') {
    return false;
  }
  if (cur.stream_ready === false) {
    return false;
  }
  if (cur.stream_ready === true) {
    return true;
  }
  const lid = cur.library_track_id;
  return lid != null && String(lid).trim() !== '' && Number(lid) > 0;
}

function applyPlaybackState(data) {
  globalErr.hidden = true;
  guestHasPlayableCurrent = playableLibraryTrackId(data?.current);
  const useCast = guestCastingPlayback();

  if (playableLibraryTrackId(data?.current)) {
    const t = data.current;
    if (lastCurrentQueueRowId !== t.id) {
      lastCurrentQueueRowId = t.id;
      updateNowPlayingMeta(t);
    }
    updateNowPlayingArt(t);

    const relStream = `/api/jukeboxes/stream/${t.library_track_id}?jukebox_id=${encodeURIComponent(jukeboxId)}&token=${encodeURIComponent(guestToken)}&mode=guest`;
    const absStream = new URL(relStream, window.location.origin).href;
    let trackJustChanged = false;
    const serverPaused = Boolean(data.jukebox?.is_paused);
    const serverBecamePlaying = lastServerPaused === true && !serverPaused;
    const firstPlaybackState = lastServerPaused === null;
    lastServerPaused = serverPaused;
    const vol = data.jukebox?.volume ?? 1;
    if (volSlider) {
      const vStr = String(Math.round(vol * 100));
      if (volSlider.value !== vStr) {
        volSlider.value = vStr;
      }
    }
    setVolumeButtonIcon(vol);

    if (useCast) {
      withIgnoreMediaEvents(() => {
        if (audioEl) {
          audioEl.pause();
          audioEl.removeAttribute('src');
        }
      });
      JbCast.castSetReceiverVolume(vol);
      if (lastQueueItemId !== data.current.id) {
        lastQueueItemId = data.current.id;
      }
      currentPlayingQueueItemId = data.current.id;
      const needMediaLoad = lastCastLoadedQueueItemId !== t.id;
      const seekSnap = data;
      const seq = ++castLoadSeq;
      void (async () => {
        if (seq !== castLoadSeq) {
          return;
        }
        if (!guestCastingPlayback()) {
          return;
        }
        if (needMediaLoad) {
          const ok = await JbCast.loadStreamOnCast({
            streamUrl: absStream,
            title: t.title || 'Track',
            artist: typeof t.artist === 'string' ? t.artist : '',
            autoplay: !serverPaused,
          });
          if (seq !== castLoadSeq || !guestCastingPlayback()) {
            return;
          }
          if (ok) {
            lastCastLoadedQueueItemId = t.id;
          }
        } else {
          JbCast.castSetPaused(serverPaused);
        }
        applyHostSeekFromJukeboxState(seekSnap);
        setPlayIcon(serverPaused);
      })();
    } else {
      lastCastLoadedQueueItemId = null;
      if (audioEl) {
        withIgnoreMediaEvents(() => {
          if (lastQueueItemId !== data.current.id) {
            trackJustChanged = true;
            lastQueueItemId = data.current.id;
            audioEl.src = relStream;
          }
          if (serverPaused) {
            audioEl.pause();
          } else if (serverBecamePlaying || firstPlaybackState || !audioEl.paused || trackJustChanged) {
            void audioEl.play().catch(() => {});
          }
        });
        audioEl.volume = vol;
        currentPlayingQueueItemId = data.current.id;
        setPlayIcon(audioEl.paused);
      } else {
        currentPlayingQueueItemId = data.current.id;
        setPlayIcon(true);
      }
      applyHostSeekFromJukeboxState(data);
    }
  } else {
    lastQueueItemId = null;
    currentPlayingQueueItemId = null;
    lastServerPaused = null;
    lastCastLoadedQueueItemId = null;
    const wasPlaying = lastCurrentQueueRowId !== null;
    lastCurrentQueueRowId = null;
    if (wasPlaying) {
      lastNpArtKey = '';
    }
    updateNowPlayingMeta(null);
    updateNowPlayingArt(null);
    if (useCast) {
      JbCast.castStopMediaIfAny();
    }
    withIgnoreMediaEvents(() => {
      if (audioEl) {
        audioEl.pause();
        audioEl.removeAttribute('src');
      }
    });
    setPlayIcon(true);
    if (npProgressFill) {
      npProgressFill.style.width = '0%';
    }
    if (npProgressRail) {
      npProgressRail.setAttribute('aria-valuenow', '0');
    }
    const jbVol = data?.jukebox?.volume;
    if (volSlider && jbVol != null && Number.isFinite(Number(jbVol))) {
      const nv = Math.min(1, Math.max(0, Number(jbVol)));
      volSlider.value = String(Math.round(nv * 100));
      if (audioEl) {
        audioEl.volume = nv;
      }
      setVolumeButtonIcon(nv);
    } else {
      setVolumeButtonIcon(audioEl ? audioEl.volume : 1);
    }
  }

  applyQueueFromState(data.queue);
  applyHistoryFromState(data.play_history);
  updateVolumeSliderState();
  updateJukeboxCastChrome();
  if (playableLibraryTrackId(data?.current) && guestCastingPlayback()) {
    applyHostSeekFromJukeboxState(data);
  }
}

function attachGuestTrackEndedHandler() {
  if (!audioEl) {
    return;
  }
  audioEl.onended = async () => {
    const qid = currentPlayingQueueItemId;
    if (qid) {
      await fetch(`${base}/advance?${qs()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ queue_item_id: Number(qid) }),
      });
      void refreshPlaybackOnly();
    }
  };
}

async function refreshPlaybackOnly() {
  if (!jukeboxId || !guestToken) {
    return;
  }
  const { ok, data } = await fetchGuestState(false);
  if (!ok) {
    globalErr.hidden = false;
    globalErr.textContent = data.error || 'Could not load';
    return;
  }
  applyPlaybackState(data);
}

async function maybeSilentlyRefreshDiscovery() {
  if (!jukeboxId || !guestToken) {
    return;
  }
  if (searchSheet?.classList.contains('open')) {
    return;
  }
  if (Date.now() < discoveryInteractUntil) {
    return;
  }
  const { ok, data } = await fetchGuestState(true);
  if (!ok) {
    return;
  }
  applyDiscoverySections(data);
}

async function bootstrapGuestUi() {
  let installBackGuard = false;
  try {
    if (!jukeboxId || !guestToken) {
      return;
    }
    const { ok, data } = await fetchGuestState(true);
    if (!ok) {
      globalErr.hidden = false;
      globalErr.textContent = data.error || 'Could not load';
      return;
    }
    /* Discovery before playback: applyPlaybackState can throw if <audio> is missing; strips must still render. */
    applyDiscoverySections(data);
    try {
      applyPlaybackState(data);
    } catch (e) {
      console.warn('[jukebox guest] applyPlaybackState', e);
    }
    attachGuestTrackEndedHandler();
    installBackGuard = true;
  } finally {
    hideJukeboxPageLoading();
  }
  /* Defer history/touch guard so the first paint + discovery DOM settle before WebKit history work. */
  if (installBackGuard) {
    window.setTimeout(() => installJukeboxGuestBackGuard(), 0);
  }
}

function openCardActionSheet(t) {
  const pl = discoveryPayload(t);
  if (!pl.id) {
    alert('This track cannot be added from here.');
    return;
  }
  markDiscoveryInteract();
  pendingCardPayload = { payload: pl };
  if (cardActionTitle) {
    cardActionTitle.textContent = t.title || 'Track';
  }
  cardActionSheet?.removeAttribute('hidden');
}

function closeCardActionSheet() {
  pendingCardPayload = null;
  cardActionSheet?.setAttribute('hidden', '');
}

cardActionCancel?.addEventListener('click', () => closeCardActionSheet());
cardActionBackdrop?.addEventListener('click', () => closeCardActionSheet());
cardActionQueue?.addEventListener('click', async () => {
  if (!pendingCardPayload) {
    return;
  }
  const ok = await addTrack(pendingCardPayload.payload, false);
  if (ok) {
    closeCardActionSheet();
  }
});
cardActionNext?.addEventListener('click', async () => {
  if (!pendingCardPayload) {
    return;
  }
  const ok = await addTrack(pendingCardPayload.payload, true);
  if (ok) {
    closeCardActionSheet();
  }
});

function renderDiscoveryCard(container, t) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'jb-card';
  btn.setAttribute('role', 'listitem');
  const img = document.createElement('img');
  img.className = 'jb-card-img';
  img.alt = '';
  img.src = t.album_cover || PLACEHOLDER_IMG;
  img.loading = 'lazy';
  const title = document.createElement('div');
  title.className = 'jb-card-title';
  title.textContent = t.title || 'Track';
  const art = document.createElement('div');
  art.className = 'jb-card-artist';
  art.textContent = t.artist || '';
  btn.append(img, title, art);
  btn.addEventListener('click', () => openCardActionSheet(t));
  container.appendChild(btn);
}

function openHistoryActionSheet(h) {
  const pl = discoveryPayload({
    deezer_id: h.deezer_id,
    library_track_id: h.library_track_id,
    title: h.title,
    artist: h.artist,
    album: h.album,
  });
  if (!pl.id && !pl.library_track_id) {
    alert('This track cannot be re-queued from here.');
    return;
  }
  markDiscoveryInteract();
  pendingCardPayload = { payload: pl };
  if (cardActionTitle) {
    cardActionTitle.textContent = h.title || 'Track';
  }
  cardActionSheet?.removeAttribute('hidden');
}

function renderHistoryRow(container, h) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'jb-queue-row jb-history-row';
  row.setAttribute('aria-label', `Recently played: ${h.title || 'Track'}. Tap to add to queue.`);
  const img = document.createElement('img');
  img.className = 'jb-queue-art';
  img.alt = '';
  img.src = h.album_cover || PLACEHOLDER_IMG;
  img.loading = 'lazy';
  const text = document.createElement('div');
  text.className = 'jb-queue-text';
  const tt = document.createElement('div');
  tt.className = 'jb-queue-title';
  tt.textContent = h.title || 'Track';
  const ar = document.createElement('div');
  ar.className = 'jb-queue-artist';
  ar.textContent = h.artist || '';
  text.append(tt, ar);
  row.append(img, text);
  row.addEventListener('click', () => openHistoryActionSheet(h));
  container.appendChild(row);
}

function queueRowRequestStatusIconHtml(userFacingStatus) {
  const Card = window.TrackFlowTrackCard;
  if (!Card || userFacingStatus == null || userFacingStatus === '') {
    return '';
  }
  if (userFacingStatus === 'Available') {
    return '';
  }
  return Card.statusIconHtmlForList(userFacingStatus);
}

function renderQueueRow(container, q, index) {
  const row = document.createElement('div');
  row.className = 'jb-queue-row';
  if (index === 0) {
    row.classList.add('jb-queue-row--next');
  }
  if (index >= 3) {
    row.classList.add('jb-queue-row--compact');
  }
  const img = document.createElement('img');
  img.className = 'jb-queue-art';
  img.alt = '';
  img.src = q.album_cover || PLACEHOLDER_IMG;
  img.loading = 'lazy';
  const text = document.createElement('div');
  text.className = 'jb-queue-text';
  const tt = document.createElement('div');
  tt.className = 'jb-queue-title';
  tt.textContent = q.title || 'Track';
  const ar = document.createElement('div');
  ar.className = 'jb-queue-artist';
  ar.textContent = q.artist || '';
  text.append(tt, ar);
  const statusHtml = queueRowRequestStatusIconHtml(q.requestDisplayStatus);
  if (statusHtml) {
    const statusSlot = document.createElement('div');
    statusSlot.className = 'jb-queue-status';
    statusSlot.innerHTML = statusHtml;
    statusSlot.setAttribute('role', 'img');
    statusSlot.setAttribute('aria-label', q.requestDisplayStatus);
    row.append(img, text, statusSlot);
  } else {
    row.append(img, text);
  }
  container.appendChild(row);
}

async function addTrack(t, playNext) {
  const libId = t.library_track_id;
  const useLib = libId != null && String(libId).trim() !== '' && Number(libId) > 0;
  const did = t.id != null ? String(t.id).trim() : '';
  if (!useLib && !did) {
    alert('Missing track id');
    return false;
  }
  const payload = useLib
    ? {
        library_track_id: Number(libId),
        title: t.title,
        artist: typeof t.artist === 'string' ? t.artist : t.artist?.name || '',
        album: typeof t.album === 'string' ? t.album : t.album?.title || '',
        duration_seconds: t.duration,
      }
    : {
        deezer_id: did,
        title: t.title,
        artist: typeof t.artist === 'string' ? t.artist : t.artist?.name || '',
        album: typeof t.album === 'string' ? t.album : t.album?.title || '',
        duration_seconds: t.duration,
      };
  if (playNext) {
    let pin = '';
    try {
      const st = await fetch(`${base}/state?${qs()}&discovery=0`, { credentials: 'same-origin' });
      const d = await st.json();
      if (d?.jukebox?.pin_require_play_next) {
        const p = await askPin('Enter PIN to Play Next');
        if (p == null) {
          return false;
        }
        pin = p;
      }
    } catch {
      /* ignore */
    }
    let res = await fetch(`${base}/play-next?${qs()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ ...payload, pin }),
    });
    if (res.status === 401) {
      const p2 = await askPin('Wrong PIN. Try again');
      if (p2 == null) {
        return false;
      }
      res = await fetch(`${base}/play-next?${qs()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ...payload, pin: p2 }),
      });
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Could not add track');
      return false;
    }
    void refreshPlaybackOnly();
    return true;
  }
  const res = await fetch(`${base}/queue?${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not add track');
    return false;
  }
  void refreshPlaybackOnly();
  return true;
}

function deezerTrackPayload(t) {
  return {
    id: t.id,
    title: t.title,
    artist: typeof t.artist === 'string' ? t.artist : t.artist?.name || '',
    album: typeof t.album === 'string' ? t.album : t.album?.title || '',
    duration: t.duration,
  };
}

/** @type {ReturnType<typeof setTimeout> | null} */
let jbToastHideTimer = null;

function toastShortTitle(title) {
  const s = String(title || 'Track').trim() || 'Track';
  return s.length > 44 ? `${s.slice(0, 42)}…` : s;
}

function showQueueAddToast(message) {
  if (!jbToast) {
    return;
  }
  jbToast.textContent = message;
  jbToast.hidden = false;
  if (jbToastHideTimer != null) {
    clearTimeout(jbToastHideTimer);
  }
  jbToastHideTimer = setTimeout(() => {
    jbToast.hidden = true;
    jbToastHideTimer = null;
  }, 3200);
}

function renderSearchTrackRow(t, container) {
  const row = document.createElement('div');
  row.className = 'jb-result-row';
  const img = document.createElement('img');
  img.src = t.albumCover || PLACEHOLDER_IMG;
  img.alt = '';
  const meta = document.createElement('div');
  meta.className = 'jb-result-meta';
  const tt = document.createElement('div');
  tt.className = 't';
  tt.textContent = t.title || 'Track';
  const ar = document.createElement('div');
  ar.className = 'a';
  ar.textContent = t.artist || '';
  meta.append(tt, ar);
  const actions = document.createElement('div');
  actions.className = 'jb-result-actions';
  const blocked = jukeboxSearchTrackBlockedFromQueue(t);
  const statusHtml = jukeboxSearchRowStatusIconHtml(t);
  const bq = document.createElement('button');
  bq.type = 'button';
  bq.className = 'primary';
  bq.textContent = 'Add to Queue';
  const bn = document.createElement('button');
  bn.type = 'button';
  bn.textContent = 'Play Next';
  if (blocked) {
    const slot = document.createElement('div');
    slot.className = 'jb-result-blocked--icon-only';
    if (statusHtml) {
      slot.innerHTML = statusHtml;
    }
    const ariaLabel =
      t.requestDisplayStatus === 'Denied'
        ? 'Request denied'
        : t.requestDisplayStatus === 'Needs Attention'
          ? 'Request needs attention'
          : t.requestProcessingStatus === 'Failed'
            ? 'Download failed'
            : t.requestDisplayStatus || 'Cannot queue';
    slot.setAttribute('role', 'img');
    slot.setAttribute('aria-label', ariaLabel);
    actions.appendChild(slot);
  }
  const runAdd = async (playNext) => {
    if (bq.disabled || jukeboxSearchTrackBlockedFromQueue(t)) {
      return;
    }
    if (!confirmJukeboxSearchAddTrack(t.title, t.artist, playNext)) {
      return;
    }
    bq.disabled = true;
    bn.disabled = true;
    try {
      const ok = await addTrack(deezerTrackPayload(t), playNext);
      if (ok) {
        const name = toastShortTitle(t.title);
        showQueueAddToast(
          playNext ? `“${name}” will play next.` : `“${name}” was added to the queue.`,
        );
      }
    } finally {
      bq.disabled = false;
      bn.disabled = false;
    }
  };
  if (!blocked) {
    bq.addEventListener('click', () => void runAdd(false));
    bn.addEventListener('click', () => void runAdd(true));
    actions.append(bq, bn);
  }
  if (statusHtml && !blocked) {
    const statusSlot = document.createElement('div');
    statusSlot.className = 'jb-result-status';
    statusSlot.innerHTML = statusHtml;
    statusSlot.setAttribute('role', 'img');
    statusSlot.setAttribute('aria-label', t.requestDisplayStatus || '');
    row.append(img, meta, statusSlot, actions);
  } else {
    row.append(img, meta, actions);
  }
  container.appendChild(row);
}

/** @type {{ type: string, albumId?: string, artistId?: string, title?: string }[]} */
let sheetStack = [];

function openSearchSheet() {
  markDiscoveryInteract();
  jbShell?.classList.add('jb-search-open');
  searchSheet.classList.add('open');
  searchSheet.setAttribute('aria-hidden', 'false');
}

function closeSearchSheet() {
  jbShell?.classList.remove('jb-search-open');
  searchSheet.classList.remove('open');
  searchSheet.setAttribute('aria-hidden', 'true');
  sheetStack = [];
  sheetBody.replaceChildren();
  sheetBackBtn.hidden = true;
  sheetTitle.textContent = 'Search';
  searchQ.value = '';
  searchQ.blur();
}

function updateSheetChrome() {
  const depth = sheetStack.length;
  sheetBackBtn.hidden = depth === 0;
  if (depth === 0) {
    sheetTitle.textContent = 'Search';
  }
}

sheetCloseBtn?.addEventListener('click', () => {
  closeSearchSheet();
});

sheetBackBtn?.addEventListener('click', () => {
  sheetStack.pop();
  if (sheetStack.length === 0) {
    void runSearch(searchQ.value.trim());
  } else {
    const top = sheetStack[sheetStack.length - 1];
    if (top.type === 'album') {
      void openAlbumInSheet(top.albumId, top.title);
    } else if (top.type === 'artist') {
      void openArtistInSheet(top.artistId, top.title);
    }
  }
});

async function openAlbumInSheet(albumId, title) {
  sheetTitle.textContent = title || 'Album';
  sheetBody.replaceChildren();
  const res = await fetch(`${base}/browse/album/${encodeURIComponent(albumId)}/tracks?${qs()}`, {
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    sheetBody.textContent = data.error || 'Could not load album.';
    return;
  }
  for (const t of data.tracks || []) {
    renderSearchTrackRow(t, sheetBody);
  }
  updateSheetChrome();
}

async function openArtistInSheet(artistId, name) {
  sheetTitle.textContent = name || 'Artist';
  sheetBody.replaceChildren();
  const res = await fetch(`${base}/browse/artist/${encodeURIComponent(artistId)}/tracks?${qs()}`, {
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    sheetBody.textContent = data.error || 'Could not load artist.';
    return;
  }
  for (const t of data.tracks || []) {
    renderSearchTrackRow(t, sheetBody);
  }
  updateSheetChrome();
}

async function runSearch(q) {
  sheetBody.replaceChildren();
  sheetStack = [];
  updateSheetChrome();
  if (q.length < 2) {
    sheetBody.textContent = 'Keep typing…';
    return;
  }
  const res = await fetch(`${base}/search?${qs()}&q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    sheetBody.textContent = data.error || 'Search failed.';
    return;
  }
  const tracks = (data.tracks || []).slice(0, 28);
  if (!tracks.length) {
    sheetBody.textContent = 'No tracks found.';
    return;
  }
  for (const t of tracks) {
    renderSearchTrackRow(t, sheetBody);
  }
}

let searchTimer;
searchQ?.addEventListener('focus', () => {
  openSearchSheet();
  if (searchQ.value.trim().length < 2) {
    sheetBody.replaceChildren();
  }
});
searchQ?.addEventListener('input', () => {
  openSearchSheet();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void runSearch(searchQ.value.trim());
  }, 320);
});

for (const el of [queuePreview, historyPreview, topTracksList, freshTracksList, recentMixList]) {
  el?.addEventListener('scroll', markDiscoveryInteract, { passive: true });
}

JbCast.setJukeboxCastCallbacks({
  onSessionUiUpdate: () => {
    updateJukeboxCastChrome();
    void refreshPlaybackOnly();
  },
  onCastProgress: (cur, dur) => {
    applyCastProgress(cur, dur);
  },
  onCastPausedSync: (paused) => {
    setPlayIcon(paused);
    void syncGuestPauseToServer(paused);
  },
  onCastTrackFinished: async () => {
    const qid = currentPlayingQueueItemId;
    if (qid) {
      await fetch(`${base}/advance?${qs()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ queue_item_id: Number(qid) }),
      });
      void refreshPlaybackOnly();
    }
  },
  onCastFallbackLocal: () => {
    lastCastLoadedQueueItemId = null;
    castLoadSeq += 1;
    void refreshPlaybackOnly();
  },
});

if (JbCast.shouldOfferCastUi()) {
  void JbCast.loadCastSenderScript().then(() => {
    updateJukeboxCastChrome();
    updateVolumeSliderState();
  });
} else {
  updateJukeboxCastChrome();
  updateVolumeSliderState();
}

setInterval(() => void refreshPlaybackOnly(), 2800);
setInterval(() => void maybeSilentlyRefreshDiscovery(), 120000);
void bootstrapGuestUi();
