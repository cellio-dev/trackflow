/**
 * Global + per-user discover caches (Deezer-backed sections).
 * Recently added is always merged live on read.
 */

const { getDb } = require('../db');
const deezer = require('./deezer');
const { enrichDeezerTrackRows } = require('./searchTrackEnrichment');
const { getRecentlyAddedTracksForDiscover } = require('./tracksDb');
const { getDiscoverCacheTtlMs } = require('./discoverCacheSettings');
const {
  getOrRefreshDiscoverRecommendations,
  refreshDiscoverRecommendationsCache,
} = require('./recommendations');
const {
  filterDiscoverHomePayloadForUser,
  filterDiscoverGenrePayloadForUser,
} = require('./discoverPersonalization');

const LIMIT = 20;
/** Match client DISCOVER_PREVIEW_BATCH and route cap — full batch must be enriched, not first LIMIT rows only. */
const MAX_TRACK_PREVIEW_FETCH = 80;
/** Cap parallel GET /track/:id calls for ids not served from preview memory cache. */
const PREVIEW_FETCH_CONCURRENCY = 8;

/** In-memory cache for POST /api/discover/track-previews (key: Deezer track id string). */
const previewMemoryCache = new Map();
const PREVIEW_CACHE_TTL_MIN_MS = 60 * 60 * 1000; // 1h
const PREVIEW_CACHE_TTL_MAX_MS = 6 * 60 * 60 * 1000; // 6h
const PREVIEW_CACHE_TTL_DEFAULT_MS = 3 * 60 * 60 * 1000; // 3h (between 1–6h)

function getPreviewMemoryCacheTtlMs() {
  const raw = process.env.TF_DISCOVER_PREVIEW_CACHE_TTL_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return Math.min(PREVIEW_CACHE_TTL_MAX_MS, Math.max(PREVIEW_CACHE_TTL_MIN_MS, n));
    }
  }
  return PREVIEW_CACHE_TTL_DEFAULT_MS;
}

const db = getDb();

async function mapWithConcurrency(items, concurrency, mapper) {
  const n = items.length;
  if (n === 0) {
    return [];
  }
  const c = Math.max(1, Math.min(concurrency, n));
  const results = new Array(n);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= n) break;
      results[i] = await mapper(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: c }, () => worker()));
  return results;
}

/** Deezer anonymous API: avoid hammering GET /track/:id (quota) on every Discover load. */
let deezerTrackDetailPausedUntil = 0;
let deezerQuotaNoticeAt = 0;

function isDeezerLimitError(err) {
  const m = String(err?.message || err).toLowerCase();
  return m.includes('quota') || m.includes('limit exceeded') || m.includes('too many');
}

/**
 * Load track detail for preview/cover backfill. Does not short-circuit while the global
 * quota window is active (unlike a hard pause) so a fresh page load still attempts fetches;
 * throttling is handled by mapWithConcurrency in ensureMissingTrackPreviews.
 */
async function fetchTrackDetailForDiscover(id) {
  try {
    return await deezer.getTrackById(id);
  } catch (err) {
    if (isDeezerLimitError(err)) {
      deezerTrackDetailPausedUntil = Date.now() + 5 * 60 * 1000;
      if (Date.now() - deezerQuotaNoticeAt > 120_000) {
        deezerQuotaNoticeAt = Date.now();
        console.warn(
          '[Discover] Deezer rate/quota limit hit; pausing per-track preview/metadata fetches for 5 minutes.',
        );
      }
      return null;
    }
    console.warn('Discover track detail fetch failed for id', id, err?.message || err);
    return null;
  }
}

const getGlobalStmt = db.prepare(
  `SELECT payload_json, updated_at FROM discover_global_cache WHERE cache_key = ?`,
);
const upsertGlobalStmt = db.prepare(`
  INSERT INTO discover_global_cache (cache_key, payload_json, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(cache_key) DO UPDATE SET
    payload_json = excluded.payload_json,
    updated_at = datetime('now')
`);

const getUserDiscoverStmt = db.prepare(
  `SELECT payload_json, updated_at FROM discover_user_cache WHERE user_id = ?`,
);
const upsertUserDiscoverStmt = db.prepare(`
  INSERT INTO discover_user_cache (user_id, payload_json, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(user_id) DO UPDATE SET
    payload_json = excluded.payload_json,
    updated_at = datetime('now')
`);

function cacheRowFresh(updatedAt, ttlMs) {
  if (!updatedAt || typeof updatedAt !== 'string') {
    return false;
  }
  const t = Date.parse(updatedAt.replace(' ', 'T'));
  if (!Number.isFinite(t)) {
    return false;
  }
  return Date.now() - t < ttlMs;
}

