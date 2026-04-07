import { AUTH_ME_TIMEOUT_MS } from '../js/auth-guard.js';

const form = document.getElementById('loginForm');
const usernameEl = document.getElementById('loginUsername');
const passwordEl = document.getElementById('loginPassword');
const messageEl = document.getElementById('loginMessage');
const loginOr = document.getElementById('loginOr');
const loginPlexBtn = document.getElementById('loginPlexBtn');

const PLEX_PIN_STORAGE_KEY = 'trackflow_plex_pin_resume_v1';
/** Backup if sessionStorage is cleared when leaving the PWA for plex.tv (common on some mobile WebViews). */
const PLEX_PIN_LOCAL_KEY = 'trackflow_plex_pin_resume_v1_local';
const PLEX_POLL_MS = 2000;
/** Slightly faster polling when finishing after returning from Plex in the same app. */
const PLEX_POLL_RESUME_MS = 900;
const PLEX_TIMEOUT_MS = 5 * 60 * 1000;

/** Prevents overlapping resume loops (pageshow / visibility / initial load). */
let plexResumeRunning = false;

function returnTarget() {
  const q = new URLSearchParams(window.location.search).get('return');
  if (q && q.startsWith('/') && !q.startsWith('//')) {
    return q;
  }
  return '/index.html';
}

/** Installed PWA / iOS “Add to Home Screen” — pop-ups are unreliable or blocked. */
function isStandaloneDisplayMode() {
  try {
    if (window.navigator.standalone === true) {
      return true;
    }
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return true;
    }
    if (window.matchMedia('(display-mode: minimal-ui)').matches) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function setLoginMessage(text, kind) {
  if (!messageEl) {
    return;
  }
  messageEl.className = 'login-msg';
  messageEl.replaceChildren();
  if (!text) {
    messageEl.removeAttribute('role');
    return;
  }
  if (kind === 'error') {
    messageEl.classList.add('login-msg--error');
    messageEl.setAttribute('role', 'alert');
    messageEl.textContent = text;
    return;
  }
  if (kind === 'info') {
    messageEl.classList.add('login-msg--info');
    messageEl.removeAttribute('role');
    const spin = document.createElement('span');
    spin.className = 'login-msg__spinner';
    spin.setAttribute('aria-hidden', 'true');
    const t = document.createElement('span');
    t.className = 'login-msg__text';
    t.textContent = text;
    messageEl.append(spin, t);
    return;
  }
  messageEl.textContent = text;
}

function persistPlexPinForResume(pinId, returnPath) {
  const payload = JSON.stringify({
    pinId: String(pinId),
    returnPath,
    startedAt: Date.now(),
  });
  try {
    sessionStorage.setItem(PLEX_PIN_STORAGE_KEY, payload);
  } catch {
    // private mode / quota — caller should fall back to messaging
  }
  try {
    localStorage.setItem(PLEX_PIN_LOCAL_KEY, payload);
  } catch {
    // ignore
  }
}

function clearPlexPinResume() {
  try {
    sessionStorage.removeItem(PLEX_PIN_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(PLEX_PIN_LOCAL_KEY);
  } catch {
    // ignore
  }
}

function readPlexPinResumeRaw() {
  try {
    const s = sessionStorage.getItem(PLEX_PIN_STORAGE_KEY);
    if (s) return s;
  } catch {
    // ignore
  }
  try {
    return localStorage.getItem(PLEX_PIN_LOCAL_KEY);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function redirectIfAlreadyAuthed() {
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(AUTH_ME_TIMEOUT_MS),
    });
    if (res.ok) {
      window.location.replace(returnTarget());
      await new Promise(() => {});
    }
  } catch {
    // stay on login
  }
}

async function fetchPlexPinStatus(pinId) {
  const st = await fetch(`/api/auth/plex/pin/${encodeURIComponent(pinId)}/status`, {
    credentials: 'same-origin',
  });
  const body = await st.json().catch(() => ({}));
  return { st, body };
}

function unhidePlexLoginRow() {
  if (loginOr) {
    loginOr.hidden = false;
  }
  if (loginPlexBtn) {
    loginPlexBtn.hidden = false;
  }
}

/**
 * After same-tab redirect to Plex (PWA / blocked pop-up), user returns here; finish PIN poll + session.
 */
async function maybeResumePlexPinFlow() {
  if (plexResumeRunning) {
    return;
  }

  const raw = readPlexPinResumeRaw();
  if (!raw) {
    return;
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    clearPlexPinResume();
    return;
  }

  const pinId = state.pinId != null ? String(state.pinId).trim() : '';
  const returnPath =
    typeof state.returnPath === 'string' && state.returnPath.startsWith('/') && !state.returnPath.startsWith('//')
      ? state.returnPath
      : '/index.html';
  const startedAt = Number(state.startedAt) || Date.now();

  if (!pinId || !/^\d{1,24}$/.test(pinId)) {
    clearPlexPinResume();
    return;
  }

  if (Date.now() - startedAt >= PLEX_TIMEOUT_MS) {
    clearPlexPinResume();
    return;
  }

  plexResumeRunning = true;
  unhidePlexLoginRow();
  setLoginMessage('Signing you in with Plex…', 'info');
  if (loginPlexBtn) {
    loginPlexBtn.disabled = true;
  }

  let success = false;
  try {
    while (Date.now() - startedAt < PLEX_TIMEOUT_MS) {
      const { st, body } = await fetchPlexPinStatus(pinId);
      if (body.done && st.ok) {
        clearPlexPinResume();
        success = true;
        setLoginMessage('You’re signed in. Taking you in…', 'info');
        window.location.replace(returnPath);
        return;
      }
      if (body.error && st.status >= 400) {
        throw new Error(body.error || 'Plex sign-in failed');
      }
      await sleep(PLEX_POLL_RESUME_MS);
    }
    setLoginMessage(
      'Plex sign-in timed out. Tap Sign in with Plex again if you already approved the link on plex.tv.',
      'error',
    );
  } catch (err) {
    setLoginMessage(err?.message || 'Plex sign-in failed', 'error');
  } finally {
    plexResumeRunning = false;
    if (!success) {
      clearPlexPinResume();
      if (loginPlexBtn) {
        loginPlexBtn.disabled = false;
      }
    }
  }
}

await redirectIfAlreadyAuthed();
void maybeResumePlexPinFlow();

async function showPlexLoginIfEnabled() {
  try {
    const res = await fetch('/api/auth/config', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(AUTH_ME_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (data.plex_auth_enabled && loginOr && loginPlexBtn) {
      loginOr.hidden = false;
      loginPlexBtn.hidden = false;
    }
  } catch {
    // ignore
  }
}

const showPlexPromise = showPlexLoginIfEnabled();

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    void maybeResumePlexPinFlow();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void maybeResumePlexPinFlow();
  }
});

