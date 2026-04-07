/**
 * Poll Discover / genre: track request badges (POST /api/discover/track-status) and
 * artist/playlist follow badges (same refresh as refreshEntityFollowUi).
 */

const DEFAULT_POLL_MS = 12_000;
const MAX_IDS = 100;

export function collectTrackListDeezerIds(listEls) {
  const ids = new Set();
  for (const ul of listEls) {
    if (!ul) continue;
    for (const li of ul.querySelectorAll('li[data-trackflow-id]')) {
      const id = li.getAttribute('data-trackflow-id');
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export async function fetchDiscoverTrackStatuses(ids) {
  const unique = [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (unique.length === 0) {
    return { byId: {} };
  }
  const res = await fetch('/api/discover/track-status', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: unique }),
  });
  if (!res.ok) {
    throw new Error(`track-status ${res.status}`);
  }
  return res.json();
}

export function applyStatusPatchesToTrackLists(listEls, byId) {
  if (!byId || typeof byId !== 'object') return;
  const patch = window.TrackFlowTrackCard?.patchTrackListItem;
  if (!patch) return;
  for (const ul of listEls) {
    if (!ul) continue;
    for (const li of ul.querySelectorAll('li[data-trackflow-id]')) {
      const id = li.getAttribute('data-trackflow-id');
      const row = id ? byId[id] : null;
      if (row) patch(li, row);
    }
  }
}

/**
 * @param {(HTMLElement|null|undefined)[]} listEls
 * @param {{ intervalMs?: number, shouldPoll?: () => boolean, refreshEntityFollowUi?: () => void | Promise<void> }} [opts]
 * @returns {() => void} stop
 */
export function startDiscoverTrackStatusPolling(listEls, opts = {}) {
  const intervalMs = Math.max(5000, opts.intervalMs ?? DEFAULT_POLL_MS);
  const shouldPoll = typeof opts.shouldPoll === 'function' ? opts.shouldPoll : () => true;
  const refreshFollow =
    typeof opts.refreshEntityFollowUi === 'function' ? opts.refreshEntityFollowUi : null;

  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped || document.visibilityState !== 'visible' || !shouldPoll()) return;
    const ids = collectTrackListDeezerIds(listEls);
    const tasks = [];
    if (ids.length > 0) {
      tasks.push(
        fetchDiscoverTrackStatuses(ids)
          .then((data) => {
            if (data?.byId) applyStatusPatchesToTrackLists(listEls, data.byId);
          })
          .catch((e) => {
            console.warn('Discover track status poll:', e?.message || e);
          }),
      );
    }
    if (refreshFollow) {
      tasks.push(
        Promise.resolve(refreshFollow()).catch((e) => {
          console.warn('Discover follow UI poll:', e?.message || e);
        }),
      );
    }
    if (tasks.length === 0) return;
    await Promise.all(tasks);
  }

  function arm() {
    if (timer) clearInterval(timer);
    if (stopped) return;
    timer = setInterval(() => void tick(), intervalMs);
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') void tick();
  }

  document.addEventListener('visibilitychange', onVisibility);
  arm();
  setTimeout(() => void tick(), 2500);

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    if (timer) clearInterval(timer);
    timer = null;
  };
}
