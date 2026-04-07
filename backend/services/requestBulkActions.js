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

const db = getDb();
const { enrichRequestRowFromTracksSync } = require('./tracksDb');
const { computeDisplayFields } = require('./requestDisplayStatus');

/**
 * Still waiting on Plex (UI: Processing / Plex Pending). Same row is often `status = completed`.
 * Exclude from history clears and from bulk "clear completed" until truly complete.
 */
function isPlexPendingCompletedTrackRow(rawRow) {
  if (!rawRow || String(rawRow.status || '') !== 'completed') {
    return false;
  }
  const enriched = enrichRequestRowFromTracksSync(rawRow);
  const { displayStatus, processingStatus } = computeDisplayFields(enriched);
  return displayStatus === 'Processing' && processingStatus === 'Plex Pending';
}

const markPlexFoundByIdStmt = db.prepare(`
  UPDATE requests
  SET plex_status = 'found'
  WHERE id = ?
`);

const getRequestByIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, plex_status, processing_phase, created_at, request_type
  FROM requests
  WHERE id = ?
`);

const setCancelledFailedStmt = db.prepare(`
  UPDATE requests
  SET status = 'failed', cancelled = 1
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

/**
 * Single row: mark Plex found when UI shows Plex Pending (completed + waiting on Plex).
 * @returns {{ ok: true, row: object } | { ok: false, code: string }}
 */
function markPlexFoundForSingleRequest(requestId) {
  const id = Number(requestId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, code: 'INVALID_ID' };
  }
  const row = getRequestByIdStmt.get(id);
  if (!row) {
    return { ok: false, code: 'NOT_FOUND' };
  }
  if (!isPlexPendingCompletedTrackRow(row)) {
    return { ok: false, code: 'NOT_PLEX_PENDING' };
  }
  markPlexFoundByIdStmt.run(id);
  return { ok: true, row: getRequestByIdStmt.get(id) };
}

/**
 * Completed rows that still show “Plex Pending” → treat as found in Plex (admin override).
 * @param {{ userId?: string | null }} options
 * @returns {{ updated: number }}
 */
function markAllPlexPendingFound(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const listStmt = userId
    ? db.prepare(`
        SELECT * FROM requests
        WHERE status = 'completed' AND user_id = ?
        ORDER BY id ASC
      `)
    : db.prepare(`
        SELECT * FROM requests
        WHERE status = 'completed'
        ORDER BY id ASC
      `);

  const rows = userId ? listStmt.all(userId) : listStmt.all();
  let updated = 0;
  for (const row of rows) {
    if (!isPlexPendingCompletedTrackRow(row)) {
      continue;
    }
    markPlexFoundByIdStmt.run(row.id);
    updated += 1;
  }
  return { updated };
}

/**
 * Mark pending + requested (admin “Pending” queue) as denied.
 * @param {{ userId?: string | null }} options
 */
