const express = require('express');
const { getDb } = require('../db');
const { requestAllTracksFromPlaylist } = require('../services/playlistRequestAll');
const { sessionUserIdString } = require('../middleware/auth');
const { getAvailabilitySettingsSync } = require('../services/libraryAvailability');
const {
  syncFollowedPlaylistToPlex,
  teardownPlexSyncForFollowedPlaylist,
} = require('../services/plexPlaylistSync');

const router = express.Router();
const db = getDb();

const getFollowSettingsStmt = db.prepare(`
  SELECT follow_playlist_requires_approval
  FROM settings
  WHERE id = 1
`);

const listFollowedSelect = `
  SELECT fp.id, fp.playlist_id, fp.title, fp.picture, fp.user_id, fp.follow_status, fp.last_sync_at, fp.created_at,
         fp.plex_sync_enabled,
         u.username AS owner_username
  FROM followed_playlists fp
  LEFT JOIN users u ON CAST(fp.user_id AS INTEGER) = u.id
`;

const listFollowedActiveStmt = db.prepare(`
  ${listFollowedSelect}
  WHERE fp.user_id = ? AND fp.follow_status = 'active'
  ORDER BY fp.id DESC
`);

const listFollowedAllStmt = db.prepare(`
  ${listFollowedSelect}
  WHERE fp.user_id = ? AND fp.follow_status IN ('active', 'pending')
  ORDER BY fp.id DESC
`);

const listFollowedAllUsersActiveStmt = db.prepare(`
  ${listFollowedSelect}
  WHERE fp.follow_status = 'active'
  ORDER BY fp.user_id ASC, fp.id DESC
`);

const listFollowedAllUsersAllStmt = db.prepare(`
  ${listFollowedSelect}
  WHERE fp.follow_status IN ('active', 'pending')
  ORDER BY fp.user_id ASC, fp.id DESC
`);

const getUserIdExistsStmt = db.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`);

const getFollowedByUserAndPlaylistStmt = db.prepare(`
  SELECT id, playlist_id, title, picture, user_id, follow_status, last_sync_at, created_at, plex_sync_enabled, plex_playlist_rating_key
  FROM followed_playlists
  WHERE user_id = ? AND playlist_id = ?
  LIMIT 1
`);

const insertFollowedStmt = db.prepare(`
  INSERT INTO followed_playlists (playlist_id, title, picture, user_id, follow_status, sync_auto_approve)
  VALUES (@playlist_id, @title, @picture, @user_id, @follow_status, @sync_auto_approve)
`);

const getFollowedByIdStmt = db.prepare(`
  SELECT id, playlist_id, title, picture, user_id, follow_status, last_sync_at, created_at, plex_sync_enabled, plex_playlist_rating_key
  FROM followed_playlists
  WHERE id = ?
  LIMIT 1
`);

const deleteFollowedStmt = db.prepare(`
  DELETE FROM followed_playlists
  WHERE id = ? AND user_id = ?
`);

const deleteFollowedAdminStmt = db.prepare(`DELETE FROM followed_playlists WHERE id = ?`);

const getUserPlexAuthStmt = db.prepare(`
  SELECT auth_provider, plex_user_token FROM users WHERE id = ?
`);

const setPlexSyncEnabledStmt = db.prepare(`
  UPDATE followed_playlists SET plex_sync_enabled = ? WHERE id = ? AND user_id = ?
`);

const clearPlexPlaylistKeyStmt = db.prepare(`
  UPDATE followed_playlists SET plex_playlist_rating_key = NULL WHERE id = ?
