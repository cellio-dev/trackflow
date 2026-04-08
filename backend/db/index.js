// SQLite database setup for TrackFlow backend.
// This keeps DB setup centralized and simple.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const envDb = process.env.TRACKFLOW_SQLITE_PATH && String(process.env.TRACKFLOW_SQLITE_PATH).trim();
const dbPath = envDb
  ? path.resolve(envDb)
  : path.join(__dirname, 'trackflow.sqlite');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
try {
  fs.accessSync(dbDir, fs.constants.W_OK);
} catch {
  const dockerHint =
    process.platform !== 'win32'
      ? ' On Docker, fix host permissions (container user is often UID 1000): `sudo chown -R 1000:1000 /path/to/appdata` on the host folder mounted at /appdata.'
      : '';
  throw new Error(
    `Cannot open SQLite database at ${dbPath}: directory is not writable: ${dbDir}.${dockerHint}`,
  );
}
const db = new Database(dbPath);

// Create requests table once at startup if missing.
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deezer_id TEXT,
    title TEXT,
    artist TEXT,
    album TEXT,
    user_id TEXT,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const requestColumns = db.prepare(`PRAGMA table_info(requests)`).all();
const hasUserIdColumn = requestColumns.some((column) => column.name === 'user_id');
if (!hasUserIdColumn) {
  db.exec(`ALTER TABLE requests ADD COLUMN user_id TEXT;`);
}

const requestColumnsLatest = db.prepare(`PRAGMA table_info(requests)`).all();
const hasDurationSecondsColumn = requestColumnsLatest.some((column) => column.name === 'duration_seconds');
if (!hasDurationSecondsColumn) {
  db.exec(`ALTER TABLE requests ADD COLUMN duration_seconds INTEGER;`);
}

const requestColumnsV3 = db.prepare(`PRAGMA table_info(requests)`).all();
const hasCancelledColumn = requestColumnsV3.some((column) => column.name === 'cancelled');
if (!hasCancelledColumn) {
  db.exec(`ALTER TABLE requests ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0;`);
}

const requestColumnsV4 = db.prepare(`PRAGMA table_info(requests)`).all();
const hasSlskdExpectedBasenameColumn = requestColumnsV4.some(
  (column) => column.name === 'slskd_expected_basename',
);
if (!hasSlskdExpectedBasenameColumn) {
  db.exec(`ALTER TABLE requests ADD COLUMN slskd_expected_basename TEXT;`);
}

/** Legacy status → completed (no Plex state) */
db.exec(`
  UPDATE requests SET status = 'completed' WHERE status = 'available';
`);

const requestColumnsV6 = db.prepare(`PRAGMA table_info(requests)`).all();
const hasProcessingPhaseColumn = requestColumnsV6.some((column) => column.name === 'processing_phase');
if (!hasProcessingPhaseColumn) {
  db.exec(`ALTER TABLE requests ADD COLUMN processing_phase TEXT;`);
}

