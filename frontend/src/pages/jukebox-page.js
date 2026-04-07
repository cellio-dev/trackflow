import { ensureLoggedIn, redirectUnlessJukeboxEnabled } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await redirectUnlessJukeboxEnabled(__tfMe);
await initAppNavAuth(__tfMe);

const RETURN_AFTER_JUKEBOX_KEY = 'tf-jukebox-return-href';

function rememberJukeboxReturnHref() {
  try {
    sessionStorage.setItem(RETURN_AFTER_JUKEBOX_KEY, '/jukebox.html');
  } catch {
    /* ignore */
  }
}

function jukeboxReturnParam() {
  return `&return=${encodeURIComponent('/jukebox.html')}`;
}

const panelEl = document.getElementById('jbPanel');
const statusEl = document.getElementById('jbStatus');
const errEl = document.getElementById('jbErr');
const npArt = document.getElementById('jbNpArt');
const npTitle = document.getElementById('jbNpTitle');
const npArtist = document.getElementById('jbNpArtist');
const btnLaunch = document.getElementById('jbBtnLaunch');
const btnControl = document.getElementById('jbBtnControl');
const btnEdit = document.getElementById('jbBtnEdit');
const btnClearHist = document.getElementById('jbBtnClearHist');
const clearDialog = document.getElementById('jbClearDialog');
const clearCancel = document.getElementById('jbClearCancel');
const clearConfirm = document.getElementById('jbClearConfirm');

let lastJukeboxId = null;

const PLACEHOLDER_SVG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect fill="%2327272a" width="96" height="96" rx="12"/><path fill="%2352525b" d="M40 28v40l28-20-28-20z"/></svg>',
  );

function setError(msg) {
  if (!errEl) {
    return;
  }
  if (msg) {
    errEl.hidden = false;
    errEl.textContent = msg;
  } else {
    errEl.hidden = true;
    errEl.textContent = '';
  }
}

function wireLaunchControl() {
  const origin = window.location.origin;
  const openLaunch = () => {
    if (!lastJukeboxId) {
      return;
    }
    rememberJukeboxReturnHref();
    window.location.href = `${origin}/jukebox-guest.html?id=${encodeURIComponent(lastJukeboxId)}${jukeboxReturnParam()}`;
  };
  const openControl = () => {
    if (!lastJukeboxId) {
      return;
    }
    rememberJukeboxReturnHref();
    window.location.href = `${origin}/jukebox-host.html?id=${encodeURIComponent(lastJukeboxId)}${jukeboxReturnParam()}`;
  };
  btnLaunch?.addEventListener('click', openLaunch);
  btnControl?.addEventListener('click', openControl);
}

function applyPlayback(data) {
  const st = data?.panel?.status === 'active' ? 'active' : 'idle';
  if (statusEl) {
    statusEl.textContent = st === 'active' ? 'Active' : 'Idle';
    statusEl.dataset.status = st;
  }
  const cur = data?.panel?.current;
  if (cur?.title) {
    if (npTitle) {
      npTitle.textContent = cur.title;
    }
    if (npArtist) {
      npArtist.textContent = cur.artist || '';
    }
    if (npArt) {
      npArt.src = cur.album_cover || PLACEHOLDER_SVG;
    }
  } else {
    if (npTitle) {
      npTitle.textContent = 'Nothing playing';
    }
    if (npArtist) {
      npArtist.textContent = 'Queue a track from Launch or the control panel';
    }
    if (npArt) {
      npArt.src = PLACEHOLDER_SVG;
    }
  }
}

async function loadPanel() {
  setError('');
  if (panelEl) {
    panelEl.hidden = false;
  }
  try {
    const res = await fetch('/api/jukebox', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || 'Could not load jukebox.');
      return;
    }
    lastJukeboxId = data.id;
    applyPlayback(data);
  } catch {
    setError('Could not load jukebox.');
  }
}

wireLaunchControl();

btnEdit?.addEventListener('click', () => {
  const id = lastJukeboxId;
  window.location.href = id
    ? `/jukebox-edit.html?id=${encodeURIComponent(id)}`
    : '/jukebox-edit.html';
});

async function runClearHistory() {
  clearDialog?.close?.();
  try {
    const res = await fetch('/api/jukebox/clear-history', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || 'failed');
    }
    await loadPanel();
  } catch {
    alert('Could not clear play history.');
  }
}

btnClearHist?.addEventListener('click', () => {
  if (clearDialog && typeof clearDialog.showModal === 'function') {
    clearDialog.showModal();
  } else if (window.confirm('Clear all jukebox play history? This does not delete your library.')) {
    void runClearHistory();
  }
});

clearCancel?.addEventListener('click', () => clearDialog?.close?.());

clearConfirm?.addEventListener('click', () => void runClearHistory());

void loadPanel();
setInterval(() => {
  if (document.visibilityState === 'visible' && lastJukeboxId) {
    void loadPanel();
  }
}, 8000);
