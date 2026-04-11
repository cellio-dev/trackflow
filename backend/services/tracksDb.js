/**
 * Tracks table: library files from disk scans + optional Plex rating keys for playlist sync (not availability).
 */

const path = require('path');
const { getDb } = require('../db');
const { yieldToEventLoop } = require('./cooperativeYield');

const db = getDb();

/** Batch size for `markLibraryFilesMissing` transaction chunks (yield between chunks). */
const MARK_MISSING_DB_CHUNK = 400;

/** Cap for in-memory fuzzy match pool; newest rows first so recent downloads stay matchable. */
const MAX_POOL_ROWS = 50_000;

function normMeta(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLooseFilename(stem) {
  let x = String(stem || '').toLowerCase();
  x = x.replace(/\([^)]*remaster[^)]*\)/gi, ' ');
  x = x.replace(/\([^)]*feat[^)]*\)/gi, ' ');
  x = x.replace(/\([^)]*ft\.[^)]*\)/gi, ' ');
  x = x.replace(/\[.*?\]/g, ' ');
  x = x.replace(/[^a-z0-9\s]/g, ' ');
  return x.replace(/\s+/g, ' ').trim();
}

function durationsClose(a, b, tol = 2) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  return Math.abs(x - y) <= tol;
}

function strictIdMatch(probeFlow, rowFlow) {
  const a = probeFlow != null ? String(probeFlow).trim() : '';
  const b = rowFlow != null ? String(rowFlow).trim() : '';
  return Boolean(a && b && a === b);
}

function metaMatch(probe, row) {
  if (strictIdMatch(probe.deezer_id ?? probe.trackflow_id, row.trackflow_id)) {
    return true;
  }
  const ta = normMeta(probe.artist);
  const tt = normMeta(probe.title);
  const ra = normMeta(row.artist);
  const rt = normMeta(row.title);
  if (!ta || !tt || !ra || !rt) {
    return false;
  }
  const artistOk = ra === ta || ra.includes(ta) || ta.includes(ra);
  const titleOk = rt === tt || rt.includes(tt) || tt.includes(rt);
  if (!artistOk || !titleOk) {
    return false;
  }
  const ds =
    probe.duration_seconds != null && Number.isFinite(Number(probe.duration_seconds))
      ? Math.round(Number(probe.duration_seconds))
      : null;
  if (ds == null || row.duration_seconds == null) {
    return true;
  }
  return durationsClose(ds, row.duration_seconds, 2);
}

function filenameMatch(probe, row) {
  if (!row.file_path || !probe.artist || !probe.title) {
    return false;
  }
  const stem = path.basename(row.file_path, path.extname(row.file_path));
  const looseStem = normalizeLooseFilename(stem);
  const needle = normalizeLooseFilename(`${probe.artist} - ${probe.title}`);
  const needleAlt = normalizeLooseFilename(`${probe.artist} ${probe.title}`);
  if (!looseStem) {
    return false;
  }
  return (
    (needle && (looseStem.includes(needle) || needle.includes(looseStem))) ||
    (needleAlt && (looseStem.includes(needleAlt) || needleAlt.includes(looseStem)))
  );
}

function rowIsPresent(row) {
  return Number(row.db_exists) === 1;
}

const getByFlowStmt = db.prepare(`
  SELECT id, trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, plex_rating_key, source, updated_at
  FROM tracks
  WHERE trackflow_id = ? AND db_exists = 1
  LIMIT 1
`);

const loadPoolStmt = db.prepare(`
  SELECT id, trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, plex_rating_key, source, updated_at
  FROM tracks
  WHERE db_exists = 1
  ORDER BY id DESC
  LIMIT ${MAX_POOL_ROWS}
`);

/** Merge duplicate `tracks` rows that share `trackflow_id` (file + optional plex_rating_key). */
function mergeTrackPresenceRows(rows) {
  if (!rows || rows.length === 0) {
    return null;
  }
  const withFile = rows.find((r) => Number(r.db_exists) === 1 && r.file_path);
  const withKey = rows.find((r) => r.plex_rating_key != null && String(r.plex_rating_key).trim() !== '');
  const base = withFile || withKey || rows[0];
  const db_exists = rows.some((r) => Number(r.db_exists) === 1) ? 1 : 0;
  let plex_rating_key = null;
  if (withKey) {
    plex_rating_key = String(withKey.plex_rating_key).trim();
  } else {
    const r = rows.find((x) => x.plex_rating_key != null && String(x.plex_rating_key).trim() !== '');
    plex_rating_key = r ? String(r.plex_rating_key).trim() : null;
  }
  const file_path = withFile ? withFile.file_path : base.file_path;
  return {
    ...base,
    id: base.id,
    db_exists,
    file_path,
    plex_rating_key,
  };
}

