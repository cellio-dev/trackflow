/**
 * Bulk updates for /api/requests/*-all and retry-failed.
 * Approve / retry mirror per-row admin approve (processing + download queue).
 */

const { getDb } = require('../db');
const { approveRequestById, dropPendingDownloadsForRequestIds } = require('./requestApproval');
const slskd = require('./slskd');
const {
  deleteAllFollowHistory,
  deleteAllFollowHistoryForUser,
  deleteFollowHistoryOlderThanDays,
  deleteFollowHistoryByOutcomeForScope,
} = require('./followRequestHistory');
const { addBlockedTrackFromRequestRow } = require('./blockedTracks');
const { yieldToEventLoop } = require('./cooperativeYield');

const db = getDb();

const getRequestByIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, processed_at, request_type
  FROM requests
  WHERE id = ?
`);

const setCancelledFailedStmt = db.prepare(`
  UPDATE requests
  SET status = 'failed', cancelled = 1, processed_at = datetime('now')
  WHERE id = ?
`);

function normalizeUserScope(userId) {
  if (userId == null) {
    return null;
  }
  const s = String(userId).trim();
  return s || null;
}

/**
 * @param {{ userId?: string | null }} options — if set, only rows for this user_id
 */
async function approveAllPending(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const listStmt = userId
    ? db.prepare(`
        SELECT id FROM requests
        WHERE status IN ('pending', 'requested') AND user_id = ?
        ORDER BY id ASC
      `)
    : db.prepare(`
        SELECT id FROM requests
        WHERE status IN ('pending', 'requested')
        ORDER BY id ASC
      `);

  const rows = userId ? listStmt.all(userId) : listStmt.all();
  let updated = 0;
  for (const row of rows) {
    const result = await approveRequestById(row.id);
    if (result.ok) {
      updated += 1;
    }
  }
  return { updated };
}

/**
 * Cancel all processing (same as admin cancel per row).
 * @param {{ userId?: string | null }} options
 */
async function cancelAllActive(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const listStmt = userId
    ? db.prepare(`
        SELECT id FROM requests
        WHERE status = 'processing' AND user_id = ?
        ORDER BY id ASC
      `)
    : db.prepare(`
        SELECT id FROM requests
        WHERE status = 'processing'
        ORDER BY id ASC
      `);

  const rows = userId ? listStmt.all(userId) : listStmt.all();
  if (rows.length === 0) {
    return { updated: 0 };
  }
  for (const row of rows) {
    setCancelledFailedStmt.run(row.id);
  }
  dropPendingDownloadsForRequestIds(rows.map((r) => r.id));
  for (const row of rows) {
    try {
      await slskd.cancelActiveDownloadForRequest(getRequestByIdStmt.get(row.id));
    } catch (err) {
      console.error('bulk cancel: slskd notify failed (ignored):', err?.message || err);
    }
  }
  return { updated: rows.length };
}

const listDenyCandidatesByUserStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, processed_at, request_type
  FROM requests
  WHERE user_id = ?
    AND (
      status IN ('pending', 'requested')
      OR (status = 'failed' AND IFNULL(cancelled, 0) != 1)
    )
  ORDER BY id ASC
`);

const listDenyCandidatesStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, processed_at, request_type
  FROM requests
  WHERE status IN ('pending', 'requested')
     OR (status = 'failed' AND IFNULL(cancelled, 0) != 1)
  ORDER BY id ASC
`);

const setRequestDeniedStmt = db.prepare(`
  UPDATE requests
  SET status = 'denied', cancelled = 0, processing_phase = NULL, processed_at = datetime('now')
  WHERE id = ?
