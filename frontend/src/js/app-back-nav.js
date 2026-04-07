/**
 * History-based back: window.history.back() with same-origin guard,
 * sessionStorage fallback (trackflow-nav-from), then Discover (/index.html).
 */

const STORAGE_KEY = 'trackflow-nav-from';
const FALLBACK_HREF = '/index.html';

function isSameOriginHref(href) {
  try {
    return new URL(href, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function canUseHistoryBack() {
  if (typeof window.history === 'undefined' || window.history.length <= 1) {
    return false;
  }
  const ref = document.referrer;
  if (!ref) {
    return true;
  }
  return isSameOriginHref(ref);
}

function goBackOrDiscover() {
  const from = sessionStorage.getItem(STORAGE_KEY);
  if (from) {
    try {
      const u = new URL(from, window.location.origin);
      if (u.origin === window.location.origin) {
        sessionStorage.removeItem(STORAGE_KEY);
        const path = u.pathname + u.search + u.hash;
        window.location.assign(path);
        return;
      }
    } catch {
      // fall through
    }
  }
  if (canUseHistoryBack()) {
    window.history.back();
    return;
  }
  window.location.href = FALLBACK_HREF;
}

/** Call before programmatic navigation to album / artist / playlist. */
function recordNavFrom() {
  sessionStorage.setItem(STORAGE_KEY, window.location.pathname + window.location.search);
}

function captureEntityLinkClicks() {
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      let url;
      try {
        url = new URL(a.getAttribute('href') || '', window.location.origin);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      const path = (url.pathname || '').toLowerCase();
      const entity =
        path.endsWith('/album.html') || path.endsWith('/artist.html') || path.endsWith('/playlist.html');
      if (!entity) return;
      sessionStorage.setItem(STORAGE_KEY, window.location.pathname + window.location.search);
    },
    true,
  );
}

function wireBackControls() {
  const sel = 'a.back-link, button.back-link, #backNavButton';
  for (const el of document.querySelectorAll(sel)) {
    if (el.dataset.trackflowBackWired === '1') continue;
    el.dataset.trackflowBackWired = '1';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      goBackOrDiscover();
    });
  }
}

function initTrackFlowBackNavigation() {
  captureEntityLinkClicks();
  wireBackControls();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTrackFlowBackNavigation);
  } else {
    initTrackFlowBackNavigation();
  }
}

window.TrackFlowBackNavigation = {
  goBackOrDiscover,
  recordNavFrom,
  init: initTrackFlowBackNavigation,
};

export { goBackOrDiscover, recordNavFrom, initTrackFlowBackNavigation };
