// Settings API — stored in SQLite `settings` table.

const path = require('path');
const express = require('express');
const { getDb } = require('../db');
const {
  DEFAULT_PATTERN,
  normalizePatternString,
  validateFileNamingPattern,
  previewFileNamingPattern,
} = require('../services/fileNaming');
const { getFileNamingPattern } = require('../services/appSettings');
const {
  MIN_DISCOVER_CACHE_REFRESH_MINUTES,
  MAX_DISCOVER_CACHE_REFRESH_MINUTES,
  DEFAULT_DISCOVER_CACHE_REFRESH_MINUTES,
} = require('../services/discoverCacheSettings');

const router = express.Router();
const db = getDb();
const {
  withJobTelemetry,
  withJobTelemetrySync,
  JOB_KEYS,
  buildJobScheduleStatusPayload,
} = require('../services/jobScheduleTelemetry');

const DEFAULT_PREFERRED_FORMAT = 'prefer_mp3';
const ALLOWED_PREFERRED_FORMATS = new Set([
  'prefer_mp3',
  'prefer_flac',
  'mp3',
  'flac',
]);

const MIN_CONCURRENT_DOWNLOADS = 1;
const MAX_CONCURRENT_DOWNLOADS_CAP = 50;

const MIN_DOWNLOAD_ATTEMPTS = 1;
const MAX_DOWNLOAD_ATTEMPTS_CAP = 20;
const DEFAULT_DOWNLOAD_ATTEMPTS = 3;

const getSettingsStmt = db.prepare(`SELECT * FROM settings WHERE id = 1`);

const updateSettingsStmt = db.prepare(`
  UPDATE settings
  SET auto_approve = ?,
      preferred_format = ?,
      max_concurrent_downloads = ?,
      max_download_attempts = ?,
      track_match_mode = ?,
      plex_integration_enabled = ?,
      plex_detection_enabled = ?,
      require_plex_for_available = ?,
      file_naming_pattern = ?,
      plex_scan_interval_minutes = ?,
      library_scan_interval_minutes = ?,
      primary_library_path = ?,
      library_scan_paths_json = ?,
      library_path = ?,
      slskd_local_download_path = ?,
      plex_url = ?,
      plex_token = ?,
      plex_music_section_id = ?,
      plex_track_scan_size = ?,
      slskd_base_url = ?,
      slskd_api_key = ?,
      slskd_max_file_size_bytes = ?,
      slskd_search_create_stagger_ms = ?,
      slskd_auto_clear_completed_downloads = ?,
      trackflow_download_stagger_ms = ?,
      slskd_orphan_cleanup_enabled = ?,
      slskd_orphan_cleanup_interval_ms = ?,
      slskd_orphan_cleanup_interval_hours = ?,
      slskd_orphan_cleanup_interval_minutes = ?,
      follow_playlist_requires_approval = ?,
      follow_artist_requires_approval = ?,
      default_playlist_follow_sync_auto_approve = ?,
      default_artist_follow_sync_auto_approve = ?,
      follow_sync_interval_minutes = ?,
      request_history_retention_days = ?,
      discover_cache_refresh_minutes = ?,
      display_timezone = ?,
      plex_play_history_recommendations = ?,
      completed_request_auto_clear_days = ?,
      job_library_scan_enabled = ?,
      job_plex_scan_enabled = ?,
      job_plex_playlist_sync_enabled = ?,
      plex_playlist_sync_interval_minutes = ?,
      job_follow_sync_enabled = ?,
      job_discover_cache_enabled = ?,
      job_completed_request_clear_enabled = ?,
      job_completed_request_clear_interval_minutes = ?,
      job_plex_sync_enabled = ?,
      plex_run_library_scan_before_sync = ?,
      plex_auth_enabled = ?,
      plex_oauth_client_id = ?,
      smtp_host = ?,
      smtp_port = ?,
      smtp_user = ?,
      smtp_password = ?,
      smtp_secure = ?,
      email_from_address = ?,
      status_email_to = ?,
      job_status_email_enabled = ?,
      status_email_interval_minutes = ?,
      jukebox_requests_auto_approve = ?,
      jukebox_guest_queue_display_limit = ?,
      jukebox_guest_history_display_limit = ?
  WHERE id = 1
`);

/** Single Plex Sync job flag; legacy scan + playlist columns are kept in sync in persist. */
function resolveJobPlexSyncTripletForPersist(row) {
  if (row?.job_plex_sync_enabled != null && row.job_plex_sync_enabled !== '') {
    return Number(row.job_plex_sync_enabled) !== 0 ? 1 : 0;
  }
  const scan = row?.job_plex_scan_enabled == null || Number(row.job_plex_scan_enabled) !== 0;
  const pl = row?.job_plex_playlist_sync_enabled == null || Number(row.job_plex_playlist_sync_enabled) !== 0;
  return scan && pl ? 1 : 0;
}

function normalizePreferredFormat(value) {
  if (value == null || value === '') {
    return DEFAULT_PREFERRED_FORMAT;
  }
  const s = String(value);
  return ALLOWED_PREFERRED_FORMATS.has(s) ? s : null;
}

/** DB column kept for compatibility; matching is driven by the tracks cache (`tracksDb`). */
function persistedTrackMatchModeFromRow(row) {
  const s = String(row?.track_match_mode || '').toLowerCase();
  if (s === 'strict' || s === 'balanced' || s === 'loose') {
    return s;
  }
  return 'balanced';
}

function clampMaxConcurrentDownloads(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_CONCURRENT_DOWNLOADS) {
    return MIN_CONCURRENT_DOWNLOADS;
  }
  return Math.min(Math.floor(n), MAX_CONCURRENT_DOWNLOADS_CAP);
}

function clampMaxDownloadAttempts(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_DOWNLOAD_ATTEMPTS) {
    return DEFAULT_DOWNLOAD_ATTEMPTS;
  }
  return Math.min(Math.floor(n), MAX_DOWNLOAD_ATTEMPTS_CAP);
}

function clampJukeboxGuestListLimit(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) {
    return 15;
  }
  return Math.min(50, Math.max(3, n));
}

function rowFileNamingPattern(row) {
  const raw = row?.file_naming_pattern;
  if (typeof raw === 'string' && raw.trim()) {
    return normalizePatternString(raw);
  }
  return DEFAULT_PATTERN;
}

function clampScanIntervalMinutes(value, fallback, minM, maxM) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(maxM, Math.max(minM, Math.floor(n)));
}

function clampPlexTrackScanSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 300;
  }
  return Math.min(500, Math.max(50, Math.floor(n)));
}

function clampRequestHistoryRetentionDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(3650, Math.floor(n));
}

function clampDiscoverCacheRefreshMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_DISCOVER_CACHE_REFRESH_MINUTES;
  }
  return Math.min(
    MAX_DISCOVER_CACHE_REFRESH_MINUTES,
    Math.max(MIN_DISCOVER_CACHE_REFRESH_MINUTES, Math.floor(n)),
  );
}

function clampDisplayTimezone(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 80) {
    return 'UTC';
  }
  if (!/^[\w/+\-]+$/.test(s)) {
    return 'UTC';
  }
  return s;
}

function clampCompletedRequestAutoClearDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(3650, Math.floor(n));
}

function clampJobCompletedClearIntervalMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 1440;
  }
  return Math.min(10080, Math.max(5, Math.floor(n)));
}

const MIN_STATUS_EMAIL_INTERVAL_MINUTES = 240;
const MAX_STATUS_EMAIL_INTERVAL_MINUTES = 10080;

function clampStatusEmailIntervalMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 1440;
  }
  return Math.min(
    MAX_STATUS_EMAIL_INTERVAL_MINUTES,
    Math.max(MIN_STATUS_EMAIL_INTERVAL_MINUTES, Math.floor(n)),
  );
}

function clampStaggerMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 200;
  }
  return Math.min(60_000, Math.max(0, Math.floor(n)));
}

