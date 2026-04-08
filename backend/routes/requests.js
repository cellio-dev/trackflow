// Placeholder route for requests.
// Keep this file thin; move the real request logic into `services/` later.

const express = require('express');
const { getDb } = require('../db');
const { approveRequestById } = require('../services/requestApproval');
const {
  approveAllPending,
  cancelAllActive,
  denyAllPending,
  retryAllFailed,
  clearAllRequests,
  clearAllHistory,
  clearHistoryOlderThanDays,
  clearHistoryTrackByStatus,
  clearHistoryFollowByOutcome,
} = require('../services/requestBulkActions');
const { listAllFollowHistory, getFollowHistoryById, deleteFollowHistoryById } = require('../services/followRequestHistory');
const { usernamesByIds, usernameForId } = require('../services/userDisplay');
const { enrichRequestRow } = require('../services/requestDisplayStatus');
const {
  enrichRequestRowsForApi,
  enrichRequestRowWithLibraryMatch,
  isTrackAlreadyInLibraryOrPlex,
} = require('../services/libraryAvailability');
const { requireAdmin, sessionUserIdString } = require('../middleware/auth');

const router = express.Router();
const db = getDb();

const insertRequestStmt = db.prepare(`
  INSERT INTO requests (deezer_id, title, artist, album, user_id, status, duration_seconds, request_type)
  VALUES (@deezer_id, @title, @artist, @album, @user_id, @status, @duration_seconds, @request_type)
`);

const getRequestByIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests
  WHERE id = ?
`);

const getRequestByDeezerIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests
  WHERE deezer_id = ?
`);

const deleteRequestByIdStmt = db.prepare(`DELETE FROM requests WHERE id = ?`);

function userMayDeleteRequestViaUserApi(row) {
  if (!row) {
    return false;
  }
  const st = String(row.status || '');
  const cancelled = Number(row.cancelled) === 1;
  if (st === 'pending' || st === 'requested') {
    return true;
  }
  if (st === 'completed' || st === 'denied' || st === 'available') {
    return true;
  }
  if (st === 'failed' && cancelled) {
    return true;
  }
  if (st === 'processing' && cancelled) {
    return true;
  }
  return false;
}

const listRequestsStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests
  ORDER BY id DESC
`);

const listRequestsByStatusStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests
  WHERE status = ?
  ORDER BY id DESC
`);

const listRequestsByUserIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests
  WHERE user_id = ?
  ORDER BY id DESC
`);

const listRequestsByStatusAndUserIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests
  WHERE status = ? AND user_id = ?
  ORDER BY id DESC
`);

const getAutoApproveSettingStmt = db.prepare(`
  SELECT auto_approve
  FROM settings
  WHERE id = 1
`);

const getDisplayTimezoneStmt = db.prepare(`
  SELECT display_timezone
  FROM settings
  WHERE id = 1
`);

// GET /api/requests/display-config — timezone for request timestamps (all logged-in users)
router.get('/display-config', (req, res) => {
  try {
    const row = getDisplayTimezoneStmt.get();
    let tz = typeof row?.display_timezone === 'string' ? row.display_timezone.trim() : '';
    if (!tz) {
      tz = 'UTC';
    }
    return res.json({ display_timezone: tz });
  } catch {
    return res.json({ display_timezone: 'UTC' });
  }
});

function resolveBulkUserId(req) {
  const fromBody =
    typeof req.body?.user_id === 'string' && req.body.user_id.trim()
      ? req.body.user_id.trim()
      : null;
  const fromQuery =
    typeof req.query?.user_id === 'string' && req.query.user_id.trim()
      ? req.query.user_id.trim()
      : null;
  return fromBody || fromQuery || null;
}

// POST /api/requests/approve-all — approve every pending/requested (same as per-row admin approve)
router.post('/approve-all', requireAdmin, async (req, res) => {
  try {
    const userId = resolveBulkUserId(req);
    const summary = await approveAllPending({ userId });
    return res.json(summary);
  } catch (error) {
    console.error('approve-all failed:', error.message);
    return res.status(500).json({ error: 'approve-all failed' });
  }
});

// POST /api/requests/cancel-all — cancel every processing request
router.post('/cancel-all', requireAdmin, async (req, res) => {
  try {
    const userId = resolveBulkUserId(req);
    const summary = await cancelAllActive({ userId });
    return res.json(summary);
  } catch (error) {
    console.error('cancel-all failed:', error.message);
    return res.status(500).json({ error: 'cancel-all failed' });
  }
});

// POST /api/requests/deny-all — deny every pending/requested
router.post('/deny-all', requireAdmin, async (req, res) => {
  try {
    const userId = resolveBulkUserId(req);
    const summary = denyAllPending({ userId });
    return res.json(summary);
  } catch (error) {
    console.error('deny-all failed:', error.message);
    return res.status(500).json({ error: 'deny-all failed' });
  }
});