await showPlexPromise;

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!usernameEl || !passwordEl || !messageEl) {
    return;
  }
  setLoginMessage('', '');
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) {
    setLoginMessage('Enter username and password.', 'error');
    return;
  }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }
    window.location.replace(returnTarget());
  } catch (err) {
    setLoginMessage(err?.message || 'Login failed', 'error');
  }
});

function startPlexRedirectFlow(pinId, authUrl) {
  const ret = returnTarget();
  persistPlexPinForResume(pinId, ret);
  let stored = false;
  try {
    stored = Boolean(sessionStorage.getItem(PLEX_PIN_STORAGE_KEY) || localStorage.getItem(PLEX_PIN_LOCAL_KEY));
  } catch {
    stored = false;
  }
  if (!stored && messageEl) {
    setLoginMessage(
      'Could not save sign-in state (browser storage). Allow cookies/storage for this app, or use Safari/Chrome without private mode.',
      'error',
    );
    return;
  }
  window.location.assign(authUrl);
}

loginPlexBtn?.addEventListener('click', async () => {
  if (!messageEl) {
    return;
  }
  setLoginMessage('', '');
  loginPlexBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/plex/pin', {
      method: 'POST',
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Could not start Plex sign-in');
    }
    const { pinId, authUrl } = data;
    if (!pinId || !authUrl) {
      throw new Error('Invalid response from server');
    }

    if (isStandaloneDisplayMode()) {
      startPlexRedirectFlow(pinId, authUrl);
      return;
    }

    const popup = window.open(authUrl, 'plex_oauth', 'width=600,height=720,scrollbars=yes');
    if (!popup) {
      startPlexRedirectFlow(pinId, authUrl);
      return;
    }

    const started = Date.now();
    while (Date.now() - started < PLEX_TIMEOUT_MS) {
      const { st, body } = await fetchPlexPinStatus(pinId);
      if (body.done && st.ok) {
        try {
          popup.close();
        } catch {
          // ignore
        }
        window.location.replace(returnTarget());
        return;
      }
      if (body.error && st.status >= 400) {
        throw new Error(body.error || 'Plex sign-in failed');
      }
      await sleep(PLEX_POLL_MS);
    }
    setLoginMessage('Plex sign-in timed out. Close the Plex window and try again.', 'error');
  } catch (err) {
    setLoginMessage(err?.message || 'Plex sign-in failed', 'error');
  } finally {
    loginPlexBtn.disabled = false;
  }
});
