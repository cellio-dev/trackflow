/**
 * Persist admin decisions on playlist/artist follow requests (for Request history UI).
 */

const { getDb } = require('../db');

/**
 * Remove a denied tombstone row from followed_* when its follow_request_history row is removed.
 * @param {{ follow_kind?: string, entity_id?: string, user_id?: string, outcome?: string }} row
 */
function purgeDeniedFollowForHistoryRow(row) {
  if (!row || String(row.outcome || '').toLowerCase() !== 'denied') {
    return;
  }
  const uid = String(row.user_id != null ? row.user_id : '').trim();
  const eid = String(row.entity_id != null ? row.entity_id : '').trim();
  if (!uid || !eid) {
    return;
  }
  const db = getDb();
  const kind = String(row.follow_kind || '').toLowerCase();
  if (kind === 'playlist') {
    db.prepare(
      `DELETE FROM followed_playlists WHERE user_id = ? AND playlist_id = ? AND follow_status = 'denied'`,
    ).run(uid, eid);
  } else if (kind === 'artist') {
    db.prepare(
      `DELETE FROM followed_artists WHERE user_id = ? AND artist_id = ? AND follow_status = 'denied'`,
    ).run(uid, eid);
  }
}

/** After clearing denied follow history for a scope, drop matching denied follows so users can retry. */
function purgeDeniedFollowRowsForUserScope(userId) {
  const db = getDb();
  if (userId != null && String(userId).trim()) {
    const u = String(userId).trim();
    db.prepare(`DELETE FROM followed_playlists WHERE user_id = ? AND follow_status = 'denied'`).run(u);
    db.prepare(`DELETE FROM followed_artists WHERE user_id = ? AND follow_status = 'denied'`).run(u);
  } else {
    db.prepare(`DELETE FROM followed_playlists WHERE follow_status = 'denied'`).run();
    db.prepare(`DELETE FROM followed_artists WHERE follow_status = 'denied'`).run();
  }
}

/**
 * @param {object} row — pending follow row (playlist or artist shape)
 * @param {'playlist'|'artist'} followKind
 * @param {'approved'|'denied'} outcome
 */
function recordFollowResolution(row, followKind, outcome) {
  if (!row) {
    return;
  }
  const entityId =
    followKind === 'playlist'
      ? row.playlist_id != null
        ? String(row.playlist_id)
        : ''
      : row.artist_id != null
        ? String(row.artist_id)
        : '';
  const title =
    followKind === 'playlist'
      ? row.title != null
        ? String(row.title)
        : ''
      : row.name != null
        ? String(row.name)
        : '';
  const uid = String(row.user_id != null ? row.user_id : '').trim();
  if (!uid) {
    console.error('recordFollowResolution: missing user_id on pending follow row', followKind, row);
    throw new Error('follow_request_history: missing user_id');
  }
  const db = getDb();
  db.prepare(
    `
    INSERT INTO follow_request_history (follow_kind, entity_id, title, user_id, outcome, requested_at, resolved_at)
    VALUES (@follow_kind, @entity_id, @title, @user_id, @outcome, @requested_at, datetime('now'))
  `,
  ).run({
    follow_kind: followKind,
    entity_id: entityId,
    title,
    user_id: uid,
    outcome,
    requested_at: row.created_at != null ? String(row.created_at) : null,
  });
}

let cachedListStmts = null;

function listStatements() {
  if (cachedListStmts) {
    return cachedListStmts;
  }
  const db = getDb();
  cachedListStmts = {
    listAll: db.prepare(`
      SELECT id, follow_kind, entity_id, title, user_id, outcome, requested_at, resolved_at
      FROM follow_request_history
      ORDER BY datetime(resolved_at) DESC, id DESC
      LIMIT 500
    `),
    listForUser: db.prepare(`
      SELECT id, follow_kind, entity_id, title, user_id, outcome, requested_at, resolved_at
      FROM follow_request_history
      WHERE user_id = ?
      ORDER BY datetime(resolved_at) DESC, id DESC
      LIMIT 500
    `),
    getById: db.prepare(`
      SELECT id, follow_kind, entity_id, title, user_id, outcome, requested_at, resolved_at
      FROM follow_request_history
      WHERE id = ?
    `),
    deleteById: db.prepare(`DELETE FROM follow_request_history WHERE id = ?`),
    deleteByIdForUser: db.prepare(`
      DELETE FROM follow_request_history WHERE id = ? AND user_id = ?
    `),
    deleteAllForUser: db.prepare(`DELETE FROM follow_request_history WHERE user_id = ?`),
    deleteAll: db.prepare(`DELETE FROM follow_request_history`),
  };
  return cachedListStmts;
}

