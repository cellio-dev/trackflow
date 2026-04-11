// Periodically add missing requests for followed playlists (all tracks) and artists (top tracks).

const { getDb } = require('../db');
const {
  fetchPlaylistAllTracks,
  fetchArtistTopTracksRaw,
  ARTIST_TOP_TRACKS_LIMIT,
} = require('../services/deezer');
const { ingestRawDeezerTracks } = require('../services/syncTrackRequests');
const { yieldToEventLoop } = require('../services/cooperativeYield');

function readFollowSyncSettings() {
  try {
    const row = getDb()
      .prepare(
        `SELECT auto_approve FROM settings WHERE id = 1`,
      )
      .get();
    return { globalAutoApprove: Boolean(row?.auto_approve) };
  } catch {
    return { globalAutoApprove: false };
  }
}

/**
 * @returns {Promise<{ playlists_processed: number, artists_processed: number, errors: string[] }>}
 */
async function runFollowSyncJob() {
  const db = getDb();
  const { globalAutoApprove } = readFollowSyncSettings();

  const listPl = db.prepare(`
    SELECT fp.id, fp.playlist_id, fp.user_id, fp.sync_auto_approve AS row_sync_auto
    FROM followed_playlists fp
    WHERE fp.follow_status = 'active'
  `);
  const listArt = db.prepare(`
    SELECT fa.id, fa.artist_id, fa.user_id, fa.sync_auto_approve AS row_sync_auto
    FROM followed_artists fa
    WHERE fa.follow_status = 'active'
  `);

  const touchPl = db.prepare(`UPDATE followed_playlists SET last_sync_at = datetime('now') WHERE id = ?`);
  const touchArt = db.prepare(`UPDATE followed_artists SET last_sync_at = datetime('now') WHERE id = ?`);

  const playlists = listPl.all();
  const artists = listArt.all();

  const errors = [];
  let playlists_processed = 0;
  let artists_processed = 0;

  for (const row of playlists) {
    await yieldToEventLoop();
    const playlistId = row.playlist_id != null ? String(row.playlist_id).trim() : '';
    if (!playlistId) {
      continue;
    }
    try {
      const rawTracks = await fetchPlaylistAllTracks(playlistId);
      await ingestRawDeezerTracks(rawTracks, {
        userId: String(row.user_id || '1'),
        requestType: 'Playlist',
        syncAutoApprove: Number(row.row_sync_auto) === 1,
        globalAutoApprove,
      });
      touchPl.run(row.id);
      playlists_processed += 1;
    } catch (e) {
      errors.push(`playlist ${playlistId}: ${e?.message || e}`);
    }
  }

  for (const row of artists) {
    await yieldToEventLoop();
    const artistId = row.artist_id != null ? String(row.artist_id).trim() : '';
    if (!artistId) {
      continue;
    }
    try {
      const rawTracks = await fetchArtistTopTracksRaw(artistId, ARTIST_TOP_TRACKS_LIMIT);
      await ingestRawDeezerTracks(rawTracks, {
        userId: String(row.user_id || '1'),
        requestType: 'Artist',
        syncAutoApprove: Number(row.row_sync_auto) === 1,
        globalAutoApprove,
      });
      touchArt.run(row.id);
      artists_processed += 1;
    } catch (e) {
      errors.push(`artist ${artistId}: ${e?.message || e}`);
    }
  }

  if (errors.length > 0) {
    console.warn('followSyncJob partial errors:', errors.slice(0, 5).join(' | '));
  }

  return { playlists_processed, artists_processed, errors };
}

module.exports = {
  runFollowSyncJob,
};
