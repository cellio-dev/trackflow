/**
 * Reduce iOS / WebKit edge-swipe "back" leaving the jukebox guest screen without Close.
 * `location.replace` alone is unreliable in Safari and standalone PWA; combine history
 * stacking + capture-phase touches in the left edge (no fixed overlay — overlays broke
 * discovery list painting on some WebKit builds).
 */

let guardActive = false;
/** True while a touch sequence began in the left-edge strip. */
let edgeSwipeTracking = false;

const LEFT_EDGE_PX = 32;
const TOUCH_CAPTURE = { capture: true, passive: false };
const TOUCH_END_OPTS = { capture: true, passive: true };

function onPopState() {
  if (!guardActive) {
    return;
  }
  try {
    window.history.pushState({ tfJbGuestGuard: Date.now() }, '', window.location.href);
  } catch {
    /* ignore */
  }
}

function onPageShow(ev) {
  if (!guardActive || !ev.persisted) {
    return;
  }
  try {
    window.history.pushState({ tfJbGuestGuard: Date.now() }, '', window.location.href);
  } catch {
    /* ignore */
  }
}

function onDocTouchStart(ev) {
  if (!guardActive) {
    return;
  }
  const t = ev.targetTouches[0];
  if (!t || t.clientX >= LEFT_EDGE_PX) {
    edgeSwipeTracking = false;
    return;
  }
  edgeSwipeTracking = true;
  ev.preventDefault();
}

function onDocTouchMove(ev) {
  if (!guardActive || !edgeSwipeTracking) {
    return;
  }
  ev.preventDefault();
}

function onDocTouchEnd() {
  edgeSwipeTracking = false;
}

function wireDocumentEdgeTouch() {
  document.addEventListener('touchstart', onDocTouchStart, TOUCH_CAPTURE);
  document.addEventListener('touchmove', onDocTouchMove, TOUCH_CAPTURE);
  document.addEventListener('touchend', onDocTouchEnd, TOUCH_END_OPTS);
  document.addEventListener('touchcancel', onDocTouchEnd, TOUCH_END_OPTS);
}

export function installJukeboxGuestBackGuard() {
  if (guardActive) {
    return;
  }
  guardActive = true;

  const url = window.location.href;
  try {
    window.history.pushState({ tfJbGuestGuard: 0 }, '', url);
    window.history.pushState({ tfJbGuestGuard: 1 }, '', url);
  } catch {
    /* ignore */
  }

  window.addEventListener('popstate', onPopState);
  window.addEventListener('pageshow', onPageShow);
  wireDocumentEdgeTouch();

  /* Second frame: some WebKit builds only apply extra history entries after paint. */
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!guardActive) {
        return;
      }
      try {
        window.history.pushState({ tfJbGuestGuard: 2 }, '', window.location.href);
      } catch {
        /* ignore */
      }
    });
  });
}

export function releaseJukeboxGuestBackGuard() {
  guardActive = false;
  edgeSwipeTracking = false;
  window.removeEventListener('popstate', onPopState);
  window.removeEventListener('pageshow', onPageShow);
  document.removeEventListener('touchstart', onDocTouchStart, TOUCH_CAPTURE);
  document.removeEventListener('touchmove', onDocTouchMove, TOUCH_CAPTURE);
  document.removeEventListener('touchend', onDocTouchEnd, TOUCH_END_OPTS);
  document.removeEventListener('touchcancel', onDocTouchEnd, TOUCH_END_OPTS);
}