function listAllFollowHistory() {
  return listStatements().listAll.all();
}

function listFollowHistoryForUser(userId) {
  return listStatements().listForUser.all(String(userId));
}

function getFollowHistoryById(id) {
  return listStatements().getById.get(id);
}

function deleteFollowHistoryById(id) {
  const row = listStatements().getById.get(id);
  if (!row) {
    return { changes: 0 };
  }
  const r = listStatements().deleteById.run(id);
  if (r.changes) {
    purgeDeniedFollowForHistoryRow(row);
  }
  return r;
}

function deleteFollowHistoryByIdForUser(id, userId) {
  const uid = String(userId);
  const row = listStatements().getById.get(id);
  if (!row || String(row.user_id) !== uid) {
    return { changes: 0 };
  }
  const r = listStatements().deleteByIdForUser.run(id, uid);
  if (r.changes) {
    purgeDeniedFollowForHistoryRow(row);
  }
  return r;
}

function deleteAllFollowHistoryForUser(userId) {
  const r = listStatements().deleteAllForUser.run(String(userId));
  purgeDeniedFollowRowsForUserScope(String(userId));
  return r;
}

function deleteAllFollowHistory() {
  const r = listStatements().deleteAll.run();
  purgeDeniedFollowRowsForUserScope(null);
  return r;
}

/**
 * @param {number} days — validated 1..3650
 * @param {string | null} userId — scope, or null for all users (admin)
 */
function deleteFollowHistoryOlderThanDays(days, userId) {
  const d = Math.min(3650, Math.max(1, Math.floor(Number(days) || 0)));
  const mod = `-${d} days`;
  const db = getDb();
  const listSql =
    userId != null && String(userId).trim()
      ? `SELECT follow_kind, entity_id, user_id, outcome FROM follow_request_history WHERE user_id = ? AND datetime(IFNULL(resolved_at, requested_at)) < datetime('now', ?)`
      : `SELECT follow_kind, entity_id, user_id, outcome FROM follow_request_history WHERE datetime(IFNULL(resolved_at, requested_at)) < datetime('now', ?)`;
  const stale =
    userId != null && String(userId).trim()
      ? db.prepare(listSql).all(String(userId).trim(), mod)
      : db.prepare(listSql).all(mod);
  for (let i = 0; i < stale.length; i += 1) {
    purgeDeniedFollowForHistoryRow(stale[i]);
  }
  if (userId != null && String(userId).trim()) {
    return db
      .prepare(
        `DELETE FROM follow_request_history WHERE user_id = ? AND datetime(IFNULL(resolved_at, requested_at)) < datetime('now', ?)`,
      )
      .run(String(userId).trim(), mod);
  }
  return db
    .prepare(
      `DELETE FROM follow_request_history WHERE datetime(IFNULL(resolved_at, requested_at)) < datetime('now', ?)`,
    )
    .run(mod);
}

function deleteFollowHistoryByOutcomeForScope(outcome, userId) {
  if (outcome !== 'approved' && outcome !== 'denied') {
    return { changes: 0 };
  }
  const db = getDb();
  let histChanges;
  if (userId != null && String(userId).trim()) {
    histChanges = db
      .prepare(`DELETE FROM follow_request_history WHERE outcome = ? AND user_id = ?`)
      .run(outcome, String(userId).trim());
  } else {
    histChanges = db.prepare(`DELETE FROM follow_request_history WHERE outcome = ?`).run(outcome);
  }
  if (outcome === 'denied') {
    purgeDeniedFollowRowsForUserScope(userId);
  }
  return histChanges;
}

module.exports = {
  recordFollowResolution,
  listAllFollowHistory,
  listFollowHistoryForUser,
  getFollowHistoryById,
  deleteFollowHistoryById,
  deleteFollowHistoryByIdForUser,
  deleteAllFollowHistoryForUser,
  deleteAllFollowHistory,
  deleteFollowHistoryOlderThanDays,
  deleteFollowHistoryByOutcomeForScope,
};
