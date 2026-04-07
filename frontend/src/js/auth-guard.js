/** Max wait for session check; avoids a stuck UI when the API is down or the dev proxy hangs. */
export const AUTH_ME_TIMEOUT_MS = 12_000;

function redirectToLogin() {
  const dest = window.location.pathname + window.location.search;
  const ret = encodeURIComponent(dest);
  window.location.replace(`/login.html?return=${ret}`);
}

async function blockUntilNav() {
  await new Promise(() => {});
}

/**
 * Ensures the visitor has a session. Redirects to login when unauthenticated or when the
 * session check fails (network, timeout, non-OK response), then blocks until navigation.
 * On `login.html`, returns null without redirect so the login UI can run.
 */
export async function ensureLoggedIn() {
  const path = window.location.pathname || '';
  const isLoginPage = /\/login\.html$/i.test(path) || path === '/login';
  if (isLoginPage) {
    return null;
  }

  let res;
  try {
    res = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(AUTH_ME_TIMEOUT_MS),
    });
  } catch {
    redirectToLogin();
    await blockUntilNav();
    return null;
  }

  if (res.ok) {
    return res.json();
  }

  redirectToLogin();
  await blockUntilNav();
  return null;
}

/**
 * @param {{ jukebox_enabled?: boolean } | null | undefined} me
 */
export async function redirectUnlessJukeboxEnabled(me) {
  if (me?.jukebox_enabled) {
    return;
  }
  window.location.replace('/index.html');
  await blockUntilNav();
}
