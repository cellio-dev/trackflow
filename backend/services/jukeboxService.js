/**
 * Jukebox party mode: queue, playback state, guest/host tokens, per-jukebox play history.
 */

const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { resolveStoredLibraryFileToAbsolute } = require('./libraryPaths');
const deezer = require('./deezer');
const { findPresentTrackForProbe, enrichRequestRowFromTracksSync } = require('./tracksDb');
const { computeDisplayFields } = require('./requestDisplayStatus');
const { approveRequestById } = require('./requestApproval');
const { isTrackAlreadyInLibraryOrPlex } = require('./libraryAvailability');

const db = getDb();

const insertRequestStmt = db.prepare(`
  INSERT INTO requests (deezer_id, title, artist, album, user_id, status, duration_seconds, request_type)
  VALUES (@deezer_id, @title, @artist, @album, @user_id, @status, @duration_seconds, 'Track')
`);

const getRequestByIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests WHERE id = ?
`);

const getRequestByDeezerIdStmt = db.prepare(`
  SELECT id FROM requests WHERE deezer_id = ? ORDER BY id DESC LIMIT 1
`);

const getRequestStatusRowByDeezerStmt = db.prepare(`
  SELECT id, status, cancelled, processing_phase
  FROM requests WHERE deezer_id = ? ORDER BY id DESC LIMIT 1
`);

const getJukeboxRequestsAutoApproveStmt = db.prepare(`
  SELECT jukebox_requests_auto_approve FROM settings WHERE id = 1
`);

const getTrackByIdStmt = db.prepare(`
  SELECT id, trackflow_id, artist, title, album, file_path, db_exists, plex_rating_key
  FROM tracks WHERE id = ?
`);

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function touchJukeboxStmt() {
  return db.prepare(`UPDATE jukeboxes SET updated_at = datetime('now') WHERE id = ?`);
}

const insertJukeboxStmt = db.prepare(`
  INSERT INTO jukeboxes (
    user_id, name, party_playlist_id, party_playlist_title, playlist_loop,
    pin_require_play_next, pin_require_skip, pin_require_close, pin_hash,
    guest_token, host_token, is_default,
    guest_queue_display_limit, guest_history_display_limit
  ) VALUES (
    @user_id, @name, @party_playlist_id, @party_playlist_title, @playlist_loop,
    @pin_require_play_next, @pin_require_skip, @pin_require_close, @pin_hash,
    @guest_token, @host_token, @is_default,
    @guest_queue_display_limit, @guest_history_display_limit
  )
`);

const getJukeboxByIdStmt = db.prepare(`SELECT * FROM jukeboxes WHERE id = ?`);

const getDefaultJukeboxForUserStmt = db.prepare(`
  SELECT * FROM jukeboxes WHERE user_id = ?
  ORDER BY is_default DESC, id DESC
  LIMIT 1
`);

const countJukeboxesForUserStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM jukeboxes WHERE user_id = ?
`);

const listJukeboxesForUserStmt = db.prepare(`
  SELECT * FROM jukeboxes WHERE user_id = ? ORDER BY id DESC
`);

const listJukeboxesAllStmt = db.prepare(`
  SELECT j.*, u.username AS owner_username
  FROM jukeboxes j
  LEFT JOIN users u ON CAST(j.user_id AS INTEGER) = u.id
  ORDER BY j.user_id ASC, j.id DESC
`);

const deleteJukeboxStmt = db.prepare(`DELETE FROM jukeboxes WHERE id = ?`);
const deleteQueueForJukeboxStmt = db.prepare(`DELETE FROM jukebox_queue_items WHERE jukebox_id = ?`);
const deleteHistoryForJukeboxStmt = db.prepare(`DELETE FROM jukebox_play_history WHERE jukebox_id = ?`);

const listQueueStmt = db.prepare(`
  SELECT * FROM jukebox_queue_items WHERE jukebox_id = ? ORDER BY position ASC, id ASC
`);

const insertQueueStmt = db.prepare(`
  INSERT INTO jukebox_queue_items (
    jukebox_id, position, source, library_track_id, deezer_id, title, artist, album, request_id, status
  ) VALUES (
    @jukebox_id, @position, @source, @library_track_id, @deezer_id, @title, @artist, @album, @request_id, @status
  )
`);

const deleteQueueItemStmt = db.prepare(`DELETE FROM jukebox_queue_items WHERE id = ? AND jukebox_id = ?`);
const updateQueueItemStmt = db.prepare(`
  UPDATE jukebox_queue_items
  SET library_track_id = @library_track_id, deezer_id = @deezer_id, request_id = @request_id, status = @status
  WHERE id = @id AND jukebox_id = @jukebox_id
`);

/** Repair: row has a library file but status never left awaiting_request (or is empty). */
const normalizeQueueRowQueuedStmt = db.prepare(`
  UPDATE jukebox_queue_items SET status = 'queued' WHERE id = ? AND jukebox_id = ?
`);

const updateJukeboxPlaybackStmt = db.prepare(`
  UPDATE jukeboxes
  SET current_queue_item_id = @current_queue_item_id, is_paused = @is_paused, volume = @volume, updated_at = datetime('now')
  WHERE id = @id
`);

const updateJukeboxClosedStmt = db.prepare(`
  UPDATE jukeboxes SET closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
`);

const reopenJukeboxStmt = db.prepare(`
  UPDATE jukeboxes SET closed_at = NULL, updated_at = datetime('now') WHERE id = ?
`);

const updateJukeboxCursorStmt = db.prepare(`
  UPDATE jukeboxes SET playlist_fill_cursor = @cursor, updated_at = datetime('now') WHERE id = @id
`);

const resetJukeboxPlaybackTelemetryStmt = db.prepare(`
  UPDATE jukeboxes SET
    guest_playback_pos_sec = NULL,
    guest_playback_dur_sec = NULL,
    guest_playback_qitem_id = NULL,
    guest_playback_reported_at = NULL,
    host_seek_pos_sec = NULL,
    host_seek_nonce = 0,
    host_seek_qitem_id = NULL,
    updated_at = datetime('now')
  WHERE id = ?
`);

const guestReportPlaybackStmt = db.prepare(`
  UPDATE jukeboxes SET
    guest_playback_pos_sec = @pos,
    guest_playback_dur_sec = @dur,
    guest_playback_qitem_id = @qid,
    guest_playback_reported_at = datetime('now'),
    updated_at = datetime('now')
  WHERE id = @id
`);

const hostSeekStmt = db.prepare(`
  UPDATE jukeboxes SET
    host_seek_pos_sec = @pos,
    host_seek_nonce = COALESCE(host_seek_nonce, 0) + 1,
    host_seek_qitem_id = @qid,
    updated_at = datetime('now')
  WHERE id = @id
`);

const insertHistoryStmt = db.prepare(`
  INSERT INTO jukebox_play_history (jukebox_id, library_track_id) VALUES (?, ?)
`);

function hashPin(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

function verifyPin(jukeboxRow, plain) {
  const h = jukeboxRow?.pin_hash;
  if (!h || !plain) {
    return false;
  }
  return bcrypt.compareSync(String(plain), h);
}

/** Guest/host volume 0–1. Default 1 when missing/invalid; 0 (mute) must not become 1. */
function normalizeJukeboxVolume01(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    return 1;
  }
  return Math.min(1, Math.max(0, v));
}

function userOwnsJukebox(jukebox, userId) {
  return jukebox && String(jukebox.user_id) === String(userId);
}

function getJukeboxById(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) {
    return null;
  }
  return getJukeboxByIdStmt.get(n) || null;
}

function getDefaultJukeboxForUser(userId) {
  return getDefaultJukeboxForUserStmt.get(String(userId)) || null;
}

const AUTO_JUKEBOX_NAME = 'My Jukebox';

/**
 * Atomically ensure a row exists: if the user has zero jukeboxes, insert "My Jukebox" as default.
 * SQLite transaction serializes concurrent panel loads so only one insert runs.
 */
