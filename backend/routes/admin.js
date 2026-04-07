// Placeholder route for admin.
// Keep this file thin; move the real admin logic into `services/` later.

const express = require('express');
const { getDb } = require('../db');
const { approveRequestById, dropPendingDownloadsForRequestIds } = require('../services/requestApproval');
const { runAutoAcquire } = require('../services/autoAcquire');
const slskd = require('../services/slskd');
const {
  getAvailabilitySettingsSync,
  enrichRequestRowWithLibraryMatch,
} = require('../services/libraryAvailability');
const { findPresentTrackForProbe } = require('../services/tracksDb');
const { enrichRequestRow } = require('../services/requestDisplayStatus');
const { usernamesByIds, usernameForId } = require('../services/userDisplay');
const { recordFollowResolution } = require('../services/followRequestHistory');

const router = express.Router();
const db = getDb();

const getRequestByIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, plex_status, processing_phase, created_at, request_type
  FROM requests
  WHERE id = ?
`);

const setFailedStmt = db.prepare(`
  UPDATE requests
  SET status = 'failed', processing_phase = NULL
  WHERE id = ?
`);

const setCancelledFailedStmt = db.prepare(`
  UPDATE requests
  SET status = 'failed', cancelled = 1, processing_phase = NULL
  WHERE id = ?
`);

const setCompletedPendingPlexStmt = db.prepare(`
  UPDATE requests
  SET status = 'completed', plex_status = 'pending', cancelled = 0, processing_phase = NULL
  WHERE id = ?
`);

const setCompletedPlexFoundStmt = db.prepare(`
  UPDATE requests
  SET status = 'completed', plex_status = 'found', cancelled = 0, processing_phase = NULL
  WHERE id = ?
`);

const setDeniedStmt = db.prepare(`
  UPDATE requests
  SET status = 'denied', processing_phase = NULL
  WHERE id = ?
`);

const deleteRequestStmt = db.prepare(`
  DELETE FROM requests
  WHERE id = ?
`);

// GET /api/admin
router.get('/', async (req, res) => {
  // TODO: add real admin/auth logic
  res.json({
    message: 'Placeholder: GET /api/admin',
  });
});

// POST /api/admin/requests/:id/approve
router.post('/requests/:id/approve', async (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  try {
    const approval = await approveRequestById(requestId);
    if (!approval.ok && approval.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (!approval.ok && approval.code === 'ALREADY_PROCESSED') {
      return res.status(400).json({ error: 'Request already processed' });
    }

    const withLib = await enrichRequestRowWithLibraryMatch(approval.request);
    return res.json(enrichRequestRow(withLib));
  } catch (error) {
    console.error('Failed to approve request:', error.message);
    return res.status(500).json({ error: 'Failed to approve request' });
  }
});

// POST /api/admin/requests/:id/deny — pending/requested → denied; failed (needs attention) → denied
router.post('/requests/:id/deny', (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  try {
    const existing = getRequestByIdStmt.get(requestId);
    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const st = String(existing.status || '');
    const cancelled = Number(existing.cancelled) === 1;
    const canDeny =
      st === 'pending' ||
      st === 'requested' ||
      (st === 'failed' && !cancelled);
    if (!canDeny) {
      return res.status(400).json({ error: 'Request cannot be denied in its current state' });
    }

    setDeniedStmt.run(requestId);
    const updated = getRequestByIdStmt.get(requestId);
    return res.json(enrichRequestRow(updated));
  } catch (error) {
    console.error('Failed to deny request:', error.message);
    return res.status(500).json({ error: 'Failed to deny request' });
  }
});

// POST /api/admin/requests/:id/cancel — mark failed/cancelled; worker lets slskd finish to completed folder, then discards file and clears slskd completed list (no library/Plex)
router.post('/requests/:id/cancel', async (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  try {
    const existing = getRequestByIdStmt.get(requestId);
    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (existing.status !== 'processing') {
      return res.status(400).json({ error: 'Request is not processing' });
    }

    // Download may already be in the library / Plex while status is still "processing".
    try {
      const settings = getAvailabilitySettingsSync();
      const match = findPresentTrackForProbe({
        deezer_id: existing.deezer_id,
        artist: existing.artist,
        title: existing.title,
        duration_seconds: existing.duration_seconds,
      });
      const inPlex = match && Number(match.plex_available) === 1;
      const onDisk = match && Number(match.db_exists) === 1;
      if (settings.plex_integration_enabled && inPlex) {
        setCompletedPlexFoundStmt.run(requestId);
        const updated = getRequestByIdStmt.get(requestId);
        const withLib = await enrichRequestRowWithLibraryMatch(updated);
        console.log(
          'admin cancel: track in Plex (DB) — marked completed + plex found instead of cancel:',
          requestId,
        );
        return res.json({
          ...enrichRequestRow(withLib),
          resolvedAs: 'completed',
          plex_status: 'found',
        });
      }
      if (onDisk) {
        setCompletedPendingPlexStmt.run(requestId);
        const updated = getRequestByIdStmt.get(requestId);
        const withLib = await enrichRequestRowWithLibraryMatch(updated);
        console.log(
          'admin cancel: file on disk (tracks DB) — marked completed + plex pending instead of cancel:',
          requestId,
        );
        return res.json({
          ...enrichRequestRow(withLib),
          resolvedAs: 'completed',
          plex_status: 'pending',
        });
      }
    } catch (plexErr) {
      console.warn('admin cancel: library/Plex DB check failed, proceeding with cancel:', plexErr?.message);
    }

    setCancelledFailedStmt.run(requestId);
    dropPendingDownloadsForRequestIds([requestId]);

    try {
      await slskd.cancelActiveDownloadForRequest(getRequestByIdStmt.get(requestId));
    } catch (slErr) {
      console.error('slskd cancel failed (request marked cancelled):', slErr.message);
    }

    const updated = getRequestByIdStmt.get(requestId);
    return res.json(enrichRequestRow(updated));
  } catch (error) {
    console.error('Failed to cancel request:', error.message);
    return res.status(500).json({ error: 'Failed to cancel request' });
  }
});

// DELETE /api/admin/requests/:id
router.delete('/requests/:id', (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  try {
    const existing = getRequestByIdStmt.get(requestId);
    if (!existing) {
      return res.status(404).json({ error: 'Request not found' });
    }

    deleteRequestStmt.run(requestId);
    return res.status(204).send();
  } catch (error) {
    console.error('Failed to delete request:', error.message);
    return res.status(500).json({ error: 'Failed to delete request' });
  }
});

// POST /api/admin/auto-acquire
router.post('/auto-acquire', async (req, res) => {
  try {
    const result = await runAutoAcquire();
    return res.json(result);
  } catch (error) {
    console.error('Auto-acquire failed:', error.message);
    return res.status(500).json({ error: error.message || 'Auto-acquire failed' });
  }
});

const listPendingPlaylistFollowsStmt = db.prepare(`
  SELECT id, playlist_id, title, picture, user_id, follow_status, sync_auto_approve, created_at
  FROM followed_playlists
  WHERE follow_status = 'pending'
  ORDER BY id ASC