const requestColumnsV7 = db.prepare(`PRAGMA table_info(requests)`).all();
const hasRequestTypeColumn = requestColumnsV7.some((column) => column.name === 'request_type');
if (!hasRequestTypeColumn) {
  db.exec(`ALTER TABLE requests ADD COLUMN request_type TEXT NOT NULL DEFAULT 'Track';`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    auto_approve INTEGER NOT NULL DEFAULT 0
  );
`);

db.exec(`
  INSERT INTO settings (id, auto_approve)
  VALUES (1, 0)
  ON CONFLICT(id) DO NOTHING;
`);

const settingsColumns = db.prepare(`PRAGMA table_info(settings)`).all();
const hasPreferredFormatColumn = settingsColumns.some((column) => column.name === 'preferred_format');
if (!hasPreferredFormatColumn) {
  db.exec(`ALTER TABLE settings ADD COLUMN preferred_format TEXT;`);
  db.exec(`UPDATE settings SET preferred_format = 'prefer_mp3' WHERE preferred_format IS NULL;`);
}

const settingsColumnsV2 = db.prepare(`PRAGMA table_info(settings)`).all();
const hasMaxConcurrentDownloadsColumn = settingsColumnsV2.some(
  (column) => column.name === 'max_concurrent_downloads',
);
if (!hasMaxConcurrentDownloadsColumn) {
  db.exec(`ALTER TABLE settings ADD COLUMN max_concurrent_downloads INTEGER NOT NULL DEFAULT 1;`);
}

const settingsColumnsV3 = db.prepare(`PRAGMA table_info(settings)`).all();
const hasMaxDownloadAttemptsColumn = settingsColumnsV3.some(
  (column) => column.name === 'max_download_attempts',
);
if (!hasMaxDownloadAttemptsColumn) {
  db.exec(`ALTER TABLE settings ADD COLUMN max_download_attempts INTEGER NOT NULL DEFAULT 3;`);
}

function ensureSettingsColumn(columnName, alterSql) {
  const cols = db.prepare(`PRAGMA table_info(settings)`).all();
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(alterSql);
  }
}

/**
 * One row per non-null trackflow_id: keep best row (db_exists, then id),
 * clear trackflow_id on the rest. Safe for file_path uniqueness (rows stay; only id cleared).
 */
function dedupeTracksTrackflowIds(database) {
  const dupKeys = database
    .prepare(
      `
    SELECT trackflow_id
    FROM tracks
    WHERE trackflow_id IS NOT NULL
    GROUP BY trackflow_id
    HAVING COUNT(*) > 1
  `,
    )
    .all();

  if (dupKeys.length === 0) {
    return;
  }

  const selectGroup = database.prepare(`
    SELECT id, db_exists
    FROM tracks
    WHERE trackflow_id = ?
    ORDER BY db_exists DESC, id ASC
  `);
  const clearTf = database.prepare(`UPDATE tracks SET trackflow_id = NULL WHERE id = ?`);

  for (const { trackflow_id: tf } of dupKeys) {
    const rows = selectGroup.all(tf);
    const losers = rows.slice(1);
    for (const l of losers) {
      clearTf.run(l.id);
    }
  }
}

function trackflowIdUniqueIndexNeedsRebuild(indexSql) {
  return Boolean(indexSql && /trackflow_id\s*!=\s*''/i.test(indexSql));
}
ensureSettingsColumn(
  'track_match_mode',
  `ALTER TABLE settings ADD COLUMN track_match_mode TEXT NOT NULL DEFAULT 'balanced';`,
);
ensureSettingsColumn(
  'plex_integration_enabled',
  `ALTER TABLE settings ADD COLUMN plex_integration_enabled INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'plex_detection_enabled',
  `ALTER TABLE settings ADD COLUMN plex_detection_enabled INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'require_plex_for_available',
  `ALTER TABLE settings ADD COLUMN require_plex_for_available INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'file_naming_pattern',
  `ALTER TABLE settings ADD COLUMN file_naming_pattern TEXT;`,
);
ensureSettingsColumn(
  'plex_scan_interval_minutes',
  `ALTER TABLE settings ADD COLUMN plex_scan_interval_minutes INTEGER NOT NULL DEFAULT 30;`,
);
ensureSettingsColumn(
  'library_scan_interval_minutes',
  `ALTER TABLE settings ADD COLUMN library_scan_interval_minutes INTEGER NOT NULL DEFAULT 60;`,
);
ensureSettingsColumn('library_path', `ALTER TABLE settings ADD COLUMN library_path TEXT;`);
ensureSettingsColumn('primary_library_path', `ALTER TABLE settings ADD COLUMN primary_library_path TEXT;`);
ensureSettingsColumn(
  'library_scan_paths_json',
  `ALTER TABLE settings ADD COLUMN library_scan_paths_json TEXT NOT NULL DEFAULT '[]';`,
);
ensureSettingsColumn(
  'slskd_local_download_path',
  `ALTER TABLE settings ADD COLUMN slskd_local_download_path TEXT;`,
);
ensureSettingsColumn('plex_url', `ALTER TABLE settings ADD COLUMN plex_url TEXT;`);
ensureSettingsColumn('plex_token', `ALTER TABLE settings ADD COLUMN plex_token TEXT;`);
ensureSettingsColumn(
  'plex_music_section_id',
  `ALTER TABLE settings ADD COLUMN plex_music_section_id TEXT;`,
);
ensureSettingsColumn(
  'plex_track_scan_size',
  `ALTER TABLE settings ADD COLUMN plex_track_scan_size INTEGER NOT NULL DEFAULT 300;`,
);
ensureSettingsColumn('slskd_base_url', `ALTER TABLE settings ADD COLUMN slskd_base_url TEXT;`);
ensureSettingsColumn('slskd_api_key', `ALTER TABLE settings ADD COLUMN slskd_api_key TEXT;`);
ensureSettingsColumn(
  'slskd_max_file_size_bytes',
  `ALTER TABLE settings ADD COLUMN slskd_max_file_size_bytes INTEGER;`,
);
ensureSettingsColumn(
  'slskd_search_create_stagger_ms',
  `ALTER TABLE settings ADD COLUMN slskd_search_create_stagger_ms INTEGER NOT NULL DEFAULT 200;`,
);
ensureSettingsColumn(
  'slskd_auto_clear_completed_downloads',
  `ALTER TABLE settings ADD COLUMN slskd_auto_clear_completed_downloads INTEGER NOT NULL DEFAULT 1;`,
);
ensureSettingsColumn(
  'trackflow_download_stagger_ms',
  `ALTER TABLE settings ADD COLUMN trackflow_download_stagger_ms INTEGER;`,
);
ensureSettingsColumn(
  'slskd_orphan_cleanup_enabled',
  `ALTER TABLE settings ADD COLUMN slskd_orphan_cleanup_enabled INTEGER NOT NULL DEFAULT 1;`,
);
ensureSettingsColumn(
  'slskd_orphan_cleanup_interval_ms',
  `ALTER TABLE settings ADD COLUMN slskd_orphan_cleanup_interval_ms INTEGER;`,
);
ensureSettingsColumn(
  'slskd_orphan_cleanup_interval_hours',
  `ALTER TABLE settings ADD COLUMN slskd_orphan_cleanup_interval_hours INTEGER;`,
);
ensureSettingsColumn(
  'slskd_orphan_cleanup_interval_minutes',
  `ALTER TABLE settings ADD COLUMN slskd_orphan_cleanup_interval_minutes INTEGER;`,
);
ensureSettingsColumn(
  'follow_playlist_requires_approval',
  `ALTER TABLE settings ADD COLUMN follow_playlist_requires_approval INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'follow_artist_requires_approval',
  `ALTER TABLE settings ADD COLUMN follow_artist_requires_approval INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'default_playlist_follow_sync_auto_approve',
  `ALTER TABLE settings ADD COLUMN default_playlist_follow_sync_auto_approve INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'default_artist_follow_sync_auto_approve',
  `ALTER TABLE settings ADD COLUMN default_artist_follow_sync_auto_approve INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'follow_sync_interval_minutes',
  `ALTER TABLE settings ADD COLUMN follow_sync_interval_minutes INTEGER NOT NULL DEFAULT 120;`,
);
ensureSettingsColumn(
  'discover_cache_refresh_minutes',
  `ALTER TABLE settings ADD COLUMN discover_cache_refresh_minutes INTEGER NOT NULL DEFAULT 240;`,
);