function ensureDefaultJukeboxRowSync(userId) {
  const uid = String(userId);
  return db.transaction(() => {
    const existing = getDefaultJukeboxForUserStmt.get(uid);
    if (existing) {
      return { row: existing, created: false };
    }
    const c = Number(countJukeboxesForUserStmt.get(uid)?.c) || 0;
    if (c > 0) {
      const row = getDefaultJukeboxForUserStmt.get(uid);
      return { row, created: false };
    }
    const guest_token = randomToken();
    const host_token = randomToken();
    const r = insertJukeboxStmt.run({
      user_id: uid,
      name: AUTO_JUKEBOX_NAME,
      party_playlist_id: null,
      party_playlist_title: null,
      playlist_loop: 0,
      pin_require_play_next: 0,
      pin_require_skip: 0,
      pin_require_close: 0,
      pin_hash: null,
      guest_token,
      host_token,
      is_default: 1,
      guest_queue_display_limit: 15,
      guest_history_display_limit: 15,
    });
    const row = getJukeboxById(Number(r.lastInsertRowid));
    return { row, created: Boolean(row) };
  })();
}

/**
 * Return the user's default jukebox row, creating "My Jukebox" (default) if they have none.
 */
async function ensureDefaultJukeboxForUser(userId) {
  const uid = String(userId);
  const quick = getDefaultJukeboxForUser(uid);
  if (quick) {
    return quick;
  }
  const { row, created } = ensureDefaultJukeboxRowSync(uid);
  if (!row) {
    return null;
  }
  if (created) {
    await seedPartyPlaylistQueue(row);
  }
  return getJukeboxById(row.id) || row;
}

function listJukeboxes(viewerUserId, viewerRole, filterUserId) {
  if (viewerRole === 'admin' && filterUserId === 'all') {
    return listJukeboxesAllStmt.all().map((row) => serializeJukeboxListRow(row));
  }
  const uid =
    viewerRole === 'admin' && filterUserId && filterUserId !== 'self' ? String(filterUserId) : String(viewerUserId);
  return listJukeboxesForUserStmt.all(uid).map((row) => serializeJukeboxListRow(row));
}

function serializeJukeboxListRow(row) {
  const base = {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    party_playlist_id: row.party_playlist_id,
    party_playlist_title: row.party_playlist_title,
    playlist_loop: Boolean(Number(row.playlist_loop)),
    guest_token: row.guest_token,
    host_token: row.host_token,
    closed_at: row.closed_at,
    created_at: row.created_at,
  };
  if (row.owner_username != null) {
    base.owner_username = row.owner_username;
  }
  return base;
}

function clampGuestListLimit(raw, def = 15) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) {
    return def;
  }
  return Math.min(50, Math.max(3, n));
}

function serializeJukeboxDetail(row) {
  return {
    ...serializeJukeboxListRow(row),
    pin_require_play_next: Boolean(Number(row.pin_require_play_next)),
    pin_require_skip: Boolean(Number(row.pin_require_skip)),
    pin_require_close: Boolean(Number(row.pin_require_close)),
    has_pin: Boolean(row.pin_hash),
    is_paused: Boolean(Number(row.is_paused)),
    volume: normalizeJukeboxVolume01(row.volume),
    current_queue_item_id: row.current_queue_item_id,
    playlist_fill_cursor: row.playlist_fill_cursor,
    guest_queue_display_limit: clampGuestListLimit(row.guest_queue_display_limit, 15),
    guest_history_display_limit: clampGuestListLimit(row.guest_history_display_limit, 15),
  };
}

async function createJukebox(userId, body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) {
    throw new Error('name is required');
  }
  const guest_token = randomToken();
  const host_token = randomToken();
  let pin_hash = null;
  if (body?.pin != null && String(body.pin).trim() !== '') {
    pin_hash = hashPin(String(body.pin).trim());
  }
  const existingCount = Number(countJukeboxesForUserStmt.get(String(userId))?.c) || 0;
  const is_default = existingCount === 0 ? 1 : 0;
  const r = insertJukeboxStmt.run({
    user_id: String(userId),
    name,
    party_playlist_id: body?.party_playlist_id != null ? String(body.party_playlist_id).trim() || null : null,
    party_playlist_title:
      typeof body?.party_playlist_title === 'string' ? body.party_playlist_title.trim() || null : null,
    playlist_loop: body?.playlist_loop ? 1 : 0,
    pin_require_play_next: body?.pin_require_play_next ? 1 : 0,
    pin_require_skip: body?.pin_require_skip ? 1 : 0,
    pin_require_close: body?.pin_require_close ? 1 : 0,
    pin_hash,
    guest_token,
    host_token,
    is_default,
    guest_queue_display_limit: clampGuestListLimit(body?.guest_queue_display_limit, 15),
    guest_history_display_limit: clampGuestListLimit(body?.guest_history_display_limit, 15),
  });
  const id = r.lastInsertRowid;
  const jb = getJukeboxById(id);
  await seedPartyPlaylistQueue(jb);
  return serializeJukeboxDetail(getJukeboxById(id));
}

async function updateJukebox(jukeboxId, userId, isAdmin, body) {
  const jb = getJukeboxById(jukeboxId);
  if (!jb) {
    throw new Error('NOT_FOUND');
  }
  if (!userOwnsJukebox(jb, userId) && !isAdmin) {
    throw new Error('FORBIDDEN');
  }
  const fields = [];
  const params = { id: jukeboxId };
  if (typeof body?.name === 'string' && body.name.trim()) {
    fields.push('name = @name');
    params.name = body.name.trim();
  }
  if (body?.party_playlist_id !== undefined) {
    fields.push('party_playlist_id = @party_playlist_id');
    params.party_playlist_id =
      body.party_playlist_id == null || body.party_playlist_id === ''
        ? null
        : String(body.party_playlist_id).trim();
  }
  if (body?.party_playlist_title !== undefined) {
    fields.push('party_playlist_title = @party_playlist_title');
    params.party_playlist_title =
      typeof body.party_playlist_title === 'string' ? body.party_playlist_title.trim() || null : null;
  }
  if (body?.playlist_loop !== undefined) {
    fields.push('playlist_loop = @playlist_loop');
    params.playlist_loop = body.playlist_loop ? 1 : 0;
  }
  if (body?.pin_require_play_next !== undefined) {
    fields.push('pin_require_play_next = @pin_require_play_next');
    params.pin_require_play_next = body.pin_require_play_next ? 1 : 0;
  }
  if (body?.pin_require_skip !== undefined) {
    fields.push('pin_require_skip = @pin_require_skip');
    params.pin_require_skip = body.pin_require_skip ? 1 : 0;
  }
  if (body?.pin_require_close !== undefined) {
    fields.push('pin_require_close = @pin_require_close');
    params.pin_require_close = body.pin_require_close ? 1 : 0;
  }
  if (body?.pin !== undefined) {
    if (body.pin === null || String(body.pin).trim() === '') {
      fields.push('pin_hash = NULL');
    } else {
      fields.push('pin_hash = @pin_hash');
      params.pin_hash = hashPin(String(body.pin).trim());
    }
  }
  if (body?.guest_queue_display_limit !== undefined) {
    const n = Number(body.guest_queue_display_limit);
    if (!Number.isFinite(n) || n < 3 || n > 50) {
      throw new Error('guest_queue_display_limit must be 3–50');
    }
    fields.push('guest_queue_display_limit = @guest_queue_display_limit');
    params.guest_queue_display_limit = Math.floor(n);
  }
  if (body?.guest_history_display_limit !== undefined) {
    const n = Number(body.guest_history_display_limit);
    if (!Number.isFinite(n) || n < 3 || n > 50) {
      throw new Error('guest_history_display_limit must be 3–50');
    }
    fields.push('guest_history_display_limit = @guest_history_display_limit');
    params.guest_history_display_limit = Math.floor(n);
  }
  if (fields.length === 0) {
    return serializeJukeboxDetail(jb);
  }
  fields.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE jukeboxes SET ${fields.join(', ')} WHERE id = @id`).run(params);
  const next = getJukeboxById(jukeboxId);
  await seedPartyPlaylistQueue(next);
  return serializeJukeboxDetail(next);
}

function deleteJukebox(jukeboxId, userId, isAdmin) {
  const jb = getJukeboxById(jukeboxId);
  if (!jb) {
    throw new Error('NOT_FOUND');
  }
  if (!userOwnsJukebox(jb, userId) && !isAdmin) {
    throw new Error('FORBIDDEN');
  }
  deleteQueueForJukeboxStmt.run(jukeboxId);
  deleteHistoryForJukeboxStmt.run(jukeboxId);
  deleteJukeboxStmt.run(jukeboxId);
}

function clearPlayHistoryForUserDefault(userId, isAdmin) {
  const jb = getDefaultJukeboxForUser(userId);
  if (!jb) {
    throw new Error('NOT_FOUND');
  }
  if (!userOwnsJukebox(jb, userId) && !isAdmin) {
    throw new Error('FORBIDDEN');
  }
  db.prepare(`DELETE FROM jukebox_play_history WHERE jukebox_id = ?`).run(jb.id);
  touchJukeboxStmt().run(jb.id);
  return { ok: true, jukebox_id: jb.id };
}

function nextQueuePosition(jukeboxId) {
  const row = db
    .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM jukebox_queue_items WHERE jukebox_id = ?`)
    .get(jukeboxId);
  return row?.n ?? 0;
}

