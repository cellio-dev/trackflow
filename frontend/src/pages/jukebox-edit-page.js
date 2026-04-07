import { ensureLoggedIn, redirectUnlessJukeboxEnabled } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';
import '../js/app-back-nav.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await redirectUnlessJukeboxEnabled(__tfMe);
await initAppNavAuth(__tfMe);

const params = new URLSearchParams(window.location.search);
const editId = params.get('id');

const form = document.getElementById('jukeboxForm');
const titleEl = document.getElementById('editTitle');
const nameEl = document.getElementById('jbName');
const partyEl = document.getElementById('jbPartyPl');
const loopEl = document.getElementById('jbLoop');
const pinEl = document.getElementById('jbPin');
const pinNextEl = document.getElementById('jbPinNext');
const pinSkipEl = document.getElementById('jbPinSkip');
const pinCloseEl = document.getElementById('jbPinClose');
const guestQueueLimitEl = document.getElementById('jbGuestQueueLimit');
const guestHistoryLimitEl = document.getElementById('jbGuestHistoryLimit');
const msgEl = document.getElementById('formMsg');
const saveBtn = document.getElementById('saveBtn');

document.getElementById('cancelBtn')?.addEventListener('click', () => {
  window.location.href = '/jukebox.html';
});

async function loadFollowedPlaylists() {
  try {
    const res = await fetch('/api/playlists/followed', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    const rows = Array.isArray(data.results) ? data.results : [];
    for (const pl of rows) {
      if (pl.follow_status !== 'active') {
        continue;
      }
      const opt = document.createElement('option');
      opt.value = String(pl.playlist_id);
      opt.textContent = pl.title || pl.playlist_id;
      opt.dataset.title = pl.title || '';
      partyEl?.appendChild(opt);
    }
  } catch {
    /* ignore */
  }
}

async function loadExisting() {
  if (!editId) {
    return;
  }
  const res = await fetch(`/api/jukeboxes/${encodeURIComponent(editId)}`, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    msgEl.hidden = false;
    msgEl.textContent = data.error || 'Could not load jukebox';
    saveBtn.disabled = true;
    return;
  }
  if (titleEl) {
    titleEl.textContent = 'Edit jukebox';
  }
  if (nameEl) {
    nameEl.value = data.name || '';
  }
  if (loopEl) {
    loopEl.checked = Boolean(data.playlist_loop);
  }
  if (pinNextEl) {
    pinNextEl.checked = Boolean(data.pin_require_play_next);
  }
  if (pinSkipEl) {
    pinSkipEl.checked = Boolean(data.pin_require_skip);
  }
  if (pinCloseEl) {
    pinCloseEl.checked = Boolean(data.pin_require_close);
  }
  if (partyEl && data.party_playlist_id) {
    partyEl.value = String(data.party_playlist_id);
  }
  if (guestQueueLimitEl) {
    const q = data.guest_queue_display_limit;
    guestQueueLimitEl.value =
      q != null && Number.isFinite(Number(q)) ? String(Math.floor(Number(q))) : '15';
  }
  if (guestHistoryLimitEl) {
    const h = data.guest_history_display_limit;
    guestHistoryLimitEl.value =
      h != null && Number.isFinite(Number(h)) ? String(Math.floor(Number(h))) : '15';
  }
}

await loadFollowedPlaylists();
await loadExisting();

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  msgEl.hidden = true;
  const name = nameEl?.value.trim() || '';
  if (!name) {
    return;
  }
  const sel = partyEl?.selectedOptions?.[0];
  const partyId = partyEl?.value?.trim() || null;
  const partyTitle = sel && partyId ? sel.textContent || sel.dataset.title || null : null;
  const qLim = parseInt(String(guestQueueLimitEl?.value ?? '15'), 10);
  const hLim = parseInt(String(guestHistoryLimitEl?.value ?? '15'), 10);
  if (!Number.isFinite(qLim) || qLim < 3 || qLim > 50 || !Number.isFinite(hLim) || hLim < 3 || hLim > 50) {
    msgEl.hidden = false;
    msgEl.textContent = 'Guest list limits must be between 3 and 50.';
    return;
  }
  const body = {
    name,
    party_playlist_id: partyId,
    party_playlist_title: partyTitle,
    playlist_loop: Boolean(loopEl?.checked),
    pin_require_play_next: Boolean(pinNextEl?.checked),
    pin_require_skip: Boolean(pinSkipEl?.checked),
    pin_require_close: Boolean(pinCloseEl?.checked),
    guest_queue_display_limit: qLim,
    guest_history_display_limit: hLim,
  };
  const pinVal = pinEl?.value?.trim();
  if (pinVal) {
    body.pin = pinVal;
  }
  saveBtn.disabled = true;
  try {
    if (editId) {
      const res = await fetch(`/api/jukeboxes/${encodeURIComponent(editId)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Save failed');
      }
    } else {
      const res = await fetch('/api/jukeboxes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Create failed');
      }
      window.location.href = '/jukebox.html';
      return;
    }
    window.location.href = '/jukebox.html';
  } catch (err) {
    msgEl.hidden = false;
    msgEl.textContent = err?.message || 'Error';
    saveBtn.disabled = false;
  }
});
