/**
 * Persist last run / result for scheduled jobs and expose next-run hints for Settings UI.
 */

const { getDb } = require('../db');
const {
  MIN_DISCOVER_CACHE_REFRESH_MINUTES,
  MAX_DISCOVER_CACHE_REFRESH_MINUTES,
  DEFAULT_DISCOVER_CACHE_REFRESH_MINUTES,
} = require('./discoverCacheSettings');
const { parseIntervalMs, isEnabled: isOrphanCleanupEnabled } = require('../jobs/orphanDownloadsCleanup');

const db = getDb();

/** SQLite TEXT is fine with long strings; keep UI/API payloads bounded. */
const MAX_JOB_LAST_ERROR_LENGTH = 2000;

const JOB_KEYS = Object.freeze({
  discover_cache: 'discover_cache',
  library_scan: 'library_scan',
  follow_sync: 'follow_sync',
  orphan_cleanup: 'orphan_cleanup',
  completed_request_clear: 'completed_request_clear',
  status_email: 'status_email',
  plex_sync: 'plex_sync',
});

const upsertStartStmt = db.prepare(`
  INSERT INTO job_run_telemetry (job_key, last_started_at)
  VALUES (@job_key, @last_started_at)
  ON CONFLICT(job_key) DO UPDATE SET last_started_at = excluded.last_started_at
`);

const updateEndStmt = db.prepare(`
  UPDATE job_run_telemetry
  SET last_finished_at = @last_finished_at,
      last_result = @last_result,
      last_error = @last_error
  WHERE job_key = @job_key
`);

const getAllStmt = db.prepare(`
  SELECT job_key, last_started_at, last_finished_at, last_result, last_error
  FROM job_run_telemetry
`);

function nowIso() {
  return new Date().toISOString();
}

function markJobStart(jobKey) {
  upsertStartStmt.run({ job_key: jobKey, last_started_at: nowIso() });
}

function truncateJobErrorMessage(msg) {
  const s = msg != null ? String(msg).trim() : '';
  if (!s) {
    return null;
  }
  if (s.length <= MAX_JOB_LAST_ERROR_LENGTH) {
    return s;
  }
  return `${s.slice(0, MAX_JOB_LAST_ERROR_LENGTH - 20)}… [truncated]`;
}

function markJobEnd(jobKey, ok, errorMessage) {
  updateEndStmt.run({
    job_key: jobKey,
    last_finished_at: nowIso(),
    last_result: ok ? 'success' : 'failure',
    last_error: truncateJobErrorMessage(errorMessage),
  });
}

/**
 * @template T
 * @param {string} jobKey
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withJobTelemetry(jobKey, fn) {
  markJobStart(jobKey);
  try {
    const out = await fn();
    markJobEnd(jobKey, true, null);
    return out;
  } catch (e) {
    markJobEnd(jobKey, false, e?.message || String(e));
    throw e;
  }
}

/**
 * @param {string} jobKey
 * @param {() => void} fn
 */
function withJobTelemetrySync(jobKey, fn) {
  markJobStart(jobKey);
  try {
    fn();
    markJobEnd(jobKey, true, null);
  } catch (e) {
    markJobEnd(jobKey, false, e?.message || String(e));
    throw e;
  }
}

function clamp(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) {
    return fallback;
  }
  return Math.min(hi, Math.max(lo, Math.floor(x)));
}

function clampCompletedDays(v) {
  return Math.max(0, Math.min(3650, Math.floor(Number(v) || 0)));
}

function clampCompletedClearIntervalMinutes(v) {
  return clamp(v, 5, 10080, 1440);
}

function discoverIntervalMs(settingsRow) {
  const m = clamp(
    settingsRow?.discover_cache_refresh_minutes,
    MIN_DISCOVER_CACHE_REFRESH_MINUTES,
    MAX_DISCOVER_CACHE_REFRESH_MINUTES,
    DEFAULT_DISCOVER_CACHE_REFRESH_MINUTES,
  );
  return m * 60_000;
}

function libraryIntervalMs(settingsRow) {
  const m = clamp(settingsRow?.library_scan_interval_minutes, 5, 1440, 60);
  return m * 60_000;
}

function plexIntervalMs(settingsRow) {
  const m = clamp(settingsRow?.plex_scan_interval_minutes, 5, 720, 30);
  return m * 60_000;
}

function followIntervalMs(settingsRow) {
  const m = clamp(settingsRow?.follow_sync_interval_minutes, 5, 1440, 120);
  return m * 60_000;
}

function completedClearIntervalMs(settingsRow) {
  const m = clampCompletedClearIntervalMinutes(settingsRow?.job_completed_request_clear_interval_minutes);
  return m * 60_000;
}

function statusEmailIntervalMs(settingsRow) {
  const m = clamp(settingsRow?.status_email_interval_minutes, 240, 10080, 1440);
  return m * 60_000;
}

function statusEmailScheduleReady(settingsRow) {
  const on = Number(settingsRow?.job_status_email_enabled) === 1;
  const host = String(settingsRow?.smtp_host || '').trim();
  const fromAddr = String(settingsRow?.email_from_address || '').trim();
  const to = String(settingsRow?.status_email_to || '').trim();
  return on && Boolean(host) && Boolean(fromAddr) && Boolean(to);
}