function renumberQueue(jukeboxId) {
  const items = listQueueStmt.all(jukeboxId);
  const ids = items.map((it) => Number(it.id));
  assignQueuePositions(jukeboxId, ids);
}

/** Compare queue row ids from SQLite (number or BigInt). */
function queueItemSameId(a, b) {
  return Number(a) === Number(b);
}

/** Guest/host first (by position), then playlist filler — matches playback priority. */
function mergeQueueOrder(items) {
  const gh = items
    .filter((i) => i.source === 'guest' || i.source === 'host')
    .sort((a, b) => a.position - b.position);
  const pl = items.filter((i) => i.source === 'playlist').sort((a, b) => a.position - b.position);
  return [...gh, ...pl];
}

/** True if a party-playlist queue row with a library file exists other than the one now playing (Up Next buffer). */
function hasPlaylistFillerBesidesCurrent(jb, items) {
  const curRaw = jb?.current_queue_item_id;
  const hasLib = (row) => {
    const lid = row.library_track_id;
    return lid != null && String(lid).trim() !== '' && Number(lid) > 0;
  };
  if (curRaw == null || curRaw === '') {
    return items.some((i) => i.source === 'playlist' && hasLib(i));
  }
  const cid = Number(curRaw);
  return items.some((i) => i.source === 'playlist' && hasLib(i) && Number(i.id) !== cid);
}

/**
 * Apply order without violating UNIQUE(jukebox_id, position): assigning 0..n in one pass
 * can temporarily duplicate a position when the new order differs from the old one.
 */
function assignQueuePositions(jukeboxId, orderedIds) {
  if (!orderedIds.length) {
    touchJukeboxStmt().run(jukeboxId);
    return;
  }
  const run = db.transaction((ids) => {
    const upd = db.prepare(`UPDATE jukebox_queue_items SET position = ? WHERE id = ? AND jukebox_id = ?`);
    ids.forEach((id, i) => {
      upd.run(-(i + 1), Number(id), jukeboxId);
    });
    ids.forEach((id, i) => {
      upd.run(i, Number(id), jukeboxId);
    });
  });
  run(orderedIds);
  touchJukeboxStmt().run(jukeboxId);
}

function resolveLibraryTrackForDeezer(deezerId) {
  if (deezerId == null) {
    return null;
  }
  return findPresentTrackForProbe({ deezer_id: String(deezerId) });
}

function promotePendingQueueItems(jukeboxId) {
  const items = listQueueStmt.all(jukeboxId);
  for (const it of items) {
    if (!it.request_id || it.library_track_id) {
      continue;
    }
    const req = getRequestByIdStmt.get(it.request_id);
    if (!req || String(req.status) !== 'completed') {
      continue;
    }
    const lib = resolveLibraryTrackForDeezer(it.deezer_id || req.deezer_id);
    if (lib && trackRowPlayableInJukebox(lib)) {
      updateQueueItemStmt.run({
        id: it.id,
        jukebox_id: jukeboxId,
        library_track_id: lib.id,
        deezer_id: it.deezer_id || req.deezer_id,
        request_id: it.request_id,
        status: 'queued',
      });
    }
  }
}

/** True when the track file exists under a configured library root (may differ from library_ready). */
function queueRowStreamReady(row) {
  const lid = row.library_track_id;
  if (lid == null || lid === '' || !(Number(lid) > 0)) {
    return false;
  }
  const tr = getTrackByIdStmt.get(Number(lid));
  return Boolean(tr && trackRowPlayableInJukebox(tr));
}

/**
 * User-facing status from the linked request row only (no "has library id ⇒ Available" shortcut).
 * Used for playback/skip policy so failed requests stay Needs Attention even if a stale library_track_id exists.
 */
function queueItemRequestFacingStatusFromRequest(row) {
  const rid = row.request_id != null ? Number(row.request_id) : NaN;
  if (!Number.isInteger(rid) || rid < 1) {
    return null;
  }
  const req = getRequestByIdStmt.get(rid);
  if (!req) {
    return null;
  }
  const enriched = enrichRequestRowFromTracksSync(req);
  const { displayStatus } = computeDisplayFields(enriched);
  return displayStatus || null;
}

/** User-facing status label; aligns with Discover / track cards (TrackFlowTrackStatus). */
function queueItemRequestDisplayStatus(row) {
  const libraryReady = Boolean(row.library_track_id && Number(row.library_track_id) > 0);
  if (libraryReady) {
    return 'Available';
  }
  return queueItemRequestFacingStatusFromRequest(row);
}

/** Remove queue rows that failed (Needs Attention) and cannot be streamed; keep Processing / Requested / etc. */
function pruneNeedsAttentionUnstreamableQueueItems(jukeboxId) {
  const items = listQueueStmt.all(jukeboxId);
  const jb = getJukeboxById(jukeboxId);
  const curId = jb?.current_queue_item_id != null ? Number(jb.current_queue_item_id) : null;
  const toRemove = [];
  for (const it of items) {
    if (queueItemRequestFacingStatusFromRequest(it) !== 'Needs Attention') {
      continue;
    }
    if (queueRowStreamReady(it)) {
      continue;
    }
    toRemove.push(Number(it.id));
  }
  if (!toRemove.length) {
    return;
  }
  const clearCur = curId != null && toRemove.includes(curId);
  for (const id of toRemove) {
    deleteQueueItemStmt.run(id, jukeboxId);
  }
  renumberQueue(jukeboxId);
  if (clearCur) {
    const jb2 = getJukeboxById(jukeboxId);
    updateJukeboxPlaybackStmt.run({
      id: jukeboxId,
      current_queue_item_id: null,
      is_paused: jb2.is_paused,
      volume: jb2.volume,
    });
  }
}

function serializeQueueItem(row) {
  const library_ready = Boolean(row.library_track_id && Number(row.library_track_id) > 0);
  return {
    id: row.id,
    position: row.position,
    source: row.source,
    library_track_id: row.library_track_id,
    deezer_id: row.deezer_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    request_id: row.request_id,
    status: row.status,
    library_ready,
    stream_ready: queueRowStreamReady(row),
    requestDisplayStatus: queueItemRequestDisplayStatus(row),
  };
}

function getCurrentItem(jukeboxId) {
  const jb = getJukeboxById(jukeboxId);
  if (!jb?.current_queue_item_id) {
    return null;
  }
  const item = db
    .prepare(`SELECT * FROM jukebox_queue_items WHERE id = ? AND jukebox_id = ?`)
    .get(jb.current_queue_item_id, jukeboxId);
  if (!item) {
    updateJukeboxPlaybackStmt.run({
      id: jukeboxId,
      current_queue_item_id: null,
      is_paused: jb.is_paused,
      volume: jb.volume,
    });
    return null;
  }
  return item;
}

function pickNextPlayableItem(jukeboxId) {
  const items = listQueueStmt.all(jukeboxId);
  const guestFirst = [...items].sort((a, b) => {
    const ag = a.source === 'guest' || a.source === 'host' ? 0 : 1;
    const bg = b.source === 'guest' || b.source === 'host' ? 0 : 1;
    if (ag !== bg) {
      return ag - bg;
    }
    return a.position - b.position;
  });
  for (const it of guestFirst) {
    const lid = it.library_track_id;
    if (lid == null || lid === '' || !(Number(lid) > 0)) {
      continue;
    }
    const trPick = getTrackByIdStmt.get(Number(lid));
    if (!trPick || !trackRowPlayableInJukebox(trPick)) {
      continue;
    }
    const st = it.status;
    if (st === 'queued' || st === 'playing') {
      return it;
    }
    if (st === 'awaiting_request' || st == null || (typeof st === 'string' && st.trim() === '')) {
      normalizeQueueRowQueuedStmt.run(it.id, jukeboxId);
      return it;
    }
    normalizeQueueRowQueuedStmt.run(it.id, jukeboxId);
    return it;
  }
  return null;
}