`);

function serializeFollowedRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    playlist_id: row.playlist_id,
    title: row.title,
    picture: row.picture,
    user_id: row.user_id,
    follow_status: row.follow_status,
    last_sync_at: row.last_sync_at,
    created_at: row.created_at,
    owner_username: row.owner_username,
    plex_sync_enabled: Boolean(Number(row.plex_sync_enabled)),
  };
}

function parseFollowedListQuery(req) {
  const sessionUid = sessionUserIdString(req);
  const isAdmin = req.session?.role === 'admin';
  const raw = req.query.user;
  const q =
    raw == null || raw === ''
      ? 'self'
      : String(raw).trim().toLowerCase() === 'me'
        ? 'self'
        : String(raw).trim();

  if (!isAdmin) {
    return { mode: 'self', targetUserId: sessionUid };
  }

  if (q === 'self' || q === '') {
    return { mode: 'self', targetUserId: sessionUid };
  }
  if (q === 'all' || q === '*') {
    return { mode: 'all' };
  }
  const n = Number(q);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: 'Invalid user filter' };
  }
  const exists = getUserIdExistsStmt.get(n);
  if (!exists) {
    return { error: 'User not found' };
  }
  return { mode: 'user', targetUserId: String(n) };
}

// GET /api/playlists/followed?include_pending=1&user=self|all|<id>
router.get('/followed', (req, res) => {
  const includePending =
    req.query.include_pending === '1' ||
    req.query.include_pending === 'true' ||
    req.query.include_pending === true;

  const parsed = parseFollowedListQuery(req);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    let results;
    if (parsed.mode === 'all') {
      results = includePending
        ? listFollowedAllUsersAllStmt.all()
        : listFollowedAllUsersActiveStmt.all();
    } else {
      results = includePending
        ? listFollowedAllStmt.all(parsed.targetUserId)
        : listFollowedActiveStmt.all(parsed.targetUserId);
    }
    return res.json({ results: results.map(serializeFollowedRow) });
  } catch (error) {
    console.error('Failed to list followed playlists:', error.message);
    return res.status(500).json({ error: 'Failed to load followed playlists' });
  }
});

// POST /api/playlists/follow
router.post('/follow', (req, res) => {
  const playlistId = req.body?.playlist_id ? String(req.body.playlist_id).trim() : '';
  const title = req.body?.title ? String(req.body.title).trim() : '';
  const picture = req.body?.picture ? String(req.body.picture).trim() : null;
  const userId = sessionUserIdString(req);

  if (!playlistId || !title) {
    return res.status(400).json({ error: 'playlist_id and title are required' });
  }

  try {
    const existing = getFollowedByUserAndPlaylistStmt.get(userId, playlistId);
    if (existing) {
      return res.json(serializeFollowedRow(existing));
    }

    const s = getFollowSettingsStmt.get();
    const needsApproval = Boolean(Number(s?.follow_playlist_requires_approval));
    const follow_status = needsApproval ? 'pending' : 'active';

    const insertResult = insertFollowedStmt.run({
      playlist_id: playlistId,
      title,
      picture,
      user_id: userId,
      follow_status,
      sync_auto_approve: needsApproval ? 0 : 1,
    });

    const created = getFollowedByIdStmt.get(insertResult.lastInsertRowid);
    const statusCode = needsApproval ? 202 : 201;
    return res.status(statusCode).json(serializeFollowedRow(created));
  } catch (error) {
    console.error('Failed to follow playlist:', error.message);
    return res.status(500).json({ error: 'Failed to follow playlist' });
  }
});

// PATCH /api/playlists/follow/:id — plex_sync_enabled (Plex-auth users, active follow only)
router.patch('/follow/:id', async (req, res) => {
  const userId = sessionUserIdString(req);
  const followedId = Number(req.params.id);
  if (!Number.isInteger(followedId) || followedId <= 0) {
    return res.status(400).json({ error: 'Invalid followed playlist id' });
  }

  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'plex_sync_enabled')) {
    return res.status(400).json({ error: 'plex_sync_enabled is required' });
  }
  if (typeof req.body.plex_sync_enabled !== 'boolean') {
    return res.status(400).json({ error: 'plex_sync_enabled must be a boolean' });
  }
  const wantSync = req.body.plex_sync_enabled;

  try {
    const row = getFollowedByIdStmt.get(followedId);
    if (!row || row.user_id !== userId) {
      return res.status(404).json({ error: 'Followed playlist not found' });
    }
    if (row.follow_status !== 'active') {
      return res.status(400).json({ error: 'Playlist follow must be active to sync with Plex' });
    }

    const uidNum = Number(userId);
    const u = Number.isFinite(uidNum) ? getUserPlexAuthStmt.get(uidNum) : null;
    if (!u || String(u.auth_provider || '').toLowerCase() !== 'plex') {
      return res.status(403).json({ error: 'Plex playlist sync is only available for Plex sign-in accounts' });
    }

    const avail = getAvailabilitySettingsSync();
    if (!avail.plex_integration_enabled) {
      return res.status(400).json({ error: 'Plex integration is disabled in Settings' });
    }

    if (!wantSync) {
      await teardownPlexSyncForFollowedPlaylist(row, u.plex_user_token);
      const next = getFollowedByIdStmt.get(followedId);
      return res.json(serializeFollowedRow(next));
    }

    setPlexSyncEnabledStmt.run(1, followedId, userId);
    const withFlag = getFollowedByIdStmt.get(followedId);
    try {
      await syncFollowedPlaylistToPlex(withFlag, u.plex_user_token);
    } catch (e) {
      setPlexSyncEnabledStmt.run(0, followedId, userId);
      clearPlexPlaylistKeyStmt.run(followedId);
      console.error('plex sync enable failed:', e?.message || e);
      return res.status(502).json({ error: e?.message || 'Could not sync playlist to Plex' });
    }
    const next = getFollowedByIdStmt.get(followedId);
    return res.json(serializeFollowedRow(next));
  } catch (error) {
    console.error('PATCH follow plex sync:', error.message);
    return res.status(500).json({ error: 'Failed to update Plex sync' });
  }
});

// POST /api/playlists/follow/:id/plex-sync — manual push (same eligibility as PATCH enable)
router.post('/follow/:id/plex-sync', async (req, res) => {
  const userId = sessionUserIdString(req);
  const followedId = Number(req.params.id);
  if (!Number.isInteger(followedId) || followedId <= 0) {
    return res.status(400).json({ error: 'Invalid followed playlist id' });
  }

  try {
    const row = getFollowedByIdStmt.get(followedId);
    if (!row || row.user_id !== userId) {
      return res.status(404).json({ error: 'Followed playlist not found' });
    }
    if (row.follow_status !== 'active' || !Number(row.plex_sync_enabled)) {
      return res.status(400).json({ error: 'Enable Plex sync for this active follow first' });
    }

    const uidNum = Number(userId);
    const u = Number.isFinite(uidNum) ? getUserPlexAuthStmt.get(uidNum) : null;
    if (!u || String(u.auth_provider || '').toLowerCase() !== 'plex') {
      return res.status(403).json({ error: 'Plex playlist sync is only available for Plex sign-in accounts' });
    }

    const avail = getAvailabilitySettingsSync();
    if (!avail.plex_integration_enabled) {
      return res.status(400).json({ error: 'Plex integration is disabled in Settings' });
    }

    const result = await syncFollowedPlaylistToPlex(row, u.plex_user_token);
    return res.json(result);
  } catch (error) {
    console.error('manual plex playlist sync:', error.message);
    return res.status(502).json({ error: error?.message || 'Plex sync failed' });
  }
});

// DELETE /api/playlists/follow/:id
router.delete('/follow/:id', async (req, res) => {
  const userId = sessionUserIdString(req);
  const isAdmin = req.session?.role === 'admin';
  const followedId = Number(req.params.id);
  if (!Number.isInteger(followedId) || followedId <= 0) {
    return res.status(400).json({ error: 'Invalid followed playlist id' });
  }

  try {
    const existing = getFollowedByIdStmt.get(followedId);
    if (!existing) {
      return res.status(404).json({ error: 'Followed playlist not found' });
    }

    const ownerNum = Number(existing.user_id);
    const ownerAuth = Number.isFinite(ownerNum) ? getUserPlexAuthStmt.get(ownerNum) : null;
    const token = ownerAuth?.plex_user_token || null;

    if (isAdmin) {
      await teardownPlexSyncForFollowedPlaylist(existing, token);
      deleteFollowedAdminStmt.run(followedId);
      return res.status(204).send();
    }

    if (existing.user_id !== userId) {
      return res.status(404).json({ error: 'Followed playlist not found' });
    }

    await teardownPlexSyncForFollowedPlaylist(existing, token);
    deleteFollowedStmt.run(followedId, userId);
    return res.status(204).send();
  } catch (error) {
    console.error('Failed to unfollow playlist:', error.message);
    return res.status(500).json({ error: 'Failed to unfollow playlist' });
  }
});

// POST /api/playlists/:id/request-all — bulk add playlist tracks as requests (by deezer_id)
router.post('/:id/request-all', async (req, res) => {
  const playlistId = req.params.id != null ? String(req.params.id).trim() : '';
  if (!playlistId) {
    return res.status(400).json({ error: 'Invalid playlist id' });
  }

  const userId = sessionUserIdString(req);

  try {
    const summary = await requestAllTracksFromPlaylist(playlistId, { userId });
    return res.json(summary);
  } catch (error) {
    const message = error?.message || 'Failed to request playlist tracks';
    console.error('playlist request-all failed:', message);
    return res.status(502).json({ error: message });
  }
});

module.exports = router;
