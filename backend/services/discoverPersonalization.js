const { getDb } = require('../db');
const { findPresentTrackForProbe } = require('./tracksDb');

function loadFollowedArtistIds(userId) {
  const rows = getDb()
    .prepare(
      `
    SELECT artist_id
    FROM followed_artists
    WHERE user_id = ? AND follow_status = 'active'
  `,
    )
    .all(String(userId));
  return new Set(rows.map((r) => String(r.artist_id).trim()).filter(Boolean));
}

function loadFollowedPlaylistIds(userId) {
  const rows = getDb()
    .prepare(
      `
    SELECT playlist_id
    FROM followed_playlists
    WHERE user_id = ? AND follow_status = 'active'
  `,
    )
    .all(String(userId));
  return new Set(rows.map((r) => String(r.playlist_id).trim()).filter(Boolean));
}

function trackAvailableInLibrary(track) {
  const id = track?.id;
  if (id == null || String(id).trim() === '') {
    return false;
  }
  return Boolean(findPresentTrackForProbe({ deezer_id: String(id).trim() }));
}

function filterTrackList(tracks) {
  return (Array.isArray(tracks) ? tracks : []).filter((t) => !trackAvailableInLibrary(t));
}

/**
 * Remove followed playlists/artists and in-library tracks from discover home payload.
 * Does not touch recently added (merged separately).
 */
function filterDiscoverHomePayloadForUser(userId, payload) {
  const fa = loadFollowedArtistIds(userId);
  const fp = loadFollowedPlaylistIds(userId);
  const p = payload && typeof payload === 'object' ? payload : {};

  return {
    ...p,
    trendingTracks: filterTrackList(p.trendingTracks),
    newTracks: filterTrackList(p.newTracks),
    recommendedTracks: filterTrackList(p.recommendedTracks),
    trendingPlaylists: (Array.isArray(p.trendingPlaylists) ? p.trendingPlaylists : []).filter(
      (pl) => pl?.id != null && !fp.has(String(pl.id)),
    ),
    popularArtists: (Array.isArray(p.popularArtists) ? p.popularArtists : []).filter(
      (a) => a?.id != null && !fa.has(String(a.id)),
    ),
    recommendedArtists: (Array.isArray(p.recommendedArtists) ? p.recommendedArtists : []).filter(
      (a) => a?.id != null && !fa.has(String(a.id)),
    ),
    newAlbums: (Array.isArray(p.newAlbums) ? p.newAlbums : []).filter((al) => {
      const aid = al?.artistId != null ? String(al.artistId).trim() : '';
      return !aid || !fa.has(aid);
    }),
    genres: Array.isArray(p.genres) ? p.genres : [],
  };
}

/** Same filtering for genre page payload (no genres / recommendations keys). */
function filterDiscoverGenrePayloadForUser(userId, payload) {
  const fa = loadFollowedArtistIds(userId);
  const fp = loadFollowedPlaylistIds(userId);
  const p = payload && typeof payload === 'object' ? payload : {};

  return {
    ...p,
    trendingTracks: filterTrackList(p.trendingTracks),
    newTracks: filterTrackList(p.newTracks),
    trendingPlaylists: (Array.isArray(p.trendingPlaylists) ? p.trendingPlaylists : []).filter(
      (pl) => pl?.id != null && !fp.has(String(pl.id)),
    ),
    popularArtists: (Array.isArray(p.popularArtists) ? p.popularArtists : []).filter(
      (a) => a?.id != null && !fa.has(String(a.id)),
    ),
    newAlbums: (Array.isArray(p.newAlbums) ? p.newAlbums : []).filter((al) => {
      const aid = al?.artistId != null ? String(al.artistId).trim() : '';
      return !aid || !fa.has(aid);
    }),
  };
}

module.exports = {
  filterDiscoverHomePayloadForUser,
  filterDiscoverGenrePayloadForUser,
  loadFollowedArtistIds,
  loadFollowedPlaylistIds,
  trackAvailableInLibrary,
};