function jukeboxIsClosed(jb) {
  return jb && jb.closed_at != null && String(jb.closed_at).trim() !== '';
}

function ensureNowPlaying(jukeboxId) {
  let jb = getJukeboxById(jukeboxId);
  if (!jb) {
    return null;
  }
  if (jukeboxIsClosed(jb)) {
    if (jb.current_queue_item_id) {
      clearJukeboxPlayback(jukeboxId);
    }
    return getJukeboxById(jukeboxId);
  }
  promotePendingQueueItems(jukeboxId);
  pruneNeedsAttentionUnstreamableQueueItems(jukeboxId);
  const maxHops = Math.max(8, listQueueStmt.all(jukeboxId).length + 2);
  for (let hop = 0; hop < maxHops; hop++) {
    jb = getJukeboxById(jukeboxId);
    const cur = getCurrentItem(jukeboxId);
    if (!cur) {
      break;
    }
    const lid = cur.library_track_id;
    if (lid == null || lid === '' || !(Number(lid) > 0)) {
      if (queueItemRequestFacingStatusFromRequest(cur) === 'Needs Attention') {
        deleteQueueItemStmt.run(cur.id, jukeboxId);
        renumberQueue(jukeboxId);
      }
      resetJukeboxPlaybackTelemetry(jukeboxId);
      updateJukeboxPlaybackStmt.run({
        id: jukeboxId,
        current_queue_item_id: null,
        is_paused: jb.is_paused,
        volume: jb.volume,
      });
      continue;
    }
    const trCur = getTrackByIdStmt.get(Number(lid));
    if (!trCur || !trackRowPlayableInJukebox(trCur)) {
      if (queueItemRequestFacingStatusFromRequest(cur) === 'Needs Attention') {
        deleteQueueItemStmt.run(cur.id, jukeboxId);
        renumberQueue(jukeboxId);
      } else {
        normalizeQueueRowQueuedStmt.run(cur.id, jukeboxId);
      }
      resetJukeboxPlaybackTelemetry(jukeboxId);
      updateJukeboxPlaybackStmt.run({
        id: jukeboxId,
        current_queue_item_id: null,
        is_paused: jb.is_paused,
        volume: jb.volume,
      });
      continue;
    }
    const st = cur.status;
    if (st === 'awaiting_request' || st == null || (typeof st === 'string' && st.trim() === '')) {
      normalizeQueueRowQueuedStmt.run(cur.id, jukeboxId);
    }
    if (jb.party_playlist_id) {
      void maybeRefillPlaylist(jukeboxId);
    }
    return getJukeboxById(jukeboxId);
  }
  jb = getJukeboxById(jukeboxId);
  const next = pickNextPlayableItem(jukeboxId);
  if (!next) {
    resetJukeboxPlaybackTelemetry(jukeboxId);
    updateJukeboxPlaybackStmt.run({
      id: jukeboxId,
      current_queue_item_id: null,
      is_paused: jb.is_paused,
      volume: jb.volume,
    });
    void maybeRefillPlaylist(jukeboxId);
    return getJukeboxById(jukeboxId);
  }
  resetJukeboxPlaybackTelemetry(jukeboxId);
  db.prepare(`UPDATE jukebox_queue_items SET status = 'playing' WHERE id = ?`).run(next.id);
  updateJukeboxPlaybackStmt.run({
    id: jukeboxId,
    current_queue_item_id: next.id,
    is_paused: jb.is_paused,
    volume: jb.volume,
  });
  return getJukeboxById(jukeboxId);
}

function recordPlayAndAdvance(jukeboxId, queueItemId) {
  const it = db
    .prepare(`SELECT * FROM jukebox_queue_items WHERE id = ? AND jukebox_id = ?`)
    .get(queueItemId, jukeboxId);
  if (!it || !it.library_track_id) {
    return;
  }
  resetJukeboxPlaybackTelemetry(jukeboxId);
  insertHistoryStmt.run(jukeboxId, it.library_track_id);
  deleteQueueItemStmt.run(it.id, jukeboxId);
  renumberQueue(jukeboxId);
  const jb = getJukeboxById(jukeboxId);
  updateJukeboxPlaybackStmt.run({
    id: jukeboxId,
    current_queue_item_id: null,
    is_paused: jb.is_paused,
    volume: jb.volume,
  });
  ensureNowPlaying(jukeboxId);
  void maybeRefillPlaylist(jukeboxId);
}

/**
 * Serialize playlist refills per jukebox. `void maybeRefillPlaylist` from concurrent
 * `ensureNowPlaying` / `buildState` calls otherwise races: each sees an empty queue and
 * seeds the same cursor position, duplicating the same track.
 */
const playlistRefillChainByJukeboxId = new Map();

async function maybeRefillPlaylist(jukeboxId) {
  const k = String(jukeboxId);
  const prev = playlistRefillChainByJukeboxId.get(k) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => maybeRefillPlaylistUnlocked(jukeboxId));
  playlistRefillChainByJukeboxId.set(k, next);
  return next;
}

async function maybeRefillPlaylistUnlocked(jukeboxId) {
  const jb = getJukeboxById(jukeboxId);
  if (!jb || !jb.party_playlist_id) {
    return;
  }
  const items = listQueueStmt.all(jukeboxId);
  if (hasPlaylistFillerBesidesCurrent(jb, items)) {
    return;
  }
  await seedPartyPlaylistQueue(jb, true);
}

async function seedPartyPlaylistQueue(jb, appendOnly = false) {
  if (!jb?.party_playlist_id) {
    return;
  }
  let cursor = Number(jb.playlist_fill_cursor) || 0;
  let raw;
  try {
    raw = await deezer.fetchPlaylistAllTracks(jb.party_playlist_id);
  } catch {
    return;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return;
  }
  const existing = listQueueStmt.all(jb.id);
  const maxPos = existing.length ? Math.max(...existing.map((e) => e.position)) + 1 : 0;
  let added = 0;
  const batch = 1;
  let i = 0;
  while (i < batch && raw.length > 0) {
    if (cursor >= raw.length) {
      if (Number(jb.playlist_loop)) {
        cursor = 0;
      } else {
        break;
      }
    }
    const t = raw[cursor];
    cursor += 1;
    const did = t?.id != null ? String(t.id) : null;
    if (!did) {
      continue;
    }
    const lib = resolveLibraryTrackForDeezer(did);
    if (!lib || !trackRowPlayableInJukebox(lib)) {
      continue;
    }
    const title = t.title || lib.title || 'Unknown';
    const artist = t.artist?.name || lib.artist || 'Unknown';
    const album = t.album?.title || lib.album || '';
    insertQueueStmt.run({
      jukebox_id: jb.id,
      position: maxPos + added,
      source: 'playlist',
      library_track_id: lib.id,
      deezer_id: did,
      title,
      artist,
      album,
      request_id: null,
      status: 'queued',
    });
    added += 1;
    i += 1;
  }
  updateJukeboxCursorStmt.run({ id: jb.id, cursor });
  if (added > 0) {
    renumberQueue(jb.id);
    touchJukeboxStmt().run(jb.id);
  }
  if (!appendOnly) {
    ensureNowPlaying(jb.id);
  }
}

function assertJukeboxQueueAllowedForDeezerRequest(deezerId) {
  const did = deezerId != null ? String(deezerId).trim() : '';
  if (!did) {
    return;
  }
  const row = getRequestStatusRowByDeezerStmt.get(did);
  if (!row) {
    return;
  }
  const st = String(row.status || '');
  const cancelled = Number(row.cancelled) === 1;
  if (st === 'denied') {
    throw new Error('This track cannot be queued (request denied).');
  }
  if (st === 'failed' && !cancelled) {
    throw new Error('This track cannot be queued (request needs attention).');
  }
  const { displayStatus, processingStatus } = computeDisplayFields({
    ...row,
    library_file_match: false,
  });
  if (displayStatus === 'Denied' || displayStatus === 'Needs Attention') {
    throw new Error(
      displayStatus === 'Denied'
        ? 'This track cannot be queued (request denied).'
        : 'This track cannot be queued (request needs attention).',
    );
  }
  if (processingStatus === 'Failed' || processingStatus === 'Denied') {
    throw new Error('This track cannot be queued (download failed).');
  }
}