function statusEmailScheduleNote(settingsRow) {
  if (Number(settingsRow?.job_status_email_enabled) !== 1) {
    return 'Job disabled';
  }
  if (!String(settingsRow?.smtp_host || '').trim()) {
    return 'SMTP host not set';
  }
  if (!String(settingsRow?.email_from_address || '').trim()) {
    return 'From address not set';
  }
  if (!String(settingsRow?.status_email_to || '').trim()) {
    return 'Recipients not set';
  }
  return null;
}

function telemetryMap() {
  const rows = getAllStmt.all();
  const m = new Map();
  for (const r of rows) {
    m.set(r.job_key, r);
  }
  return m;
}

function nextScheduledIso(lastStartedIso, intervalMs, scheduleActive) {
  if (!scheduleActive || !lastStartedIso) {
    return null;
  }
  const ms = Number(intervalMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const t = Date.parse(lastStartedIso);
  if (!Number.isFinite(t)) {
    return null;
  }
  try {
    const d = new Date(t + ms);
    if (Number.isNaN(d.getTime())) {
      return null;
    }
    return d.toISOString();
  } catch {
    return null;
  }
}

/**
 * @param {object} settingsRow — raw `settings` row
 * @returns {Record<string, { last_run_at: string|null, last_result: string|null, last_error: string|null, next_scheduled_at: string|null, schedule_active: boolean, schedule_note: string|null }>}
 */
function buildJobScheduleStatusPayload(settingsRow) {
  const tel = telemetryMap();
  const plexIntegration = Number(settingsRow?.plex_integration_enabled) === 1;

  const discoverOn =
    settingsRow?.job_discover_cache_enabled == null || Number(settingsRow.job_discover_cache_enabled) !== 0;
  const libraryOn =
    settingsRow?.job_library_scan_enabled == null || Number(settingsRow.job_library_scan_enabled) !== 0;
  const followOn =
    settingsRow?.job_follow_sync_enabled == null || Number(settingsRow.job_follow_sync_enabled) !== 0;
  const plexSyncJobOn =
    settingsRow?.job_plex_sync_enabled == null || Number(settingsRow.job_plex_sync_enabled) !== 0;
  const completedJobOn = Number(settingsRow?.job_completed_request_clear_enabled) === 1;
  const completedDays = clampCompletedDays(settingsRow?.completed_request_auto_clear_days);
  const retryDays = clampCompletedDays(settingsRow?.failed_request_auto_retry_days);
  const orphanOn =
    settingsRow?.slskd_orphan_cleanup_enabled == null || Number(settingsRow.slskd_orphan_cleanup_enabled) !== 0;

  const orphanScheduleActive = orphanOn && isOrphanCleanupEnabled();

  function pack(key, intervalMs, scheduleActive, scheduleNote) {
    const row = tel.get(key);
    const lastStarted = row?.last_started_at ? String(row.last_started_at) : null;
    const lastFinished = row?.last_finished_at ? String(row.last_finished_at) : null;
    const lastResult = row?.last_result != null ? String(row.last_result) : null;
    const lastError = row?.last_error != null && String(row.last_error).trim() ? String(row.last_error) : null;

    return {
      last_run_at: lastFinished,
      last_result: lastResult,
      last_error: lastError,
      next_scheduled_at: nextScheduledIso(lastStarted, intervalMs, scheduleActive),
      schedule_active: scheduleActive,
      schedule_note: scheduleNote,
    };
  }

  return {
    [JOB_KEYS.discover_cache]: pack(
      JOB_KEYS.discover_cache,
      discoverIntervalMs(settingsRow),
      discoverOn,
      discoverOn ? null : 'Job disabled',
    ),
    [JOB_KEYS.library_scan]: pack(
      JOB_KEYS.library_scan,
      libraryIntervalMs(settingsRow),
      libraryOn,
      libraryOn ? null : 'Job disabled',
    ),
    [JOB_KEYS.follow_sync]: pack(
      JOB_KEYS.follow_sync,
      followIntervalMs(settingsRow),
      followOn,
      followOn ? null : 'Job disabled',
    ),
    [JOB_KEYS.orphan_cleanup]: pack(
      JOB_KEYS.orphan_cleanup,
      parseIntervalMs(),
      orphanScheduleActive,
      !orphanOn ? 'Job disabled' : !isOrphanCleanupEnabled() ? 'Interval or path not configured' : null,
    ),
    [JOB_KEYS.completed_request_clear]: pack(
      JOB_KEYS.completed_request_clear,
      completedClearIntervalMs(settingsRow),
      completedJobOn && (completedDays >= 1 || retryDays >= 1),
      !completedJobOn
        ? 'Job disabled'
        : completedDays < 1 && retryDays < 1
          ? 'Set completed clear/retry failed to >= 1 day (General)'
          : null,
    ),
    [JOB_KEYS.status_email]: pack(
      JOB_KEYS.status_email,
      statusEmailIntervalMs(settingsRow),
      statusEmailScheduleReady(settingsRow),
      statusEmailScheduleNote(settingsRow),
    ),
    [JOB_KEYS.plex_sync]: pack(
      JOB_KEYS.plex_sync,
      plexIntervalMs(settingsRow),
      plexSyncJobOn && plexIntegration,
      !plexSyncJobOn ? 'Job disabled' : !plexIntegration ? 'Plex integration off' : null,
    ),
  };
}

module.exports = {
  JOB_KEYS,
  MAX_JOB_LAST_ERROR_LENGTH,
  markJobStart,
  markJobEnd,
  truncateJobErrorMessage,
  withJobTelemetry,
  withJobTelemetrySync,
  buildJobScheduleStatusPayload,
};
