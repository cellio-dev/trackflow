// Deezer track search service.
// Keep this focused on API calls/data shaping only.

/** Artist `/top` limit for the artist page and follow sync (must stay in sync). */
const ARTIST_TOP_TRACKS_LIMIT = 20;

/** Space out Deezer calls (public API quota); all `api.deezer.com` requests go through the gate. */
const DEEZER_CALL_GAP_MS = 120;

const DEEZER_QUOTA_MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableDeezerLimit(err, status) {
  if (status === 429 || status === 503 || status === 502) {
    return true;
  }
  const msg = String(err?.message || '').toLowerCase();
  const type = String(err?.type || '').toLowerCase();
  if (type.includes('quota') || msg.includes('quota')) {
    return true;
  }
  if (msg.includes('rate limit') || msg.includes('too many requests')) {
    return true;
  }
  return false;
}

/** One in-flight chain: each request waits for the previous to finish (including retries) + gap. */
let deezerGate = Promise.resolve();

function withDeezerGate(fn) {
  const run = deezerGate.then(() => fn());
  deezerGate = run.then(
    () => sleep(DEEZER_CALL_GAP_MS),
    () => sleep(DEEZER_CALL_GAP_MS),
  );
  return run;
}

/**
 * GET JSON from api.deezer.com with global throttling and quota/rate-limit retries.
 * @param {string} url
 * @returns {Promise<object>}
 */
async function fetchDeezerJson(url) {
  return withDeezerGate(() => fetchDeezerJsonInner(url));
}

