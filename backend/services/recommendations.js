/**
 * Per-user track + artist recommendations (Deezer → JSON in recommendation_cache).
 * TTL matches settings `discover_cache_refresh_minutes` (default 4h).
 * Seeds: followed artists, or (when enabled) recent Plex plays for Plex-auth users → related artists
 * on Deezer; track picks come from those recommended artists’ top tracks.
 */

const { getDb } = require('../db');
const deezer = require('./deezer');
const { findPresentTrackForProbe } = require('./tracksDb');
const { getDiscoverCacheTtlMs } = require('./discoverCacheSettings');
const { fetchQualifyingPlexMusicPlayRows } = require('./plexPlayHistory');

const db = getDb();

const getCacheStmt = db.prepare(`
  SELECT track_data, artist_data, created_at
  FROM recommendation_cache
  WHERE user_id = ?
`);

const upsertCacheStmt = db.prepare(`
  INSERT INTO recommendation_cache (user_id, track_data, artist_data, created_at)
  VALUES (@user_id, @track_data, @artist_data, datetime('now'))
  ON CONFLICT(user_id) DO UPDATE SET
    track_data = excluded.track_data,
    artist_data = excluded.artist_data,
    created_at = excluded.created_at
`);

const getRecSettingsStmt = db.prepare(
  `SELECT plex_play_history_recommendations FROM settings WHERE id = 1`,
);
const getUserRecoContextStmt = db.prepare(
  `SELECT auth_provider, plex_user_token FROM users WHERE id = ?`,
);

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function loadRequestedDeezerIdsForUser(userId) {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT deezer_id
    FROM requests
    WHERE user_id = ? AND deezer_id IS NOT NULL AND trim(deezer_id) != ''
  `,
    )
    .all(String(userId));
  return new Set(rows.map((r) => String(r.deezer_id).trim()));
}

function isInLibraryByDeezerId(deezerId) {
  const id = String(deezerId).trim();
  if (!id) {
    return false;
  }
  return Boolean(findPresentTrackForProbe({ deezer_id: id }));
}

/** Top tracks requested per artist (Deezer max 50; keep modest for quota). */
const TOP_PER_RECOMMENDED_ARTIST = 15;

/** Max followed artists to pull “related” from per refresh (Deezer calls). */
const MAX_RELATED_SEED_ARTISTS = 8;

/** Deezer search/artist lookups when resolving Plex play history → seed artist ids. */
const MAX_PLEX_SEED_DEEZER_LOOKUPS = 24;

function isPlexPlayHistoryRecommendationsEnabled() {
  try {
    return Number(getRecSettingsStmt.get()?.plex_play_history_recommendations) === 1;
  } catch {
    return false;
  }
}

function loadFollowedArtistIdSet(userId) {
  const uid = String(userId);
  const arRows = db
    .prepare(
      `
    SELECT artist_id
    FROM followed_artists
    WHERE user_id = ? AND follow_status = 'active'
  `,
    )
    .all(uid);
  return new Set(arRows.map((r) => String(r.artist_id).trim()).filter(Boolean));
}

/**
 * Map Plex play rows (artist names, recent-first) to Deezer artist ids for recommendation seeds.
 * @param {{ artist: string, title?: string, viewedAt?: number }[]} playRows
 * @returns {Promise<string[]>}
 */
async function resolveDeezerArtistIdsFromPlexPlayRows(playRows) {
  const rows = Array.isArray(playRows) ? playRows : [];
  const orderedIds = [];
  const seenId = new Set();
  for (const pr of rows) {
    if (orderedIds.length >= MAX_PLEX_SEED_DEEZER_LOOKUPS) {
      break;
    }
    const q = trimText(pr?.artist);
    if (!q) {
      continue;
    }
    try {
      const { results } = await deezer.searchArtists(q);
      const first = results?.[0];
      if (first?.id == null) {
        continue;
      }
      const idStr = String(first.id);
      if (seenId.has(idStr)) {
        continue;
      }
      seenId.add(idStr);
      orderedIds.push(idStr);
    } catch (e) {
      console.warn('recommendations Plex seed artist lookup', q, e?.message || e);
    }
  }
  return orderedIds;
}

/** Only fetch top tracks for this many recommended artists (then shuffle pool → 20). */
const MAX_ARTISTS_FOR_TOP_TRACK_FETCH = 12;

/** Stop early once we have enough candidates after filters (before dedupe to final 20). */
const TARGET_TRACK_POOL_STOP = 56;

/**
 * Random track picks from Deezer top tracks of each recommended artist (same list as Discover “Recommended artists”).
 * @param {string} userId
 * @param {{ id: number|string, name?: string, picture?: string|null, type?: string }[]} recommendedArtists
 * @returns {Promise<object[]>}
 */
async function buildTrackRecommendationsFromRecommendedArtists(userId, recommendedArtists) {
  const uid = String(userId);
  const artists = Array.isArray(recommendedArtists) ? recommendedArtists : [];
  if (artists.length === 0) {
    return [];
  }

  const requested = loadRequestedDeezerIdsForUser(uid);
  const seenTrackIds = new Set();
  const pool = [];

  const slice = artists.slice(0, MAX_ARTISTS_FOR_TOP_TRACK_FETCH);

  for (const a of slice) {
    if (pool.length >= TARGET_TRACK_POOL_STOP) {
      break;
    }
    const aid = a?.id;
    if (aid == null || String(aid).trim() === '') {
      continue;
    }
    try {
      const raw = await deezer.fetchArtistTopTracksRaw(aid, TOP_PER_RECOMMENDED_ARTIST);
      for (const tr of raw) {
        if (!tr || tr.id == null) {
          continue;
        }
        const idStr = String(tr.id);
        if (seenTrackIds.has(idStr)) {
          continue;
        }
        seenTrackIds.add(idStr);
        if (requested.has(idStr)) {
          continue;
        }
        if (isInLibraryByDeezerId(idStr)) {
          continue;
        }
        pool.push(deezer.shapeTrackFromDeezerApi(tr));
      }
    } catch (e) {
      console.warn('recommendations tracks from artist', aid, e?.message || e);
    }
  }

  shuffleInPlace(pool);
  return pool.slice(0, 20);
}

function shapeRelatedArtist(raw) {
  return {
    id: raw.id,
    name: trimText(raw.name) || 'Artist',
    picture: raw.picture_medium || raw.picture || null,
    type: 'artist',
  };
}

/**
 * Related-artist recommendations from Deezer seed artist ids (e.g. followed artists or Plex history).
 * @param {string[]} orderedSeedDeezerIds — candidate pool (order preserved when preserveSeedOrder)
 * @param {Set<string>|string[]} excludeRelatedIds — do not recommend these (e.g. followed + Plex seeds)
 * @param {{ preserveSeedOrder?: boolean }} [options]
 */
async function buildArtistRecommendationsFromDeezerSeeds(
  orderedSeedDeezerIds,
  excludeRelatedIds,
  options = {},
) {
  const pool = [...new Set((orderedSeedDeezerIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (pool.length === 0) {
    return [];
  }

  if (!options.preserveSeedOrder) {
    shuffleInPlace(pool);
  }

  const seeds = pool.slice(0, Math.min(MAX_RELATED_SEED_ARTISTS, pool.length));
  const exclude = new Set(
    [...excludeRelatedIds].map((x) => String(x).trim()).filter(Boolean),
  );

  const perSeedLists = [];
  for (const aid of seeds) {
    const list = [];
    try {
      const related = await deezer.fetchArtistRelatedRaw(aid, 40);
      for (const a of related) {
        if (!a?.id) {
          continue;
        }
        const idStr = String(a.id);
        if (exclude.has(idStr)) {
          continue;
        }
        list.push({ idStr, raw: a });
      }
    } catch (e) {
      console.warn('recommendations artist related', aid, e?.message || e);
    }
    perSeedLists.push(list);
  }

  const picked = new Set();
  const out = [];

  const cursors = perSeedLists.map(() => 0);
  while (out.length < 20) {
    let progressed = false;
    for (let s = 0; s < perSeedLists.length; s++) {
      if (out.length >= 20) {
        break;
      }
      const list = perSeedLists[s];
      let idx = cursors[s];
      while (idx < list.length) {
        const { idStr, raw } = list[idx];
        idx += 1;
        if (picked.has(idStr)) {
          continue;
        }
        picked.add(idStr);
        out.push(shapeRelatedArtist(raw));
        progressed = true;
        break;
      }
      cursors[s] = idx;
    }
    if (!progressed) {
      break;
    }
  }

  if (out.length >= 20) {
    return out;
  }

  /** @type {Map<string, { count: number, raw: object }>} */
  const acc = new Map();
  for (const list of perSeedLists) {
    for (const { idStr, raw } of list) {
      if (picked.has(idStr)) {
        continue;
      }
      const prev = acc.get(idStr);
      if (prev) {
        prev.count += 1;
      } else {
        acc.set(idStr, { count: 1, raw });
      }
    }
  }

  const rows = [...acc.values()].map((v) => ({
    count: v.count,
    artist: shapeRelatedArtist(v.raw),
  }));

  rows.sort((a, b) => b.count - a.count);
  const tail = [];
  let i = 0;
  while (i < rows.length) {
    const c = rows[i].count;
    let j = i + 1;
    while (j < rows.length && rows[j].count === c) {
      j++;
    }
    const chunk = rows.slice(i, j);
    shuffleInPlace(chunk);
    tail.push(...chunk);
    i = j;
  }

  for (const r of tail) {
    if (out.length >= 20) {
      break;
    }
    out.push(r.artist);
  }

  return out;
}

async function buildArtistRecommendationsForUser(userId) {
  const uid = String(userId);
  const followedSet = loadFollowedArtistIdSet(uid);
  const artistIds = [...followedSet];
  if (artistIds.length === 0) {
    return [];
  }
  return buildArtistRecommendationsFromDeezerSeeds(artistIds, followedSet, {
    preserveSeedOrder: false,
  });
}

function cacheFresh(row) {
  if (!row?.created_at) {
    return false;
  }
  const t = new Date(row.created_at.replace(' ', 'T')).getTime();
  return Number.isFinite(t) && Date.now() - t < getDiscoverCacheTtlMs();
}

async function refreshDiscoverRecommendationsCache(userId) {
  const uid = String(userId);
  const followedSet = loadFollowedArtistIdSet(uid);

  let artists = [];

  const plexRecsOn = isPlexPlayHistoryRecommendationsEnabled();
  const uctx = getUserRecoContextStmt.get(uid);
  const isPlexAuth =
    String(uctx?.auth_provider || '')
      .trim()
      .toLowerCase() === 'plex';
  const plexTok =
    typeof uctx?.plex_user_token === 'string' ? uctx.plex_user_token.trim() : '';

  if (plexRecsOn && isPlexAuth && plexTok) {
    try {
      const playRows = await fetchQualifyingPlexMusicPlayRows(plexTok);
      const seedIds = await resolveDeezerArtistIdsFromPlexPlayRows(playRows);
      if (seedIds.length > 0) {
        const exclude = new Set([...followedSet, ...seedIds]);
        artists = await buildArtistRecommendationsFromDeezerSeeds(seedIds, exclude, {
          preserveSeedOrder: true,
        });
      }
    } catch (e) {
      console.warn('[recommendations] Plex play history path failed:', e?.message || e);
    }
  }

  if (!Array.isArray(artists) || artists.length === 0) {
    artists = await buildArtistRecommendationsForUser(uid);
  }

  const tracks = await buildTrackRecommendationsFromRecommendedArtists(uid, artists);
  upsertCacheStmt.run({
    user_id: uid,
    track_data: JSON.stringify(tracks),
    artist_data: JSON.stringify(artists),
  });
  return { tracks, artists };
}

/**
 * @param {string} userId
 * @returns {Promise<{ tracks: object[], artists: object[], fromCache: boolean }>}
 */
async function getOrRefreshDiscoverRecommendations(userId) {
  const uid = String(userId);
  const row = getCacheStmt.get(uid);
  if (row && cacheFresh(row)) {
    try {
      return {
        tracks: JSON.parse(row.track_data || '[]'),
        artists: JSON.parse(row.artist_data || '[]'),
        fromCache: true,
      };
    } catch {
      // regenerate
    }
  }

  const { tracks, artists } = await refreshDiscoverRecommendationsCache(uid);
  return { tracks, artists, fromCache: false };
}

module.exports = {
  getOrRefreshDiscoverRecommendations,
  refreshDiscoverRecommendationsCache,
  buildTrackRecommendationsFromRecommendedArtists,
  buildArtistRecommendationsForUser,
  buildArtistRecommendationsFromDeezerSeeds,
};