function denyAllPending(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const runStmt = userId
    ? db.prepare(`
        UPDATE requests
        SET status = 'denied', processing_phase = NULL
        WHERE status IN ('pending', 'requested') AND user_id = ?
      `)
    : db.prepare(`
        UPDATE requests
        SET status = 'denied', processing_phase = NULL
        WHERE status IN ('pending', 'requested')
      `);

  const result = userId ? runStmt.run(userId) : runStmt.run();
  return { updated: result.changes || 0 };
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

/** Terminal / cleared-from-queue statuses only — never pending, requested, or processing. */
const CLEARABLE_STATUSES = ['completed', 'failed', 'denied', 'available'];

/**
 * Delete request rows in completed, failed, denied (and legacy available). Same as Clear on those rows.
 * Does not remove pending, requested, or processing (including active downloads).
 * @param {{ userId?: string | null }} options
 * @returns {{ deleted: number }}
 */
function clearAllRequests(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const placeholders = CLEARABLE_STATUSES.map(() => '?').join(', ');
  const listStmt = userId
    ? db.prepare(
        `SELECT * FROM requests WHERE user_id = ? AND status IN (${placeholders})`,
      )
    : db.prepare(`SELECT * FROM requests WHERE status IN (${placeholders})`);
  const params = userId ? [userId, ...CLEARABLE_STATUSES] : CLEARABLE_STATUSES;
  const rows = listStmt.all(...params);
  const delOne = db.prepare(`DELETE FROM requests WHERE id = ?`);
  let deleted = 0;
  for (const row of rows) {
    if (isPlexPendingCompletedTrackRow(row)) {
      continue;
    }
    delOne.run(row.id);
    deleted += 1;
  }
  return { deleted };
}

const HISTORY_TRACK_TERMINAL_SQL = `
  status IN ('denied', 'available')
  OR (status = 'failed' AND IFNULL(cancelled, 0) = 1)
  OR (status = 'processing' AND IFNULL(cancelled, 0) = 1)
`;

/** Time-based purge: terminal rows except denied, plus aged `completed` (Plex Pending completed rows skipped in JS). */
const HISTORY_TRACK_AGE_TERMINAL_SQL = `
  status = 'available'
  OR (status = 'failed' AND IFNULL(cancelled, 0) = 1)
  OR (status = 'processing' AND IFNULL(cancelled, 0) = 1)
`;

/**
 * Remove finished track requests + follow decision log (Request history UI).
 * Does not delete active queue rows (pending, requested, processing without cancel, failed without cancel).
 * Completed rows still showing Plex Pending are kept until Plex confirms.
 * @param {{ userId?: string | null }} options
 * @returns {{ deletedTracks: number, deletedFollows: number }}
 */
function clearAllHistory(options = {}) {
  const userId = normalizeUserScope(options.userId);

  const delTerminalStmt = userId
    ? db.prepare(`DELETE FROM requests WHERE user_id = ? AND (${HISTORY_TRACK_TERMINAL_SQL})`)
    : db.prepare(`DELETE FROM requests WHERE (${HISTORY_TRACK_TERMINAL_SQL})`);
  const terminalResult = userId ? delTerminalStmt.run(userId) : delTerminalStmt.run();

  const listCompletedStmt = userId
    ? db.prepare(`SELECT * FROM requests WHERE user_id = ? AND status = 'completed'`)
    : db.prepare(`SELECT * FROM requests WHERE status = 'completed'`);
  const completedRows = userId ? listCompletedStmt.all(userId) : listCompletedStmt.all();
  const delOne = db.prepare(`DELETE FROM requests WHERE id = ?`);
  let completedDeleted = 0;
  for (const row of completedRows) {
    if (isPlexPendingCompletedTrackRow(row)) {
      continue;
    }
    delOne.run(row.id);
    completedDeleted += 1;
  }

  const trackChanges = (terminalResult.changes || 0) + completedDeleted;
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

/** Finished track rows only — `completed` uses special handling (skips Plex Pending). */
const TRACK_HISTORY_STATUS_FILTERS = {
  completed: `status = 'completed'`,
  denied: `status = 'denied'`,
  available: `status = 'available'`,
  failed_cancelled: `status = 'failed' AND IFNULL(cancelled, 0) = 1`,
  processing_cancelled: `status = 'processing' AND IFNULL(cancelled, 0) = 1`,
  /** User-cancelled failed or processing rows (both buckets). */
  cancelled: `status IN ('failed', 'processing') AND IFNULL(cancelled, 0) = 1`,
};

/**
 * Delete finished track history rows for one status bucket.
 * @param {{ userId?: string | null, track_status: string }} options
 */
function clearHistoryTrackByStatus(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const key = String(options.track_status || '').trim();
  if (key === 'completed') {
    const listStmt = userId
      ? db.prepare(`SELECT * FROM requests WHERE user_id = ? AND status = 'completed'`)
      : db.prepare(`SELECT * FROM requests WHERE status = 'completed'`);
    const rows = userId ? listStmt.all(userId) : listStmt.all();
    const delOne = db.prepare(`DELETE FROM requests WHERE id = ?`);
    let deleted = 0;
    for (const row of rows) {
      if (isPlexPendingCompletedTrackRow(row)) {
        continue;
      }
      delOne.run(row.id);
      deleted += 1;
    }
    return { deleted };
  }
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
 * Delete history rows older than N days (track created_at, follow resolved_at/requested_at).
 * Denied track rows are not removed (scheduled / age retention should keep an audit trail).
 * @param {{ userId?: string | null, older_than_days: number }} options
 */
/**
 * Delete completed track rows older than N days (scheduled retention).
 * @param {{ userId?: string | null, older_than_days: number }} options
 * @returns {{ deletedTracks: number }}
 */
function clearCompletedRequestsOlderThanDays(options = {}) {
  const userId = normalizeUserScope(options.userId);
  const days = Math.min(3650, Math.max(1, Math.floor(Number(options.older_than_days) || 0)));
  const mod = `-${days} days`;
  const listStmt = userId
    ? db.prepare(
        `SELECT * FROM requests WHERE user_id = ? AND status = 'completed' AND datetime(created_at) < datetime('now', ?)`,
      )
    : db.prepare(
        `SELECT * FROM requests WHERE status = 'completed' AND datetime(created_at) < datetime('now', ?)`,
      );
  const rows = userId ? listStmt.all(userId, mod) : listStmt.all(mod);
  const delOne = db.prepare(`DELETE FROM requests WHERE id = ?`);
  let deletedTracks = 0;
  for (const row of rows) {
    if (isPlexPendingCompletedTrackRow(row)) {
      continue;
    }
    delOne.run(row.id);
    deletedTracks += 1;
  }
  return { deletedTracks };
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

  const listOldCompletedStmt = userId
    ? db.prepare(
        `SELECT * FROM requests WHERE user_id = ? AND status = 'completed' AND datetime(created_at) < datetime('now', ?)`,
      )
    : db.prepare(
        `SELECT * FROM requests WHERE status = 'completed' AND datetime(created_at) < datetime('now', ?)`,
      );
  const oldCompleted = userId ? listOldCompletedStmt.all(userId, mod) : listOldCompletedStmt.all(mod);
  const delOne = db.prepare(`DELETE FROM requests WHERE id = ?`);
  let completedDeleted = 0;
  for (const row of oldCompleted) {
    if (isPlexPendingCompletedTrackRow(row)) {
      continue;
    }
    delOne.run(row.id);
    completedDeleted += 1;
  }

  const followResult = deleteFollowHistoryOlderThanDays(days, userId);
  return {
    deletedTracks: (terminalResult.changes || 0) + completedDeleted,
    deletedFollows: followResult.changes || 0,
  };
}

module.exports = {
  approveAllPending,
  cancelAllActive,
  markAllPlexPendingFound,
  markPlexFoundForSingleRequest,
  denyAllPending,
  retryAllFailed,
  clearAllRequests,
  clearAllHistory,
  clearHistoryTrackByStatus,
  clearHistoryFollowByOutcome,
  clearHistoryOlderThanDays,
  clearCompletedRequestsOlderThanDays,
  TRACK_HISTORY_STATUS_FILTERS,
};
