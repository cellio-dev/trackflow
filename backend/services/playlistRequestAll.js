// Bulk request all tracks from a Deezer playlist (idempotent by deezer_id; skips library file matches).

const { getDb } = require('../db');
const { fetchPlaylistAllTracks } = require('./deezer');
const { ingestRawDeezerTracks } = require('./syncTrackRequests');

const db = getDb();

const getAutoApproveSettingStmt = db.prepare(`
  SELECT auto_approve
  FROM settings
  WHERE id = 1
`);

/**
 * @param {string} playlistId — Deezer playlist id
 * @param {{ userId?: string }} [options]
 * @returns {Promise<{ total_tracks: number, newly_requested: number, skipped_existing: number, skipped_in_library: number, skipped_in_plex: number }>}
 */
async function requestAllTracksFromPlaylist(playlistId, options = {}) {
  const userId = options.userId != null ? String(options.userId) : '1';
  const rawTracks = await fetchPlaylistAllTracks(playlistId);

  const autoApproveEnabled = Boolean(getAutoApproveSettingStmt.get()?.auto_approve);

  return ingestRawDeezerTracks(rawTracks, {
    userId,
    requestType: 'Playlist',
    syncAutoApprove: false,
    globalAutoApprove: autoApproveEnabled,
  });
}

module.exports = {
  requestAllTracksFromPlaylist,
};
