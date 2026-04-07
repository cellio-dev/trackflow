import { ensureLoggedIn, redirectUnlessJukeboxEnabled } from '../js/auth-guard.js';
import '../js/track-card-shared.js';
import {
  confirmJukeboxSearchAddTrack,
  jukeboxSearchRowStatusIconHtml,
  jukeboxSearchTrackBlockedFromQueue,
} from '../js/jukebox-search-queue-shared.js';

const RETURN_AFTER_JUKEBOX_KEY = 'tf-jukebox-return-href';

const params = new URLSearchParams(window.location.search);

const PLACEHOLDER_IMG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="%2327272a" width="64" height="64" rx="8"/></svg>',
  );

const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';

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

function leaveControlPanel() {
  const href = returnAfterJukeboxHref();
  try {
    sessionStorage.removeItem(RETURN_AFTER_JUKEBOX_KEY);
  } catch {
    /* ignore */
  }
  window.location.href = href;
}

const jukeboxId = params.get('id');

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await redirectUnlessJukeboxEnabled(__tfMe);

let hostToken = '';
if (!jukeboxId) {
  document.body.prepend(
    Object.assign(document.createElement('p'), {
      textContent: 'Missing jukebox id.',
      style: 'color:#f87171',
    }),
  );
} else {
  const jbRes = await fetch(`/api/jukeboxes/${encodeURIComponent(jukeboxId)}`, { credentials: 'same-origin' });
  const jb = await jbRes.json().catch(() => ({}));
  if (!jbRes.ok) {
    window.location.replace('/jukebox.html');
    await new Promise(() => {});
  }
  hostToken = String(jb.host_token || '').trim();
  if (!hostToken) {
    document.body.prepend(
      Object.assign(document.createElement('p'), {
        textContent: 'Could not load host credentials for this jukebox.',
        style: 'color:#f87171',
      }),
    );
    await new Promise(() => {});
  }
}

const base = `/api/jukeboxes/host/${encodeURIComponent(jukeboxId || '')}`;

function qs() {
  return `token=${encodeURIComponent(hostToken)}`;
}

const hostTitle = document.getElementById('hostTitle');
const queueHost = document.getElementById('queueHost');
const jhShell = document.getElementById('jhShell');
const npPlayBtn = document.getElementById('npPlayBtn');
const npPlayIcon = document.getElementById('npPlayIcon');
const btnSkip = document.getElementById('npSkipBtn');
const volRange = document.getElementById('volRange');
const jhNpProgressWrap = document.getElementById('jhNpProgressWrap');
const jhNpProgress = document.getElementById('jhNpProgress');
const jhNpTimeCur = document.getElementById('jhNpTimeCur');
const jhNpTimeDur = document.getElementById('jhNpTimeDur');
const btnClose = document.getElementById('btnClose');
const btnClearQueue = document.getElementById('btnClearQueue');
const hostSearchQ = document.getElementById('hostSearchQ');
const searchSheet = document.getElementById('searchSheet');
const sheetBody = document.getElementById('sheetBody');
const sheetCloseBtn = document.getElementById('sheetCloseBtn');
const jbToast = document.getElementById('jbToast');

let lastPaused = false;
/** Last host /state payload used for queue drag-and-drop commit. */
let lastHostQueueState = null;
/** Source row index while dragging (display order in `lastHostQueueState.queue`). */
let hostQueueDragFromIndex = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let volDebounceTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let searchTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let jbToastHideTimer = null;
let hostScrubbing = false;
/** @type {ReturnType<typeof setInterval> | null} */
let hostProgressExtrapTimer = null;
/** @type {{ pos: number, dur: number, reportedAtMs: number } | null} */
let hostProgressExtrapBase = null;