function unwrapResults(label, settled) {
  if (settled.status === 'fulfilled') {
    const v = settled.value;
    if (v && Array.isArray(v.results)) {
      return v.results.slice(0, LIMIT);
    }
    if (Array.isArray(v)) {
      return v.slice(0, LIMIT);
    }
    return [];
  }
  console.warn(`Discover ${label}:`, settled.reason?.message || settled.reason);
  return [];
}

async function enrichTracks(rows) {
  const slice = Array.isArray(rows) ? rows.slice(0, LIMIT) : [];
  if (slice.length === 0) {
    return [];
  }
  try {
    return await enrichDeezerTrackRows(slice);
  } catch (e) {
    console.error('Discover track enrichment failed:', e?.message || e);
    return slice;
  }
}

/**
 * Deezer cdnt-preview URLs carry exp=UNIX (often ~15m). Discover cache TTL is much longer, so we must
 * refetch when the signature is stale — otherwise cards keep a non-empty but dead preview (common on
 * high-traffic genre pages that reuse cached JSON).
 */
function deezerSignedPreviewIsExpired(url) {
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
 * @returns {{ preview: string, albumCover?: string } | null}
 */
function memoryPreviewCacheGet(id) {
  const key = String(id).trim();
  if (!key) {
    return null;
  }
  const e = previewMemoryCache.get(key);
  if (!e) {
    return null;
  }
  const ttl = getPreviewMemoryCacheTtlMs();
  if (Date.now() - e.cachedAt > ttl) {
    previewMemoryCache.delete(key);
    return null;
  }
  const p = typeof e.preview === 'string' ? e.preview.trim() : '';
  if (!p || deezerSignedPreviewIsExpired(p)) {
    previewMemoryCache.delete(key);
    return null;
  }
  const c = typeof e.albumCover === 'string' && e.albumCover.trim() ? e.albumCover.trim() : '';
  return c ? { preview: p, albumCover: c } : { preview: p };
}

function memoryPreviewCacheSet(id, preview, albumCover) {
  const key = String(id).trim();
  if (!key) {
    return;
  }
  const p = typeof preview === 'string' && preview.trim() ? preview.trim() : '';
  const c = typeof albumCover === 'string' && albumCover.trim() ? albumCover.trim() : '';
  if (!p) {
    return;
  }
  previewMemoryCache.set(key, {
    preview: p,
    albumCover: c,
    cachedAt: Date.now(),
  });
}

/**
 * Fetches GET /track/:id when preview is missing/expired or album art is missing (covers-only backfill).
 */
async function ensureMissingTrackPreviews(rows) {
  const list = Array.isArray(rows) ? rows.slice(0, MAX_TRACK_PREVIEW_FETCH) : [];
  if (list.length === 0) {
    return list;
  }
  return mapWithConcurrency(list, PREVIEW_FETCH_CONCURRENCY, async (row) => {
    const id = row?.id;
    if (id == null || String(id).trim() === '') {
      return row;
    }
    const previewStr = typeof row.preview === 'string' ? row.preview.trim() : '';
    const previewOk = previewStr && !deezerSignedPreviewIsExpired(row.preview);
    const coverStr = typeof row.albumCover === 'string' ? row.albumCover.trim() : '';
    const coverOk = Boolean(coverStr);
    if (previewOk && coverOk) {
      return row;
    }
    const d = await fetchTrackDetailForDiscover(id);
    if (!d) {
      return row;
    }
    return {
      ...row,
      preview: d.preview || row.preview,
      albumCover: row.albumCover || d.albumCover,
    };
  });
}

async function fetchAndEnrichGlobalHomeDeezerPayload() {
  const settled = await Promise.allSettled([
    deezer.getChartTracks(LIMIT, 0),
    deezer.getChartPlaylists(LIMIT),
    deezer.getChartArtists(LIMIT),
    deezer.getEditorialNewReleasesAndNewTracks(LIMIT, LIMIT),
    deezer.getPopularGenresForDiscoverCards(),
  ]);

  const trendingRaw = unwrapResults('trending tracks', settled[0]);
  const playlists = unwrapResults('trending playlists', settled[1]);
  const artists = unwrapResults('popular artists', settled[2]);
  let newAlbums = [];
  let newTracksRaw = [];
  if (settled[3].status === 'fulfilled' && settled[3].value) {
    const v = settled[3].value;
    if (v.albumResults?.results) {
      newAlbums = v.albumResults.results.slice(0, LIMIT);
    }
    if (Array.isArray(v.newTrackRows)) {
      newTracksRaw = v.newTrackRows.slice(0, LIMIT);
    }
  } else if (settled[3].status === 'rejected') {
    console.warn(
      'Discover new albums / new tracks:',
      settled[3].reason?.message || settled[3].reason,
    );
  }

  const [trendingEnriched, newTracksEnriched] = await Promise.all([
    enrichTracks(trendingRaw),
    enrichTracks(newTracksRaw),
  ]);

  let genreCards = [];
  if (settled[4].status === 'fulfilled' && Array.isArray(settled[4].value)) {
    genreCards = settled[4].value;
  } else if (settled[4].status === 'rejected') {
    console.warn('Discover genre cards:', settled[4].reason?.message || settled[4].reason);
  }

  return {
    trendingTracks: trendingEnriched,
    newTracks: newTracksEnriched,
    trendingPlaylists: playlists,
    popularArtists: artists,
    newAlbums,
    genres: genreCards,
  };
}

const GLOBAL_HOME_KEY = 'home';

async function loadOrBuildGlobalHomePayload() {
  const ttl = getDiscoverCacheTtlMs();
  const row = getGlobalStmt.get(GLOBAL_HOME_KEY);
  if (row?.payload_json && cacheRowFresh(row.updated_at, ttl)) {
    try {
      return JSON.parse(row.payload_json);
    } catch {
      // rebuild
    }
  }

  const built = await fetchAndEnrichGlobalHomeDeezerPayload();
  upsertGlobalStmt.run(GLOBAL_HOME_KEY, JSON.stringify(built));
  return built;
}

/**
 * Used by background job: always refetch Deezer and store global home cache.
 */
async function buildAndStoreGlobalHomeCache() {
  const built = await fetchAndEnrichGlobalHomeDeezerPayload();
  upsertGlobalStmt.run(GLOBAL_HOME_KEY, JSON.stringify(built));
  return built;
}

function mergeHomeWithRecommendations(globalPayload, rec) {
  return {
    ...globalPayload,
    recommendedTracks: Array.isArray(rec?.tracks) ? rec.tracks : [],
    recommendedArtists: Array.isArray(rec?.artists) ? rec.artists : [],
  };
}

function buildPersonalizedHomePayloadForUser(userId, rec, globalPayload) {
  return filterDiscoverHomePayloadForUser(userId, mergeHomeWithRecommendations(globalPayload, rec));
}

/**
 * Rebuild user row from current global cache + fresh recommendations (job).
 */
async function rebuildUserDiscoverCacheRow(userId) {
  const uid = String(userId);
  const globalRow = getGlobalStmt.get(GLOBAL_HOME_KEY);
  if (!globalRow?.payload_json) {
    await buildAndStoreGlobalHomeCache();
  }
  let globalPayload;
  try {
    globalPayload = JSON.parse(getGlobalStmt.get(GLOBAL_HOME_KEY).payload_json);
  } catch {
    globalPayload = await buildAndStoreGlobalHomeCache();
  }

  const rec = await refreshDiscoverRecommendationsCache(uid);
  const personalized = filterDiscoverHomePayloadForUser(uid, mergeHomeWithRecommendations(globalPayload, rec));
  upsertUserDiscoverStmt.run(uid, JSON.stringify(personalized));
}

async function getDiscoverHomeResponseForUser(userId) {
  const uid = String(userId);
  const ttl = getDiscoverCacheTtlMs();

  const userRow = getUserDiscoverStmt.get(uid);
  let base;
  if (userRow?.payload_json && cacheRowFresh(userRow.updated_at, ttl)) {
    try {
      base = JSON.parse(userRow.payload_json);
    } catch {
      base = null;
    }
  }

  if (!base) {
    const [rec, globalPayload] = await Promise.all([
      getOrRefreshDiscoverRecommendations(uid),
      loadOrBuildGlobalHomePayload(),
    ]);
    base = buildPersonalizedHomePayloadForUser(uid, rec, globalPayload);
    upsertUserDiscoverStmt.run(uid, JSON.stringify(base));
  } else {
    base = filterDiscoverHomePayloadForUser(uid, base);
  }

  const recentRaw = getRecentlyAddedTracksForDiscover(LIMIT).slice(0, LIMIT);
  const recRaw = Array.isArray(base.recommendedTracks) ? base.recommendedTracks : [];
  const trendRaw = Array.isArray(base.trendingTracks) ? base.trendingTracks : [];
  const newRaw = Array.isArray(base.newTracks) ? base.newTracks : [];

  // DB-only enrich (request/library badges). Deezer GET /track/:id for previews/covers is done
  // on the client via POST /api/discover/track-previews so this handler stays fast on every visit.
  const [recentEnriched, recommendedTracks, trendingTracks, newTracks] = await Promise.all([
    enrichTracks(recentRaw),
    enrichTracks(recRaw),
    enrichTracks(trendRaw),
    enrichTracks(newRaw),
  ]);

  return {
    ...base,
    recommendedTracks,
    trendingTracks,
    newTracks,
    recentlyAddedTracks: recentEnriched,
  };
}

function genreCacheKey(genreId) {
  return `genre:${Math.floor(Number(genreId))}`;
}

async function fetchAndEnrichGlobalGenrePayload(gid) {
  const settled = await Promise.allSettled([
    deezer.getGenreById(gid),
    deezer.getGenreTrendingTracksAndPopularArtistsFromChart(gid, LIMIT, LIMIT),
    deezer.getChartPlaylistsForGenre(gid, LIMIT),
    deezer.getEditorialReleasesForGenreAndNewTracks(gid, LIMIT, LIMIT),
  ]);

  if (settled[0].status === 'rejected') {
    throw new Error('Genre not found');
  }

  const genre = settled[0].value;
  const chartBundle =
    settled[1].status === 'fulfilled' && settled[1].value ? settled[1].value : null;
  const trendingRaw =
    chartBundle?.trendingTracks?.results != null
      ? chartBundle.trendingTracks.results.slice(0, LIMIT)
      : [];
  const artists =
    chartBundle?.popularArtists?.results != null
      ? chartBundle.popularArtists.results.slice(0, LIMIT)
      : [];
  const playlists =
    settled[2].status === 'fulfilled' && settled[2].value?.results
      ? settled[2].value.results.slice(0, LIMIT)
      : [];
  let newAlbums = [];
  let newTracksRaw = [];
  if (settled[3].status === 'fulfilled' && settled[3].value) {
    const v = settled[3].value;
    if (v.albumResults?.results) {
      newAlbums = v.albumResults.results.slice(0, LIMIT);
    }
    if (Array.isArray(v.newTrackRows)) {
      newTracksRaw = v.newTrackRows.slice(0, LIMIT);
    }
  } else if (settled[3].status === 'rejected') {
    console.warn(
      'Genre new albums / new tracks:',
      settled[3].reason?.message || settled[3].reason,
    );
  }

  if (settled[1].status === 'rejected') {
    console.warn(
      'Genre chart tracks / popular artists:',
      settled[1].reason?.message || settled[1].reason,
    );
  }
  if (settled[2].status === 'rejected') {
    console.warn('Genre chart playlists:', settled[2].reason?.message || settled[2].reason);
  }

  const [trendingEnriched, newTracksEnriched] = await Promise.all([
    enrichTracks(trendingRaw),
    enrichTracks(newTracksRaw),
  ]);

  return {
    genre,
    trendingTracks: trendingEnriched,
    newTracks: newTracksEnriched,
    trendingPlaylists: playlists,
    popularArtists: artists,
    newAlbums,
  };
}

async function loadOrBuildGlobalGenrePayload(gid) {
  const key = genreCacheKey(gid);
  const ttl = getDiscoverCacheTtlMs();
  const row = getGlobalStmt.get(key);
  if (row?.payload_json && cacheRowFresh(row.updated_at, ttl)) {
    try {
      return JSON.parse(row.payload_json);
    } catch {
      // rebuild
    }
  }

  const built = await fetchAndEnrichGlobalGenrePayload(gid);
  upsertGlobalStmt.run(key, JSON.stringify(built));
  return built;
}

/** Space Deezer calls when warming many genre caches in one job run. */
const GENRE_GLOBAL_CACHE_STAGGER_MS = 900;

/**
 * Refetch one genre from Deezer and store under discover_global_cache (ignores TTL).
 * Used by discover cache refresh job so genre.html first visits are usually cache hits.
 */
async function buildAndStoreGlobalGenreCache(gid) {
  const g = Math.floor(Number(gid));
  if (!Number.isInteger(g) || g <= 0) {
    return;
  }
  const built = await fetchAndEnrichGlobalGenrePayload(g);
  upsertGlobalStmt.run(genreCacheKey(g), JSON.stringify(built));
}

function collectGenreIdsForGlobalCacheWarm(homePayload) {
  const ids = new Set();
  const genres = homePayload && Array.isArray(homePayload.genres) ? homePayload.genres : [];
  for (const g of genres) {
    const id = g?.id != null ? Math.floor(Number(g.id)) : NaN;
    if (Number.isInteger(id) && id > 0) {
      ids.add(id);
    }
  }
  if (ids.size > 0) {
    return [...ids];
  }
  for (const id of deezer.POPULAR_GENRE_IDS || []) {
    const n = Math.floor(Number(id));
    if (Number.isInteger(n) && n > 0) {
      ids.add(n);
    }
  }
  return [...ids];
}

/**
 * After global home is rebuilt, warm every Discover genre page payload in SQLite
 * so GET /api/discover/genre/:id avoids cold Deezer fetches on first user visit.
 * @returns {Promise<{ warmed: number, failed: number }>}
 */
async function refreshDiscoverGenreGlobalCaches(homePayload) {
  const genreIds = collectGenreIdsForGlobalCacheWarm(homePayload);
  if (genreIds.length === 0) {
    return { warmed: 0, failed: 0 };
  }
  let warmed = 0;
  let failed = 0;
  for (let i = 0; i < genreIds.length; i += 1) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, GENRE_GLOBAL_CACHE_STAGGER_MS));
    }
    const gid = genreIds[i];
    try {
      await buildAndStoreGlobalGenreCache(gid);
      warmed += 1;
    } catch (e) {
      failed += 1;
      console.warn('[discoverCache] genre global cache warm failed', gid, e?.message || e);
    }
  }
  return { warmed, failed };
}