`);

const denyAllTx = db.transaction((rows) => {
  let updated = 0;
  for (const row of rows) {
    addBlockedTrackFromRequestRow(row, 'denied');
    const r = setRequestDeniedStmt.run(row.id);
    if ((r.changes || 0) > 0) {
      updated += 1;
    }
  }
  return updated;
});

/**
 * Deny pending/requested and needs-attention failed rows: add blocked_tracks entry and set status = denied.
 * Excludes user-cancelled failures (failed + cancelled=1).
 * @param {{ userId?: string | null }} options
 */
function denyAllPending(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const rows = userId ? listDenyCandidatesByUserStmt.all(userId) : listDenyCandidatesStmt.all();
  if (rows.length === 0) {
    return { updated: 0 };
  }
  return { updated: denyAllTx(rows) };
}

/**
 * Same as clicking Retry on each failed row (excludes user-canceled: failed + cancelled=1).
 * @param {{ userId?: string | null }} options
 */
async function retryAllFailed(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const listStmt = userId
    ? db.prepare(`
        SELECT id FROM requests
        WHERE status = 'failed' AND IFNULL(cancelled, 0) != 1 AND user_id = ?
        ORDER BY id ASC
      `)
    : db.prepare(`
        SELECT id FROM requests
        WHERE status = 'failed' AND IFNULL(cancelled, 0) != 1
        ORDER BY id ASC
      `);

  const rows = userId ? listStmt.all(userId) : listStmt.all();
  let updated = 0;
  for (const row of rows) {
    const result = await approveRequestById(row.id);
    if (result.ok) {
      updated += 1;
    }
  }
  return { updated };
}

/** Terminal / cleared-from-queue statuses only — never pending, requested, or active processing. */
const CLEARABLE_STATUSES = ['completed', 'failed', 'available', 'denied'];

/**
 * Delete request rows in completed, failed, denied (and legacy available). Same as Clear on those rows.
 * Does not remove pending, requested, or processing (including active downloads).
 * @param {{ userId?: string | null }} options
 * @returns {{ deleted: number }}
 */
function clearAllRequests(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const placeholders = CLEARABLE_STATUSES.map(() => '?').join(', ');
  const sql = userId
    ? `DELETE FROM requests WHERE user_id = ? AND status IN (${placeholders})`
    : `DELETE FROM requests WHERE status IN (${placeholders})`;
  const params = userId ? [userId, ...CLEARABLE_STATUSES] : CLEARABLE_STATUSES;
  const result = db.prepare(sql).run(...params);
  return { deleted: result.changes || 0 };
}

const HISTORY_TRACK_TERMINAL_SQL = `
  status IN ('denied', 'available')
  OR (status = 'failed' AND IFNULL(cancelled, 0) = 1)
  OR (status = 'processing' AND IFNULL(cancelled, 0) = 1)
`;

const HISTORY_TRACK_AGE_TERMINAL_SQL = `
  status = 'available'
  OR (status = 'failed' AND IFNULL(cancelled, 0) = 1)
  OR (status = 'processing' AND IFNULL(cancelled, 0) = 1)
