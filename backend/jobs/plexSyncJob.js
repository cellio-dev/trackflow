/**
 * Plex Sync: optional PMS library refresh + filesystem library scan → Plex rating-key mapping → followed playlists.
 */

const { getDb } = require('../db');
const { getAvailabilitySettingsSync } = require('../services/libraryAvailability');
const { truncateJobErrorMessage } = require('../services/jobScheduleTelemetry');
const { triggerPlexLibrarySectionRefresh } = require('../services/plex');
const { runLibraryScanJob } = require('./libraryScanJob');
const { runPlexLibraryScanJob } = require('./plexLibraryScanJob');
const { runPlexPlaylistSyncCore } = require('./plexPlaylistSyncJob');

const db = getDb();

const plexSyncSettingsStmt = db.prepare(`
  SELECT job_plex_sync_enabled, plex_run_library_scan_before_sync
  FROM settings
  WHERE id = 1
`);

function summarizePlaylistSyncFailure(pr) {
  const failed = Number(pr?.failed) || 0;
  const targets = Number(pr?.targets) || 0;
  const errs = Array.isArray(pr?.errors) ? pr.errors : [];
  const parts = [`Plex playlist sync: ${failed} of ${targets} playlist(s) failed`];
  for (const e of errs.slice(0, 3)) {
    const t = e?.title ? String(e.title) : '';
    const pid = e?.playlist_id ? String(e.playlist_id) : '';
    const m = e?.error != null ? String(e.error) : '';
    const bit = [t && `“${t}”`, pid && `id=${pid}`, m].filter(Boolean).join(' ');
    if (bit) {
      parts.push(bit);
    }
  }
  return truncateJobErrorMessage(parts.join('. ')) || 'Plex playlist sync failed';
}

/**
 * Completes all steps where possible; throws if a non-skipped step reports failure so job telemetry matches UI.
 * Skipped runs (integration off, job disabled) return without throwing.
 */
async function runPlexSyncJob() {
  const t0 = Date.now();
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
    console.log('[plexSyncJob] step: plex_server_library_refresh + filesystem_library_scan');
    await triggerPlexLibrarySectionRefresh();
    out.steps.push({ name: 'plex_server_library_refresh', ok: true });
    const fsScan = await runLibraryScanJob();
    out.steps.push({ name: 'filesystem_library_scan', ...fsScan });
    if (fsScan && fsScan.ok === false) {
      console.warn('[plexSyncJob] filesystem_library_scan:', fsScan.reason || fsScan);
    }
  }

  console.log('[plexSyncJob] step: plex_rating_key_sync');
  const rkResult = await runPlexLibraryScanJob();
  out.steps.push({ name: 'plex_rating_key_sync', ...rkResult });
  if (rkResult && rkResult.skipped) {
    console.log('[plexSyncJob] plex_rating_key_sync skipped');
  } else {
    console.log(
      `[plexSyncJob] plex_rating_key_sync done plexTracks=${rkResult?.plexTracks ?? '?'} ratingKeyMatches=${rkResult?.ratingKeyMatches ?? '?'}`,
    );
  }

  console.log('[plexSyncJob] step: plex_playlist_sync');
  const playlistResult = await runPlexPlaylistSyncCore();
  out.steps.push({ name: 'plex_playlist_sync', ...playlistResult });

  if (playlistResult && playlistResult.skipped) {
    console.log('[plexSyncJob] plex_playlist_sync skipped:', playlistResult.reason || '');
  } else {
    console.log(
      `[plexSyncJob] plex_playlist_sync done targets=${playlistResult?.targets ?? 0} synced=${playlistResult?.synced ?? 0} failed=${playlistResult?.failed ?? 0} (${Date.now() - t0}ms total)`,
    );
  }

  if (playlistResult && !playlistResult.skipped && playlistResult.ok === false) {
    const msg = summarizePlaylistSyncFailure(playlistResult);
    console.error('[plexSyncJob]', msg);
    const err = new Error(msg);
    err.plexSyncPayload = out;
    throw err;
  }

  return out;
}

module.exports = { runPlexSyncJob };
