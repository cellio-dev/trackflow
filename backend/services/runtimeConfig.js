/**
 * Paths, Plex, and slskd integration: read from settings row, with env fallback for migration / containers.
 */

const { getDb } = require('../db');

const DEFAULT_SLSKD_BASE = 'http://127.0.0.1:5030';
const DEFAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

const settingsRowStmt = getDb().prepare(`
  SELECT
    library_path,
    slskd_local_download_path,
    plex_url,
    plex_token,
    plex_music_section_id,
    plex_track_scan_size,
    slskd_base_url,
    slskd_api_key,
    slskd_max_file_size_bytes,
    slskd_search_create_stagger_ms,
    slskd_auto_clear_completed_downloads,
    trackflow_download_stagger_ms,
    slskd_orphan_cleanup_enabled,
    slskd_orphan_cleanup_interval_ms,
    slskd_orphan_cleanup_interval_hours,
    slskd_orphan_cleanup_interval_minutes
  FROM settings
  WHERE id = 1
`);

function row() {
  try {
    return settingsRowStmt.get();
  } catch {
    return null;
  }
}

function trimQuotes(s) {
  if (s == null || typeof s !== 'string') {
    return '';
  }
  return s.trim().replace(/^['"]+|['"]+$/g, '');
}

function strFrom(dbVal, envKey) {
  const t = trimQuotes(typeof dbVal === 'string' ? dbVal : dbVal != null ? String(dbVal) : '');
  if (t) {
    return t;
  }
  return trimQuotes(process.env[envKey] || '');
}

function parseBoolEnv(value, defaultValue = true) {
  if (value == null || String(value).trim() === '') {
    return defaultValue;
  }
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(s)) {
    return false;
  }
  return defaultValue;
}

function boolFromDbInt(dbVal, envKey, defaultValue = true) {
  if (dbVal != null && dbVal !== '') {
    return Number(dbVal) === 1;
  }
  const ev = process.env[envKey];
  if (ev != null && String(ev).trim() !== '') {
    return parseBoolEnv(ev, defaultValue);
  }
  return defaultValue;
}

function getLibraryPath() {
  return strFrom(row()?.library_path, 'LIBRARY_PATH');
}

function getSlskdLocalDownloadPath() {
  return strFrom(row()?.slskd_local_download_path, 'SLSKD_LOCAL_DOWNLOAD_PATH');
}

function getPlexMusicSectionId() {
  const r = row();
  const t = trimQuotes(
    typeof r?.plex_music_section_id === 'string'
      ? r.plex_music_section_id
      : r?.plex_music_section_id != null
        ? String(r.plex_music_section_id)
        : '',
  );
  if (t) {
    return t;
  }
  const fromEnv = trimQuotes(
    process.env.PLEX_MUSIC_SECTION_ID || process.env.PLEX_LIBRARY_SECTION_ID || '',
  );
  return fromEnv || '4';
}

function getPlexTrackScanSize() {
  const r = row();
  const n = Number(r?.plex_track_scan_size);
  if (Number.isFinite(n) && n > 0) {
    return Math.min(500, Math.max(50, Math.floor(n)));
  }
  const envN = Number(process.env.PLEX_TRACK_SCAN_SIZE || 300);
  return Math.min(500, Math.max(50, Number.isFinite(envN) ? Math.floor(envN) : 300));
}

function getPlexUrlAndToken() {
  const r = row();
  const plexUrl = strFrom(r?.plex_url, 'PLEX_URL').replace(/\/+$/, '');
  const plexToken = strFrom(r?.plex_token, 'PLEX_TOKEN');
  return { plexUrl, plexToken };
}

function getSlskdSearchCreateStaggerMs() {
  const r = row();
  const n = Number(r?.slskd_search_create_stagger_ms);
  if (Number.isFinite(n) && n >= 0) {
    return Math.floor(n);
  }
  const envN = Number.parseInt(String(process.env.SLSKD_SEARCH_CREATE_STAGGER_MS || '200'), 10);
  return Math.max(0, Number.isFinite(envN) ? envN : 200);
}

function getSlskdConfig() {
  const r = row();
  const rawBase = trimQuotes(
    typeof r?.slskd_base_url === 'string'
      ? r.slskd_base_url
      : r?.slskd_base_url != null
        ? String(r.slskd_base_url)
        : '',
  );
  const fromEnv = trimQuotes(process.env.SLSKD_BASE_URL || '');
  let baseUrl = (rawBase || fromEnv || DEFAULT_SLSKD_BASE).replace(/\/+$/, '');
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('invalid protocol');
    }
    baseUrl = `${parsed.origin}`;
  } catch {
    throw new Error(
      `Invalid slskd base URL "${baseUrl}". Use http:// or https:// (set in Settings or SLSKD_BASE_URL).`,
    );
  }

  const apiKey = strFrom(r?.slskd_api_key, 'SLSKD_API_KEY');

  const maxRaw = r?.slskd_max_file_size_bytes;
  const maxFromDb = Number(maxRaw);
  const maxFromEnv = Number(process.env.SLSKD_MAX_FILE_SIZE_BYTES);

  let maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES;
  if (Number.isFinite(maxFromDb) && maxFromDb > 0) {
    maxFileSizeBytes = Math.floor(maxFromDb);
  } else if (Number.isFinite(maxFromEnv) && maxFromEnv > 0) {
    maxFileSizeBytes = Math.floor(maxFromEnv);
  }

  const autoClear = boolFromDbInt(
    r?.slskd_auto_clear_completed_downloads,
    'SLSKD_AUTO_CLEAR_COMPLETED_DOWNLOADS',
    true,
  );

  return {
    baseUrl,
    apiKey,
    maxFileSizeBytes,
    autoClearCompletedDownloads: autoClear,
  };
}