`);

const listPendingArtistFollowsStmt = db.prepare(`
  SELECT id, artist_id, name, picture, user_id, follow_status, sync_auto_approve, created_at
  FROM followed_artists
  WHERE follow_status = 'pending'
  ORDER BY id ASC
`);

const approvePlaylistFollowStmt = db.prepare(`
  UPDATE followed_playlists
  SET follow_status = 'active', sync_auto_approve = 1
  WHERE id = ? AND follow_status = 'pending'
`);

const approveArtistFollowStmt = db.prepare(`
  UPDATE followed_artists
  SET follow_status = 'active', sync_auto_approve = 1
  WHERE id = ? AND follow_status = 'pending'
`);

const deletePlaylistFollowStmt = db.prepare(`DELETE FROM followed_playlists WHERE id = ? AND follow_status = 'pending'`);
const deleteArtistFollowStmt = db.prepare(`DELETE FROM followed_artists WHERE id = ? AND follow_status = 'pending'`);

const getPendingPlaylistFollowByIdStmt = db.prepare(`
  SELECT id, playlist_id, title, picture, user_id, follow_status, sync_auto_approve, created_at
  FROM followed_playlists
  WHERE id = ? AND follow_status = 'pending'
`);

const getPendingArtistFollowByIdStmt = db.prepare(`
  SELECT id, artist_id, name, picture, user_id, follow_status, sync_auto_approve, created_at
  FROM followed_artists
  WHERE id = ? AND follow_status = 'pending'