async function getDiscoverGenreResponseForUser(userId, genreId) {
  const gid = Number(genreId);
  if (!Number.isInteger(gid) || gid <= 0) {
    throw new Error('Invalid genre id');
  }

  const raw = await loadOrBuildGlobalGenrePayload(gid);
  const filtered = filterDiscoverGenrePayloadForUser(userId, raw);
  const trendRaw = Array.isArray(filtered.trendingTracks) ? filtered.trendingTracks : [];
  const newRaw = Array.isArray(filtered.newTracks) ? filtered.newTracks : [];
  // DB-only enrich (badges). Previews/covers load on the client via POST /api/discover/track-previews
  // (same pattern as Discover home) so genre pages stay fast when global cache is warm.
  const [trendingTracks, newTracks] = await Promise.all([
    enrichTracks(trendRaw),
    enrichTracks(newRaw),
  ]);
  return {
    ...filtered,
    trendingTracks,
    newTracks,
  };
}

/**
 * Deezer GET /track/:id for preview + cover only (used when list payloads omitted preview).
 * @param {(string|number)[]} rawIds
 * @returns {Promise<Record<string, { preview?: string|null, albumCover?: string|null }>>}
 */
async function fetchPreviewFieldsByDeezerIds(rawIds) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map((x) => String(x).trim()).filter(Boolean))].slice(
    0,
    MAX_TRACK_PREVIEW_FETCH,
  );
  if (ids.length === 0) {
    return {};
  }
  const byId = {};
  const needFetch = [];
  for (const id of ids) {
    const hit = memoryPreviewCacheGet(id);
    if (hit) {
      const key = String(id);
      byId[key] = {
        ...(hit.preview ? { preview: hit.preview } : {}),
        ...(hit.albumCover ? { albumCover: hit.albumCover } : {}),
      };
    } else {
      needFetch.push(id);
    }
  }

  if (needFetch.length === 0) {
    return byId;
  }

  const stubs = needFetch.map((id) => ({ id }));
  const filled = await ensureMissingTrackPreviews(stubs);
  for (const row of filled) {
    if (row?.id == null) continue;
    const key = String(row.id);
    const preview = typeof row.preview === 'string' && row.preview.trim() ? row.preview.trim() : null;
    const albumCover =
      typeof row.albumCover === 'string' && row.albumCover.trim() ? row.albumCover.trim() : null;
    if (preview || albumCover) {
      byId[key] = { preview: preview || undefined, albumCover: albumCover || undefined };
    }
    if (preview) {
      memoryPreviewCacheSet(key, preview, albumCover || '');
    }
  }
  return byId;
}

module.exports = {
  getDiscoverHomeResponseForUser,
  getDiscoverGenreResponseForUser,
  buildAndStoreGlobalHomeCache,
  refreshDiscoverGenreGlobalCaches,
  rebuildUserDiscoverCacheRow,
  loadOrBuildGlobalHomePayload,
  GLOBAL_HOME_KEY,
  genreCacheKey,
  fetchPreviewFieldsByDeezerIds,
};