async function addGuestTrack(jukeboxId, body) {
  promotePendingQueueItems(jukeboxId);
  let jb = getJukeboxById(jukeboxId);
  if (!jb) {
    throw new Error('NOT_FOUND');
  }
  if (jukeboxIsClosed(jb)) {
    reopenJukeboxStmt.run(jukeboxId);
    jb = getJukeboxById(jukeboxId);
  }
  const playNext = Boolean(body?.play_next);
  let deezer_id = body?.deezer_id != null ? String(body.deezer_id).trim() : '';
  let title = typeof body?.title === 'string' ? body.title.trim() : '';
  let artist = typeof body?.artist === 'string' ? body.artist.trim() : '';
  const album = typeof body?.album === 'string' ? body.album.trim() : '';
  const duration_seconds =
    body?.duration_seconds != null && Number.isFinite(Number(body.duration_seconds))
      ? Math.round(Number(body.duration_seconds))
      : null;

  let directLib = null;
  const rawLid = body?.library_track_id;
  if (rawLid != null && String(rawLid).trim() !== '') {
    const lid = Number(rawLid);
    if (Number.isFinite(lid) && lid > 0) {
      const tr = getTrackByIdStmt.get(lid);
      if (tr && trackRowPlayableInJukebox(tr)) {
        directLib = tr;
      }
    }
  }
  if (directLib) {
    if (!title) {
      title = String(directLib.title || '').trim();
    }
    if (!artist) {
      artist = String(directLib.artist || '').trim();
    }
    if (!deezer_id && directLib.trackflow_id != null) {
      const flow = String(directLib.trackflow_id).trim();
      if (flow) {
        deezer_id = flow;
      }
    }
  }
  if (!title || !artist) {
    throw new Error('title and artist are required');
  }

  const existingItems = listQueueStmt.all(jukeboxId);
  const order = mergeQueueOrder(existingItems);
  const cur = getCurrentItem(jukeboxId);
  let insertIndex = order.length;
  if (playNext) {
    const curIdx = cur ? order.findIndex((x) => queueItemSameId(x.id, cur.id)) : -1;
    insertIndex = curIdx >= 0 ? curIdx + 1 : 0;
  } else {
    const lastGh = order.map((x, i) => (x.source === 'guest' || x.source === 'host' ? i : -1)).filter((i) => i >= 0);
    insertIndex = lastGh.length ? lastGh[lastGh.length - 1] + 1 : 0;
  }

  const tempPos = nextQueuePosition(jukeboxId);

  if (directLib && trackRowPlayableInJukebox(directLib)) {
    const ins = insertQueueStmt.run({
      jukebox_id: jukeboxId,
      position: tempPos,
      source: 'guest',
      library_track_id: directLib.id,
      deezer_id: deezer_id || null,
      title,
      artist,
      album: album || null,
      request_id: null,
      status: 'queued',
    });
    const rowId = Number(ins.lastInsertRowid);
    const row = db
      .prepare(`SELECT * FROM jukebox_queue_items WHERE id = ? AND jukebox_id = ?`)
      .get(rowId, jukeboxId);
    if (!row) {
      throw new Error('Queue insert failed');
    }
    const all = listQueueStmt.all(jukeboxId);
    const merged = mergeQueueOrder(all.filter((x) => !queueItemSameId(x.id, row.id)));
    const nextOrder = [...merged.slice(0, insertIndex), row, ...merged.slice(insertIndex)].map((x) => x.id);
    assignQueuePositions(jukeboxId, nextOrder);
    ensureNowPlaying(jukeboxId);
    return { ok: true, queued: true };
  }

  if (!deezer_id) {
    throw new Error('deezer_id, title, and artist are required');
  }
  const lib = resolveLibraryTrackForDeezer(deezer_id);

  if (lib && trackRowPlayableInJukebox(lib)) {
    const ins = insertQueueStmt.run({
      jukebox_id: jukeboxId,
      position: tempPos,
      source: 'guest',
      library_track_id: lib.id,
      deezer_id,
      title,
      artist,
      album,
      request_id: null,
      status: 'queued',
    });
    const rowId = Number(ins.lastInsertRowid);
    const row = db
      .prepare(`SELECT * FROM jukebox_queue_items WHERE id = ? AND jukebox_id = ?`)
      .get(rowId, jukeboxId);
    if (!row) {
      throw new Error('Queue insert failed');
    }
    const all = listQueueStmt.all(jukeboxId);
    const merged = mergeQueueOrder(all.filter((x) => !queueItemSameId(x.id, row.id)));
    const nextOrder = [...merged.slice(0, insertIndex), row, ...merged.slice(insertIndex)].map((x) => x.id);
    assignQueuePositions(jukeboxId, nextOrder);
    ensureNowPlaying(jukeboxId);
    return { ok: true, queued: true };
  }
  assertJukeboxQueueAllowedForDeezerRequest(deezer_id);
  const probe = { deezer_id, title, artist, album, duration_seconds };
  if (isTrackAlreadyInLibraryOrPlex(probe)) {
    throw new Error('Track already in library');
  }
  let requestRow = getRequestByDeezerIdStmt.get(deezer_id);
  let requestId = requestRow?.id;
  if (!requestId) {
    const insertResult = insertRequestStmt.run({
      deezer_id,
      title,
      artist,
      album: album || null,
      user_id: String(jb.user_id),
      status: 'pending',
      duration_seconds,
    });
    requestId = insertResult.lastInsertRowid;
    const auto = Boolean(Number(getJukeboxRequestsAutoApproveStmt.get()?.jukebox_requests_auto_approve));
    if (auto) {
      void approveRequestById(requestId).catch(() => {});
    }
  }
  const insAwait = insertQueueStmt.run({
    jukebox_id: jukeboxId,
    position: tempPos,
    source: 'guest',
    library_track_id: null,
    deezer_id,
    title,
    artist,
    album: album || null,
    request_id: requestId,
    status: 'awaiting_request',
  });
  const awaitRowId = Number(insAwait.lastInsertRowid);
  const row = db
    .prepare(`SELECT * FROM jukebox_queue_items WHERE id = ? AND jukebox_id = ?`)
    .get(awaitRowId, jukeboxId);
  if (!row) {
    throw new Error('Queue insert failed');
  }
  const all = listQueueStmt.all(jukeboxId);
  const merged = mergeQueueOrder(all.filter((x) => !queueItemSameId(x.id, row.id)));
  const nextOrder = [...merged.slice(0, insertIndex), row, ...merged.slice(insertIndex)].map((x) => x.id);
  assignQueuePositions(jukeboxId, nextOrder);
  return { ok: true, queued: true, request_id: requestId, awaiting: true };
}

function buildState(jukeboxId, opts) {
  ensureNowPlaying(jukeboxId);
  const jb = getJukeboxById(jukeboxId);
  if (!jb) {
    return null;
  }
  const items = listQueueStmt.all(jukeboxId).map(serializeQueueItem);
  const current = getCurrentItem(jukeboxId);
  const queueLimit = opts?.queueLimit;
  let queueOut = items;
  if (opts?.queuePlaybackMerge) {
    let order = mergeQueueOrder(listQueueStmt.all(jukeboxId)).map((r) => serializeQueueItem(r));
    if (opts.queuePinCurrentFirst) {
      const curId = current?.id;
      if (curId != null) {
        const rest = order.filter((x) => !queueItemSameId(x.id, curId));
        const curSerialized = current ? serializeQueueItem(current) : null;
        queueOut = curSerialized ? [curSerialized, ...rest] : rest;
      } else {
        queueOut = order;
      }
    } else {
      queueOut = order;
    }
  } else if (queueLimit != null) {
    const order = mergeQueueOrder(listQueueStmt.all(jukeboxId)).map((r) => serializeQueueItem(r));
    const curId = current?.id;
    // Playback order is guest/host then playlist; guests sort before the current playlist row in this
    // merge. Using "slice after current index" hid new guest picks until the playlist track ended.
    const upcoming =
      curId != null ? order.filter((x) => !queueItemSameId(x.id, curId)) : order;
    queueOut = upcoming.slice(0, queueLimit);
  }
  const curSerId = current?.id != null ? Number(current.id) : null;
  const repQid = jb.guest_playback_qitem_id != null ? Number(jb.guest_playback_qitem_id) : null;
  const repMatch =
    curSerId != null && repQid != null && Number.isFinite(curSerId) && Number.isFinite(repQid) && curSerId === repQid;
  const playback_position_seconds =
    repMatch && jb.guest_playback_pos_sec != null && Number.isFinite(Number(jb.guest_playback_pos_sec))
      ? Number(jb.guest_playback_pos_sec)
      : null;
  const playback_duration_seconds =
    repMatch && jb.guest_playback_dur_sec != null && Number.isFinite(Number(jb.guest_playback_dur_sec))
      ? Number(jb.guest_playback_dur_sec)
      : null;
  const playback_reported_at =
    repMatch && jb.guest_playback_reported_at != null && String(jb.guest_playback_reported_at).trim() !== ''
      ? String(jb.guest_playback_reported_at).trim()
      : null;
  const host_seek_nonce = Number(jb.host_seek_nonce) || 0;
  const host_seek_position_seconds =
    jb.host_seek_pos_sec != null && Number.isFinite(Number(jb.host_seek_pos_sec))
      ? Number(jb.host_seek_pos_sec)
      : 0;
  const host_seek_queue_item_id =
    jb.host_seek_qitem_id != null && Number.isFinite(Number(jb.host_seek_qitem_id))
      ? Number(jb.host_seek_qitem_id)
      : null;
  return {
    jukebox: {
      id: jb.id,
      name: jb.name,
      is_paused: Boolean(Number(jb.is_paused)),
      volume: normalizeJukeboxVolume01(jb.volume),
      pin_require_play_next: Boolean(Number(jb.pin_require_play_next)),
      pin_require_skip: Boolean(Number(jb.pin_require_skip)),
      pin_require_close: Boolean(Number(jb.pin_require_close)),
      has_pin: Boolean(jb.pin_hash),
      party_playlist_id: jb.party_playlist_id,
      playlist_loop: Boolean(Number(jb.playlist_loop)),
      closed_at: jb.closed_at || null,
      playback_position_seconds,
      playback_duration_seconds,
      playback_reported_at,
      host_seek_nonce,
      host_seek_position_seconds,
      host_seek_queue_item_id,
    },
    current: current ? serializeQueueItem(current) : null,
    queue: queueOut,
  };
}