`);

const approvePlaylistTx = db.transaction((rowId) => {
  const pending = getPendingPlaylistFollowByIdStmt.get(rowId);
  if (!pending) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  recordFollowResolution(pending, 'playlist', 'approved');
  approvePlaylistFollowStmt.run(rowId);
});

const rejectPlaylistTx = db.transaction((rowId) => {
  const pending = getPendingPlaylistFollowByIdStmt.get(rowId);
  if (!pending) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  recordFollowResolution(pending, 'playlist', 'denied');
  deletePlaylistFollowStmt.run(rowId);
});

const approveArtistTx = db.transaction((rowId) => {
  const pending = getPendingArtistFollowByIdStmt.get(rowId);
  if (!pending) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  recordFollowResolution(pending, 'artist', 'approved');
  approveArtistFollowStmt.run(rowId);
});

const rejectArtistTx = db.transaction((rowId) => {
  const pending = getPendingArtistFollowByIdStmt.get(rowId);
  if (!pending) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  recordFollowResolution(pending, 'artist', 'denied');
  deleteArtistFollowStmt.run(rowId);
});

// GET /api/admin/pending-follows
router.get('/pending-follows', (req, res) => {
  try {
    const playlists = listPendingPlaylistFollowsStmt.all();
    const artists = listPendingArtistFollowsStmt.all();
    const nameMap = usernamesByIds([
      ...playlists.map((p) => p.user_id),
      ...artists.map((a) => a.user_id),
    ]);
    return res.json({
      playlists: playlists.map((p) => ({
        ...p,
        requested_by_username: usernameForId(nameMap, p.user_id),
      })),
      artists: artists.map((a) => ({
        ...a,
        requested_by_username: usernameForId(nameMap, a.user_id),
      })),
    });
  } catch (error) {
    console.error('pending-follows:', error.message);
    return res.status(500).json({ error: 'Failed to load pending follows' });
  }
});

// POST /api/admin/follows/:kind/:id/approve — kind = playlist | artist
router.post('/follows/:kind/:id/approve', (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  const rowId = Number(req.params.id);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    if (kind === 'playlist') {
      try {
        approvePlaylistTx(rowId);
      } catch (e) {
        if (e.code === 'NOT_FOUND') {
          return res.status(404).json({ error: 'Pending playlist follow not found' });
        }
        throw e;
      }
      const row = db
        .prepare(
          `SELECT id, playlist_id, title, picture, user_id, follow_status, sync_auto_approve, last_sync_at, created_at FROM followed_playlists WHERE id = ?`,
        )
        .get(rowId);
      return res.json(row);
    }
    if (kind === 'artist') {
      try {
        approveArtistTx(rowId);
      } catch (e) {
        if (e.code === 'NOT_FOUND') {
          return res.status(404).json({ error: 'Pending artist follow not found' });
        }
        throw e;
      }
      const row = db
        .prepare(
          `SELECT id, artist_id, name, picture, user_id, follow_status, sync_auto_approve, last_sync_at, created_at FROM followed_artists WHERE id = ?`,
        )
        .get(rowId);
      return res.json(row);
    }
    return res.status(400).json({ error: 'kind must be playlist or artist' });
  } catch (error) {
    console.error('approve follow:', error.message);
    return res.status(500).json({ error: 'Failed to approve follow' });
  }
});

// POST /api/admin/follows/:kind/:id/reject
router.post('/follows/:kind/:id/reject', (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  const rowId = Number(req.params.id);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    if (kind === 'playlist') {
      try {
        rejectPlaylistTx(rowId);
      } catch (e) {
        if (e.code === 'NOT_FOUND') {
          return res.status(404).json({ error: 'Pending playlist follow not found' });
        }
        throw e;
      }
      return res.status(204).send();
    }
    if (kind === 'artist') {
      try {
        rejectArtistTx(rowId);
      } catch (e) {
        if (e.code === 'NOT_FOUND') {
          return res.status(404).json({ error: 'Pending artist follow not found' });
        }
        throw e;
      }
      return res.status(204).send();
    }
    return res.status(400).json({ error: 'kind must be playlist or artist' });
  } catch (error) {
    console.error('reject follow:', error.message);
    return res.status(500).json({ error: 'Failed to reject follow' });
  }
});

// POST /api/admin/follows/approve-all
router.post('/follows/approve-all', (req, res) => {
  try {
    const playlists = listPendingPlaylistFollowsStmt.all();
    const artists = listPendingArtistFollowsStmt.all();
    const runAll = db.transaction(() => {
      for (const p of playlists) {
        recordFollowResolution(p, 'playlist', 'approved');
        approvePlaylistFollowStmt.run(p.id);
      }
      for (const a of artists) {
        recordFollowResolution(a, 'artist', 'approved');
        approveArtistFollowStmt.run(a.id);
      }
    });
    runAll();
    return res.json({ updated: playlists.length + artists.length });
  } catch (error) {
    console.error('follows approve-all:', error.message);
    return res.status(500).json({ error: 'Failed to approve all follow requests' });
  }
});

// POST /api/admin/follows/reject-all
router.post('/follows/reject-all', (req, res) => {
  try {
    const playlists = listPendingPlaylistFollowsStmt.all();
    const artists = listPendingArtistFollowsStmt.all();
    const runAll = db.transaction(() => {
      for (const p of playlists) {
        recordFollowResolution(p, 'playlist', 'denied');
        deletePlaylistFollowStmt.run(p.id);
      }
      for (const a of artists) {
        recordFollowResolution(a, 'artist', 'denied');
        deleteArtistFollowStmt.run(a.id);
      }
    });
    runAll();
    return res.json({ updated: playlists.length + artists.length });
  } catch (error) {
    console.error('follows reject-all:', error.message);
    return res.status(500).json({ error: 'Failed to reject all follow requests' });
  }
});

module.exports = router;