function setPlayIcon(paused) {
  if (!npPlayIcon) {
    return;
  }
  npPlayIcon.innerHTML = `<path d="${paused ? PLAY_PATH : PAUSE_PATH}"/>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatHostTime(sec) {
  const s = Math.floor(Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/** Parse SQLite `datetime('now')` / ISO strings to epoch ms (UTC). */
function parsePlaybackReportedAtMs(raw) {
  if (raw == null || raw === '') {
    return null;
  }
  const s = String(raw).trim();
  if (!s) {
    return null;
  }
  let t = Date.parse(s);
  if (Number.isFinite(t)) {
    return t;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) {
    t = Date.parse(`${m[1]}T${m[2]}Z`);
  }
  return Number.isFinite(t) ? t : null;
}

function stopHostProgressExtrapolation() {
  if (hostProgressExtrapTimer != null) {
    clearInterval(hostProgressExtrapTimer);
    hostProgressExtrapTimer = null;
  }
  hostProgressExtrapBase = null;
}

function tickHostProgressExtrapolation() {
  if (hostScrubbing || lastPaused || !jhNpProgress || jhNpProgress.disabled) {
    return;
  }
  const b = hostProgressExtrapBase;
  if (!b || !Number.isFinite(b.dur) || b.dur <= 0 || b.reportedAtMs == null) {
    return;
  }
  const elapsedSec = (Date.now() - b.reportedAtMs) / 1000;
  if (elapsedSec < -0.5 || elapsedSec > 120) {
    return;
  }
  const cur = Math.min(b.dur, Math.max(0, b.pos + elapsedSec));
  const maxMs = Math.round(b.dur * 1000);
  if (jhNpProgress.max !== String(maxMs)) {
    jhNpProgress.max = String(maxMs);
  }
  jhNpProgress.value = String(Math.min(maxMs, Math.max(0, Math.round(cur * 1000))));
  if (jhNpTimeCur) {
    jhNpTimeCur.textContent = formatHostTime(cur);
  }
}

function syncHostProgressExtrapolation(data) {
  stopHostProgressExtrapolation();
  const jb = data?.jukebox;
  const cur = data?.current;
  if (!jb || !cur?.id || jb.is_paused) {
    return;
  }
  const dur = jb.playback_duration_seconds;
  const pos = jb.playback_position_seconds;
  const at = parsePlaybackReportedAtMs(jb.playback_reported_at);
  if (dur == null || !Number.isFinite(Number(dur)) || Number(dur) <= 0) {
    return;
  }
  if (pos == null || !Number.isFinite(Number(pos)) || at == null) {
    return;
  }
  hostProgressExtrapBase = {
    pos: Number(pos),
    dur: Number(dur),
    reportedAtMs: at,
  };
  hostProgressExtrapTimer = setInterval(tickHostProgressExtrapolation, 200);
  tickHostProgressExtrapolation();
}

function updateHostProgressFromState(data) {
  if (!jhNpProgressWrap || !jhNpProgress) {
    return;
  }
  const cur = data?.current;
  const pos = data?.jukebox?.playback_position_seconds;
  const dur = data?.jukebox?.playback_duration_seconds;
  if (!cur?.id) {
    stopHostProgressExtrapolation();
    jhNpProgressWrap.hidden = true;
    return;
  }
  jhNpProgressWrap.hidden = false;
  if (dur != null && Number.isFinite(Number(dur)) && Number(dur) > 0) {
    const durN = Number(dur);
    jhNpProgress.disabled = false;
    const maxMs = Math.max(1, Math.round(durN * 1000));
    jhNpProgress.max = String(maxMs);
    if (!hostScrubbing) {
      const p = pos != null && Number.isFinite(Number(pos)) ? Number(pos) : 0;
      const v = Math.min(maxMs, Math.max(0, Math.round(p * 1000)));
      jhNpProgress.value = String(v);
    }
    if (jhNpTimeDur) {
      jhNpTimeDur.textContent = formatHostTime(durN);
    }
  } else {
    stopHostProgressExtrapolation();
    jhNpProgress.disabled = true;
    jhNpProgress.max = '1000';
    if (!hostScrubbing) {
      jhNpProgress.value = '0';
    }
    if (jhNpTimeDur) {
      jhNpTimeDur.textContent = '—';
    }
  }
  if (jhNpTimeCur) {
    jhNpTimeCur.textContent = formatHostTime((Number(jhNpProgress.value) || 0) / 1000);
  }
  syncHostProgressExtrapolation(data);
}

function queueRowRequestStatusIconHtml(userFacingStatus) {
  const Card = window.TrackFlowTrackCard;
  if (!Card || userFacingStatus == null || userFacingStatus === '') {
    return '';
  }
  return Card.statusIconHtmlForList(userFacingStatus);
}

function sameQueueId(a, b) {
  return Number(a) === Number(b);
}

function firstUpcomingId(state) {
  const curId = state?.current?.id;
  const list = state?.queue || [];
  const up = curId != null ? list.filter((x) => !sameQueueId(x.id, curId)) : list;
  return up[0]?.id ?? null;
}

/**
 * @param {string[]|number[]} ids
 * @param {number} fromIndex
 * @param {number} insertBeforeIndex — index in the original `ids` before which to place the moved item
 * @param {string|number|null} currentQueueItemId — when set, row 0 must stay the current track
 */
function reorderQueueItemIds(ids, fromIndex, insertBeforeIndex, currentQueueItemId) {
  const next = ids.map((x) => x);
  const [el] = next.splice(fromIndex, 1);
  let to = insertBeforeIndex;
  if (fromIndex < insertBeforeIndex) {
    to -= 1;
  }
  if (currentQueueItemId != null && to < 1) {
    to = 1;
  }
  to = Math.max(0, Math.min(to, next.length));
  next.splice(to, 0, el);
  return next;
}

async function postQueueReorder(ids) {
  await fetch(`${base}/reorder?${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ordered_ids: ids }),
  });
  void refresh();
}