async function fetchDeezerJsonInner(url) {
  for (let attempt = 0; attempt < DEEZER_QUOTA_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(url);
    let data;
    try {
      data = await response.json();
    } catch {
      if (isRetriableDeezerLimit(null, response.status) && attempt + 1 < DEEZER_QUOTA_MAX_ATTEMPTS) {
        await sleep(750 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Deezer API request failed with status ${response.status}`);
      }
      throw new Error('Invalid JSON from Deezer API');
    }

    const err = data?.error;
    if (err) {
      if (isRetriableDeezerLimit(err, response.status) && attempt + 1 < DEEZER_QUOTA_MAX_ATTEMPTS) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const msg = err.message || String(err.type || 'Deezer error');
      throw new Error(msg);
    }

    if (!response.ok) {
      if (isRetriableDeezerLimit(null, response.status) && attempt + 1 < DEEZER_QUOTA_MAX_ATTEMPTS) {
        await sleep(750 * 2 ** attempt);
        continue;
      }
      throw new Error(`Deezer API request failed with status ${response.status}`);
    }

    return data;
  }

  throw new Error('Deezer API: max retries exceeded');
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function removeNullishFields(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== null && value !== undefined),
  );
}

function mapDuration(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function mapTrack(track, fallback = {}) {
  const artistPicture =
    track.artist?.picture_medium ||
    track.artist?.picture_small ||
    track.artist?.picture ||
    fallback.artistPicture ||
    null;
  return {
    id: track.id,
    title: trimText(track.title),
    artist: trimText(track.artist?.name ?? fallback.artist),
    artistId: track.artist?.id ?? fallback.artistId ?? null,
    artistPicture,
    album: trimText(track.album?.title ?? fallback.album),
    albumId: track.album?.id ?? fallback.albumId ?? null,
    albumCover:
      track.album?.cover_medium || track.album?.cover || fallback.albumCover || null,
    duration: mapDuration(track.duration),
    preview: track.preview || null,
  };
}

function simplifyTracks(tracks) {
  const safeTracks = Array.isArray(tracks) ? tracks : [];

  const results = safeTracks.slice(0, 20).map((track) => ({
    ...mapTrack(track),
    type: 'track',
  }));

  return { results };
}

function simplifyArtists(artists) {
  const safeArtists = Array.isArray(artists) ? artists : [];

  return {
    results: safeArtists.slice(0, 20).map((artist) => ({
      id: artist.id,
      name: trimText(artist.name),
      picture: artist.picture_medium || artist.picture || null,
      type: 'artist',
    })),
  };
}

function numForAlbumSort(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function trackCountFromAlbum(album) {
  return Number(album?.nb_tracks) || 0;
}

function normalizeAlbumGroupingFields(album) {
  const tracks = Number(album?.nb_tracks) || 0;
  const type = String(album?.record_type || '').toLowerCase().trim();
  return { tracks, type };
}

/**
 * Group A (real albums): type === 'album' OR tracks >= 8.
 * Hard exclude: tracks <= 3 → always B. Singles and EPs → always B.
 */
function isAlbumGroupA(album) {
  const { tracks, type } = normalizeAlbumGroupingFields(album);
  if (tracks <= 3) {
    return false;
  }
  if (type === 'single' || type === 'ep') {
    return false;
  }
  return type === 'album' || tracks >= 8;
}

/**
 * @param {{ album: object, index: number }} wrappedA
 * @param {{ album: object, index: number }} wrappedB
 * Rank DESC, fans DESC; then nb_tracks >= 6 before shorter releases; then original API order.
 */
function compareAlbumDiscoveryOrder(wrappedA, wrappedB) {
  const a = wrappedA.album;
  const b = wrappedB.album;
  const rankDiff = numForAlbumSort(b.rank) - numForAlbumSort(a.rank);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const fansDiff = numForAlbumSort(b.fans) - numForAlbumSort(a.fans);
  if (fansDiff !== 0) {
    return fansDiff;
  }
  const manyA = trackCountFromAlbum(a) >= 6 ? 1 : 0;
  const manyB = trackCountFromAlbum(b) >= 6 ? 1 : 0;
  const manyDiff = manyB - manyA;
  if (manyDiff !== 0) {
    return manyDiff;
  }
  return wrappedA.index - wrappedB.index;
}

/** Group A vs B via isAlbumGroupA; each group sorted, then [...A, ...B]. */
function orderAlbumsSearchAndDiscover(rawAlbums) {
  const safe = Array.isArray(rawAlbums) ? rawAlbums : [];
  const wrapped = safe.map((album, index) => ({ album, index }));
  const groupA = wrapped.filter((w) => isAlbumGroupA(w.album));
  const groupB = wrapped.filter((w) => !isAlbumGroupA(w.album));
  groupA.sort(compareAlbumDiscoveryOrder);
  groupB.sort(compareAlbumDiscoveryOrder);
  return [...groupA, ...groupB].map((w) => w.album);
}

function mapAlbumToSearchRow(album) {
  return {
    id: album.id,
    title: album.title,
    artist: album.artist?.name ?? null,
    artistId: album.artist?.id ?? null,
    cover: album.cover_medium || null,
    type: 'album',
  };
}

/**
 * @param {object[]} rawAlbums — Deezer album objects (search, editorial, genre releases)
 * @param {number} [maxResults=20]
 */
function formatAlbumResultsFromRaw(rawAlbums, maxResults = 20) {
  const ordered = orderAlbumsSearchAndDiscover(rawAlbums);
  const cap = Math.min(100, Math.max(1, Math.floor(Number(maxResults) || 20)));
  return {
    results: ordered.slice(0, cap).map(mapAlbumToSearchRow),
  };
}

function simplifyAlbums(albums, maxResults = 20) {
  return formatAlbumResultsFromRaw(albums, maxResults);
}

function simplifyPlaylists(playlists) {
  const safePlaylists = Array.isArray(playlists) ? playlists : [];

  return {
    results: safePlaylists.slice(0, 20).map((playlist) => ({
      id: playlist.id,
      title: playlist.title,
      picture: playlist.picture_medium || null,
      type: 'playlist',
    })),
  };
}

async function searchTracks(query, limit = 20) {
  const encodedQuery = encodeURIComponent(query);
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  const url = `https://api.deezer.com/search?q=${encodedQuery}&limit=${lim}`;

  const data = await fetchDeezerJson(url);
  const safe = Array.isArray(data.data) ? data.data : [];
  const results = safe.slice(0, lim).map((track) => ({
    ...mapTrack(track),
    type: 'track',
  }));
  return { results };
}

/**
 * GET /track/:id — album art, preview URL, canonical artist/album ids.
 * @param {string|number} trackId
 */
async function getTrackById(trackId) {
  const encoded = encodeURIComponent(String(trackId).trim());
  if (!encoded) {
    throw new Error('Track id required');
  }
  const url = `https://api.deezer.com/track/${encoded}`;

  const data = await fetchDeezerJson(url);

  return {
    ...mapTrack(data),
    type: 'track',
  };
}

/** Deezer API track object → discover/search row shape. */
function shapeTrackFromDeezerApi(track) {
  return {
    ...mapTrack(track),
    type: 'track',
  };
}

/**
 * Related artists (raw API rows).
 * @param {string|number} artistId
 * @param {number} [limit=25]
 */
async function fetchArtistRelatedRaw(artistId, limit = 25) {
  const encoded = encodeURIComponent(String(artistId).trim());
  if (!encoded) {
    throw new Error('Artist id required');
  }
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 25)));
  const url = `https://api.deezer.com/artist/${encoded}/related?limit=${lim}`;

  const data = await fetchDeezerJson(url);

  return Array.isArray(data.data) ? data.data : [];
}

/**
 * GET /artist/:id — canonical name and picture URLs.
 * Deezer often omits picture fields on nested `artist` in `/artist/:id/top` track rows; use this for UI headers.
 * @param {string|number} artistId
 */
async function getArtistById(artistId) {
  const encoded = encodeURIComponent(String(artistId).trim());
  if (!encoded) {
    throw new Error('Artist id required');
  }
  const url = `https://api.deezer.com/artist/${encoded}`;

  const data = await fetchDeezerJson(url);

  return {
    id: data.id,
    name: trimText(data.name),
    picture: data.picture_medium || data.picture_small || data.picture || null,
  };
}

async function getArtistTopTracks(artistId) {
  const encodedArtistId = encodeURIComponent(artistId);
  const url = `https://api.deezer.com/artist/${encodedArtistId}/top?limit=${ARTIST_TOP_TRACKS_LIMIT}`;

  const data = await fetchDeezerJson(url);
  return simplifyTracks(data.data);
}

/**
 * Raw Deezer track rows from artist top (for sync / bulk insert). Max 50 per API.
 * @param {string|number} artistId
 * @param {number} [limit=50]
 * @returns {Promise<object[]>}
 */
async function fetchArtistTopTracksRaw(artistId, limit = 50) {
  const encodedArtistId = encodeURIComponent(artistId);
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit) || 50)));
  const url = `https://api.deezer.com/artist/${encodedArtistId}/top?limit=${lim}`;

  const data = await fetchDeezerJson(url);

  return Array.isArray(data.data) ? data.data : [];
}