function buildFlowPresenceMap(pool) {
  const m = new Map();
  for (const row of pool) {
    if (!rowIsPresent(row)) {
      continue;
    }
    const k = row.trackflow_id != null ? String(row.trackflow_id).trim() : '';
    if (!k) {
      continue;
    }
    m.set(k, { db_exists: 1 });
  }
  return m;
}

function normPathKey(p) {
  return String(p || '').replace(/\\/g, '/');
}

function releaseTrackflowIdFromOtherPaths(trackflowId, relativePathUnix) {
  const flow = trackflowId != null ? String(trackflowId).trim() : '';
  if (!flow) {
    return;
  }
  const p = normPathKey(relativePathUnix);
  db.prepare(
    `
    UPDATE tracks SET trackflow_id = NULL
    WHERE trackflow_id = ?
      AND file_path IS NOT NULL
      AND replace(file_path, '\\', '/') != ?
  `,
  ).run(flow, p);
}

function upsertByTrackflowId(data) {
  releaseTrackflowIdFromOtherPaths(data.trackflow_id, data.file_path);
  db.prepare(
    `
    INSERT INTO tracks (trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, source, updated_at)
    VALUES (@trackflow_id, @artist, @title, @album, @year, @duration_seconds, @file_path, @db_exists, @source, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      trackflow_id = excluded.trackflow_id,
      artist = excluded.artist,
      title = excluded.title,
      album = excluded.album,
      year = excluded.year,
      duration_seconds = excluded.duration_seconds,
      db_exists = excluded.db_exists,
      source = excluded.source,
      updated_at = datetime('now')
  `,
  ).run(data);
}

/**
 * After download: file in library, tags written.
 */
function upsertTrackAfterDownload({
  libraryRoot,
  destPathAbsolute,
  trackflow_id,
  artist,
  title,
  album,
  year,
  duration_seconds,
}) {
  const absLib = path.resolve(libraryRoot);
  const absDest = path.resolve(destPathAbsolute);
  if (!require('fs').existsSync(absDest)) {
    throw new Error('upsertTrackAfterDownload: destination file missing');
  }
  const rel = path.relative(absLib, absDest);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('upsertTrackAfterDownload: path outside library');
  }
  const relUnix = rel.split(path.sep).join('/');
  const flow = trackflow_id != null ? String(trackflow_id).trim() : '';
  if (!flow) {
    db.prepare(
      `
      INSERT INTO tracks (trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, source, updated_at)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, 'download', datetime('now'))
      ON CONFLICT(file_path) DO UPDATE SET
        artist = excluded.artist,
        title = excluded.title,
        album = excluded.album,
        year = excluded.year,
        duration_seconds = excluded.duration_seconds,
        db_exists = 1,
        source = excluded.source,
        updated_at = datetime('now'),
        trackflow_id = COALESCE(tracks.trackflow_id, excluded.trackflow_id)
    `,
    ).run(
      String(artist || '').trim(),
      String(title || '').trim(),
      album == null ? null : String(album).trim(),
      year == null ? null : String(year).trim(),
      duration_seconds != null && Number.isFinite(Number(duration_seconds))
        ? Math.round(Number(duration_seconds))
        : null,
      relUnix,
    );
    return;
  }
  upsertByTrackflowId({
    trackflow_id: flow,
    artist: String(artist || '').trim(),
    title: String(title || '').trim(),
    album: album == null ? null : String(album).trim(),
    year: year == null ? null : String(year).trim(),
    duration_seconds:
      duration_seconds != null && Number.isFinite(Number(duration_seconds))
        ? Math.round(Number(duration_seconds))
        : null,
    file_path: relUnix,
    db_exists: 1,
    source: 'download',
  });
}

function findPresentTrackForProbe(probe, pool) {
  const rows = pool || loadPoolStmt.all();
  const flow = probe.deezer_id != null ? String(probe.deezer_id).trim() : '';
  if (flow) {
    const same = rows.filter(
      (r) => String(r.trackflow_id || '').trim() === flow && rowIsPresent(r),
    );
    if (same.length > 0) {
      return mergeTrackPresenceRows(same);
    }
  }
  for (const row of rows) {
    if (!rowIsPresent(row)) {
      continue;
    }
    if (metaMatch(probe, row)) {
      return row;
    }
  }
  for (const row of rows) {
    if (!rowIsPresent(row)) {
      continue;
    }
    if (filenameMatch(probe, row)) {
      return row;
    }
  }
  return null;
}

/** Duplicate guard: block if the track already has a file-backed row in `tracks`. */
function trackBlocksNewRequest(probe) {
  const row = findPresentTrackForProbe(toProbe(probe));
  if (!row) {
    return false;
  }
  return Number(row.db_exists) === 1;
}

function toProbe(row) {
  return {
    deezer_id: row.deezer_id,
    artist: row.artist,
    title: row.title,
    duration_seconds: row.duration_seconds,
  };
}