async function commitHostQueueReorder(fromIndex, insertBeforeIndex, items, currentQueueItemId) {
  if (fromIndex == null || fromIndex < 0 || !items.length) {
    return;
  }
  if (currentQueueItemId != null && fromIndex === 0) {
    return;
  }
  const ids = items.map((x) => x.id);
  const newIds = reorderQueueItemIds(ids, fromIndex, insertBeforeIndex, currentQueueItemId);
  const same =
    newIds.length === ids.length && newIds.every((id, idx) => sameQueueId(id, ids[idx]));
  if (same) {
    return;
  }
  await postQueueReorder(newIds);
}

function initHostQueueDragAndDrop() {
  if (!queueHost || queueHost.dataset.jhDnDInit === '1') {
    return;
  }
  queueHost.dataset.jhDnDInit = '1';

  queueHost.addEventListener('dragover', (e) => {
    if (hostQueueDragFromIndex == null) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    queueHost.querySelectorAll('.jb-queue-row--drag-over').forEach((el) => el.classList.remove('jb-queue-row--drag-over'));
    const row = e.target.closest?.('.jb-queue-row');
    if (row && queueHost.contains(row)) {
      row.classList.add('jb-queue-row--drag-over');
    }
  });

  queueHost.addEventListener('drop', async (e) => {
    if (hostQueueDragFromIndex == null) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    queueHost.querySelectorAll('.jb-queue-row--drag-over').forEach((el) => el.classList.remove('jb-queue-row--drag-over'));

    const items = lastHostQueueState?.queue || [];
    const curId = lastHostQueueState?.current?.id ?? null;
    const row = e.target.closest?.('.jb-queue-row');
    let insertBefore = items.length;
    if (row && queueHost.contains(row)) {
      const idx = Number(row.dataset.queueIndex);
      if (Number.isFinite(idx)) {
        const r = row.getBoundingClientRect();
        insertBefore = e.clientY < r.top + r.height / 2 ? idx : idx + 1;
      }
    }
    const from = hostQueueDragFromIndex;
    hostQueueDragFromIndex = null;
    await commitHostQueueReorder(from, insertBefore, items, curId);
  });
}