`;

/**
 * Remove finished track requests + follow decision log (Request history UI).
 * @param {{ userId?: string | null }} options
 * @returns {{ deletedTracks: number, deletedFollows: number }}
 */
function clearAllHistory(options = {}) {
  const userId = normalizeUserScope(options.userId);

  const delTerminalStmt = userId
    ? db.prepare(`DELETE FROM requests WHERE user_id = ? AND (${HISTORY_TRACK_TERMINAL_SQL})`)
    : db.prepare(`DELETE FROM requests WHERE (${HISTORY_TRACK_TERMINAL_SQL})`);
  const terminalResult = userId ? delTerminalStmt.run(userId) : delTerminalStmt.run();

  const delCompletedStmt = userId
    ? db.prepare(`DELETE FROM requests WHERE user_id = ? AND status = 'completed'`)
    : db.prepare(`DELETE FROM requests WHERE status = 'completed'`);
  const completedResult = userId ? delCompletedStmt.run(userId) : delCompletedStmt.run();

  const trackChanges = (terminalResult.changes || 0) + (completedResult.changes || 0);
  let followResult;
  if (userId) {
    followResult = deleteAllFollowHistoryForUser(userId);
  } else {
    followResult = deleteAllFollowHistory();
  }
  return {
    deletedTracks: trackChanges,
    deletedFollows: followResult.changes || 0,
  };
}

const TRACK_HISTORY_STATUS_FILTERS = {
  /** Finished / error rows only (exclude pending, requested, active processing). */
  all: `(status IN ('completed', 'available', 'denied', 'failed') OR (status = 'processing' AND IFNULL(cancelled, 0) = 1))`,
  /** Library-complete outcomes (includes legacy status = 'available'). */
  completed: `status IN ('completed', 'available')`,
  /** Failed downloads and user-cancelled attempts (failed + cancelled, or processing + cancelled). */
  failed: `(status = 'failed' OR (status = 'processing' AND IFNULL(cancelled, 0) = 1))`,
  /** User-cancelled only (failed + cancelled, or processing + cancelled). */
  canceled: `((status = 'failed' AND IFNULL(cancelled, 0) = 1) OR (status = 'processing' AND IFNULL(cancelled, 0) = 1))`,
  denied: `status = 'denied'`,
};

/**
 * Delete finished track history rows for one status bucket.
 * @param {{ userId?: string | null, track_status: string }} options
 */
function clearHistoryTrackByStatus(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const key = String(options.track_status || '').trim();
  const clause = TRACK_HISTORY_STATUS_FILTERS[key];
  if (!clause) {
    return { deleted: 0 };
  }
  const sql = userId
    ? `DELETE FROM requests WHERE user_id = ? AND (${clause})`
    : `DELETE FROM requests WHERE (${clause})`;
  const r = userId ? db.prepare(sql).run(userId) : db.prepare(sql).run();
  return { deleted: r.changes || 0 };
}

/**
 * Delete follow_request_history rows for one outcome.
 * @param {{ userId?: string | null, follow_outcome: 'approved'|'denied' }} options
 */
function clearHistoryFollowByOutcome(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const outcome = String(options.follow_outcome || '').trim();
  return deleteFollowHistoryByOutcomeForScope(outcome, userId);
}

/**
 * Delete completed track rows older than N days (scheduled retention).
 * @param {{ userId?: string | null, older_than_days: number }} options
 * @returns {{ deletedTracks: number }}
 */
function clearCompletedRequestsOlderThanDays(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const days = Math.min(3650, Math.max(1, Math.floor(Number(options.older_than_days) || 0)));
  const mod = `-${days} days`;
  const sql = userId
    ? `DELETE FROM requests WHERE user_id = ? AND status = 'completed' AND datetime(COALESCE(processed_at, created_at)) < datetime('now', ?)`
    : `DELETE FROM requests WHERE status = 'completed' AND datetime(COALESCE(processed_at, created_at)) < datetime('now', ?)`;
  const r = userId ? db.prepare(sql).run(userId, mod) : db.prepare(sql).run(mod);
  return { deletedTracks: r.changes || 0 };
}

function clearHistoryOlderThanDays(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const days = Math.min(3650, Math.max(1, Math.floor(Number(options.older_than_days) || 0)));
  const mod = `-${days} days`;
  const trackSqlTerminal = userId
    ? `DELETE FROM requests WHERE user_id = ? AND (${HISTORY_TRACK_AGE_TERMINAL_SQL}) AND datetime(created_at) < datetime('now', ?)`
    : `DELETE FROM requests WHERE (${HISTORY_TRACK_AGE_TERMINAL_SQL}) AND datetime(created_at) < datetime('now', ?)`;
  const terminalResult = userId
    ? db.prepare(trackSqlTerminal).run(userId, mod)
    : db.prepare(trackSqlTerminal).run(mod);

  const delOldCompletedSql = userId
    ? `DELETE FROM requests WHERE user_id = ? AND status = 'completed' AND datetime(COALESCE(processed_at, created_at)) < datetime('now', ?)`
    : `DELETE FROM requests WHERE status = 'completed' AND datetime(COALESCE(processed_at, created_at)) < datetime('now', ?)`;
  const completedResult = userId
    ? db.prepare(delOldCompletedSql).run(userId, mod)
    : db.prepare(delOldCompletedSql).run(mod);

  const followResult = deleteFollowHistoryOlderThanDays(days, userId);
  return {
    deletedTracks: (terminalResult.changes || 0) + (completedResult.changes || 0),
    deletedFollows: followResult.changes || 0,
  };
}

/**
 * Retry failed requests older than N days (excluding user-canceled failures).
 * @param {{ userId?: string | null, older_than_days: number }} options
 * @returns {Promise<{retried: number}>}
 */
async function retryFailedRequestsOlderThanDays(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const days = Math.min(3650, Math.max(1, Math.floor(Number(options.older_than_days) || 0)));
  const mod = `-${days} days`;
  const listStmt = userId
    ? db.prepare(`
        SELECT id
        FROM requests
        WHERE user_id = ?
          AND status = 'failed'
          AND IFNULL(cancelled, 0) != 1
          AND datetime(COALESCE(processed_at, created_at)) < datetime('now', ?)
        ORDER BY id ASC
      `)
    : db.prepare(`
        SELECT id
        FROM requests
        WHERE status = 'failed'
          AND IFNULL(cancelled, 0) != 1
          AND datetime(COALESCE(processed_at, created_at)) < datetime('now', ?)
        ORDER BY id ASC
      `);
  const rows = userId ? listStmt.all(userId, mod) : listStmt.all(mod);
  let retried = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const result = await approveRequestById(row.id);
    if (result.ok) {
      retried += 1;
    }
    if (i + 1 < rows.length) {
      await yieldToEventLoop();
    }
  }
  return { retried };
}

module.exports = {
  approveAllPending,
  cancelAllActive,
  denyAllPending,
  retryAllFailed,
  clearAllRequests,
  clearAllHistory,
  clearHistoryTrackByStatus,
  clearHistoryFollowByOutcome,
  clearHistoryOlderThanDays,
  clearCompletedRequestsOlderThanDays,
  retryFailedRequestsOlderThanDays,
  TRACK_HISTORY_STATUS_FILTERS,
};