async function searchArtists(query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.deezer.com/search/artist?q=${encodedQuery}&limit=25`;

  const data = await fetchDeezerJson(url);
  return simplifyArtists(data.data);
}

async function searchAlbums(query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.deezer.com/search/album?q=${encodedQuery}&limit=25`;

  const data = await fetchDeezerJson(url);
  return formatAlbumResultsFromRaw(data.data, 20);
}

async function searchPlaylists(query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.deezer.com/search/playlist?q=${encodedQuery}&limit=25`;

  const data = await fetchDeezerJson(url);
  return simplifyPlaylists(data.data);
}

/**
 * All playlist track rows from Deezer (follows tracks.next pagination).
 * @returns {Promise<object[]>} raw track objects as returned by the API
 */
async function fetchPlaylistAllTracks(playlistId) {
  const encodedPlaylistId = encodeURIComponent(playlistId);
  const firstUrl = `https://api.deezer.com/playlist/${encodedPlaylistId}`;

  const playlist = await fetchDeezerJson(firstUrl);

  const out = [];
  let batch = Array.isArray(playlist.tracks?.data) ? playlist.tracks.data : [];
  out.push(...batch);
  let nextUrl = playlist.tracks?.next || null;

  while (nextUrl) {
    const page = await fetchDeezerJson(nextUrl);
    batch = Array.isArray(page.data) ? page.data : [];
    out.push(...batch);
    nextUrl = page.next || null;
  }

  return out;
}

async function getPlaylist(playlistId) {
  const encodedPlaylistId = encodeURIComponent(playlistId);
  const url = `https://api.deezer.com/playlist/${encodedPlaylistId}`;

  const data = await fetchDeezerJson(url);
  const rawTracks = Array.isArray(data.tracks?.data) ? data.tracks.data : [];

  return {
    id: data.id,
    title: trimText(data.title),
    picture: data.picture_medium || data.picture || null,
    tracks: rawTracks.map((track) => mapTrack(track)),
  };
}