// POST /api/requests/retry-failed — retry failed that were not canceled (same as per-row Retry)
router.post('/retry-failed', requireAdmin, async (req, res) => {
  try {
    const userId = resolveBulkUserId(req);
    const summary = await retryAllFailed({ userId });
    return res.json(summary);
  } catch (error) {
    console.error('retry-failed failed:', error.message);
    return res.status(500).json({ error: 'retry-failed failed' });
  }
});

// POST /api/requests/clear-all — delete completed, failed, denied (and legacy available) only; optional user_id scope
router.post('/clear-all', requireAdmin, async (req, res) => {
  try {
    const userId = resolveBulkUserId(req);
    const summary = clearAllRequests({ userId });
    return res.json(summary);
  } catch (error) {
    console.error('clear-all failed:', error.message);
    return res.status(500).json({ error: 'clear-all failed' });
  }
});

// POST /api/requests/clear-history — finished track rows + follow history log (admin only; optional user_id scope)
// Body (optional): { older_than_days: number } — only delete entries older than N days
router.post('/clear-history', requireAdmin, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const olderRaw = body.older_than_days;
    if (olderRaw != null && olderRaw !== '') {
      const days = Math.floor(Number(olderRaw));
      if (!Number.isFinite(days) || days < 1) {
        return res.status(400).json({ error: 'older_than_days must be a positive integer' });
      }
      const scopedUser = resolveBulkUserId(req);
      const summary = clearHistoryOlderThanDays({
        userId: scopedUser,
        older_than_days: days,
      });
      return res.json(summary);
    }
    const scoped = resolveBulkUserId(req);
    const summary = clearAllHistory({ userId: scoped });
    return res.json(summary);
  } catch (error) {
    console.error('clear-history failed:', error.message);
    return res.status(500).json({ error: 'clear-history failed' });
  }
});

// POST /api/requests/clear-history-status — exactly one of track_status | follow_outcome (admin only)
router.post('/clear-history-status', requireAdmin, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const trackStatus = typeof body.track_status === 'string' ? body.track_status.trim() : '';
    const followOutcome =
      typeof body.follow_outcome === 'string' ? body.follow_outcome.trim().toLowerCase() : '';
    const hasTrack = Boolean(trackStatus);
    const hasFollow = Boolean(followOutcome);
    if (hasTrack === hasFollow) {
      return res.status(400).json({ error: 'Provide exactly one of track_status or follow_outcome' });
    }
    const scopedUser = resolveBulkUserId(req);
    if (hasTrack) {
      const summary = clearHistoryTrackByStatus({
        userId: scopedUser,
        track_status: trackStatus,
      });
      return res.json({ deletedTracks: summary.deleted, deletedFollows: 0 });
    }
    if (followOutcome !== 'approved' && followOutcome !== 'denied') {
      return res.status(400).json({ error: 'follow_outcome must be approved or denied' });
    }
    const summary = clearHistoryFollowByOutcome({
      userId: scopedUser,
      follow_outcome: followOutcome,
    });
    return res.json({ deletedTracks: 0, deletedFollows: summary.changes || 0 });
  } catch (error) {
    console.error('clear-history-status failed:', error.message);
    return res.status(500).json({ error: 'clear-history-status failed' });
  }
});

// GET /api/requests/follow-history
router.get('/follow-history', requireAdmin, async (req, res) => {
  try {
    const rows = listAllFollowHistory();
    const nameMap = usernamesByIds(rows.map((r) => r.user_id));
    const results = rows.map((r) => ({
      ...r,
      requested_by_username: usernameForId(nameMap, r.user_id),
    }));
    return res.json({ results });
  } catch (error) {
    console.error('follow-history failed:', error.message);
    return res.status(500).json({ error: 'Failed to load follow history' });
  }
});

// DELETE /api/requests/follow-history/:id
router.delete('/follow-history/:id', requireAdmin, async (req, res) => {
  const hid = Number(req.params.id);
  if (!Number.isInteger(hid) || hid <= 0) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const existing = getFollowHistoryById(hid);
    if (!existing) {
      return res.status(404).json({ error: 'Not found' });
    }
    const result = deleteFollowHistoryById(hid);
    if (!result.changes) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.status(204).send();
  } catch (error) {
    console.error('delete follow-history failed:', error.message);
    return res.status(500).json({ error: 'Failed to delete follow history row' });
  }
});

