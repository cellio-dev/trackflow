/**
 * Plex Sync: optional PMS library refresh → TrackFlow Plex library scan → followed playlists → Plex.
 */

const { getDb } = require('../db');
const { getAvailabilitySettingsSync } = require('../services/libraryAvailability');
const { triggerPlexLibrarySectionRefresh } = require('../services/plex');
const { runPlexLibraryScanJob } = require('./plexLibraryScanJob');
const { runPlexPlaylistSyncCore } = require('./plexPlaylistSyncJob');

const db = getDb();

const plexSyncSettingsStmt = db.prepare(`
  SELECT job_plex_sync_enabled, plex_run_library_scan_before_sync
  FROM settings
  WHERE id = 1
`);

async function runPlexSyncJob() {
  const avail = getAvailabilitySettingsSync();
  if (!avail.plex_integration_enabled) {
    return { ok: false, skipped: true, reason: 'plex_integration_off' };
  }

  const s = plexSyncSettingsStmt.get();
  const jobOn = s?.job_plex_sync_enabled == null || Number(s.job_plex_sync_enabled) !== 0;
  if (!jobOn) {
    return { ok: false, skipped: true, reason: 'job_disabled' };
  }

  const out = { ok: true, steps: [] };

  if (Number(s?.plex_run_library_scan_before_sync) === 1) {
    await triggerPlexLibrarySectionRefresh();
    out.steps.push({ name: 'plex_server_library_refresh', ok: true });
  }

  const scanResult = await runPlexLibraryScanJob();
  out.steps.push({ name: 'plex_library_scan', ...scanResult });

  const playlistResult = await runPlexPlaylistSyncCore();
  out.steps.push({ name: 'plex_playlist_sync', ...playlistResult });

  return out;
}

module.exports = { runPlexSyncJob };