async function getArtistAlbums(artistId) {
  const encodedArtistId = encodeURIComponent(artistId);
  const url = `https://api.deezer.com/artist/${encodedArtistId}/albums`;

  const data = await fetchDeezerJson(url);
  const albums = Array.isArray(data.data) ? data.data : [];

  return albums.map((album) =>
    removeNullishFields({
      id: album.id,
      title: trimText(album.title),
      cover: album.cover_medium || album.cover_small || album.cover,
    }),
  );
}

async function getChartTracks(limit = 20, index = 0) {
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const idx = Math.max(0, Math.floor(Number(index) || 0));
  const url = `https://api.deezer.com/chart/0/tracks?limit=${lim}&index=${idx}`;

  const data = await fetchDeezerJson(url);

  return simplifyTracks(data.data);
}

async function getChartPlaylists(limit = 20) {
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const url = `https://api.deezer.com/chart/0/playlists?limit=${lim}`;

  const data = await fetchDeezerJson(url);

  return simplifyPlaylists(data.data);
}

async function getChartArtists(limit = 20) {
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const url = `https://api.deezer.com/chart/0/artists?limit=${lim}`;

  const data = await fetchDeezerJson(url);

  return simplifyArtists(data.data);
}

async function getEditorialNewReleases(limit = 20) {
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const url = `https://api.deezer.com/editorial/0/releases?limit=${lim}`;

  const data = await fetchDeezerJson(url);

  return simplifyAlbums(data.data, lim);
}

/**
 * Deezer has no global "new tracks" chart. Editorial releases are albums; we take the first
 * track from each release (batched album fetches) for a "new tracks" row on Discover.
 * @param {number} [albumCardLimit=20] albums returned for the New albums UI
 * @param {number} [newTrackLimit=20] target track count
 * @returns {Promise<{ albumResults: { results: object[] }, newTrackRows: object[] }>}
 */
async function getEditorialNewReleasesAndNewTracks(albumCardLimit = 20, newTrackLimit = 20) {
  const ac = Math.min(100, Math.max(1, Math.floor(Number(albumCardLimit) || 20)));
  const tc = Math.min(100, Math.max(1, Math.floor(Number(newTrackLimit) || 20)));
  const fetchAlbums = Math.min(100, Math.max(ac, tc * 2, 24));
  const url = `https://api.deezer.com/editorial/0/releases?limit=${fetchAlbums}`;

  const data = await fetchDeezerJson(url);

  const rawAlbums = Array.isArray(data.data) ? data.data : [];
  const ordered = orderAlbumsSearchAndDiscover(rawAlbums);
  const albumResults = formatAlbumResultsFromRaw(ordered, ac);
  const albumIds = ordered.map((a) => a.id).filter((id) => id != null && id !== 0);

  const newTrackRows = await fetchFirstUniqueTracksFromAlbums(albumIds, tc, 5);

  return { albumResults, newTrackRows };
}

/**
 * @param {(string|number)[]} albumIds
 * @param {number} maxTracks
 * @param {number} [batchSize=5]
 * @returns {Promise<object[]>} track rows with type: 'track'
 */
async function fetchFirstUniqueTracksFromAlbums(albumIds, maxTracks, batchSize = 5) {
  const cap = Math.min(100, Math.max(1, Math.floor(Number(maxTracks) || 20)));
  const batch = Math.min(10, Math.max(1, Math.floor(Number(batchSize) || 5)));
  const out = [];
  const seen = new Set();

  for (let i = 0; i < albumIds.length && out.length < cap; i += batch) {
    const slice = albumIds.slice(i, i + batch);
    const settled = await Promise.allSettled(slice.map((id) => getAlbumTracks(id)));

    for (const s of settled) {
      if (out.length >= cap) {
        break;
      }
      if (s.status !== 'fulfilled' || !s.value?.tracks?.length) {
        continue;
      }
      const t = s.value.tracks[0];
      if (t?.id == null || seen.has(t.id)) {
        continue;
      }
      seen.add(t.id);
      out.push(t);
    }
  }

  return out;
}

/** Deezer genre id for charts/editorial (not 0). */
function assertPositiveGenreId(genreId) {
  const gid = Math.floor(Number(genreId));
  if (!Number.isInteger(gid) || gid <= 0) {
    throw new Error('Invalid genre id');
  }
  return gid;
}