/** Panel Active/Idle: playing = open session + resolved library track as current and not paused. */
function isPanelPlaybackActive(state) {
  if (state?.jukebox?.closed_at != null && String(state.jukebox.closed_at).trim() !== '') {
    return false;
  }
  if (!state?.current?.library_track_id) {
    return false;
  }
  return !state.jukebox?.is_paused;
}

/** Clear current playback pointer; revert "playing" queue row to queued. Used when closing the jukebox. */
function clearJukeboxPlayback(jukeboxId) {
  const jb = getJukeboxById(jukeboxId);
  if (!jb) {
    return;
  }
  const curId = jb.current_queue_item_id;
  if (curId != null) {
    const row = db
      .prepare(`SELECT id, status FROM jukebox_queue_items WHERE id = ? AND jukebox_id = ?`)
      .get(curId, jukeboxId);
    if (row?.status === 'playing') {
      db.prepare(`UPDATE jukebox_queue_items SET status = 'queued' WHERE id = ? AND jukebox_id = ?`).run(curId, jukeboxId);
    }
  }
  updateJukeboxPlaybackStmt.run({
    id: jukeboxId,
    current_queue_item_id: null,
    is_paused: 0,
    volume: Number(jb.volume) || 1,
  });
  resetJukeboxPlaybackTelemetry(jukeboxId);
}

function resetJukeboxPlaybackTelemetry(jukeboxId) {
  resetJukeboxPlaybackTelemetryStmt.run(jukeboxId);
}

function guestReportPlayback(jukeboxId, token, body) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertGuestToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  const qid = Number(body?.queue_item_id);
  const curQ = jb.current_queue_item_id != null ? Number(jb.current_queue_item_id) : NaN;
  if (!Number.isFinite(qid) || qid < 1 || !Number.isFinite(curQ) || qid !== curQ) {
    return;
  }
  let pos = Number(body?.position_seconds);
  let dur = body?.duration_seconds != null ? Number(body.duration_seconds) : NaN;
  if (!Number.isFinite(pos) || pos < 0) {
    return;
  }
  if (!Number.isFinite(dur) || dur <= 0) {
    dur = null;
  } else {
    pos = Math.min(pos, Math.max(0, dur - 0.01));
  }
  guestReportPlaybackStmt.run({
    id: jukeboxId,
    pos,
    dur,
    qid,
  });
}

function hostSeek(jukeboxId, token, body) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertHostToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  const cur = getCurrentItem(jukeboxId);
  if (!cur) {
    throw new Error('Nothing playing');
  }
  const posRaw = Number(body?.position_seconds);
  if (!Number.isFinite(posRaw) || posRaw < 0) {
    throw new Error('position_seconds required');
  }
  let pos = posRaw;
  const repQid = jb.guest_playback_qitem_id != null ? Number(jb.guest_playback_qitem_id) : null;
  const repDur =
    repQid != null &&
    Number(repQid) === Number(cur.id) &&
    jb.guest_playback_dur_sec != null
      ? Number(jb.guest_playback_dur_sec)
      : null;
  if (repDur != null && Number.isFinite(repDur) && repDur > 0) {
    pos = Math.min(pos, Math.max(0, repDur - 0.05));
  }
  hostSeekStmt.run({ id: jukeboxId, pos, qid: cur.id });
}

function getJukeboxGuestDisplayLimits(jukeboxId) {
  try {
    const jb = getJukeboxById(jukeboxId);
    if (!jb) {
      return { queue: 15, history: 15 };
    }
    return {
      queue: clampGuestListLimit(jb.guest_queue_display_limit, 15),
      history: clampGuestListLimit(jb.guest_history_display_limit, 15),
    };
  } catch {
    return { queue: 15, history: 15 };
  }
}

function buildPlayHistoryDisplay(jukeboxId, limit) {
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit) || 15)));
  const rows = db
    .prepare(
      `
    SELECT h.library_track_id,
           NULLIF(TRIM(CAST(t.trackflow_id AS TEXT)), '') AS deezer_id,
           t.title, t.artist, t.album, h.played_at
    FROM jukebox_play_history h
    INNER JOIN tracks t ON t.id = h.library_track_id
    WHERE h.jukebox_id = ?
      AND t.db_exists = 1
    ORDER BY h.played_at DESC
    LIMIT ?
  `,
    )
    .all(jukeboxId, lim);
  return rows.map((r) => ({
    library_track_id: r.library_track_id,
    deezer_id: r.deezer_id || null,
    title: r.title || 'Track',
    artist: r.artist || '',
    album: r.album || '',
    played_at: r.played_at,
  }));
}

function shuffleInPlace(arr) {
  const a = arr;
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Guest discovery cards: need a Deezer id; local file optional (guest can queue via deezer / requests). */
function trackRowToDiscoveryRow(t) {
  if (!t || Number(t.db_exists) !== 1) {
    return null;
  }
  const flow = String(t.trackflow_id ?? '').trim();
  if (!flow) {
    return null;
  }
  return normalizeDiscoveryRow({
    library_track_id: t.id,
    deezer_id: flow,
    title: t.title,
    artist: t.artist,
    album: t.album || '',
  });
}

const FRESH_RECENT_POOL = 50;
const FRESH_STRIP_LEN = 20;

/** 20 random tracks chosen from the 50 most recently updated library rows (proxy for “added”). */
function freshTracksFromRecentLibraryAdds(excludeLibIds) {
  const exclude = new Set((excludeLibIds || []).filter(Boolean).map(Number));
  const rows = db
    .prepare(
      `
    SELECT id FROM tracks
    WHERE db_exists = 1
      AND trackflow_id IS NOT NULL
      AND TRIM(COALESCE(trackflow_id, '')) != ''
    ORDER BY datetime(COALESCE(updated_at, '1970-01-01 00:00:00')) DESC, id DESC
    LIMIT 160
  `,
    )
    .all();
  const candidates = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || exclude.has(id)) {
      continue;
    }
    const r = trackRowToDiscoveryRow(getTrackByIdStmt.get(id));
    if (r) {
      candidates.push(r);
    }
    if (candidates.length >= FRESH_RECENT_POOL) {
      break;
    }
  }
  shuffleInPlace(candidates);
  return candidates.slice(0, FRESH_STRIP_LEN);
}

function recentMixCandidatesFromHistory(jukeboxId, excludeLibIds) {
  const exclude = new Set((excludeLibIds || []).filter(Boolean).map(Number));
  const events = db
    .prepare(
      `
    SELECT library_track_id FROM jukebox_play_history
    WHERE jukebox_id = ? ORDER BY played_at DESC LIMIT 50
  `,
    )
    .all(jukeboxId);
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const lid = Number(ev.library_track_id);
    if (!Number.isFinite(lid) || exclude.has(lid) || seen.has(lid)) {
      continue;
    }
    seen.add(lid);
    const r = trackRowToDiscoveryRow(getTrackByIdStmt.get(lid));
    if (r) {
      out.push(r);
    }
  }
  shuffleInPlace(out);
  return out;
}

