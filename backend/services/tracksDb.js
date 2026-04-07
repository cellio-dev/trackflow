/**
 * Tracks table: authoritative library + Plex availability (no real-time FS/Plex in request/search).
 */

const path = require('path');
const { getDb } = require('../db');

const db = getDb();

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
  return Number(row.db_exists) === 1 || Number(row.plex_available) === 1;
}

const getByFlowStmt = db.prepare(`
  SELECT id, trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, plex_available, source, updated_at
  FROM tracks
  WHERE trackflow_id = ? AND (db_exists = 1 OR plex_available = 1)
  LIMIT 1
`);

const loadPoolStmt = db.prepare(`
  SELECT id, trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, plex_available, source, updated_at
  FROM tracks
  WHERE db_exists = 1 OR plex_available = 1
  ORDER BY id DESC
  LIMIT ${MAX_POOL_ROWS}
`);

function normPathKey(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** Avoid two rows with the same trackflow_id when the canonical row is this file_path. */
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
    INSERT INTO tracks (trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, plex_available, source, updated_at)
    VALUES (@trackflow_id, @artist, @title, @album, @year, @duration_seconds, @file_path, @db_exists, @plex_available, @source, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      trackflow_id = excluded.trackflow_id,
      artist = excluded.artist,
      title = excluded.title,
      album = excluded.album,
      year = excluded.year,
      duration_seconds = excluded.duration_seconds,
      db_exists = excluded.db_exists,
      plex_available = excluded.plex_available,
      source = excluded.source,
      updated_at = datetime('now')
  `,
  ).run(data);
}

/**
 * After download: file in library, tags written. Verifies paths; sets db_exists, plex_available=false.
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
      INSERT INTO tracks (trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, plex_available, source, updated_at)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, 0, 'download', datetime('now'))
      ON CONFLICT(file_path) DO UPDATE SET
        artist = excluded.artist,
        title = excluded.title,
        album = excluded.album,
        year = excluded.year,
        duration_seconds = excluded.duration_seconds,
        db_exists = 1,
        plex_available = 0,
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
    plex_available: 0,
    source: 'download',
  });
}

function findPresentTrackForProbe(probe, pool) {
  const flow = probe.deezer_id != null ? String(probe.deezer_id).trim() : '';
  if (flow) {
    const direct = getByFlowStmt.get(flow);
    if (direct && rowIsPresent(direct)) {
      return direct;
    }
  }
  const rows = pool || loadPoolStmt.all();
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

/**
 * Duplicate guard for new requests / follow sync: block if the track is already represented
 * in `tracks` with a file on disk and/or Plex index. `require_plex_for_available` affects
 * user-facing “available” UI only (see libraryAvailability), not this check.
 */
function trackBlocksNewRequest(probe, settings) {
  const row = findPresentTrackForProbe(toProbe(probe));
  if (!row) {
    return false;
  }
  const dbOk = Number(row.db_exists) === 1;
  const plexOk = Number(row.plex_available) === 1;
  const plexOn = Boolean(settings?.plex_integration_enabled);
  if (!plexOn) {
    return dbOk;
  }
  return dbOk || plexOk;
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

/** One load of the fuzzy-match pool (up to MAX_POOL_ROWS). Reuse across many probes to avoid O(n) full-table reads. */
function loadTracksPresencePool() {
  return loadPoolStmt.all();
}

function batchDiscoverFromDb(tracks) {
  const pool = loadPoolStmt.all();
  /** Pool is `ORDER BY id DESC` (newest first). Keep first row per trackflow_id so stale duplicates do not overwrite the canonical row (fixes poll stubs with `{ id }` only). */
  const byFlow = new Map();
  for (const row of pool) {
    if (row.trackflow_id) {
      const k = String(row.trackflow_id);
      if (!byFlow.has(k)) {
        byFlow.set(k, row);
      }
    }
  }
  return tracks.map((track) => {
    const flow = track.id != null ? String(track.id).trim() : '';
    if (flow && byFlow.has(flow)) {
      const r = byFlow.get(flow);
      return Number(r.db_exists) === 1;
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

function batchPlexFlagsFromDb(tracks) {
  const pool = loadPoolStmt.all();
  const byFlow = new Map();
  for (const row of pool) {
    if (row.trackflow_id) {
      const k = String(row.trackflow_id);
      if (!byFlow.has(k)) {
        byFlow.set(k, row);
      }
    }
  }
  return tracks.map((track) => {
    const flow = track.id != null ? String(track.id).trim() : '';
    if (flow && byFlow.has(flow)) {
      return Number(byFlow.get(flow).plex_available) === 1;
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
    return r != null && Number(r.plex_available) === 1;
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
    library_plex_available: match != null && Number(match.plex_available) === 1,
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
    plex_available: 0,
    source: 'library_scan',
  };

  db.prepare(
    `
    INSERT INTO tracks (trackflow_id, artist, title, album, year, duration_seconds, file_path, db_exists, plex_available, source, updated_at)
    VALUES (@trackflow_id, @artist, @title, @album, @year, @duration_seconds, @file_path, @db_exists, @plex_available, @source, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      trackflow_id = COALESCE(NULLIF(excluded.trackflow_id, ''), tracks.trackflow_id),
      artist = excluded.artist,
      title = excluded.title,
      album = excluded.album,
      year = excluded.year,
      duration_seconds = excluded.duration_seconds,
      db_exists = 1,
      plex_available = tracks.plex_available,
      source = excluded.source,
      updated_at = datetime('now')
  `,
  ).run(payload);
}

function markLibraryFilesMissing(seenRelativePathsUnix) {
  const rows = db.prepare(`SELECT id, file_path FROM tracks WHERE db_exists = 1 AND file_path IS NOT NULL`).all();
  const seen = new Set(seenRelativePathsUnix);
  for (const r of rows) {
    const p = String(r.file_path || '').replace(/\\/g, '/');
    if (!seen.has(p)) {
      db.prepare(`UPDATE tracks SET db_exists = 0, updated_at = datetime('now') WHERE id = ?`).run(r.id);
    }
  }
}

/** Plex scan: reset plex flags then caller sets true for matches */
function clearAllPlexAvailableFlags() {
  db.prepare(`UPDATE tracks SET plex_available = 0, updated_at = datetime('now') WHERE plex_available = 1`).run();
}

function setPlexAvailableForTrackRow(id, value) {
  db.prepare(`UPDATE tracks SET plex_available = ?, updated_at = datetime('now') WHERE id = ?`).run(
    value ? 1 : 0,
    id,
  );
}

function insertOrUpdateTrackFromPlex(meta, plexDurationSec) {
  const flow = meta.trackflow_id != null ? String(meta.trackflow_id).trim() : '';
  const rkRaw = meta.plex_rating_key != null ? String(meta.plex_rating_key).trim() : '';
  const plexRatingKey = rkRaw || null;
  const pool = loadPoolStmt.all();
  let row = flow ? db.prepare(`SELECT * FROM tracks WHERE trackflow_id = ?`).get(flow) : null;
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
  const albumArtist =
    meta.album_artist != null && String(meta.album_artist).trim() !== ''
      ? String(meta.album_artist).trim()
      : null;

  if (row) {
    db.prepare(
      `
      UPDATE tracks SET
        plex_available = 1,
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
  const info = db
    .prepare(
      `
    INSERT INTO tracks (trackflow_id, artist, title, album, album_artist, year, duration_seconds, file_path, db_exists, plex_available, plex_rating_key, source, updated_at)
    VALUES (@trackflow_id, @artist, @title, @album, @album_artist, @year, @duration_seconds, NULL, 0, 1, @plex_rating_key, 'plex', datetime('now'))
  `,
    )
    .run({
      trackflow_id: flow || null,
      artist: String(meta.artist || '').trim() || 'Unknown',
      title: String(meta.title || '').trim() || 'Unknown',
      album: meta.album != null ? String(meta.album).trim() : null,
      album_artist: albumArtist,
      year: meta.year != null ? String(meta.year).trim() : null,
      duration_seconds:
        plexDurationSec != null && Number.isFinite(Number(plexDurationSec))
          ? Math.round(Number(plexDurationSec))
          : null,
      plex_rating_key: plexRatingKey,
    });
  return Number(info.lastInsertRowid);
}

const recentDiscoverStmt = db.prepare(`
  SELECT trackflow_id, artist, title, album, duration_seconds
  FROM tracks
  WHERE trackflow_id IS NOT NULL AND trim(trackflow_id) != ''
    AND (db_exists = 1 OR plex_available = 1)
  ORDER BY datetime(updated_at) DESC, id DESC
  LIMIT ?
`);

/**
 * Library rows with Deezer id, newest first (for Discover “Recently added”).
 * @param {number} [limit=20]
 * @returns {object[]} Deezer-shaped track rows (no cover/preview; enriched later)
 */
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

function syncRequestPlexStatusFromTracks() {
  db.exec(`
    UPDATE requests
    SET plex_status = 'found'
    WHERE status = 'completed'
      AND (plex_status IS NULL OR plex_status = 'pending')
      AND deezer_id IN (
        SELECT trackflow_id FROM tracks WHERE plex_available = 1 AND trackflow_id IS NOT NULL
      )
  `);
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
  batchPlexFlagsFromDb,
  enrichRequestRowFromTracksSync,
  upsertTrackFromLibraryScan,
  markLibraryFilesMissing,
  clearAllPlexAvailableFlags,
  setPlexAvailableForTrackRow,
  insertOrUpdateTrackFromPlex,
  syncRequestPlexStatusFromTracks,
  getRecentlyAddedTracksForDiscover,
  loadPoolStmt,
  getByFlowStmt,
};