async function getChartTracksForGenre(genreId, limit = 20, index = 0) {
  const gid = assertPositiveGenreId(genreId);
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const idx = Math.max(0, Math.floor(Number(index) || 0));
  const url = `https://api.deezer.com/chart/${encodeURIComponent(String(gid))}/tracks?limit=${lim}&index=${idx}`;

  const data = await fetchDeezerJson(url);

  return simplifyTracks(data.data);
}

/**
 * Deezer's GET /genre/:id/artists (and chart/:id/artists) returns the same global list for every genre.
 * Popular artists per genre are derived from chart/:id/tracks: first-seen artists, chart order.
 */
function popularArtistsFromGenreChartTrackRows(rawTracks, maxArtists) {
  const cap = Math.min(100, Math.max(1, Math.floor(Number(maxArtists) || 20)));
  const safe = Array.isArray(rawTracks) ? rawTracks : [];
  const seen = new Set();
  const results = [];
  for (const track of safe) {
    const a = track?.artist;
    if (!a || a.id == null || a.id === 0) {
      continue;
    }
    const id = a.id;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    results.push({
      id: a.id,
      name: trimText(a.name) || 'Artist',
      picture: a.picture_medium || a.picture || null,
      type: 'artist',
    });
    if (results.length >= cap) {
      break;
    }
  }
  return { results };
}

/**
 * One chart request: trending tracks (first N) + unique artists from the same chart (needs extra rows for dedupe).
 * @returns {Promise<{ trendingTracks: { results: object[] }, popularArtists: { results: object[] } }>}
 */
async function getGenreTrendingTracksAndPopularArtistsFromChart(
  genreId,
  trackLimit = 20,
  artistLimit = 20,
) {
  const gid = assertPositiveGenreId(genreId);
  const tl = Math.min(100, Math.max(1, Math.floor(Number(trackLimit) || 20)));
  const al = Math.min(100, Math.max(1, Math.floor(Number(artistLimit) || 20)));
  const fetchLimit = Math.min(100, Math.max(tl, al * 4));
  const url = `https://api.deezer.com/chart/${encodeURIComponent(String(gid))}/tracks?limit=${fetchLimit}&index=0`;

  const data = await fetchDeezerJson(url);

  const raw = Array.isArray(data.data) ? data.data : [];
  return {
    trendingTracks: simplifyTracks(raw),
    popularArtists: popularArtistsFromGenreChartTrackRows(raw, al),
  };
}

async function getChartPlaylistsForGenre(genreId, limit = 20) {
  const gid = assertPositiveGenreId(genreId);
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const url = `https://api.deezer.com/chart/${encodeURIComponent(String(gid))}/playlists?limit=${lim}`;

  const data = await fetchDeezerJson(url);

  return simplifyPlaylists(data.data);
}

async function getEditorialReleasesForGenre(genreId, limit = 20) {
  const gid = assertPositiveGenreId(genreId);
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const url = `https://api.deezer.com/editorial/${encodeURIComponent(String(gid))}/releases?limit=${lim}`;

  const data = await fetchDeezerJson(url);

  return simplifyAlbums(data.data, lim);
}

/**
 * Genre editorial new releases (albums) plus first track per album for a "New tracks" row.
 * @returns {Promise<{ albumResults: { results: object[] }, newTrackRows: object[] }>}
 */
async function getEditorialReleasesForGenreAndNewTracks(
  genreId,
  albumCardLimit = 20,
  newTrackLimit = 20,
) {
  const gid = assertPositiveGenreId(genreId);
  const ac = Math.min(100, Math.max(1, Math.floor(Number(albumCardLimit) || 20)));
  const tc = Math.min(100, Math.max(1, Math.floor(Number(newTrackLimit) || 20)));
  const fetchAlbums = Math.min(100, Math.max(ac, tc * 2, 24));
  const url = `https://api.deezer.com/editorial/${encodeURIComponent(String(gid))}/releases?limit=${fetchAlbums}`;

  const data = await fetchDeezerJson(url);

  const rawAlbums = Array.isArray(data.data) ? data.data : [];
  const ordered = orderAlbumsSearchAndDiscover(rawAlbums);
  const albumResults = formatAlbumResultsFromRaw(ordered, ac);
  const albumIds = ordered.map((a) => a.id).filter((id) => id != null && id !== 0);

  const newTrackRows = await fetchFirstUniqueTracksFromAlbums(albumIds, tc, 5);

  return { albumResults, newTrackRows };
}