function popularTracks(jukeboxId, limit = 12) {
  const rows = db
    .prepare(
      `
    SELECT library_track_id, COUNT(*) AS c
    FROM jukebox_play_history
    WHERE jukebox_id = ?
    GROUP BY library_track_id
    ORDER BY c DESC
    LIMIT ?
  `,
    )
    .all(jukeboxId, limit);
  const out = [];
  for (const r of rows) {
    const t = getTrackByIdStmt.get(r.library_track_id);
    const row = trackRowToDiscoveryRow(t);
    if (row) {
      out.push({ ...row, play_count: r.c });
    }
  }
  return out;
}

function recentTracks(jukeboxId, limit = 12) {
  const rows = db
    .prepare(
      `
    SELECT library_track_id, MAX(played_at) AS last_played
    FROM jukebox_play_history
    WHERE jukebox_id = ?
    GROUP BY library_track_id
    ORDER BY last_played DESC
    LIMIT ?
  `,
    )
    .all(jukeboxId, limit);
  const out = [];
  for (const r of rows) {
    const t = getTrackByIdStmt.get(r.library_track_id);
    const row = trackRowToDiscoveryRow(t);
    if (row) {
      out.push({ ...row, last_played: r.last_played });
    }
  }
  return out;
}

const jukeboxDeezerCoverCache = new Map();

async function albumCoverUrlForDeezerId(deezerId) {
  const key = String(deezerId || '').trim();
  if (!key) {
    return null;
  }
  if (jukeboxDeezerCoverCache.has(key)) {
    return jukeboxDeezerCoverCache.get(key);
  }
  try {
    const t = await deezer.getTrackById(key);
    const u = t.albumCover || null;
    jukeboxDeezerCoverCache.set(key, u);
    return u;
  } catch {
    jukeboxDeezerCoverCache.set(key, null);
    return null;
  }
}

function collectLibraryIdsForGuestExclude(jukeboxId) {
  const ids = new Set();
  const cur = getCurrentItem(jukeboxId);
  if (cur?.library_track_id) {
    ids.add(Number(cur.library_track_id));
  }
  for (const it of listQueueStmt.all(jukeboxId)) {
    if (it.library_track_id) {
      ids.add(Number(it.library_track_id));
    }
  }
  return [...ids];
}

function randomLibraryTracksExcluding(jukeboxId, excludeLibIds, limit) {
  const exclude = [...new Set((excludeLibIds || []).filter(Boolean).map(Number))];
  const lim = Math.min(30, Math.max(1, Math.floor(Number(limit) || 25)));
  let sql = `
    SELECT id, trackflow_id, artist, title, album FROM tracks
    WHERE db_exists = 1 AND trackflow_id IS NOT NULL AND TRIM(COALESCE(trackflow_id, '')) != ''`;
  const params = [];
  if (exclude.length) {
    sql += ` AND id NOT IN (${exclude.map(() => '?').join(',')})`;
    params.push(...exclude);
  }
  sql += ` ORDER BY RANDOM() LIMIT ?`;
  params.push(lim);
  const rows = db.prepare(sql).all(...params);
  return rows.map((t) => ({
    library_track_id: t.id,
    deezer_id: t.trackflow_id,
    title: t.title,
    artist: t.artist,
    album: t.album || '',
  }));
}

function normalizeDiscoveryRow(r) {
  const library_track_id = Number(r.library_track_id ?? r.id);
  if (!Number.isFinite(library_track_id) || library_track_id < 1) {
    return null;
  }
  return {
    library_track_id,
    deezer_id: r.deezer_id != null ? String(r.deezer_id) : null,
    title: r.title || 'Track',
    artist: r.artist || '',
    album: r.album || '',
  };
}

function mergePrimaryWithRandom(primaryRows, jukeboxId, excludeLibIds, targetLen) {
  const target = Math.min(30, Math.max(1, Math.floor(Number(targetLen) || 25)));
  const seenLib = new Set((excludeLibIds || []).filter(Boolean).map(Number));
  const out = [];
  for (const r of primaryRows || []) {
    const row = normalizeDiscoveryRow(r);
    if (!row || seenLib.has(row.library_track_id)) {
      continue;
    }
    seenLib.add(row.library_track_id);
    out.push(row);
    if (out.length >= target) {
      return out;
    }
  }
  let guard = 0;
  while (out.length < target && guard < 8) {
    guard += 1;
    const need = target - out.length;
    const random = randomLibraryTracksExcluding(jukeboxId, [...seenLib], need + 5);
    if (!random.length) {
      break;
    }
    for (const r of random) {
      const row = normalizeDiscoveryRow(r);
      if (!row || seenLib.has(row.library_track_id)) {
        continue;
      }
      seenLib.add(row.library_track_id);
      out.push(row);
      if (out.length >= target) {
        return out;
      }
    }
  }
  return out;
}

async function enrichDiscoveryRowsAlbumCovers(rows) {
  const ids = [...new Set(rows.map((r) => r.deezer_id).filter(Boolean))];
  await Promise.all(ids.map((id) => albumCoverUrlForDeezerId(String(id))));
  return rows.map((r) => ({
    ...r,
    album_cover: r.deezer_id ? jukeboxDeezerCoverCache.get(String(r.deezer_id)) ?? null : null,
  }));
}

async function buildGuestDiscovery(jukeboxId, excludeLibIds) {
  const targetLen = 20;
  const popPool = popularTracks(jukeboxId, 120);
  shuffleInPlace(popPool);
  const topMerged = mergePrimaryWithRandom(popPool, jukeboxId, excludeLibIds, targetLen);

  const recentPool = recentMixCandidatesFromHistory(jukeboxId, excludeLibIds);
  const recentMerged = mergePrimaryWithRandom(recentPool, jukeboxId, excludeLibIds, targetLen);

  const freshStrip = freshTracksFromRecentLibraryAdds(excludeLibIds);

  const [top_tracks, recent_mix, fresh_tracks] = await Promise.all([
    enrichDiscoveryRowsAlbumCovers(topMerged),
    enrichDiscoveryRowsAlbumCovers(recentMerged),
    enrichDiscoveryRowsAlbumCovers(freshStrip),
  ]);
  return { top_tracks, recent_mix, fresh_tracks };
}

async function enrichGuestPlayerCovers(state) {
  if (!state) {
    return;
  }
  if (state.current?.deezer_id) {
    const album_cover = await albumCoverUrlForDeezerId(state.current.deezer_id);
    state.current = { ...state.current, album_cover };
  }
  if (Array.isArray(state.queue) && state.queue.length) {
    const ids = [...new Set(state.queue.map((q) => q.deezer_id).filter(Boolean))];
    await Promise.all(ids.map((id) => albumCoverUrlForDeezerId(String(id))));
    state.queue = state.queue.map((q) => ({
      ...q,
      album_cover: q.deezer_id ? jukeboxDeezerCoverCache.get(String(q.deezer_id)) ?? null : null,
    }));
  }
}

function assertHostToken(jb, token) {
  return jb && jb.host_token === String(token || '').trim();
}

function assertGuestToken(jb, token) {
  return jb && jb.guest_token === String(token || '').trim();
}

function resolveStreamPath(libraryTrackId) {
  const row = getTrackByIdStmt.get(libraryTrackId);
  if (!row || Number(row.db_exists) !== 1 || !row.file_path) {
    return null;
  }
  return resolveStoredLibraryFileToAbsolute(row.file_path);
}

/** True when jukebox can play this `tracks` row from a configured library root on disk. */
function trackRowPlayableInJukebox(row) {
  if (!row || !(Number(row.id) > 0)) {
    return false;
  }
  return Boolean(resolveStreamPath(Number(row.id)));
}

function canGuestStreamTrack(jukeboxId, libraryTrackId) {
  const jb = getJukeboxById(jukeboxId);
  if (!jb) {
    return false;
  }
  const cur = getCurrentItem(jukeboxId);
  return Boolean(cur && Number(cur.library_track_id) === Number(libraryTrackId));
}