function renderQueue(state) {
  if (!queueHost) {
    return;
  }
  lastHostQueueState = state;
  queueHost.replaceChildren();
  const items = state?.queue || [];
  const curId = state?.current?.id ?? null;
  const nextId = firstUpcomingId(state);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const row = document.createElement('div');
    row.className = 'jb-queue-row';
    row.dataset.queueIndex = String(i);
    if (curId != null && sameQueueId(it.id, curId)) {
      row.classList.add('jb-queue-row--playing');
      row.setAttribute('aria-current', 'true');
    } else if (nextId != null && sameQueueId(it.id, nextId)) {
      row.classList.add('jb-queue-row--next');
    }
    if (i >= 4) {
      row.classList.add('jb-queue-row--compact');
    }
    const img = document.createElement('img');
    img.className = 'jb-queue-art';
    img.alt = '';
    img.src = it.album_cover || PLACEHOLDER_IMG;
    img.loading = 'lazy';
    const isCurrent = curId != null && sameQueueId(it.id, curId);
    const text = document.createElement('div');
    text.className = 'jb-queue-text';
    if (isCurrent) {
      const badge = document.createElement('div');
      badge.className = 'jh-now-playing-badge';
      badge.textContent = 'Now playing';
      text.appendChild(badge);
    }
    const tt = document.createElement('div');
    tt.className = 'jb-queue-title';
    tt.innerHTML = escapeHtml(it.title || 'Track');
    const ar = document.createElement('div');
    ar.className = 'jb-queue-artist';
    ar.textContent = [it.artist, it.source].filter(Boolean).join(' · ') || '';
    text.append(tt, ar);
    const statusHtml = !isCurrent ? queueRowRequestStatusIconHtml(it.requestDisplayStatus) : '';
    const parts = [img, text];
    if (statusHtml) {
      const statusSlot = document.createElement('div');
      statusSlot.className = 'jb-queue-status';
      statusSlot.innerHTML = statusHtml;
      statusSlot.setAttribute('role', 'img');
      statusSlot.setAttribute('aria-label', it.requestDisplayStatus || '');
      parts.push(statusSlot);
    }
    if (!isCurrent) {
      row.draggable = true;
      row.title = 'Drag to reorder';
      row.addEventListener('dragstart', (e) => {
        if (e.target.closest('button')) {
          e.preventDefault();
          return;
        }
        hostQueueDragFromIndex = i;
        e.dataTransfer.setData('text/plain', String(it.id));
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('jb-queue-row--dragging');
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('jb-queue-row--dragging');
        hostQueueDragFromIndex = null;
        queueHost?.querySelectorAll('.jb-queue-row--drag-over').forEach((el) => el.classList.remove('jb-queue-row--drag-over'));
      });
      const actions = document.createElement('div');
      actions.className = 'jh-queue-actions';
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '✕';
      rm.title = 'Remove';
      rm.draggable = false;
      rm.addEventListener('click', () => void removeItem(it.id));
      actions.appendChild(rm);
      parts.push(actions);
    } else {
      row.draggable = false;
      row.removeAttribute('title');
    }
    row.append(...parts);
    queueHost.appendChild(row);
  }
}

async function removeItem(id) {
  await fetch(`${base}/remove?${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ queue_item_id: id }),
  });
  void refresh();
}

async function refresh() {
  if (!jukeboxId || !hostToken) {
    return;
  }
  const res = await fetch(`${base}/state?${qs()}`, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return;
  }
  if (hostTitle && data.jukebox?.name) {
    hostTitle.textContent = `Control · ${data.jukebox.name}`;
  }
  if (volRange && data.jukebox?.volume != null) {
    volRange.value = String(Math.round(Number(data.jukebox.volume) * 100));
  }
  lastPaused = Boolean(data.jukebox?.is_paused);
  setPlayIcon(lastPaused);
  renderQueue(data);
  updateHostProgressFromState(data);
}

npPlayBtn?.addEventListener('click', async () => {
  const next = !lastPaused;
  if (next) {
    stopHostProgressExtrapolation();
  }
  await fetch(`${base}/pause-volume?${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ is_paused: next }),
  });
  lastPaused = next;
  setPlayIcon(lastPaused);
  void refresh();
});

btnSkip?.addEventListener('click', async () => {
  await fetch(`${base}/skip?${qs()}`, { method: 'POST', credentials: 'same-origin' });
  void refresh();
});

