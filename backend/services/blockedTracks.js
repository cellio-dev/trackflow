const { getDb } = require('../db');
const { normMeta } = require('./tracksDb');

const db = getDb();

const insertBlockedTrackStmt = db.prepare(`
  INSERT INTO blocked_tracks (
    deezer_id, title, artist, album, user_id, request_type, blocked_reason, duration_seconds, requested_at, blocked_at
  )
  VALUES (
    @deezer_id, @title, @artist, @album, @user_id, @request_type, @blocked_reason, @duration_seconds, @requested_at, datetime('now')
  )
`);

const listBlockedTracksStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, request_type, blocked_reason, requested_at, blocked_at
  FROM blocked_tracks
  ORDER BY id DESC
`);

const listBlockedTracksByUserStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, request_type, blocked_reason, requested_at, blocked_at
  FROM blocked_tracks
  WHERE user_id = ?
  ORDER BY id DESC
`);

const deleteBlockedTrackByIdStmt = db.prepare(`
  DELETE FROM blocked_tracks
  WHERE id = ?
`);

const clearBlockedTracksStmt = db.prepare(`DELETE FROM blocked_tracks`);
const clearBlockedTracksByUserStmt = db.prepare(`DELETE FROM blocked_tracks WHERE user_id = ?`);

const getBlockedByDeezerIdStmt = db.prepare(`
  SELECT id
  FROM blocked_tracks
  WHERE deezer_id = ?
  LIMIT 1
`);

const listBlockedForMetaProbeStmt = db.prepare(`
  SELECT deezer_id, title, artist, duration_seconds
  FROM blocked_tracks
  ORDER BY id DESC
  LIMIT 5000
`);

function normalizeUserScope(userId) {
  if (userId == null) {
    return null;
  }
  const s = String(userId).trim();
  return s || null;
}

function durationsClose(a, b, tol = 2) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  return Math.abs(Math.round(x) - Math.round(y)) <= tol;
}

function isLikelySameTrack(probe, row) {
  const pa = normMeta(probe.artist);
  const pt = normMeta(probe.title);
  const ra = normMeta(row.artist);
  const rt = normMeta(row.title);
  if (!pa || !pt || !ra || !rt) {
    return false;
  }
  const artistOk = pa === ra || pa.includes(ra) || ra.includes(pa);
  const titleOk = pt === rt || pt.includes(rt) || rt.includes(pt);
  if (!artistOk || !titleOk) {
    return false;
  }
  const pd = probe.duration_seconds;
  const rd = row.duration_seconds;
  if (pd == null || rd == null) {
    return true;
  }
  return durationsClose(pd, rd, 2);
}

function addBlockedTrackFromRequestRow(row, reason = 'denied') {
  if (!row) {
    return;
  }
  insertBlockedTrackStmt.run({
    deezer_id: row.deezer_id != null ? String(row.deezer_id).trim() || null : null,
    title: String(row.title || '').trim(),
    artist: String(row.artist || '').trim(),
    album: row.album == null ? null : String(row.album).trim(),
    user_id: row.user_id != null ? String(row.user_id).trim() : null,
    request_type: row.request_type != null ? String(row.request_type).trim() : 'Track',
    blocked_reason: String(reason || 'denied').trim() || 'denied',
    duration_seconds:
      row.duration_seconds != null && Number.isFinite(Number(row.duration_seconds))
        ? Math.round(Number(row.duration_seconds))
        : null,
    requested_at: row.created_at != null ? String(row.created_at) : null,
  });
}

function listBlockedTracks(options = {}) {
  const userId = normalizeUserScope(options.userId);
  return userId ? listBlockedTracksByUserStmt.all(userId) : listBlockedTracksStmt.all();
}

function deleteBlockedTrackById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    return { changes: 0 };
  }
  return deleteBlockedTrackByIdStmt.run(n);
}

function clearBlockedTracks(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const r = userId ? clearBlockedTracksByUserStmt.run(userId) : clearBlockedTracksStmt.run();
  return { deleted: r.changes || 0 };
}

function isTrackBlocked(probe) {
  const flow = probe?.deezer_id != null ? String(probe.deezer_id).trim() : '';
  if (flow && getBlockedByDeezerIdStmt.get(flow)) {
    return true;
  }
  const rows = listBlockedForMetaProbeStmt.all();
  return rows.some((row) => isLikelySameTrack(probe, row));
}

module.exports = {
  addBlockedTrackFromRequestRow,
  listBlockedTracks,
  deleteBlockedTrackById,
  clearBlockedTracks,
  isTrackBlocked,
};