function fileExistsInLibraryForRequestSync(row, pool) {
  const r = findPresentTrackForProbe(
    {
      deezer_id: row.deezer_id,
      artist: row.artist,
      title: row.title,
      duration_seconds: row.duration_seconds,
    },
    pool,
  );
  return r != null && Number(r.db_exists) === 1;
}

function loadTracksPresencePool() {
  return loadPoolStmt.all();
}

function batchDiscoverFromDb(tracks) {
  const pool = loadPoolStmt.all();
  const flowPresence = buildFlowPresenceMap(pool);
  return tracks.map((track) => {
    const flow = track.id != null ? String(track.id).trim() : '';
    if (flow && flowPresence.has(flow)) {
      return true;
    }
    const r = findPresentTrackForProbe(
      {
        deezer_id: track.id,
        artist: track.artist,
        title: track.title,
        duration_seconds:
          track.duration != null && Number.isFinite(Number(track.duration))
            ? Math.round(Number(track.duration))
            : null,
      },
      pool,
    );
    return r != null && Number(r.db_exists) === 1;
  });
}

function enrichRequestRowFromTracksSync(row) {
  const probe = {
    deezer_id: row.deezer_id,
    artist: row.artist,
    title: row.title,
    duration_seconds: row.duration_seconds,
  };
  const match = findPresentTrackForProbe(probe);
  return {
    ...row,
    library_file_match: match != null && Number(match.db_exists) === 1,
  };
}

/** Library scan: upsert row from file tags (unique file_path; ON CONFLICT merges). */
function upsertTrackFromLibraryScan(meta, relativePathUnix) {
  const rel = normPathKey(relativePathUnix);
  const flow = meta.trackflow_id != null ? String(meta.trackflow_id).trim() : '';
  const artist = String(meta.artist || '').trim() || 'Unknown';
  const title = String(meta.title || '').trim() || 'Unknown';
  const album = meta.album != null ? String(meta.album).trim() : null;
  const year = meta.year != null ? String(meta.year).trim() : null;
  const duration_seconds =
    meta.duration_seconds != null && Number.isFinite(Number(meta.duration_seconds))
      ? Math.round(Number(meta.duration_seconds))
      : null;

  if (flow) {
    const merged = db
      .prepare(
        `
      UPDATE tracks SET
        file_path = @file_path,
        artist = @artist,
        title = @title,
        album = @album,
        year = @year,
        duration_seconds = @duration_seconds,
        db_exists = 1,
        source = 'library_scan',
        updated_at = datetime('now')
      WHERE trackflow_id = @trackflow_id
        AND (file_path IS NULL OR trim(file_path) = '')
    `,
      )
      .run({
        trackflow_id: flow,
        file_path: rel,
        artist,
        title,
        album,
        year,
        duration_seconds,
      });
    if (merged.changes > 0) {
      return;
    }
  }

  if (flow) {
    releaseTrackflowIdFromOtherPaths(flow, rel);
  }

  const payload = {
    trackflow_id: flow || null,
    artist,
    title,
    album,
    year,
    duration_seconds,
    file_path: rel,
    db_exists: 1,
    source: 'library_scan',
  };

  db.prepare(
    `
    INSERT INTO tracks (trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, source, updated_at)
    VALUES (@trackflow_id, @artist, @title, @album, @year, @duration_seconds, @file_path, @db_exists, @source, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      trackflow_id = COALESCE(NULLIF(excluded.trackflow_id, ''), tracks.trackflow_id),
      artist = excluded.artist,
      title = excluded.title,
      album = excluded.album,
      year = excluded.year,
      duration_seconds = excluded.duration_seconds,
      db_exists = 1,
      source = excluded.source,
      updated_at = datetime('now')
  `,
  ).run(payload);
}

/**
 * Run multiple library upserts in one SQLite transaction (fewer sync points than one tx per file).
 * @param {Array<{ meta: object, fullRel: string }>} entries
 */
function upsertTracksFromLibraryScanInTransaction(entries) {
  if (!entries || entries.length === 0) {
    return;
  }
  const run = db.transaction((list) => {
    for (const ent of list) {
      upsertTrackFromLibraryScan(ent.meta, ent.fullRel);
    }
  });
  run(entries);
}

/**
 * Mark tracks whose files were not seen this scan. Batched updates with yields so large libraries
 * do not block the event loop for one huge transaction.
 * @param {string[]} seenRelativePathsUnix
 * @returns {Promise<void>}
 */