/** Popular mainstream genres for Discover (Deezer ids). */
const POPULAR_GENRE_IDS = [
  132, 84, 116, 152, 113, 165, 85, 106, 129, 464, 144, 197, 153, 98, 466, 169, 173,
];

const GENRE_CARD_BACKGROUNDS = [
  '#be123c',
  '#92400e',
  '#6d28d9',
  '#0f766e',
  '#c2410c',
  '#a21caf',
  '#4338ca',
  '#0e7490',
  '#b45309',
  '#15803d',
  '#7e22ce',
  '#b91c1c',
  '#1d4ed8',
  '#047857',
  '#a855f7',
  '#9a3412',
  '#4d7c0f',
];

async function fetchGenresCatalog() {
  const url = 'https://api.deezer.com/genre';
  const data = await fetchDeezerJson(url);
  return Array.isArray(data.data) ? data.data : [];
}

/**
 * Cards for Discover: id, name, picture, cardBackground, type: 'genre'
 * @returns {Promise<object[]>}
 */
async function getPopularGenresForDiscoverCards() {
  const all = await fetchGenresCatalog();
  const byId = new Map(all.map((g) => [g.id, g]));
  const out = [];
  for (let i = 0; i < POPULAR_GENRE_IDS.length; i++) {
    const id = POPULAR_GENRE_IDS[i];
    const raw = byId.get(id);
    if (!raw || raw.id === 0) {
      continue;
    }
    out.push({
      id: raw.id,
      name: trimText(raw.name) || 'Genre',
      picture: raw.picture_medium || raw.picture_small || raw.picture || null,
      cardBackground: GENRE_CARD_BACKGROUNDS[i % GENRE_CARD_BACKGROUNDS.length],
      type: 'genre',
    });
  }
  return out;
}

async function getGenreById(genreId) {
  const gid = assertPositiveGenreId(genreId);
  const url = `https://api.deezer.com/genre/${encodeURIComponent(String(gid))}`;
  const data = await fetchDeezerJson(url);
  return {
    id: data.id,
    name: trimText(data.name) || 'Genre',
    picture: data.picture_medium || data.picture_small || data.picture || null,
    type: 'genre',
  };
}

async function getAlbumTracks(albumId) {
  const encodedAlbumId = encodeURIComponent(albumId);
  const url = `https://api.deezer.com/album/${encodedAlbumId}`;

  const data = await fetchDeezerJson(url);
  const albumTitle = trimText(data.title);
  const artist = trimText(data.artist?.name);
  const artistId = data.artist?.id;
  const cover = data.cover_medium || data.cover_small || data.cover;
  const rawTracks = Array.isArray(data.tracks?.data) ? data.tracks.data : [];

  const tracks = rawTracks.map((track) => ({
    ...mapTrack(track, {
      artist,
      artistId,
      album: albumTitle,
      albumCover: cover,
      albumId: data.id,
    }),
    type: 'track',
  }));

  return {
    albumTitle,
    artist,
    artistId,
    cover,
    tracks,
  };
}

module.exports = {
  ARTIST_TOP_TRACKS_LIMIT,
  fetchDeezerJson,
  searchTracks,
  searchArtists,
  searchAlbums,
  searchPlaylists,
  getTrackById,
  shapeTrackFromDeezerApi,
  getPlaylist,
  fetchPlaylistAllTracks,
  fetchArtistRelatedRaw,
  getArtistById,
  getArtistTopTracks,
  fetchArtistTopTracksRaw,
  getArtistAlbums,
  getAlbumTracks,
  getChartTracks,
  getChartPlaylists,
  getChartArtists,
  getEditorialNewReleases,
  getEditorialNewReleasesAndNewTracks,
  getChartTracksForGenre,
  getChartPlaylistsForGenre,
  getGenreTrendingTracksAndPopularArtistsFromChart,
  getEditorialReleasesForGenre,
  getEditorialReleasesForGenreAndNewTracks,
  getPopularGenresForDiscoverCards,
  getGenreById,
};

