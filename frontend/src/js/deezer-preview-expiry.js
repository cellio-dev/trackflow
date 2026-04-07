/**
 * Deezer cdnt-preview URLs use exp=UNIX (~15m). Cached discover payloads can outlive them.
 * If there is no exp= token, refetch — otherwise a dead URL can look "fresh" forever.
 *
 * Also used to decide when to POST /api/discover/track-previews: same rules as Discover home
 * (refetch if preview missing/stale **or** album art missing) so Genre and Discover stay consistent.
 */
export function deezerPreviewNeedsRefresh(url) {
  if (typeof url !== 'string') {
    return true;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return true;
  }
  const m = trimmed.match(/exp=(\d{10,})/);
  if (!m) {
    return true;
  }
  const expSec = Number(m[1]);
  if (!Number.isFinite(expSec)) {
    return true;
  }
  const skewSec = 120;
  return Date.now() / 1000 >= expSec - skewSec;
}

/**
 * Deezer ids that need preview/cover backfill (matches Discover `hydrateDiscoverTrackPreviews` logic).
 * @param {object[]} tracks
 * @returns {string[]}
 */
export function collectDeezerTrackIdsForPreviewHydrate(tracks) {
  const ids = [];
  for (const t of Array.isArray(tracks) ? tracks : []) {
    const id = t?.id;
    if (id == null || String(id).trim() === '') {
      continue;
    }
    const p = t.preview;
    const previewOk = typeof p === 'string' && p.trim() && !deezerPreviewNeedsRefresh(p);
    const c = t.albumCover;
    const coverOk = typeof c === 'string' && c.trim();
    if (previewOk && coverOk) {
      continue;
    }
    ids.push(String(id));
  }
  return ids;
}

/**
 * Track cards register late on `window`; after async fetches the patch helper can be needed immediately.
 */
export async function waitForTrackFlowTrackCardPatch(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const patch = window.TrackFlowTrackCard?.patchTrackListItem;
    if (typeof patch === 'function') {
      return patch;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}