async function markLibraryFilesMissing(seenRelativePathsUnix) {
  const rows = db.prepare(`SELECT id, file_path FROM tracks WHERE db_exists = 1 AND file_path IS NOT NULL`).all();
  const seen = new Set(
    (seenRelativePathsUnix || []).map((p) => String(p || '').replace(/\\/g, '/')),
  );
  const missing = [];
  for (const r of rows) {
    const p = String(r.file_path || '').replace(/\\/g, '/');
    if (!seen.has(p)) {
      missing.push(r.id);
    }
  }
  const upd = db.prepare(`UPDATE tracks SET db_exists = 0, updated_at = datetime('now') WHERE id = ?`);
  const runChunk = db.transaction((chunk) => {
    for (const id of chunk) {
      upd.run(id);
    }
  });
  for (let i = 0; i < missing.length; i += MARK_MISSING_DB_CHUNK) {
    runChunk(missing.slice(i, i + MARK_MISSING_DB_CHUNK));
    if (i + MARK_MISSING_DB_CHUNK < missing.length) {
      await yieldToEventLoop();
    }
  }
}

/**
 * Plex metadata sync for playlist mapping only: update `plex_rating_key` on existing file-backed rows.
 * Does not create Plex-only tracks or affect availability.
 *
 * @param {object} meta
 * @param {number|null} plexDurationSec
 * @param {object[]|undefined} presencePool — from `loadTracksPresencePool()`; if omitted, loads per call (avoid in tight loops).
 */
function applyPlexRatingKeyFromPlexMetadata(meta, plexDurationSec, presencePool) {
  const flow = meta.trackflow_id != null ? String(meta.trackflow_id).trim() : '';
  const rkRaw = meta.plex_rating_key != null ? String(meta.plex_rating_key).trim() : '';
  const plexRatingKey = rkRaw || null;
  if (!plexRatingKey) {
    return null;
  }
  const pool = presencePool != null ? presencePool : loadPoolStmt.all();
  let row = flow ? db.prepare(`SELECT * FROM tracks WHERE trackflow_id = ? AND db_exists = 1`).get(flow) : null;
  if (!row) {
    row = findPresentTrackForProbe(
      {
        deezer_id: flow || null,
        artist: meta.artist,
        title: meta.title,
        duration_seconds: plexDurationSec,
      },
      pool,
    );
  }
  if (!row || Number(row.db_exists) !== 1) {
    return null;
  }
  const albumArtist =
    meta.album_artist != null && String(meta.album_artist).trim() !== ''
      ? String(meta.album_artist).trim()
      : null;

  db.prepare(
    `
      UPDATE tracks SET
        artist = COALESCE(NULLIF(?, ''), artist),
        title = COALESCE(NULLIF(?, ''), title),
        album = COALESCE(?, album),
        album_artist = COALESCE(NULLIF(?, ''), album_artist),
        duration_seconds = COALESCE(?, duration_seconds),
        plex_rating_key = COALESCE(?, plex_rating_key),
        updated_at = datetime('now')
      WHERE id = ?
    `,
  ).run(
    String(meta.artist || '').trim(),
    String(meta.title || '').trim(),
    meta.album != null ? String(meta.album).trim() : null,
    albumArtist,
    plexDurationSec != null && Number.isFinite(Number(plexDurationSec))
      ? Math.round(Number(plexDurationSec))
      : null,
    plexRatingKey,
    row.id,
  );
  return row.id;
}

const recentDiscoverStmt = db.prepare(`
  SELECT trackflow_id, artist, title, album, duration_seconds
  FROM tracks
  WHERE trackflow_id IS NOT NULL AND trim(trackflow_id) != ''
    AND db_exists = 1
  ORDER BY datetime(updated_at) DESC, id DESC
  LIMIT ?
`);

function getRecentlyAddedTracksForDiscover(limit = 20) {
  const lim = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const rows = recentDiscoverStmt.all(lim);
  return rows.map((row) => {
    const rawId = String(row.trackflow_id || '').trim();
    const id = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
    return {
      id,
      title: row.title || 'Unknown',
      artist: row.artist || 'Unknown',
      album: row.album || null,
      duration:
        row.duration_seconds != null && Number.isFinite(Number(row.duration_seconds))
          ? Math.round(Number(row.duration_seconds))
          : null,
      type: 'track',
      albumCover: null,
      preview: null,
      artistId: null,
      albumId: null,
    };
  });
}

module.exports = {
  normMeta,
  metaMatch,
  filenameMatch,
  upsertTrackAfterDownload,
  findPresentTrackForProbe,
  trackBlocksNewRequest,
  fileExistsInLibraryForRequestSync,
  loadTracksPresencePool,
  batchDiscoverFromDb,
  enrichRequestRowFromTracksSync,
  upsertTrackFromLibraryScan,
  upsertTracksFromLibraryScanInTransaction,
  markLibraryFilesMissing,
  applyPlexRatingKeyFromPlexMetadata,
  getRecentlyAddedTracksForDiscover,
  loadPoolStmt,
  getByFlowStmt,
};
