/**
 * Recurring job: push followed playlists (plex_sync_enabled) to Plex for Plex-auth users.
 */

const { getDb } = require('../db');
const { getAvailabilitySettingsSync } = require('../services/libraryAvailability');
const { syncFollowedPlaylistToPlex } = require('../services/plexPlaylistSync');

const db = getDb();

const listSyncTargetsStmt = db.prepare(`
  SELECT
    fp.id,
    fp.playlist_id,
    fp.title,
    fp.picture,
    fp.user_id,
    fp.follow_status,
    fp.plex_sync_enabled,
    fp.plex_playlist_rating_key,
    u.plex_user_token
  FROM followed_playlists fp
  INNER JOIN users u ON CAST(fp.user_id AS INTEGER) = u.id
  WHERE fp.follow_status = 'active'
    AND IFNULL(fp.plex_sync_enabled, 0) = 1
    AND LOWER(IFNULL(u.auth_provider, '')) = 'plex'
    AND u.plex_user_token IS NOT NULL
    AND trim(u.plex_user_token) != ''
`);

const jobEnabledStmt = db.prepare(`
  SELECT job_plex_playlist_sync_enabled, job_plex_sync_enabled FROM settings WHERE id = 1
`);

/**
 * Sync followed playlists to Plex (no job-toggle check). Used by Plex Sync combined job.
 */
async function runPlexPlaylistSyncCore() {
  const avail = getAvailabilitySettingsSync();
  if (!avail.plex_integration_enabled) {
    return { ok: false, skipped: true, reason: 'plex_integration_off' };
  }

  const rows = listSyncTargetsStmt.all();
  let ok = 0;
  let failed = 0;
  const errors = [];

  for (const row of rows) {
    try {
      await syncFollowedPlaylistToPlex(row, row.plex_user_token);
      ok += 1;
    } catch (e) {
      failed += 1;
      const msg = e?.message || String(e);
      errors.push({ followed_id: row.id, error: msg });
      console.error('[plexPlaylistSyncJob]', row.id, msg);
    }
  }

  return {
    ok: true,
    targets: rows.length,
    synced: ok,
    failed,
    errors: errors.slice(0, 8),
  };
}

async function runPlexPlaylistSyncJob() {
  const avail = getAvailabilitySettingsSync();
  if (!avail.plex_integration_enabled) {
    return { ok: false, skipped: true, reason: 'plex_integration_off' };
  }

  const j = jobEnabledStmt.get();
  const syncOn = j?.job_plex_sync_enabled == null || Number(j.job_plex_sync_enabled) !== 0;
  const playlistOn =
    j?.job_plex_playlist_sync_enabled == null || Number(j.job_plex_playlist_sync_enabled) !== 0;
  if (!syncOn || !playlistOn) {
    return { ok: false, skipped: true, reason: 'job_disabled' };
  }

  return runPlexPlaylistSyncCore();
}

module.exports = { runPlexPlaylistSyncJob, runPlexPlaylistSyncCore };