function canHostStreamTrack(jukeboxId, libraryTrackId) {
  if (canGuestStreamTrack(jukeboxId, libraryTrackId)) {
    return true;
  }
  const items = listQueueStmt.all(jukeboxId);
  return items.some((i) => Number(i.library_track_id) === Number(libraryTrackId));
}

function hostSkip(jukeboxId, token) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertHostToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  const cur = getCurrentItem(jukeboxId);
  if (cur) {
    recordPlayAndAdvance(jukeboxId, cur.id);
  }
}

function hostSetPauseVolume(jukeboxId, token, body) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertHostToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  const wantsUnpause = body?.is_paused === false;
  if (wantsUnpause && !jukeboxIsClosed(jb)) {
    ensureNowPlaying(jukeboxId);
  }
  const jb2 = getJukeboxById(jukeboxId);
  const is_paused = body?.is_paused !== undefined ? (body.is_paused ? 1 : 0) : jb2.is_paused;
  let volume = jb2.volume;
  if (body?.volume != null && Number.isFinite(Number(body.volume))) {
    volume = Math.min(1, Math.max(0, Number(body.volume)));
  }
  updateJukeboxPlaybackStmt.run({
    id: jukeboxId,
    current_queue_item_id: jb2.current_queue_item_id,
    is_paused,
    volume,
  });
}

/** Guest: pause/play and/or volume (touch UI). */
function guestSetPause(jukeboxId, token, body) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertGuestToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  const rawPause = body?.is_paused;
  const hasPause =
    body &&
    Object.prototype.hasOwnProperty.call(body, 'is_paused') &&
    (typeof rawPause === 'boolean' ||
      rawPause === 'false' ||
      rawPause === 'true' ||
      rawPause === 0 ||
      rawPause === 1);
  const wantsPaused =
    hasPause &&
    (rawPause === true || rawPause === 'true' || rawPause === 1);
  const hasVol = body?.volume != null && Number.isFinite(Number(body.volume));
  if (!hasPause && !hasVol) {
    throw new Error('is_paused or volume required');
  }
  if (hasPause && !wantsPaused) {
    if (jukeboxIsClosed(jb)) {
      reopenJukeboxStmt.run(jukeboxId);
    }
    ensureNowPlaying(jukeboxId);
  }
  const jb2 = getJukeboxById(jukeboxId);
  let is_paused = Number(jb2.is_paused) ? 1 : 0;
  if (hasPause) {
    is_paused = wantsPaused ? 1 : 0;
  }
  let volume = normalizeJukeboxVolume01(jb2.volume);
  if (hasVol) {
    volume = normalizeJukeboxVolume01(body.volume);
  }
  updateJukeboxPlaybackStmt.run({
    id: jukeboxId,
    current_queue_item_id: jb2.current_queue_item_id,
    is_paused,
    volume,
  });
}

function hostReorder(jukeboxId, token, orderedIds) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertHostToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  if (!Array.isArray(orderedIds)) {
    throw new Error('orderedIds array required');
  }
  const items = listQueueStmt.all(jukeboxId);
  const idSet = new Set(items.map((i) => Number(i.id)));
  const normalized = orderedIds.map((x) => Number(x));
  for (const id of normalized) {
    if (!idSet.has(id)) {
      throw new Error('invalid queue item id');
    }
  }
  assignQueuePositions(jukeboxId, normalized);
}

function hostRemoveQueueItem(jukeboxId, token, itemId) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertHostToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  deleteQueueItemStmt.run(itemId, jukeboxId);
  renumberQueue(jukeboxId);
  if (Number(jb.current_queue_item_id) === Number(itemId)) {
    updateJukeboxPlaybackStmt.run({
      id: jukeboxId,
      current_queue_item_id: null,
      is_paused: jb.is_paused,
      volume: jb.volume,
    });
    ensureNowPlaying(jukeboxId);
  }
}

/** Remove all queue rows except the one currently playing (if any). */
function hostClearQueue(jukeboxId, token) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertHostToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  const curId = jb.current_queue_item_id != null ? Number(jb.current_queue_item_id) : null;
  const items = listQueueStmt.all(jukeboxId);
  for (const it of items) {
    if (curId != null && Number(it.id) === curId) {
      continue;
    }
    deleteQueueItemStmt.run(it.id, jukeboxId);
  }
  renumberQueue(jukeboxId);
  void maybeRefillPlaylist(jukeboxId);
}

function hostClose(jukeboxId, token) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertHostToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  updateJukeboxClosedStmt.run(jukeboxId);
}

async function hostAddPlaylist(jukeboxId, token, playlistId) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertHostToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  const pid = String(playlistId || '').trim();
  if (!pid) {
    throw new Error('playlist_id required');
  }
  const raw = await deezer.fetchPlaylistAllTracks(pid);
  let pos = nextQueuePosition(jukeboxId);
  let n = 0;
  for (const t of raw) {
    const did = t?.id != null ? String(t.id) : null;
    if (!did) {
      continue;
    }
    const lib = resolveLibraryTrackForDeezer(did);
    if (!lib || !trackRowPlayableInJukebox(lib)) {
      continue;
    }
    insertQueueStmt.run({
      jukebox_id: jukeboxId,
      position: pos,
      source: 'host',
      library_track_id: lib.id,
      deezer_id: did,
      title: t.title || lib.title,
      artist: t.artist?.name || lib.artist,
      album: t.album?.title || lib.album,
      request_id: null,
      status: 'queued',
    });
    pos += 1;
    n += 1;
  }
  renumberQueue(jukeboxId);
  ensureNowPlaying(jukeboxId);
  return { added: n };
}

async function guestPlayNext(jukeboxId, token, pin, body) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertGuestToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  if (jb.pin_require_play_next && !verifyPin(jb, pin)) {
    throw new Error('PIN_REQUIRED');
  }
  const raw = body && typeof body === 'object' ? { ...body } : {};
  delete raw.pin;
  return addGuestTrack(jukeboxId, { ...raw, play_next: true });
}

function guestSkipOrClose(jukeboxId, token, pin, action) {
  const jb = getJukeboxById(jukeboxId);
  if (!assertGuestToken(jb, token)) {
    throw new Error('FORBIDDEN');
  }
  if (action === 'skip') {
    if (jb.pin_require_skip && !verifyPin(jb, pin)) {
      throw new Error('PIN_REQUIRED');
    }
    const cur = getCurrentItem(jukeboxId);
    if (cur) {
      recordPlayAndAdvance(jukeboxId, cur.id);
    }
    return { ok: true };
  }
  if (action === 'close') {
    if (jb.pin_require_close && !verifyPin(jb, pin)) {
      throw new Error('PIN_REQUIRED');
    }
    clearJukeboxPlayback(jukeboxId);
    updateJukeboxClosedStmt.run(jukeboxId);
    return { ok: true };
  }
  throw new Error('bad action');
}

function verifyPinAction(jukeboxId, token, pin, mode) {
  const jb = getJukeboxById(jukeboxId);
  const ok =
    mode === 'guest'
      ? assertGuestToken(jb, token)
      : mode === 'host'
        ? assertHostToken(jb, token)
        : false;
  if (!ok) {
    throw new Error('FORBIDDEN');
  }
  return { valid: verifyPin(jb, pin) };
}

module.exports = {
  getJukeboxById,
  getDefaultJukeboxForUser,
  ensureDefaultJukeboxForUser,
  listJukeboxes,
  createJukebox,
  updateJukebox,
  deleteJukebox,
  clearPlayHistoryForUserDefault,
  serializeJukeboxDetail,
  addGuestTrack,
  guestPlayNext,
  guestSkipOrClose,
  buildState,
  isPanelPlaybackActive,
  popularTracks,
  recentTracks,
  recordPlayAndAdvance,
  ensureNowPlaying,
  promotePendingQueueItems,
  assertGuestToken,
  assertHostToken,
  resolveStreamPath,
  trackRowPlayableInJukebox,
  canGuestStreamTrack,
  canHostStreamTrack,
  hostSkip,
  hostSeek,
  hostSetPauseVolume,
  guestSetPause,
  guestReportPlayback,
  collectLibraryIdsForGuestExclude,
  buildGuestDiscovery,
  getJukeboxGuestDisplayLimits,
  buildPlayHistoryDisplay,
  enrichDiscoveryRowsAlbumCovers,
  enrichGuestPlayerCovers,
  hostReorder,
  hostRemoveQueueItem,
  hostClearQueue,
  hostClose,
  hostAddPlaylist,
  verifyPinAction,
};