function getDownloadStaggerMs(maxConcurrentDownloads) {
  const r = row();
  const raw = r?.trackflow_download_stagger_ms;
  if (raw != null && String(raw).trim() !== '') {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  }
  const envRaw = process.env.TRACKFLOW_DOWNLOAD_STAGGER_MS;
  if (envRaw !== undefined && String(envRaw).trim() !== '') {
    const n = parseInt(String(envRaw), 10);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  }
  return maxConcurrentDownloads <= 1 ? 200 : 0;
}

function getOrphanCleanupIntervalMs() {
  const r = row();
  const rawMinutes = r?.slskd_orphan_cleanup_interval_minutes;
  if (rawMinutes != null && String(rawMinutes).trim() !== '') {
    const m = Number(rawMinutes);
    if (Number.isFinite(m) && m >= 1) {
      return Math.floor(Math.min(m, 24 * 60) * 60 * 1000);
    }
  }
  const envMin = String(process.env.SLSKD_ORPHAN_CLEANUP_INTERVAL_MINUTES || '').trim();
  if (envMin !== '') {
    const m = Number(envMin);
    if (Number.isFinite(m) && m >= 1) {
      return Math.floor(Math.min(m, 24 * 60) * 60 * 1000);
    }
  }

  const rawMs = r?.slskd_orphan_cleanup_interval_ms;
  if (rawMs != null && String(rawMs).trim() !== '') {
    const n = Number(rawMs);
    if (Number.isFinite(n) && n >= 60_000) {
      return Math.floor(Math.min(n, 24 * 60 * 60 * 1000));
    }
  }
  const envMs = String(process.env.SLSKD_ORPHAN_CLEANUP_INTERVAL_MS || '').trim();
  if (envMs !== '') {
    const n = Number(envMs);
    if (Number.isFinite(n) && n >= 60_000) {
      return Math.floor(Math.min(n, 24 * 60 * 60 * 1000));
    }
  }

  const rawHours = r?.slskd_orphan_cleanup_interval_hours;
  if (rawHours != null && String(rawHours).trim() !== '') {
    const h = Number(rawHours);
    if (Number.isFinite(h)) {
      const clamped = Math.min(Math.max(h, 1), 6);
      return Math.floor(clamped * 60 * 60 * 1000);
    }
  }
  const envHours = String(process.env.SLSKD_ORPHAN_CLEANUP_INTERVAL_HOURS || '').trim();
  if (envHours !== '') {
    const h = Number(envHours);
    if (Number.isFinite(h)) {
      const clamped = Math.min(Math.max(h, 1), 6);
      return Math.floor(clamped * 60 * 60 * 1000);
    }
  }
  return 4 * 60 * 60 * 1000;
}

function isOrphanCleanupEnabled() {
  const r = row();
  if (r?.slskd_orphan_cleanup_enabled != null && String(r.slskd_orphan_cleanup_enabled).trim() !== '') {
    return Number(r.slskd_orphan_cleanup_enabled) === 1;
  }
  return parseBoolEnv(process.env.SLSKD_ORPHAN_CLEANUP_ENABLED, true);
}

module.exports = {
  getLibraryPath,
  getSlskdLocalDownloadPath,
  getPlexMusicSectionId,
  getPlexTrackScanSize,
  getPlexUrlAndToken,
  getSlskdConfig,
  getSlskdSearchCreateStaggerMs,
  getDownloadStaggerMs,
  getOrphanCleanupIntervalMs,
  isOrphanCleanupEnabled,
  DEFAULT_SLSKD_BASE,
  DEFAULT_MAX_FILE_SIZE_BYTES,
};