// DELETE /api/requests/:id — withdraw pending/requested (owner or admin), or remove finished history row from log
router.delete('/:id', (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Invalid request id' });
  }
  const isAdmin = req.session.role === 'admin';
  const sessionUid = sessionUserIdString(req);
  try {
    const existing = getRequestByIdStmt.get(requestId);
    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (!isAdmin && String(existing.user_id) !== String(sessionUid)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!isAdmin) {
      const st = String(existing.status || '');
      if (st !== 'pending' && st !== 'requested') {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (!userMayDeleteRequestViaUserApi(existing)) {
      return res.status(400).json({ error: 'This request cannot be removed here' });
    }
    deleteRequestByIdStmt.run(requestId);
    return res.status(204).send();
  } catch (error) {
    console.error('delete request failed:', error.message);
    return res.status(500).json({ error: 'Failed to delete request' });
  }
});

// GET /api/requests
router.get('/', async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const queryUserId = typeof req.query.user_id === 'string' ? req.query.user_id.trim() : '';
    const sessionUid = sessionUserIdString(req);
    const isAdmin = req.session.role === 'admin';

    let requests;
    if (!isAdmin) {
      if (status) {
        requests = listRequestsByStatusAndUserIdStmt.all(status, sessionUid);
      } else {
        requests = listRequestsByUserIdStmt.all(sessionUid);
      }
    } else if (status && queryUserId) {
      requests = listRequestsByStatusAndUserIdStmt.all(status, queryUserId);
    } else if (status) {
      requests = listRequestsByStatusStmt.all(status);
    } else if (queryUserId) {
      requests = listRequestsByUserIdStmt.all(queryUserId);
    } else {
      requests = listRequestsStmt.all();
    }

    const enriched = await enrichRequestRowsForApi(requests);
    return res.json({ results: enriched });
  } catch (error) {
    console.error('Failed to list requests:', error.message);
    return res.status(500).json({ error: 'Failed to load requests' });
  }
});

const ALLOWED_REQUEST_TYPES = new Set(['Track', 'Artist', 'Playlist']);

// POST /api/requests
router.post('/', async (req, res) => {
  const deezer_id = req.body?.deezer_id ?? null;
  const title = req.body?.title ?? null;
  const artist = req.body?.artist ?? null;
  const album = req.body?.album ?? null;
  const durationRaw = req.body?.duration ?? req.body?.duration_seconds;
  const duration_seconds =
    durationRaw != null && Number.isFinite(Number(durationRaw))
      ? Math.round(Number(durationRaw))
      : null;
  let request_type = 'Track';
  if (req.body?.request_type != null && req.body.request_type !== '') {
    const rt = String(req.body.request_type).trim();
    if (!ALLOWED_REQUEST_TYPES.has(rt)) {
      return res.status(400).json({ error: 'Invalid request_type' });
    }
    request_type = rt;
  }

  if (!deezer_id || !title || !artist) {
    return res.status(400).json({
      error: 'deezer_id, title, and artist are required',
    });
  }

  try {
    const rowProbe = {
      deezer_id: String(deezer_id),
      title: String(title),
      artist: String(artist),
      album: album == null ? null : String(album),
      duration_seconds,
    };
    if (isTrackAlreadyInLibraryOrPlex(rowProbe)) {
      return res.status(400).json({ error: 'Track already exists in your music library or Plex' });
    }

    const normalizedDeezerId = String(deezer_id);
    const existingRequest = getRequestByDeezerIdStmt.get(normalizedDeezerId);
    if (existingRequest) {
      const st = String(existingRequest.status || '');
      const cancelled = Number(existingRequest.cancelled) === 1;
      if (st === 'denied') {
        return res.status(400).json({
          error: 'This track was denied and cannot be requested again',
        });
      }
      if (st === 'failed' && !cancelled) {
        return res.status(400).json({
          error: 'This request needs attention; resolve or clear it before requesting again',
        });
      }
      const withLib = await enrichRequestRowWithLibraryMatch(existingRequest);
      return res.json(enrichRequestRow(withLib));
    }

    const insertResult = insertRequestStmt.run({
      deezer_id: normalizedDeezerId,
      title: String(title),
      artist: String(artist),
      album: album == null ? null : String(album),
      user_id: sessionUserIdString(req),
      status: 'pending',
      duration_seconds,
      request_type,
    });

    const createdRequest = getRequestByIdStmt.get(insertResult.lastInsertRowid);
    const autoApproveSetting = getAutoApproveSettingStmt.get();
    const autoApproveEnabled = Boolean(autoApproveSetting?.auto_approve);

    if (autoApproveEnabled) {
      await approveRequestById(createdRequest.id);
      const updatedRequest = getRequestByIdStmt.get(createdRequest.id);
      const withLib = await enrichRequestRowWithLibraryMatch(updatedRequest);
      return res.status(201).json(enrichRequestRow(withLib));
    }

    const withLibNew = await enrichRequestRowWithLibraryMatch(createdRequest);
    return res.status(201).json(enrichRequestRow(withLibNew));
  } catch (error) {
    console.error('Failed to create request:', error.message);
    return res.status(500).json({ error: 'Failed to create request' });
  }
});

module.exports = router;