function nullableNonNegInt(value) {
  if (value == null || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return Math.floor(n);
}

/** 0/1 for INTEGER booleans; null/undefined → defaultOne. */
function int01(value, defaultOne = true) {
  if (value == null || value === '') {
    return defaultOne ? 1 : 0;
  }
  return Number(value) === 0 ? 0 : 1;
}

function effectivePrimaryLibraryPath(row) {
  const a = row?.primary_library_path != null ? String(row.primary_library_path).trim() : '';
  if (a) {
    return a;
  }
  const b = row?.library_path != null ? String(row.library_path).trim() : '';
  return b;
}

function parseLibraryScanPathsFromSettingsRow(row) {
  let raw = row?.library_scan_paths_json;
  if (raw == null || String(raw).trim() === '') {
    raw = '[]';
  }
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function rowToJson(row) {
  const preferredFormat =
    normalizePreferredFormat(row?.preferred_format) || DEFAULT_PREFERRED_FORMAT;
  const fnp = rowFileNamingPattern(row);
  const preview = previewFileNamingPattern(fnp);
  const plexToken = typeof row?.plex_token === 'string' ? row.plex_token.trim() : '';
  const slskdKey = typeof row?.slskd_api_key === 'string' ? row.slskd_api_key.trim() : '';

  const maxFileBytes = row?.slskd_max_file_size_bytes;
  const maxFileN = Number(maxFileBytes);

  return {
    auto_approve: Boolean(row?.auto_approve),
    preferred_format: preferredFormat,
    max_concurrent_downloads: clampMaxConcurrentDownloads(row?.max_concurrent_downloads),
    max_download_attempts: clampMaxDownloadAttempts(row?.max_download_attempts),
    plex_integration_enabled: Boolean(Number(row?.plex_integration_enabled)),
    file_naming_pattern: fnp,
    file_naming_preview:
      preview.ok && preview.relativePath ? preview.relativePath.split(path.sep).join('/') : null,
    plex_scan_interval_minutes: clampScanIntervalMinutes(row?.plex_scan_interval_minutes, 30, 5, 720),
    library_scan_interval_minutes: clampScanIntervalMinutes(
      row?.library_scan_interval_minutes,
      60,
      5,
      1440,
    ),
    primary_library_path: effectivePrimaryLibraryPath(row),
    library_paths: parseLibraryScanPathsFromSettingsRow(row),
    library_path: effectivePrimaryLibraryPath(row),
    slskd_local_download_path:
      typeof row?.slskd_local_download_path === 'string' ? row.slskd_local_download_path : '',
    plex_url: typeof row?.plex_url === 'string' ? row.plex_url.trim().replace(/\/+$/, '') : '',
    plex_music_section_id:
      typeof row?.plex_music_section_id === 'string' && row.plex_music_section_id.trim()
        ? row.plex_music_section_id.trim()
        : '4',
    plex_track_scan_size: clampPlexTrackScanSize(row?.plex_track_scan_size),
    plex_token_configured: Boolean(plexToken),
    plex_auth_enabled: Boolean(Number(row?.plex_auth_enabled)),
    slskd_base_url: typeof row?.slskd_base_url === 'string' ? row.slskd_base_url.trim() : '',
    slskd_api_key_configured: Boolean(slskdKey),
    slskd_max_file_size_bytes:
      Number.isFinite(maxFileN) && maxFileN > 0 ? Math.floor(maxFileN) : null,
    slskd_search_create_stagger_ms: clampStaggerMs(row?.slskd_search_create_stagger_ms),
    slskd_auto_clear_completed_downloads:
      row?.slskd_auto_clear_completed_downloads == null
        ? true
        : Number(row.slskd_auto_clear_completed_downloads) !== 0,
    trackflow_download_stagger_ms: nullableNonNegInt(row?.trackflow_download_stagger_ms),
    slskd_orphan_cleanup_enabled:
      row?.slskd_orphan_cleanup_enabled == null
        ? true
        : Number(row.slskd_orphan_cleanup_enabled) !== 0,
    slskd_orphan_cleanup_interval_ms: nullableNonNegInt(row?.slskd_orphan_cleanup_interval_ms),
    slskd_orphan_cleanup_interval_hours: nullableNonNegInt(row?.slskd_orphan_cleanup_interval_hours),
    slskd_orphan_cleanup_interval_minutes: (() => {
      const raw = row?.slskd_orphan_cleanup_interval_minutes;
      if (raw == null || String(raw).trim() === '') {
        return null;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        return null;
      }
      return Math.min(24 * 60, Math.floor(n));
    })(),
    follow_playlist_requires_approval: Boolean(Number(row?.follow_playlist_requires_approval)),
    follow_artist_requires_approval: Boolean(Number(row?.follow_artist_requires_approval)),
    follow_sync_interval_minutes: clampScanIntervalMinutes(
      row?.follow_sync_interval_minutes,
      120,
      5,
      1440,
    ),
    request_history_retention_days: clampRequestHistoryRetentionDays(row?.request_history_retention_days),
    discover_cache_refresh_minutes: clampDiscoverCacheRefreshMinutes(row?.discover_cache_refresh_minutes),
    display_timezone: clampDisplayTimezone(row?.display_timezone),
    plex_play_history_recommendations: Boolean(Number(row?.plex_play_history_recommendations)),
    completed_request_auto_clear_days: clampCompletedRequestAutoClearDays(
      row?.completed_request_auto_clear_days,
    ),
    job_library_scan_enabled:
      row?.job_library_scan_enabled == null ? true : Number(row.job_library_scan_enabled) !== 0,
    job_plex_sync_enabled: resolveJobPlexSyncTripletForPersist(row) === 1,
    job_plex_scan_enabled: resolveJobPlexSyncTripletForPersist(row) === 1,
    job_plex_playlist_sync_enabled: resolveJobPlexSyncTripletForPersist(row) === 1,
    plex_run_library_scan_before_sync: Boolean(Number(row?.plex_run_library_scan_before_sync)),
    plex_playlist_sync_interval_minutes: clampScanIntervalMinutes(
      row?.plex_playlist_sync_interval_minutes,
      60,
      5,
      720,
    ),
    job_follow_sync_enabled:
      row?.job_follow_sync_enabled == null ? true : Number(row.job_follow_sync_enabled) !== 0,
    job_discover_cache_enabled:
      row?.job_discover_cache_enabled == null ? true : Number(row.job_discover_cache_enabled) !== 0,
    job_completed_request_clear_enabled: Boolean(Number(row?.job_completed_request_clear_enabled)),
    job_completed_request_clear_interval_minutes: clampJobCompletedClearIntervalMinutes(
      row?.job_completed_request_clear_interval_minutes,
    ),
    follow_requests_auto_approve: !(
      Boolean(Number(row?.follow_playlist_requires_approval)) ||
      Boolean(Number(row?.follow_artist_requires_approval))
    ),
    jukebox_requests_auto_approve: Boolean(Number(row?.jukebox_requests_auto_approve)),
    smtp_host: typeof row?.smtp_host === 'string' ? row.smtp_host.trim() : '',
    smtp_port: (() => {
      const p = Number(row?.smtp_port);
      return Number.isFinite(p) && p >= 1 && p <= 65535 ? Math.floor(p) : 587;
    })(),
    smtp_user: typeof row?.smtp_user === 'string' ? row.smtp_user.trim() : '',
    smtp_password_configured: Boolean(
      typeof row?.smtp_password === 'string' && row.smtp_password.trim(),
    ),
    smtp_secure: Boolean(Number(row?.smtp_secure)),
    email_from_address:
      typeof row?.email_from_address === 'string' ? row.email_from_address.trim() : '',
    status_email_to: typeof row?.status_email_to === 'string' ? row.status_email_to.trim() : '',
    job_status_email_enabled: Boolean(Number(row?.job_status_email_enabled)),
    status_email_interval_minutes: clampStatusEmailIntervalMinutes(row?.status_email_interval_minutes),
    job_schedule_status: (() => {
      try {
        return buildJobScheduleStatusPayload(row);
      } catch (e) {
        console.error('job_schedule_status build failed:', e?.message || e);
        return null;
      }
    })(),
  };
}

function persistSettingsFromRow(row) {
  const preferredFormat =
    normalizePreferredFormat(row?.preferred_format) || DEFAULT_PREFERRED_FORMAT;
  const tmm = persistedTrackMatchModeFromRow(row);
  let fnp = rowFileNamingPattern(row);
  const checked = validateFileNamingPattern(fnp);
  if (!checked.ok) {
    fnp = DEFAULT_PATTERN;
  }

  const plexUrl =
    typeof row?.plex_url === 'string' ? row.plex_url.trim().replace(/\/+$/, '') : '';
  const plexTok = row?.plex_token == null ? null : String(row.plex_token);
  const plexSection =
    typeof row?.plex_music_section_id === 'string' && row.plex_music_section_id.trim()
      ? row.plex_music_section_id.trim()
      : '4';
  const slskdBase =
    typeof row?.slskd_base_url === 'string' ? row.slskd_base_url.trim().replace(/\/+$/, '') : '';
  const slskdKey = row?.slskd_api_key == null ? null : String(row.slskd_api_key);

  const maxFileRaw = row?.slskd_max_file_size_bytes;
  const maxFileN = Number(maxFileRaw);
  const maxFileOut =
    Number.isFinite(maxFileN) && maxFileN > 0 ? Math.floor(maxFileN) : null;

  const jobPlexSync = resolveJobPlexSyncTripletForPersist(row);

  const orphanMs = nullableNonNegInt(row?.slskd_orphan_cleanup_interval_ms);
  const orphanH = nullableNonNegInt(row?.slskd_orphan_cleanup_interval_hours);
  let orphanMin = null;
  if (row?.slskd_orphan_cleanup_interval_minutes != null && String(row.slskd_orphan_cleanup_interval_minutes).trim() !== '') {
    const n = Number(row.slskd_orphan_cleanup_interval_minutes);
    if (Number.isFinite(n) && n >= 1) {
      orphanMin = Math.min(24 * 60, Math.floor(n));
    }
  }

  const primaryForDb =
    row?.primary_library_path != null && String(row.primary_library_path).trim() !== ''
      ? String(row.primary_library_path).trim()
      : row?.library_path == null || String(row.library_path).trim() === ''
        ? null
        : String(row.library_path).trim();
  let libraryScanPathsJson = '[]';
  if (row?.library_scan_paths_json != null && String(row.library_scan_paths_json).trim() !== '') {
    libraryScanPathsJson = String(row.library_scan_paths_json);
  } else if (Array.isArray(row?.library_paths)) {
    libraryScanPathsJson = JSON.stringify(
      row.library_paths.map((x) => String(x).trim()).filter(Boolean),
    );
  }

  updateSettingsStmt.run(
    row?.auto_approve ? 1 : 0,
    preferredFormat,
    clampMaxConcurrentDownloads(row?.max_concurrent_downloads),
    clampMaxDownloadAttempts(row?.max_download_attempts),
    tmm,
    row?.plex_integration_enabled ? 1 : 0,
    0,
    0,
    fnp,
    clampScanIntervalMinutes(row?.plex_scan_interval_minutes, 30, 5, 720),
    clampScanIntervalMinutes(row?.library_scan_interval_minutes, 60, 5, 1440),
    primaryForDb,
    libraryScanPathsJson,
    primaryForDb,
    row?.slskd_local_download_path == null || String(row.slskd_local_download_path).trim() === ''
      ? null
      : String(row.slskd_local_download_path).trim(),
    plexUrl === '' ? null : plexUrl,
    plexTok === '' || plexTok == null ? null : plexTok,
    plexSection,
    clampPlexTrackScanSize(row?.plex_track_scan_size),
    slskdBase === '' ? null : slskdBase,
    slskdKey === '' || slskdKey == null ? null : slskdKey,
    maxFileOut,
    clampStaggerMs(row?.slskd_search_create_stagger_ms),
    int01(row?.slskd_auto_clear_completed_downloads, true),
    row?.trackflow_download_stagger_ms == null || String(row.trackflow_download_stagger_ms) === ''
      ? null
      : nullableNonNegInt(row.trackflow_download_stagger_ms),
    int01(row?.slskd_orphan_cleanup_enabled, true),
    orphanMs,
    orphanH,
    orphanMin,
    row?.follow_playlist_requires_approval ? 1 : 0,
    row?.follow_artist_requires_approval ? 1 : 0,
    row?.default_playlist_follow_sync_auto_approve ? 1 : 0,
    row?.default_artist_follow_sync_auto_approve ? 1 : 0,
    clampScanIntervalMinutes(row?.follow_sync_interval_minutes, 120, 5, 1440),
    clampRequestHistoryRetentionDays(row?.request_history_retention_days),
    clampDiscoverCacheRefreshMinutes(row?.discover_cache_refresh_minutes),
    clampDisplayTimezone(row?.display_timezone),
    row?.plex_play_history_recommendations ? 1 : 0,
    clampCompletedRequestAutoClearDays(row?.completed_request_auto_clear_days),
    int01(row?.job_library_scan_enabled, true),
    jobPlexSync,
    jobPlexSync,
    clampScanIntervalMinutes(row?.plex_playlist_sync_interval_minutes, 60, 5, 720),
    int01(row?.job_follow_sync_enabled, true),
    int01(row?.job_discover_cache_enabled, true),
    int01(row?.job_completed_request_clear_enabled, false),
    clampJobCompletedClearIntervalMinutes(row?.job_completed_request_clear_interval_minutes),
    jobPlexSync,
    int01(row?.plex_run_library_scan_before_sync, false),
    int01(row?.plex_auth_enabled, false),
    (() => {
      const v = row?.plex_oauth_client_id;
      if (v != null && String(v).trim()) {
        return String(v).trim();
      }
      return null;
    })(),
    (() => {
      const h = row?.smtp_host;
      if (h == null || String(h).trim() === '') {
        return null;
      }
      return String(h).trim();
    })(),
    (() => {
      const p = Number(row?.smtp_port);
      if (!Number.isFinite(p) || p < 1 || p > 65535) {
        return 587;
      }
      return Math.floor(p);
    })(),
    (() => {
      const u = row?.smtp_user;
      if (u == null || String(u).trim() === '') {
        return null;
      }
      return String(u).trim();
    })(),
    (() => {
      const pw = row?.smtp_password;
      if (pw == null || String(pw).trim() === '') {
        return null;
      }
      return String(pw);
    })(),
    int01(row?.smtp_secure, false),
    (() => {
      const v = row?.email_from_address;
      if (v == null || String(v).trim() === '') {
        return null;
      }
      return String(v).trim();
    })(),
    (() => {
      const v = row?.status_email_to;
      if (v == null || String(v).trim() === '') {
        return null;
      }
      return String(v).trim();
    })(),
    int01(row?.job_status_email_enabled, false),
    clampStatusEmailIntervalMinutes(row?.status_email_interval_minutes),
    int01(row?.jukebox_requests_auto_approve, false),
    clampJukeboxGuestListLimit(row?.jukebox_guest_queue_display_limit),
    clampJukeboxGuestListLimit(row?.jukebox_guest_history_display_limit),
  );
}

/**
 * Parallel download slots from DB (configure in Settings).
 */
function getMaxConcurrentDownloads() {
  try {
    const row = getSettingsStmt.get();
    return clampMaxConcurrentDownloads(row?.max_concurrent_downloads);
  } catch {
    return MIN_CONCURRENT_DOWNLOADS;
  }
}

function getMaxDownloadAttempts() {
  try {
    const row = getSettingsStmt.get();
    return clampMaxDownloadAttempts(row?.max_download_attempts);
  } catch {
    return DEFAULT_DOWNLOAD_ATTEMPTS;
  }
}

function getPreferredFormat() {
  try {
    const row = getSettingsStmt.get();
    return normalizePreferredFormat(row?.preferred_format) || DEFAULT_PREFERRED_FORMAT;
  } catch {
    return DEFAULT_PREFERRED_FORMAT;
  }
}

router.post('/preview-file-naming', (req, res) => {
  const raw = req.body?.pattern;
  const pattern = raw == null ? getFileNamingPattern() : String(raw);
  const result = previewFileNamingPattern(pattern);
  const payload = {
    ok: result.ok,
    error: result.ok ? undefined : result.error,
    preview_path: result.ok && result.relativePath ? result.relativePath.split(path.sep).join('/') : null,
  };
  return res.json(payload);
});

router.get('/', (req, res) => {
  try {
    const row = getSettingsStmt.get();
    return res.json(rowToJson(row));
  } catch (error) {
    console.error('Failed to read settings:', error.message);
    return res.status(500).json({ error: 'Failed to read settings' });
  }
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const hasAuto = Object.prototype.hasOwnProperty.call(body, 'auto_approve');
  const hasFormat = Object.prototype.hasOwnProperty.call(body, 'preferred_format');
  const hasMaxConcurrent = Object.prototype.hasOwnProperty.call(body, 'max_concurrent_downloads');
  const hasMaxAttempts = Object.prototype.hasOwnProperty.call(body, 'max_download_attempts');
  const hasPlexInt = Object.prototype.hasOwnProperty.call(body, 'plex_integration_enabled');
  const hasFileNaming = Object.prototype.hasOwnProperty.call(body, 'file_naming_pattern');
  const hasPlexScanMin = Object.prototype.hasOwnProperty.call(body, 'plex_scan_interval_minutes');
  const hasLibScanMin = Object.prototype.hasOwnProperty.call(body, 'library_scan_interval_minutes');
  const hasLibraryPath = Object.prototype.hasOwnProperty.call(body, 'library_path');
  const hasPrimaryLibraryPath = Object.prototype.hasOwnProperty.call(body, 'primary_library_path');
  const hasLibraryPaths = Object.prototype.hasOwnProperty.call(body, 'library_paths');
  const hasSlskdDl = Object.prototype.hasOwnProperty.call(body, 'slskd_local_download_path');
  const hasPlexUrl = Object.prototype.hasOwnProperty.call(body, 'plex_url');
  const hasPlexToken = Object.prototype.hasOwnProperty.call(body, 'plex_token');
  const hasPlexSection = Object.prototype.hasOwnProperty.call(body, 'plex_music_section_id');
  const hasPlexScanSize = Object.prototype.hasOwnProperty.call(body, 'plex_track_scan_size');
  const hasSlskdBase = Object.prototype.hasOwnProperty.call(body, 'slskd_base_url');
  const hasSlskdKey = Object.prototype.hasOwnProperty.call(body, 'slskd_api_key');
  const hasSlskdMax = Object.prototype.hasOwnProperty.call(body, 'slskd_max_file_size_bytes');
  const hasSlskdStagger = Object.prototype.hasOwnProperty.call(body, 'slskd_search_create_stagger_ms');
  const hasSlskdClear = Object.prototype.hasOwnProperty.call(body, 'slskd_auto_clear_completed_downloads');
  const hasDlStagger = Object.prototype.hasOwnProperty.call(body, 'trackflow_download_stagger_ms');
  const hasOrphanEn = Object.prototype.hasOwnProperty.call(body, 'slskd_orphan_cleanup_enabled');
  const hasOrphanMs = Object.prototype.hasOwnProperty.call(body, 'slskd_orphan_cleanup_interval_ms');
  const hasOrphanH = Object.prototype.hasOwnProperty.call(body, 'slskd_orphan_cleanup_interval_hours');
  const hasOrphanMin = Object.prototype.hasOwnProperty.call(body, 'slskd_orphan_cleanup_interval_minutes');
  const hasFollowPlApp = Object.prototype.hasOwnProperty.call(body, 'follow_playlist_requires_approval');
  const hasFollowArtApp = Object.prototype.hasOwnProperty.call(body, 'follow_artist_requires_approval');
  const hasFollowSyncMin = Object.prototype.hasOwnProperty.call(body, 'follow_sync_interval_minutes');
  const hasRequestHistoryRetention = Object.prototype.hasOwnProperty.call(
    body,
    'request_history_retention_days',
  );
  const hasDiscoverCacheRefresh = Object.prototype.hasOwnProperty.call(
    body,
    'discover_cache_refresh_minutes',
  );
  const hasDisplayTimezone = Object.prototype.hasOwnProperty.call(body, 'display_timezone');
  const hasPlexPlayHist = Object.prototype.hasOwnProperty.call(
    body,
    'plex_play_history_recommendations',
  );
  const hasCompletedAutoClear = Object.prototype.hasOwnProperty.call(
    body,
    'completed_request_auto_clear_days',
  );
  const hasJobLibScanEn = Object.prototype.hasOwnProperty.call(body, 'job_library_scan_enabled');
  const hasJobPlexSyncEn = Object.prototype.hasOwnProperty.call(body, 'job_plex_sync_enabled');
  const hasJobPlexScanEn = Object.prototype.hasOwnProperty.call(body, 'job_plex_scan_enabled');
  const hasJobPlexPlaylistSyncEn = Object.prototype.hasOwnProperty.call(
    body,
    'job_plex_playlist_sync_enabled',
  );
  const hasPlexRunLibScan = Object.prototype.hasOwnProperty.call(
    body,
    'plex_run_library_scan_before_sync',
  );
  const hasPlexPlaylistSyncMin = Object.prototype.hasOwnProperty.call(
    body,
    'plex_playlist_sync_interval_minutes',
  );
  const hasJobFollowSyncEn = Object.prototype.hasOwnProperty.call(body, 'job_follow_sync_enabled');
  const hasJobDiscoverEn = Object.prototype.hasOwnProperty.call(body, 'job_discover_cache_enabled');
  const hasJobCompletedClearEn = Object.prototype.hasOwnProperty.call(
    body,
    'job_completed_request_clear_enabled',
  );
  const hasJobCompletedClearInt = Object.prototype.hasOwnProperty.call(
    body,
    'job_completed_request_clear_interval_minutes',
  );
  const hasFollowReqAuto = Object.prototype.hasOwnProperty.call(body, 'follow_requests_auto_approve');
  const hasJukeboxReqAuto = Object.prototype.hasOwnProperty.call(body, 'jukebox_requests_auto_approve');
  const hasPlexAuth = Object.prototype.hasOwnProperty.call(body, 'plex_auth_enabled');
  const clearPlexToken = body.clear_plex_token === true;
  const clearSlskdKey = body.clear_slskd_api_key === true;

  const hasSmtpHost = Object.prototype.hasOwnProperty.call(body, 'smtp_host');
  const hasSmtpPort = Object.prototype.hasOwnProperty.call(body, 'smtp_port');
  const hasSmtpUser = Object.prototype.hasOwnProperty.call(body, 'smtp_user');
  const hasSmtpPassword = Object.prototype.hasOwnProperty.call(body, 'smtp_password');
  const hasSmtpSecure = Object.prototype.hasOwnProperty.call(body, 'smtp_secure');
  const hasEmailFrom = Object.prototype.hasOwnProperty.call(body, 'email_from_address');
  const hasStatusEmailTo = Object.prototype.hasOwnProperty.call(body, 'status_email_to');
  const hasJobStatusEmailEn = Object.prototype.hasOwnProperty.call(body, 'job_status_email_enabled');
  const hasStatusEmailInterval = Object.prototype.hasOwnProperty.call(
    body,
    'status_email_interval_minutes',
  );
  const clearSmtpPassword = body.clear_smtp_password === true;

  const hasEmailAny =
    hasSmtpHost ||
    hasSmtpPort ||
    hasSmtpUser ||
    hasSmtpPassword ||
    clearSmtpPassword ||
    hasSmtpSecure ||
    hasEmailFrom ||
    hasStatusEmailTo ||
    hasJobStatusEmailEn ||
    hasStatusEmailInterval;

  const hasJobAny =
    hasJobLibScanEn ||
    hasJobPlexSyncEn ||
    hasJobPlexScanEn ||
    hasJobPlexPlaylistSyncEn ||
    hasPlexPlaylistSyncMin ||
    hasJobFollowSyncEn ||
    hasJobDiscoverEn ||
    hasJobCompletedClearEn ||
    hasJobCompletedClearInt ||
    hasJobStatusEmailEn ||
    hasStatusEmailInterval;

  const hasLocaleMisc =
    hasDisplayTimezone ||
    hasPlexPlayHist ||
    hasCompletedAutoClear ||
    hasFollowReqAuto ||
    hasJukeboxReqAuto;

  const hasAnyIntegration =
    hasLibraryPath ||
    hasPrimaryLibraryPath ||
    hasLibraryPaths ||
    hasSlskdDl ||
    hasPlexUrl ||
    hasPlexToken ||
    clearPlexToken ||
    hasPlexSection ||
    hasPlexScanSize ||
    hasSlskdBase ||
    hasSlskdKey ||
    clearSlskdKey ||
    hasSlskdMax ||
    hasSlskdStagger ||
    hasSlskdClear ||
    hasDlStagger ||
    hasOrphanEn ||
    hasOrphanMs ||
    hasOrphanH ||
    hasOrphanMin;

  const hasFollowAny =
    hasFollowPlApp ||
    hasFollowArtApp ||
    hasFollowSyncMin ||
    hasRequestHistoryRetention ||
    hasDiscoverCacheRefresh ||
    hasFollowReqAuto;

  if (
    !hasAuto &&
    !hasFormat &&
    !hasMaxConcurrent &&
    !hasMaxAttempts &&
    !hasPlexInt &&
    !hasFileNaming &&
    !hasPlexScanMin &&
    !hasLibScanMin &&
    !hasAnyIntegration &&
    !hasFollowAny &&
    !hasJobAny &&
    !hasLocaleMisc &&
    !hasPlexAuth &&
    !hasPlexRunLibScan &&
    !hasEmailAny
  ) {
    return res.status(400).json({ error: 'No valid settings field provided' });
  }

  try {
    const current = getSettingsStmt.get();
    const next = { ...current };

    if (hasAuto) {
      if (typeof body.auto_approve !== 'boolean') {
        return res.status(400).json({ error: 'auto_approve must be a boolean' });
      }
      next.auto_approve = body.auto_approve ? 1 : 0;
    }
    if (hasFormat) {
      const normalized = normalizePreferredFormat(body.preferred_format);
      if (normalized == null) {
        return res.status(400).json({ error: 'Invalid preferred_format' });
      }
      next.preferred_format = normalized;
    }
    if (hasMaxConcurrent) {
      const n = Number(body.max_concurrent_downloads);
      if (
        !Number.isFinite(n) ||
        n < MIN_CONCURRENT_DOWNLOADS ||
        n > MAX_CONCURRENT_DOWNLOADS_CAP
      ) {
        return res.status(400).json({
          error: `max_concurrent_downloads must be an integer between ${MIN_CONCURRENT_DOWNLOADS} and ${MAX_CONCURRENT_DOWNLOADS_CAP}`,
        });
      }
      next.max_concurrent_downloads = clampMaxConcurrentDownloads(n);
    }
    if (hasMaxAttempts) {
      const n = Number(body.max_download_attempts);
      if (
        !Number.isFinite(n) ||
        n < MIN_DOWNLOAD_ATTEMPTS ||
        n > MAX_DOWNLOAD_ATTEMPTS_CAP
      ) {
        return res.status(400).json({
          error: `max_download_attempts must be an integer between ${MIN_DOWNLOAD_ATTEMPTS} and ${MAX_DOWNLOAD_ATTEMPTS_CAP}`,
        });
      }
      next.max_download_attempts = clampMaxDownloadAttempts(n);
    }
    if (hasPlexInt) {
      if (typeof body.plex_integration_enabled !== 'boolean') {
        return res.status(400).json({ error: 'plex_integration_enabled must be a boolean' });
      }
      next.plex_integration_enabled = body.plex_integration_enabled ? 1 : 0;
    }
    if (hasFileNaming) {
      if (typeof body.file_naming_pattern !== 'string') {
        return res.status(400).json({ error: 'file_naming_pattern must be a string' });
      }
      const normalized = normalizePatternString(body.file_naming_pattern);
      const checked = validateFileNamingPattern(normalized);
      if (!checked.ok) {
        return res.status(400).json({ error: checked.error || 'Invalid file_naming_pattern' });
      }
      next.file_naming_pattern = normalized;
    }
    if (hasPlexScanMin) {
      const n = Number(body.plex_scan_interval_minutes);
      if (!Number.isFinite(n) || n < 5 || n > 720) {
        return res.status(400).json({ error: 'plex_scan_interval_minutes must be 5–720' });
      }
      next.plex_scan_interval_minutes = Math.floor(n);
    }
    if (hasLibScanMin) {
      const n = Number(body.library_scan_interval_minutes);
      if (!Number.isFinite(n) || n < 5 || n > 1440) {
        return res.status(400).json({ error: 'library_scan_interval_minutes must be 5–1440' });
      }
      next.library_scan_interval_minutes = Math.floor(n);
    }

    if (hasLibraryPath) {
      next.library_path =
        body.library_path == null || String(body.library_path).trim() === ''
          ? null
          : String(body.library_path).trim();
      next.primary_library_path = next.library_path;
    }
    if (hasPrimaryLibraryPath) {
      if (body.primary_library_path == null || String(body.primary_library_path).trim() === '') {
        next.primary_library_path = null;
        next.library_path = null;
      } else {
        next.primary_library_path = String(body.primary_library_path).trim();
        next.library_path = next.primary_library_path;
      }
    }
    if (hasLibraryPaths) {
      if (!Array.isArray(body.library_paths)) {
        return res.status(400).json({ error: 'library_paths must be an array of strings' });
      }
      const cleaned = body.library_paths.map((x) => String(x).trim()).filter(Boolean);
      next.library_paths = cleaned;
      next.library_scan_paths_json = JSON.stringify(cleaned);
    }
    if (hasSlskdDl) {
      next.slskd_local_download_path =
        body.slskd_local_download_path == null || String(body.slskd_local_download_path).trim() === ''
          ? null
          : String(body.slskd_local_download_path).trim();
    }
    if (hasPlexUrl) {
      next.plex_url =
        body.plex_url == null || String(body.plex_url).trim() === ''
          ? null
          : String(body.plex_url).trim();
    }
    if (clearPlexToken) {
      next.plex_token = null;
    } else if (hasPlexToken) {
      if (typeof body.plex_token !== 'string') {
        return res.status(400).json({ error: 'plex_token must be a string' });
      }
      if (body.plex_token.trim()) {
        next.plex_token = body.plex_token.trim();
      }
    }
    if (hasPlexSection) {
      if (typeof body.plex_music_section_id !== 'string') {
        return res.status(400).json({ error: 'plex_music_section_id must be a string' });
      }
      next.plex_music_section_id =
        body.plex_music_section_id.trim() === '' ? '4' : body.plex_music_section_id.trim();
    }
    if (hasPlexScanSize) {
      const n = Number(body.plex_track_scan_size);
      if (!Number.isFinite(n) || n < 50 || n > 500) {
        return res.status(400).json({ error: 'plex_track_scan_size must be 50–500' });
      }
      next.plex_track_scan_size = Math.floor(n);
    }
    if (hasSlskdBase) {
      next.slskd_base_url =
        body.slskd_base_url == null || String(body.slskd_base_url).trim() === ''
          ? null
          : String(body.slskd_base_url).trim();
    }
    if (clearSlskdKey) {
      next.slskd_api_key = null;
    } else if (hasSlskdKey) {
      if (typeof body.slskd_api_key !== 'string') {
        return res.status(400).json({ error: 'slskd_api_key must be a string' });
      }
      if (body.slskd_api_key.trim()) {
        next.slskd_api_key = body.slskd_api_key.trim();
      }
    }
    if (hasSlskdMax) {
      if (body.slskd_max_file_size_bytes == null || body.slskd_max_file_size_bytes === '') {
        next.slskd_max_file_size_bytes = null;
      } else {
        const n = Number(body.slskd_max_file_size_bytes);
        if (!Number.isFinite(n) || n < 1_048_576) {
          return res.status(400).json({ error: 'slskd_max_file_size_bytes must be at least 1 MiB' });
        }
        next.slskd_max_file_size_bytes = Math.floor(n);
      }
    }
    if (hasSlskdStagger) {
      const n = Number(body.slskd_search_create_stagger_ms);
      if (!Number.isFinite(n) || n < 0 || n > 60_000) {
        return res.status(400).json({ error: 'slskd_search_create_stagger_ms must be 0–60000' });
      }
      next.slskd_search_create_stagger_ms = Math.floor(n);
    }
    if (hasSlskdClear) {
      if (typeof body.slskd_auto_clear_completed_downloads !== 'boolean') {
        return res
          .status(400)
          .json({ error: 'slskd_auto_clear_completed_downloads must be a boolean' });
      }
      next.slskd_auto_clear_completed_downloads = body.slskd_auto_clear_completed_downloads ? 1 : 0;
    }
    if (hasDlStagger) {
      if (body.trackflow_download_stagger_ms == null || body.trackflow_download_stagger_ms === '') {
        next.trackflow_download_stagger_ms = null;
      } else {
        const n = Number(body.trackflow_download_stagger_ms);
        if (!Number.isFinite(n) || n < 0 || n > 3600_000) {
          return res.status(400).json({ error: 'trackflow_download_stagger_ms must be 0–3600000' });
        }
        next.trackflow_download_stagger_ms = Math.floor(n);
      }
    }
    if (hasOrphanEn) {
      if (typeof body.slskd_orphan_cleanup_enabled !== 'boolean') {
        return res.status(400).json({ error: 'slskd_orphan_cleanup_enabled must be a boolean' });
      }
      next.slskd_orphan_cleanup_enabled = body.slskd_orphan_cleanup_enabled ? 1 : 0;
    }
    if (hasOrphanMs) {
      if (body.slskd_orphan_cleanup_interval_ms == null || body.slskd_orphan_cleanup_interval_ms === '') {
        next.slskd_orphan_cleanup_interval_ms = null;
      } else {
        const n = Number(body.slskd_orphan_cleanup_interval_ms);
        if (!Number.isFinite(n) || n < 60_000 || n > 24 * 60 * 60 * 1000) {
          return res.status(400).json({
            error: 'slskd_orphan_cleanup_interval_ms must be between 60000 and 86400000',
          });
        }
        next.slskd_orphan_cleanup_interval_ms = Math.floor(n);
      }
    }
    if (hasOrphanH) {
      if (body.slskd_orphan_cleanup_interval_hours == null || body.slskd_orphan_cleanup_interval_hours === '') {
        next.slskd_orphan_cleanup_interval_hours = null;
      } else {
        const n = Number(body.slskd_orphan_cleanup_interval_hours);
        if (!Number.isFinite(n) || n < 1 || n > 6) {
          return res.status(400).json({ error: 'slskd_orphan_cleanup_interval_hours must be 1–6' });
        }
        next.slskd_orphan_cleanup_interval_hours = Math.floor(n);
      }
    }
    if (hasOrphanMin) {
      if (body.slskd_orphan_cleanup_interval_minutes == null || body.slskd_orphan_cleanup_interval_minutes === '') {
        next.slskd_orphan_cleanup_interval_minutes = null;
      } else {
        const n = Number(body.slskd_orphan_cleanup_interval_minutes);
        if (!Number.isFinite(n) || n < 1 || n > 24 * 60) {
          return res.status(400).json({ error: 'slskd_orphan_cleanup_interval_minutes must be 1–1440' });
        }
        next.slskd_orphan_cleanup_interval_minutes = Math.floor(n);
        next.slskd_orphan_cleanup_interval_ms = null;
        next.slskd_orphan_cleanup_interval_hours = null;
      }
    }

    if (hasFollowPlApp) {
      if (typeof body.follow_playlist_requires_approval !== 'boolean') {
        return res.status(400).json({ error: 'follow_playlist_requires_approval must be a boolean' });
      }
      next.follow_playlist_requires_approval = body.follow_playlist_requires_approval ? 1 : 0;
    }
    if (hasFollowArtApp) {
      if (typeof body.follow_artist_requires_approval !== 'boolean') {
        return res.status(400).json({ error: 'follow_artist_requires_approval must be a boolean' });
      }
      next.follow_artist_requires_approval = body.follow_artist_requires_approval ? 1 : 0;
    }
    if (hasFollowSyncMin) {
      const n = Number(body.follow_sync_interval_minutes);
      if (!Number.isFinite(n) || n < 5 || n > 1440) {
        return res.status(400).json({ error: 'follow_sync_interval_minutes must be 5–1440' });
      }
      next.follow_sync_interval_minutes = Math.floor(n);
    }
    if (hasRequestHistoryRetention) {
      const n = Number(body.request_history_retention_days);
      if (!Number.isFinite(n) || n < 0 || n > 3650) {
        return res.status(400).json({ error: 'request_history_retention_days must be 0–3650' });
      }
      next.request_history_retention_days = Math.floor(n);
    }
    if (hasDiscoverCacheRefresh) {
      const n = Number(body.discover_cache_refresh_minutes);
      if (
        !Number.isFinite(n) ||
        n < MIN_DISCOVER_CACHE_REFRESH_MINUTES ||
        n > MAX_DISCOVER_CACHE_REFRESH_MINUTES
      ) {
        return res.status(400).json({
          error: `discover_cache_refresh_minutes must be ${MIN_DISCOVER_CACHE_REFRESH_MINUTES}–${MAX_DISCOVER_CACHE_REFRESH_MINUTES}`,
        });
      }
      next.discover_cache_refresh_minutes = clampDiscoverCacheRefreshMinutes(n);
    }

    if (hasDisplayTimezone) {
      if (typeof body.display_timezone !== 'string') {
        return res.status(400).json({ error: 'display_timezone must be a string' });
      }
      next.display_timezone = clampDisplayTimezone(body.display_timezone);
    }
    if (hasPlexPlayHist) {
      if (typeof body.plex_play_history_recommendations !== 'boolean') {
        return res.status(400).json({ error: 'plex_play_history_recommendations must be a boolean' });
      }
      next.plex_play_history_recommendations = body.plex_play_history_recommendations ? 1 : 0;
    }
    if (hasCompletedAutoClear) {
      const n = Number(body.completed_request_auto_clear_days);
      if (!Number.isFinite(n) || n < 0 || n > 3650) {
        return res.status(400).json({ error: 'completed_request_auto_clear_days must be 0–3650' });
      }
      next.completed_request_auto_clear_days = clampCompletedRequestAutoClearDays(n);
    }
    if (hasJobLibScanEn) {
      if (typeof body.job_library_scan_enabled !== 'boolean') {
        return res.status(400).json({ error: 'job_library_scan_enabled must be a boolean' });
      }
      next.job_library_scan_enabled = body.job_library_scan_enabled ? 1 : 0;
    }
    if (hasJobPlexSyncEn) {
      if (typeof body.job_plex_sync_enabled !== 'boolean') {
        return res.status(400).json({ error: 'job_plex_sync_enabled must be a boolean' });
      }
      const v = body.job_plex_sync_enabled ? 1 : 0;
      next.job_plex_sync_enabled = v;
      next.job_plex_scan_enabled = v;
      next.job_plex_playlist_sync_enabled = v;
    }
    if (hasJobPlexScanEn && !hasJobPlexSyncEn) {
      if (typeof body.job_plex_scan_enabled !== 'boolean') {
        return res.status(400).json({ error: 'job_plex_scan_enabled must be a boolean' });
      }
      next.job_plex_scan_enabled = body.job_plex_scan_enabled ? 1 : 0;
      const pl =
        next.job_plex_playlist_sync_enabled != null
          ? next.job_plex_playlist_sync_enabled
          : current.job_plex_playlist_sync_enabled;
      next.job_plex_sync_enabled =
        next.job_plex_scan_enabled && Number(pl) !== 0 ? 1 : 0;
    }
    if (hasJobPlexPlaylistSyncEn && !hasJobPlexSyncEn) {
      if (typeof body.job_plex_playlist_sync_enabled !== 'boolean') {
        return res.status(400).json({ error: 'job_plex_playlist_sync_enabled must be a boolean' });
      }
      next.job_plex_playlist_sync_enabled = body.job_plex_playlist_sync_enabled ? 1 : 0;
      const sc =
        next.job_plex_scan_enabled != null
          ? next.job_plex_scan_enabled
          : current.job_plex_scan_enabled;
      next.job_plex_sync_enabled =
        Number(sc) !== 0 && next.job_plex_playlist_sync_enabled ? 1 : 0;
    }
    if (hasPlexRunLibScan) {
      if (typeof body.plex_run_library_scan_before_sync !== 'boolean') {
        return res.status(400).json({ error: 'plex_run_library_scan_before_sync must be a boolean' });
      }
      next.plex_run_library_scan_before_sync = body.plex_run_library_scan_before_sync ? 1 : 0;
    }
    if (hasPlexPlaylistSyncMin) {
      const n = Number(body.plex_playlist_sync_interval_minutes);
      if (!Number.isFinite(n) || n < 5 || n > 720) {
        return res.status(400).json({ error: 'plex_playlist_sync_interval_minutes must be 5–720' });
      }
      next.plex_playlist_sync_interval_minutes = Math.floor(n);
    }
    if (hasJobFollowSyncEn) {
      if (typeof body.job_follow_sync_enabled !== 'boolean') {
        return res.status(400).json({ error: 'job_follow_sync_enabled must be a boolean' });
      }
      next.job_follow_sync_enabled = body.job_follow_sync_enabled ? 1 : 0;
    }
    if (hasJobDiscoverEn) {
      if (typeof body.job_discover_cache_enabled !== 'boolean') {
        return res.status(400).json({ error: 'job_discover_cache_enabled must be a boolean' });
      }
      next.job_discover_cache_enabled = body.job_discover_cache_enabled ? 1 : 0;
    }
    if (hasJobCompletedClearEn) {
      if (typeof body.job_completed_request_clear_enabled !== 'boolean') {
        return res.status(400).json({ error: 'job_completed_request_clear_enabled must be a boolean' });
      }
      next.job_completed_request_clear_enabled = body.job_completed_request_clear_enabled ? 1 : 0;
    }
    if (hasJobCompletedClearInt) {
      const n = Number(body.job_completed_request_clear_interval_minutes);
      if (!Number.isFinite(n) || n < 5 || n > 10080) {
        return res.status(400).json({
          error: 'job_completed_request_clear_interval_minutes must be 5–10080',
        });
      }
      next.job_completed_request_clear_interval_minutes = clampJobCompletedClearIntervalMinutes(n);
    }
    if (hasFollowReqAuto) {
      if (typeof body.follow_requests_auto_approve !== 'boolean') {
        return res.status(400).json({ error: 'follow_requests_auto_approve must be a boolean' });
      }
      if (body.follow_requests_auto_approve) {
        next.follow_playlist_requires_approval = 0;
        next.follow_artist_requires_approval = 0;
      } else {
        next.follow_playlist_requires_approval = 1;
        next.follow_artist_requires_approval = 1;
      }
    }
    if (hasJukeboxReqAuto) {
      if (typeof body.jukebox_requests_auto_approve !== 'boolean') {
        return res.status(400).json({ error: 'jukebox_requests_auto_approve must be a boolean' });
      }
      next.jukebox_requests_auto_approve = body.jukebox_requests_auto_approve ? 1 : 0;
    }
    if (hasPlexAuth) {
      if (typeof body.plex_auth_enabled !== 'boolean') {
        return res.status(400).json({ error: 'plex_auth_enabled must be a boolean' });
      }
      next.plex_auth_enabled = body.plex_auth_enabled ? 1 : 0;
    }

    if (hasSmtpHost) {
      if (body.smtp_host == null || String(body.smtp_host).trim() === '') {
        next.smtp_host = null;
      } else {
        next.smtp_host = String(body.smtp_host).trim();
      }
    }
    if (hasSmtpPort) {
      const p = Number(body.smtp_port);
      if (!Number.isFinite(p) || p < 1 || p > 65535) {
        return res.status(400).json({ error: 'smtp_port must be 1–65535' });
      }
      next.smtp_port = Math.floor(p);
    }
    if (hasSmtpUser) {
      if (body.smtp_user == null || String(body.smtp_user).trim() === '') {
        next.smtp_user = null;
      } else {
        next.smtp_user = String(body.smtp_user).trim();
      }
    }
    if (clearSmtpPassword) {
      next.smtp_password = null;
    } else if (hasSmtpPassword) {
      if (typeof body.smtp_password !== 'string') {
        return res.status(400).json({ error: 'smtp_password must be a string' });
      }
      if (body.smtp_password.trim()) {
        next.smtp_password = body.smtp_password.trim();
      }
    }
    if (hasSmtpSecure) {
      if (typeof body.smtp_secure !== 'boolean') {
        return res.status(400).json({ error: 'smtp_secure must be a boolean' });
      }
      next.smtp_secure = body.smtp_secure ? 1 : 0;
    }
    if (hasEmailFrom) {
      if (body.email_from_address == null || String(body.email_from_address).trim() === '') {
        next.email_from_address = null;
      } else {
        next.email_from_address = String(body.email_from_address).trim();
      }
    }
    if (hasStatusEmailTo) {
      if (body.status_email_to == null || String(body.status_email_to).trim() === '') {
        next.status_email_to = null;
      } else {
        next.status_email_to = String(body.status_email_to).trim();
      }
    }
    if (hasJobStatusEmailEn) {
      if (typeof body.job_status_email_enabled !== 'boolean') {
        return res.status(400).json({ error: 'job_status_email_enabled must be a boolean' });
      }
      next.job_status_email_enabled = body.job_status_email_enabled ? 1 : 0;
    }
    if (hasStatusEmailInterval) {
      const n = Number(body.status_email_interval_minutes);
      if (
        !Number.isFinite(n) ||
        n < MIN_STATUS_EMAIL_INTERVAL_MINUTES ||
        n > MAX_STATUS_EMAIL_INTERVAL_MINUTES
      ) {
        return res.status(400).json({
          error: `status_email_interval_minutes must be ${MIN_STATUS_EMAIL_INTERVAL_MINUTES}–${MAX_STATUS_EMAIL_INTERVAL_MINUTES}`,
        });
      }
      next.status_email_interval_minutes = clampStatusEmailIntervalMinutes(n);
    }

    next.plex_detection_enabled = 0;
    next.require_plex_for_available = 0;

    persistSettingsFromRow(next);

    const { invalidateLibraryAvailabilityCache } = require('../services/libraryAvailability');
    invalidateLibraryAvailabilityCache();

    return res.json(rowToJson(getSettingsStmt.get()));
  } catch (error) {
    console.error('Failed to update settings:', error.message);
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

router.post('/trigger-library-scan', async (req, res) => {
  try {
    const { runLibraryScanJob } = require('../jobs/libraryScanJob');
    const result = await withJobTelemetry(JOB_KEYS.library_scan, () => runLibraryScanJob());
    return res.json(result);
  } catch (error) {
    console.error('trigger-library-scan failed:', error.message);
    return res.status(500).json({ error: error.message || 'library scan failed' });
  }
});

router.post('/trigger-orphan-cleanup', async (req, res) => {
  try {
    const { runOrphanDownloadsCleanup } = require('../jobs/orphanDownloadsCleanup');
    const result = await withJobTelemetry(JOB_KEYS.orphan_cleanup, () => runOrphanDownloadsCleanup());
    return res.json(result);
  } catch (error) {
    console.error('trigger-orphan-cleanup failed:', error.message);
    return res.status(500).json({ error: error.message || 'orphan cleanup failed' });
  }
});

async function runPlexSyncWithTelemetry() {
  const { runPlexSyncJob } = require('../jobs/plexSyncJob');
  return withJobTelemetry(JOB_KEYS.plex_sync, () => runPlexSyncJob());
}

router.post('/trigger-plex-sync', async (req, res) => {
  try {
    const result = await runPlexSyncWithTelemetry();
    return res.json(result);
  } catch (error) {
    console.error('trigger-plex-sync failed:', error.message);
    return res.status(500).json({ error: error.message || 'Plex Sync failed' });
  }
});

/** @deprecated Use POST /api/settings/trigger-plex-sync */
router.post('/trigger-plex-scan', async (req, res) => {
  try {
    const result = await runPlexSyncWithTelemetry();
    return res.json(result);
  } catch (error) {
    console.error('trigger-plex-scan failed:', error.message);
    return res.status(500).json({ error: error.message || 'Plex Sync failed' });
  }
});

/** @deprecated Use POST /api/settings/trigger-plex-sync */
router.post('/trigger-plex-playlist-sync', async (req, res) => {
  try {
    const result = await runPlexSyncWithTelemetry();
    return res.json(result);
  } catch (error) {
    console.error('trigger-plex-playlist-sync failed:', error.message);
    return res.status(500).json({ error: error.message || 'Plex Sync failed' });
  }
});

router.post('/trigger-follow-sync', async (req, res) => {
  try {
    const { runFollowSyncJob } = require('../jobs/followSyncJob');
    const result = await withJobTelemetry(JOB_KEYS.follow_sync, () => runFollowSyncJob());
    return res.json(result);
  } catch (error) {
    console.error('trigger-follow-sync failed:', error.message);
    return res.status(500).json({ error: error.message || 'follow sync failed' });
  }
});

router.post('/trigger-discover-cache-refresh', async (req, res) => {
  try {
    const { runDiscoverCacheRefreshJob } = require('../jobs/discoverCacheRefreshJob');
    const result = await withJobTelemetry(JOB_KEYS.discover_cache, () => runDiscoverCacheRefreshJob());
    return res.json(result);
  } catch (error) {
    console.error('trigger-discover-cache-refresh failed:', error.message);
    return res.status(500).json({ error: error.message || 'discover cache refresh failed' });
  }
});

/**
 * Merge request body with stored settings so tests can use the form (unsaved) while reusing a stored SMTP password.
 */
function buildStatusEmailTestRow(stored, body) {
  const b = body || {};
  const host =
    b.smtp_host != null ? String(b.smtp_host).trim() : String(stored?.smtp_host || '').trim();
  const portRaw = b.smtp_port != null ? Number(b.smtp_port) : Number(stored?.smtp_port);
  const port =
    Number.isFinite(portRaw) && portRaw >= 1 && portRaw <= 65535 ? Math.floor(portRaw) : 587;
  const secure =
    typeof b.smtp_secure === 'boolean'
      ? b.smtp_secure
      : Number(stored?.smtp_secure) === 1;
  const user =
    b.smtp_user !== undefined && b.smtp_user !== null
      ? String(b.smtp_user).trim()
      : String(stored?.smtp_user || '').trim();
  let password = null;
  if (b.clear_smtp_password === true) {
    if (b.smtp_password != null && String(b.smtp_password).trim()) {
      password = String(b.smtp_password).trim();
    }
  } else if (b.smtp_password != null && String(b.smtp_password).trim()) {
    password = String(b.smtp_password).trim();
  } else if (stored?.smtp_password != null && String(stored.smtp_password).trim()) {
    password = String(stored.smtp_password);
  }
  const fromAddr =
    b.email_from_address != null
      ? String(b.email_from_address).trim()
      : String(stored?.email_from_address || '').trim();
  const to =
    b.status_email_to != null
      ? String(b.status_email_to).trim()
      : String(stored?.status_email_to || '').trim();

  return {
    smtp_host: host || null,
    smtp_port: port,
    smtp_secure: secure ? 1 : 0,
    smtp_user: user || null,
    smtp_password: password,
    email_from_address: fromAddr || null,
    status_email_to: to || null,
  };
}

router.post('/test-email', async (req, res) => {
  try {
    const { sendTestStatusEmail } = require('../jobs/statusEmailJob');
    const stored = getSettingsStmt.get();
    const row = buildStatusEmailTestRow(stored, req.body || {});
    await sendTestStatusEmail(row);
    return res.json({ ok: true });
  } catch (error) {
    console.error('test-email failed:', error.message);
    return res.status(400).json({ ok: false, error: error.message || 'Test email failed' });
  }
});

router.get('/app-version', (req, res) => {
  try {
    const { readLocalPackageVersion } = require('../services/trackflowUpdateCheck');
    return res.json({ version: readLocalPackageVersion() });
  } catch (error) {
    console.error('app-version failed:', error.message);
    return res.status(500).json({ error: 'Could not read app version' });
  }
});

router.post('/check-update', async (req, res) => {
  try {
    const { checkTrackflowUpdate } = require('../services/trackflowUpdateCheck');
    const result = await checkTrackflowUpdate();
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Update check failed' });
  }
});

router.post('/test-slskd', async (req, res) => {
  try {
    const { testSlskdConnection } = require('../services/slskd');
    await testSlskdConnection();
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'slskd test failed' });
  }
});

router.post('/test-plex', async (req, res) => {
  try {
    const { testPlexSettingsConnection } = require('../services/plex');
    await testPlexSettingsConnection();
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Plex test failed' });
  }
});

router.post('/trigger-status-email', async (req, res) => {
  try {
    const { runStatusEmailJob, isStatusEmailDeliveryReady } = require('../jobs/statusEmailJob');
    const row = getSettingsStmt.get();
    if (!isStatusEmailDeliveryReady(row)) {
      return res.status(400).json({
        error:
          'Enable the Status email job and set SMTP host, From address, and recipients under General → Email.',
      });
    }
    const result = await withJobTelemetry(JOB_KEYS.status_email, () => runStatusEmailJob());
    return res.json(result);
  } catch (error) {
    console.error('trigger-status-email failed:', error.message);
    return res.status(500).json({ error: error.message || 'Status email failed' });
  }
});

router.post('/trigger-clear-completed-requests', (req, res) => {
  try {
    const row = getSettingsStmt.get();
    const days = clampCompletedRequestAutoClearDays(row?.completed_request_auto_clear_days);
    if (days < 1) {
      return res.status(400).json({
        error: 'Set “Automatically clear completed requests” to at least 1 day in General first.',
      });
    }
    const { clearCompletedRequestsOlderThanDays } = require('../services/requestBulkActions');
    let summary;
    withJobTelemetrySync(JOB_KEYS.completed_request_clear, () => {
      summary = clearCompletedRequestsOlderThanDays({ older_than_days: days });
    });
    return res.json(summary);
  } catch (error) {
    console.error('trigger-clear-completed-requests failed:', error.message);
    return res.status(500).json({ error: error.message || 'clear failed' });
  }
});

module.exports = router;
module.exports.getPreferredFormat = getPreferredFormat;
module.exports.normalizePreferredFormat = normalizePreferredFormat;
module.exports.getMaxConcurrentDownloads = getMaxConcurrentDownloads;
module.exports.getMaxDownloadAttempts = getMaxDownloadAttempts;
module.exports.getFileNamingPattern = getFileNamingPattern;
module.exports.MAX_CONCURRENT_DOWNLOADS_CAP = MAX_CONCURRENT_DOWNLOADS_CAP;
module.exports.MAX_DOWNLOAD_ATTEMPTS_CAP = MAX_DOWNLOAD_ATTEMPTS_CAP;