function seedIntegrationSettingsFromEnv(database) {
  const trimEv = (v) => {
    if (v == null) {
      return '';
    }
    return String(v).trim().replace(/^['"]+|['"]+$/g, '');
  };
  const seedText = (col, envKey) => {
    const ev = trimEv(process.env[envKey]);
    if (!ev) {
      return;
    }
    database
      .prepare(
        `UPDATE settings SET ${col} = ? WHERE id = 1 AND IFNULL(TRIM(CAST(${col} AS TEXT)), '') = ''`,
      )
      .run(ev);
  };
  seedText('library_path', 'LIBRARY_PATH');
  seedText('primary_library_path', 'PRIMARY_LIBRARY_PATH');
  if (!trimEv(process.env.PRIMARY_LIBRARY_PATH) && trimEv(process.env.LIBRARY_PATH)) {
    seedText('primary_library_path', 'LIBRARY_PATH');
  }
  seedText('slskd_local_download_path', 'SLSKD_LOCAL_DOWNLOAD_PATH');
  seedText('plex_url', 'PLEX_URL');
  seedText('plex_token', 'PLEX_TOKEN');
  seedText('plex_music_section_id', 'PLEX_MUSIC_SECTION_ID');
  if (!trimEv(process.env.PLEX_MUSIC_SECTION_ID) && trimEv(process.env.PLEX_LIBRARY_SECTION_ID)) {
    seedText('plex_music_section_id', 'PLEX_LIBRARY_SECTION_ID');
  }
  seedText('slskd_base_url', 'SLSKD_BASE_URL');
  seedText('slskd_api_key', 'SLSKD_API_KEY');

  const seedIntIfNull = (col, envKey, min, max, transform = (n) => n) => {
    const ev = trimEv(process.env[envKey]);
    if (ev === '') {
      return;
    }
    const n = Number(ev);
    if (!Number.isFinite(n)) {
      return;
    }
    const v = transform(n);
    database
      .prepare(`UPDATE settings SET ${col} = ? WHERE id = 1 AND ${col} IS NULL`)
      .run(v);
  };

  seedIntIfNull('slskd_max_file_size_bytes', 'SLSKD_MAX_FILE_SIZE_BYTES', 1, Number.MAX_SAFE_INTEGER, (n) =>
    Math.floor(n),
  );
  seedIntIfNull(
    'slskd_search_create_stagger_ms',
    'SLSKD_SEARCH_CREATE_STAGGER_MS',
    0,
    60_000,
    (n) => Math.max(0, Math.floor(n)),
  );
  seedIntIfNull('trackflow_download_stagger_ms', 'TRACKFLOW_DOWNLOAD_STAGGER_MS', 0, 3600_000, (n) =>
    Math.max(0, Math.floor(n)),
  );
  seedIntIfNull(
    'slskd_orphan_cleanup_interval_ms',
    'SLSKD_ORPHAN_CLEANUP_INTERVAL_MS',
    60_000,
    24 * 60 * 60 * 1000,
    (n) => Math.floor(Math.min(n, 24 * 60 * 60 * 1000)),
  );
  seedIntIfNull(
    'slskd_orphan_cleanup_interval_hours',
    'SLSKD_ORPHAN_CLEANUP_INTERVAL_HOURS',
    1,
    6,
    (n) => Math.min(6, Math.max(1, Math.floor(n))),
  );
  seedIntIfNull(
    'slskd_orphan_cleanup_interval_minutes',
    'SLSKD_ORPHAN_CLEANUP_INTERVAL_MINUTES',
    1,
    24 * 60,
    (n) => Math.min(24 * 60, Math.max(1, Math.floor(n))),
  );
}

seedIntegrationSettingsFromEnv(db);

db.exec(`
  UPDATE settings SET primary_library_path = library_path
  WHERE id = 1
    AND IFNULL(TRIM(CAST(primary_library_path AS TEXT)), '') = ''
    AND IFNULL(TRIM(CAST(library_path AS TEXT)), '') != '';
`);

db.exec(
  `UPDATE settings SET file_naming_pattern = '%artist%/%artist% - %title%' WHERE file_naming_pattern IS NULL OR file_naming_pattern = '';`,
);

db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trackflow_id TEXT,
    artist TEXT,
    title TEXT,
    album TEXT,
    year TEXT,
    duration_seconds INTEGER,
    file_path TEXT,
    db_exists INTEGER NOT NULL DEFAULT 1,
    source TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
dedupeTracksTrackflowIds(db);
const trackflowIdxRow = db
  .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tracks_trackflow_id'`)
  .get();
if (trackflowIdxRow && trackflowIdUniqueIndexNeedsRebuild(trackflowIdxRow.sql)) {
  db.exec(`DROP INDEX idx_tracks_trackflow_id;`);
  dedupeTracksTrackflowIds(db);
}
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_trackflow_id ON tracks(trackflow_id) WHERE trackflow_id IS NOT NULL;`,
);
const tracksFilePathIdx = db.prepare(`PRAGMA index_list('tracks')`).all().find((r) => r.name === 'idx_tracks_file_path');
if (tracksFilePathIdx && Number(tracksFilePathIdx.unique) === 0) {
  db.exec(`DROP INDEX idx_tracks_file_path;`);
  db.exec(`
    DELETE FROM tracks
    WHERE id IN (
      SELECT t1.id FROM tracks t1
      INNER JOIN tracks t2
        ON t1.file_path = t2.file_path
        AND t1.file_path IS NOT NULL
        AND t1.id > t2.id
    );
  `);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);`);

try {
  db.exec(`
    DELETE FROM tracks
    WHERE IFNULL(db_exists, 0) = 0
      AND (file_path IS NULL OR TRIM(CAST(file_path AS TEXT)) = '');
  `);
} catch {
  /* ignore */
}
try {
  db.exec(`ALTER TABLE tracks DROP COLUMN plex_available;`);
} catch {
  /* SQLite < 3.35 or column already gone */
}
try {
  db.exec(`ALTER TABLE requests DROP COLUMN plex_status;`);
} catch {
  /* column may not exist */
}

db.exec(`DROP TABLE IF EXISTS queue;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS followed_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT,
    title TEXT,
    picture TEXT,
    user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_followed_playlists_user_playlist
  ON followed_playlists(user_id, playlist_id);
`);

let followedPlCols = db.prepare(`PRAGMA table_info(followed_playlists)`).all();
if (!followedPlCols.some((c) => c.name === 'follow_status')) {
  db.exec(
    `ALTER TABLE followed_playlists ADD COLUMN follow_status TEXT NOT NULL DEFAULT 'active';`,
  );
  followedPlCols = db.prepare(`PRAGMA table_info(followed_playlists)`).all();
}
if (!followedPlCols.some((c) => c.name === 'sync_auto_approve')) {
  db.exec(
    `ALTER TABLE followed_playlists ADD COLUMN sync_auto_approve INTEGER NOT NULL DEFAULT 0;`,
  );
  followedPlCols = db.prepare(`PRAGMA table_info(followed_playlists)`).all();
}
if (!followedPlCols.some((c) => c.name === 'last_sync_at')) {
  db.exec(`ALTER TABLE followed_playlists ADD COLUMN last_sync_at TEXT;`);
}
if (!followedPlCols.some((c) => c.name === 'plex_sync_enabled')) {
  db.exec(`ALTER TABLE followed_playlists ADD COLUMN plex_sync_enabled INTEGER NOT NULL DEFAULT 0;`);
  followedPlCols = db.prepare(`PRAGMA table_info(followed_playlists)`).all();
}
if (!followedPlCols.some((c) => c.name === 'plex_playlist_rating_key')) {
  db.exec(`ALTER TABLE followed_playlists ADD COLUMN plex_playlist_rating_key TEXT;`);
  followedPlCols = db.prepare(`PRAGMA table_info(followed_playlists)`).all();
}

const tracksTableColsForPlexRk = db.prepare(`PRAGMA table_info(tracks)`).all();
if (!tracksTableColsForPlexRk.some((c) => c.name === 'plex_rating_key')) {
  db.exec(`ALTER TABLE tracks ADD COLUMN plex_rating_key TEXT;`);
}

const tracksTableColsForAlbumArtist = db.prepare(`PRAGMA table_info(tracks)`).all();
if (!tracksTableColsForAlbumArtist.some((c) => c.name === 'album_artist')) {
  db.exec(`ALTER TABLE tracks ADD COLUMN album_artist TEXT;`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS followed_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id TEXT NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    user_id TEXT NOT NULL,
    follow_status TEXT NOT NULL DEFAULT 'active',
    sync_auto_approve INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_followed_artists_user_artist
  ON followed_artists(user_id, artist_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS follow_request_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follow_kind TEXT NOT NULL CHECK (follow_kind IN ('playlist', 'artist')),
    entity_id TEXT NOT NULL,
    title TEXT,
    user_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'denied')),
    requested_at TEXT,
    resolved_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_follow_request_history_user ON follow_request_history(user_id);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_follow_request_history_resolved ON follow_request_history(resolved_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS recommendation_cache (
    user_id TEXT PRIMARY KEY,
    track_data TEXT NOT NULL DEFAULT '[]',
    artist_data TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS discover_global_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS discover_user_cache (
    user_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS job_run_telemetry (
    job_key TEXT PRIMARY KEY NOT NULL,
    last_started_at TEXT,
    last_finished_at TEXT,
    last_result TEXT,
    last_error TEXT
  );
`);

ensureSettingsColumn(
  'request_history_retention_days',
  `ALTER TABLE settings ADD COLUMN request_history_retention_days INTEGER NOT NULL DEFAULT 0;`,
);

ensureSettingsColumn(
  'display_timezone',
  `ALTER TABLE settings ADD COLUMN display_timezone TEXT NOT NULL DEFAULT 'UTC';`,
);
ensureSettingsColumn(
  'plex_play_history_recommendations',
  `ALTER TABLE settings ADD COLUMN plex_play_history_recommendations INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'completed_request_auto_clear_days',
  `ALTER TABLE settings ADD COLUMN completed_request_auto_clear_days INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'job_library_scan_enabled',
  `ALTER TABLE settings ADD COLUMN job_library_scan_enabled INTEGER NOT NULL DEFAULT 1;`,
);
ensureSettingsColumn(
  'job_plex_scan_enabled',
  `ALTER TABLE settings ADD COLUMN job_plex_scan_enabled INTEGER NOT NULL DEFAULT 1;`,
);
ensureSettingsColumn(
  'job_plex_playlist_sync_enabled',
  `ALTER TABLE settings ADD COLUMN job_plex_playlist_sync_enabled INTEGER NOT NULL DEFAULT 1;`,
);
ensureSettingsColumn(
  'plex_playlist_sync_interval_minutes',
  `ALTER TABLE settings ADD COLUMN plex_playlist_sync_interval_minutes INTEGER NOT NULL DEFAULT 60;`,
);
ensureSettingsColumn(
  'job_follow_sync_enabled',
  `ALTER TABLE settings ADD COLUMN job_follow_sync_enabled INTEGER NOT NULL DEFAULT 1;`,
);
ensureSettingsColumn(
  'job_discover_cache_enabled',
  `ALTER TABLE settings ADD COLUMN job_discover_cache_enabled INTEGER NOT NULL DEFAULT 1;`,
);
ensureSettingsColumn(
  'job_completed_request_clear_enabled',
  `ALTER TABLE settings ADD COLUMN job_completed_request_clear_enabled INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'job_completed_request_clear_interval_minutes',
  `ALTER TABLE settings ADD COLUMN job_completed_request_clear_interval_minutes INTEGER NOT NULL DEFAULT 1440;`,
);
ensureSettingsColumn(
  'plex_auth_enabled',
  `ALTER TABLE settings ADD COLUMN plex_auth_enabled INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'plex_oauth_client_id',
  `ALTER TABLE settings ADD COLUMN plex_oauth_client_id TEXT;`,
);
ensureSettingsColumn(
  'job_plex_sync_enabled',
  `ALTER TABLE settings ADD COLUMN job_plex_sync_enabled INTEGER NOT NULL DEFAULT 1;`,
);
ensureSettingsColumn(
  'plex_run_library_scan_before_sync',
  `ALTER TABLE settings ADD COLUMN plex_run_library_scan_before_sync INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'smtp_host',
  `ALTER TABLE settings ADD COLUMN smtp_host TEXT;`,
);
ensureSettingsColumn(
  'smtp_port',
  `ALTER TABLE settings ADD COLUMN smtp_port INTEGER NOT NULL DEFAULT 587;`,
);
ensureSettingsColumn(
  'smtp_user',
  `ALTER TABLE settings ADD COLUMN smtp_user TEXT;`,
);
ensureSettingsColumn(
  'smtp_password',
  `ALTER TABLE settings ADD COLUMN smtp_password TEXT;`,
);
ensureSettingsColumn(
  'smtp_secure',
  `ALTER TABLE settings ADD COLUMN smtp_secure INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'email_from_address',
  `ALTER TABLE settings ADD COLUMN email_from_address TEXT;`,
);
ensureSettingsColumn(
  'status_email_to',
  `ALTER TABLE settings ADD COLUMN status_email_to TEXT;`,
);
ensureSettingsColumn(
  'job_status_email_enabled',
  `ALTER TABLE settings ADD COLUMN job_status_email_enabled INTEGER NOT NULL DEFAULT 0;`,
);
ensureSettingsColumn(
  'status_email_interval_minutes',
  `ALTER TABLE settings ADD COLUMN status_email_interval_minutes INTEGER NOT NULL DEFAULT 1440;`,
);

try {
  db.exec(
    `UPDATE settings SET job_plex_sync_enabled = 0 WHERE id = 1
      AND (COALESCE(job_plex_scan_enabled, 1) = 0 OR COALESCE(job_plex_playlist_sync_enabled, 1) = 0)`,
  );
} catch {
  /* settings row may not exist yet */
}

try {
  db.exec(
    `UPDATE followed_playlists SET sync_auto_approve = 1 WHERE follow_status = 'active' AND IFNULL(sync_auto_approve, 0) = 0`,
  );
  db.exec(
    `UPDATE followed_artists SET sync_auto_approve = 1 WHERE follow_status = 'active' AND IFNULL(sync_auto_approve, 0) = 0`,
  );
} catch {
  // followed_* may not exist yet on very old DBs
}

const bcrypt = require('bcryptjs');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    is_system_admin INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const userCountRow = db.prepare(`SELECT COUNT(*) AS c FROM users`).get();
if (userCountRow && Number(userCountRow.c) === 0) {
  const initialPw = process.env.TRACKFLOW_ADMIN_PASSWORD || 'admin';
  const hash = bcrypt.hashSync(initialPw, 10);
  db.prepare(
    `INSERT INTO users (username, password_hash, role, is_system_admin) VALUES ('admin', ?, 'admin', 1)`,
  ).run(hash);
  console.warn(
    '[TrackFlow] Created default admin login: username "admin". Change password after login (Settings → Users) or set TRACKFLOW_ADMIN_PASSWORD for first-run password.',
  );
}

const systemAdminRow = db.prepare(
  `SELECT id FROM users WHERE is_system_admin = 1 ORDER BY id LIMIT 1`,
).get();
if (systemAdminRow?.id != null) {
  const sid = String(systemAdminRow.id);
  db.prepare(`UPDATE requests SET user_id = ? WHERE user_id = 'demo-user'`).run(sid);
  db.prepare(`UPDATE followed_playlists SET user_id = ? WHERE user_id = 'demo-user'`).run(sid);
  db.prepare(`UPDATE followed_artists SET user_id = ? WHERE user_id = 'demo-user'`).run(sid);
}

let userTableCols = db.prepare(`PRAGMA table_info(users)`).all();
if (!userTableCols.some((c) => c.name === 'auth_provider')) {
  db.exec(`ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local';`);
  userTableCols = db.prepare(`PRAGMA table_info(users)`).all();
}
if (!userTableCols.some((c) => c.name === 'plex_account_uuid')) {
  db.exec(`ALTER TABLE users ADD COLUMN plex_account_uuid TEXT;`);
  userTableCols = db.prepare(`PRAGMA table_info(users)`).all();
}
if (!userTableCols.some((c) => c.name === 'plex_user_token')) {
  db.exec(`ALTER TABLE users ADD COLUMN plex_user_token TEXT;`);
  userTableCols = db.prepare(`PRAGMA table_info(users)`).all();
}
try {
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS users_plex_account_uuid_unique ON users(plex_account_uuid) WHERE plex_account_uuid IS NOT NULL;`,
  );
} catch {
  // ignore if not supported
}
let addedUserPlaylistSyncCol = false;
let addedUserArtistSyncCol = false;
if (!userTableCols.some((c) => c.name === 'playlist_sync_auto_approve')) {
  db.exec(
    `ALTER TABLE users ADD COLUMN playlist_sync_auto_approve INTEGER NOT NULL DEFAULT 0;`,
  );
  userTableCols = db.prepare(`PRAGMA table_info(users)`).all();
  addedUserPlaylistSyncCol = true;
}
if (!userTableCols.some((c) => c.name === 'artist_sync_auto_approve')) {
  db.exec(`ALTER TABLE users ADD COLUMN artist_sync_auto_approve INTEGER NOT NULL DEFAULT 0;`);
  addedUserArtistSyncCol = true;
}

if (addedUserPlaylistSyncCol) {
  try {
    const s = db
      .prepare(
        `SELECT default_playlist_follow_sync_auto_approve, default_artist_follow_sync_auto_approve FROM settings WHERE id = 1`,
      )
      .get();
    if (s) {
      const pl = Number(s.default_playlist_follow_sync_auto_approve) === 1 ? 1 : 0;
      const ar = Number(s.default_artist_follow_sync_auto_approve) === 1 ? 1 : 0;
      db.prepare(
        `UPDATE users SET playlist_sync_auto_approve = ?, artist_sync_auto_approve = ?`,
      ).run(pl, ar);
    }
  } catch {
    // settings row may not exist yet
  }
} else if (addedUserArtistSyncCol) {
  try {
    const s = db
      .prepare(`SELECT default_artist_follow_sync_auto_approve FROM settings WHERE id = 1`)
      .get();
    if (s) {
      const ar = Number(s.default_artist_follow_sync_auto_approve) === 1 ? 1 : 0;
      db.prepare(`UPDATE users SET artist_sync_auto_approve = ?`).run(ar);
    }
  } catch {
    // settings row may not exist yet
  }
}

if (!userTableCols.some((c) => c.name === 'jukebox_enabled')) {
  db.exec(`ALTER TABLE users ADD COLUMN jukebox_enabled INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`UPDATE users SET jukebox_enabled = 1`);
  userTableCols = db.prepare(`PRAGMA table_info(users)`).all();
}

ensureSettingsColumn(
  'jukebox_requests_auto_approve',
  `ALTER TABLE settings ADD COLUMN jukebox_requests_auto_approve INTEGER NOT NULL DEFAULT 0;`,
);

ensureSettingsColumn(
  'jukebox_guest_queue_display_limit',
  `ALTER TABLE settings ADD COLUMN jukebox_guest_queue_display_limit INTEGER NOT NULL DEFAULT 15;`,
);

ensureSettingsColumn(
  'jukebox_guest_history_display_limit',
  `ALTER TABLE settings ADD COLUMN jukebox_guest_history_display_limit INTEGER NOT NULL DEFAULT 15;`,
);

db.exec(`
  CREATE TABLE IF NOT EXISTS jukeboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    party_playlist_id TEXT,
    party_playlist_title TEXT,
    playlist_loop INTEGER NOT NULL DEFAULT 0,
    pin_require_play_next INTEGER NOT NULL DEFAULT 0,
    pin_require_skip INTEGER NOT NULL DEFAULT 0,
    pin_require_close INTEGER NOT NULL DEFAULT 0,
    pin_hash TEXT,
    guest_token TEXT NOT NULL UNIQUE,
    host_token TEXT NOT NULL UNIQUE,
    current_queue_item_id INTEGER,
    is_paused INTEGER NOT NULL DEFAULT 0,
    volume REAL NOT NULL DEFAULT 1,
    playlist_fill_cursor INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS jukebox_queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jukebox_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'guest',
    library_track_id INTEGER,
    deezer_id TEXT,
    title TEXT,
    artist TEXT,
    album TEXT,
    request_id INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(jukebox_id, position)
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jukebox_queue_jukebox ON jukebox_queue_items(jukebox_id, position);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS jukebox_play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jukebox_id INTEGER NOT NULL,
    library_track_id INTEGER NOT NULL,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jukebox_play_history_jb ON jukebox_play_history(jukebox_id, played_at DESC);
`);

const jukeboxTableCols = db.prepare(`PRAGMA table_info(jukeboxes)`).all();
if (!jukeboxTableCols.some((c) => c.name === 'is_default')) {
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;`);
  const distinctJukeboxUsers = db.prepare(`SELECT DISTINCT user_id FROM jukeboxes`).all();
  const markDefaultStmt = db.prepare(`UPDATE jukeboxes SET is_default = 1 WHERE id = ?`);
  for (const row of distinctJukeboxUsers) {
    const first = db
      .prepare(`SELECT id FROM jukeboxes WHERE user_id = ? ORDER BY id ASC LIMIT 1`)
      .get(row.user_id);
    if (first) {
      markDefaultStmt.run(first.id);
    }
  }
}

const jukeboxTableColsGuestLim = db.prepare(`PRAGMA table_info(jukeboxes)`).all();
if (!jukeboxTableColsGuestLim.some((c) => c.name === 'guest_queue_display_limit')) {
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN guest_queue_display_limit INTEGER NOT NULL DEFAULT 15;`);
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN guest_history_display_limit INTEGER NOT NULL DEFAULT 15;`);
  try {
    db.exec(`
      UPDATE jukeboxes SET
        guest_queue_display_limit = COALESCE((SELECT jukebox_guest_queue_display_limit FROM settings WHERE id = 1), 15),
        guest_history_display_limit = COALESCE((SELECT jukebox_guest_history_display_limit FROM settings WHERE id = 1), 15)
    `);
  } catch {
    /* settings row may be missing during odd migrations */
  }
}

const jukeboxTableColsPlayback = db.prepare(`PRAGMA table_info(jukeboxes)`).all();
if (!jukeboxTableColsPlayback.some((c) => c.name === 'guest_playback_pos_sec')) {
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN guest_playback_pos_sec REAL;`);
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN guest_playback_dur_sec REAL;`);
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN guest_playback_qitem_id INTEGER;`);
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN host_seek_pos_sec REAL;`);
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN host_seek_nonce INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN host_seek_qitem_id INTEGER;`);
}

const jukeboxTableColsSeekQ = db.prepare(`PRAGMA table_info(jukeboxes)`).all();
if (!jukeboxTableColsSeekQ.some((c) => c.name === 'host_seek_qitem_id')) {
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN host_seek_qitem_id INTEGER;`);
}

const jukeboxTableColsReportedAt = db.prepare(`PRAGMA table_info(jukeboxes)`).all();
if (!jukeboxTableColsReportedAt.some((c) => c.name === 'guest_playback_reported_at')) {
  db.exec(`ALTER TABLE jukeboxes ADD COLUMN guest_playback_reported_at TEXT;`);
}

function getDb() {
  return db;
}

module.exports = {
  getDb,
  dedupeTracksTrackflowIds,
};

