/**
 * Persist admin decisions on playlist/artist follow requests (for Request history UI).
 */

const { getDb } = require('../db');

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
  return listStatements().deleteById.run(id);
}

function deleteFollowHistoryByIdForUser(id, userId) {
  return listStatements().deleteByIdForUser.run(id, String(userId));
}

function deleteAllFollowHistoryForUser(userId) {
  return listStatements().deleteAllForUser.run(String(userId));
}

function deleteAllFollowHistory() {
  return listStatements().deleteAll.run();
}

/**
 * @param {number} days — validated 1..3650
 * @param {string | null} userId — scope, or null for all users (admin)
 */
function deleteFollowHistoryOlderThanDays(days, userId) {
  const d = Math.min(3650, Math.max(1, Math.floor(Number(days) || 0)));
  const mod = `-${d} days`;
  const db = getDb();
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
  if (userId != null && String(userId).trim()) {
    return db
      .prepare(`DELETE FROM follow_request_history WHERE outcome = ? AND user_id = ?`)
      .run(outcome, String(userId).trim());
  }
  return db.prepare(`DELETE FROM follow_request_history WHERE outcome = ?`).run(outcome);
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