volRange?.addEventListener('input', () => {
  const v = Number(volRange.value) / 100;
  clearTimeout(volDebounceTimer);
  volDebounceTimer = setTimeout(async () => {
    await fetch(`${base}/pause-volume?${qs()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ volume: v }),
    });
  }, 200);
});

jhNpProgress?.addEventListener('pointerdown', () => {
  hostScrubbing = true;
});
jhNpProgress?.addEventListener('pointerup', () => {
  hostScrubbing = false;
});
jhNpProgress?.addEventListener('input', () => {
  if (jhNpTimeCur && jhNpProgress) {
    jhNpTimeCur.textContent = formatHostTime((Number(jhNpProgress.value) || 0) / 1000);
  }
});
jhNpProgress?.addEventListener('change', async () => {
  if (!jhNpProgress || jhNpProgress.disabled) {
    return;
  }
  const sec = (Number(jhNpProgress.value) || 0) / 1000;
  await fetch(`${base}/seek?${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ position_seconds: sec }),
  });
  void refresh();
});

btnClose?.addEventListener('click', () => {
  leaveControlPanel();
});

btnClearQueue?.addEventListener('click', async () => {
  if (!confirm('Remove all tracks from the queue except the one currently playing?')) {
    return;
  }
  await fetch(`${base}/clear-queue?${qs()}`, { method: 'POST', credentials: 'same-origin' });
  void refresh();
});

function openSearchSheet() {
  jhShell?.classList.add('jh-search-open');
  searchSheet.classList.add('open');
  searchSheet.setAttribute('aria-hidden', 'false');
}

function closeSearchSheet() {
  jhShell?.classList.remove('jh-search-open');
  searchSheet.classList.remove('open');
  searchSheet.setAttribute('aria-hidden', 'true');
  sheetBody.replaceChildren();
  hostSearchQ.value = '';
  hostSearchQ.blur();
}

sheetCloseBtn?.addEventListener('click', () => closeSearchSheet());

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

function deezerTrackPayload(t) {
  return {
    id: t.id,
    title: t.title,
    artist: typeof t.artist === 'string' ? t.artist : t.artist?.name || '',
    album: typeof t.album === 'string' ? t.album : t.album?.title || '',
    duration: t.duration,
  };
}

async function addHostTrack(t, playNext) {
  const p = deezerTrackPayload(t);
  const libId = t.library_track_id;
  const useLib = libId != null && String(libId).trim() !== '' && Number(libId) > 0;
  const did = p.id != null ? String(p.id).trim() : '';
  if (!useLib && !did) {
    alert('Missing track id');
    return false;
  }
  const payload = useLib
    ? {
        library_track_id: Number(libId),
        title: p.title,
        artist: p.artist,
        album: p.album,
        duration_seconds: p.duration,
      }
    : {
        deezer_id: did,
        title: p.title,
        artist: p.artist,
        album: p.album,
        duration_seconds: p.duration,
      };
  const url = playNext ? `${base}/play-next?${qs()}` : `${base}/queue?${qs()}`;
  const res = await fetch(url, {
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
  void refresh();
  return true;
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
  const bq = document.createElement('button');
  bq.type = 'button';
  bq.className = 'primary';
  bq.textContent = 'Add to Queue';
  const bn = document.createElement('button');
  bn.type = 'button';
  bn.textContent = 'Play Next';
  if (blocked) {
    const hint = document.createElement('div');
    hint.className = 'jb-result-blocked';
    hint.textContent =
      t.requestDisplayStatus === 'Denied'
        ? 'Request denied — cannot queue'
        : t.requestDisplayStatus === 'Needs Attention'
          ? 'Request needs attention — cannot queue'
          : 'Download failed — cannot queue';
    actions.appendChild(hint);
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
      const ok = await addHostTrack(t, playNext);
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
  const statusHtml = jukeboxSearchRowStatusIconHtml(t);
  if (statusHtml) {
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

async function runSearch(q) {
  sheetBody.replaceChildren();
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

hostSearchQ?.addEventListener('focus', () => {
  openSearchSheet();
  if (hostSearchQ.value.trim().length < 2) {
    sheetBody.replaceChildren();
    sheetBody.textContent = 'Keep typing…';
  }
});

hostSearchQ?.addEventListener('input', () => {
  openSearchSheet();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void runSearch(hostSearchQ.value.trim());
  }, 320);
});

if (queueHost) {
  initHostQueueDragAndDrop();
}

if (jukeboxId && hostToken) {
  setInterval(() => void refresh(), 1000);
  void refresh();
}
