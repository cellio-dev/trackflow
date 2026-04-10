const express = require('express');
const { getDb } = require('../db');
const { sessionUserIdString } = require('../middleware/auth');

const router = express.Router();
const db = getDb();

const getFollowSettingsStmt = db.prepare(`
  SELECT follow_artist_requires_approval
  FROM settings
  WHERE id = 1
`);

const listFollowedActiveStmt = db.prepare(`
  SELECT fa.id, fa.artist_id, fa.name, fa.picture, fa.user_id, fa.follow_status, fa.last_sync_at, fa.created_at,
         u.username AS owner_username
  FROM followed_artists fa
  LEFT JOIN users u ON CAST(fa.user_id AS INTEGER) = u.id
  WHERE fa.user_id = ? AND fa.follow_status = 'active'
  ORDER BY fa.id DESC
`);

const listFollowedAllStmt = db.prepare(`
  SELECT fa.id, fa.artist_id, fa.name, fa.picture, fa.user_id, fa.follow_status, fa.last_sync_at, fa.created_at,
         u.username AS owner_username
  FROM followed_artists fa
  LEFT JOIN users u ON CAST(fa.user_id AS INTEGER) = u.id
  WHERE fa.user_id = ? AND fa.follow_status IN ('active', 'pending', 'denied')
  ORDER BY fa.id DESC
`);

const listFollowedAllUsersActiveStmt = db.prepare(`
  SELECT fa.id, fa.artist_id, fa.name, fa.picture, fa.user_id, fa.follow_status, fa.last_sync_at, fa.created_at,
         u.username AS owner_username
  FROM followed_artists fa
  LEFT JOIN users u ON CAST(fa.user_id AS INTEGER) = u.id
  WHERE fa.follow_status = 'active'
  ORDER BY fa.user_id ASC, fa.id DESC
`);

const listFollowedAllUsersAllStmt = db.prepare(`
  SELECT fa.id, fa.artist_id, fa.name, fa.picture, fa.user_id, fa.follow_status, fa.last_sync_at, fa.created_at,
         u.username AS owner_username
  FROM followed_artists fa
  LEFT JOIN users u ON CAST(fa.user_id AS INTEGER) = u.id
  WHERE fa.follow_status IN ('active', 'pending', 'denied')
  ORDER BY fa.user_id ASC, fa.id DESC
`);

const getUserIdExistsStmt = db.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`);

const getFollowedByUserAndArtistStmt = db.prepare(`
  SELECT id, artist_id, name, picture, user_id, follow_status, last_sync_at, created_at
  FROM followed_artists
  WHERE user_id = ? AND artist_id = ?
  LIMIT 1
`);

const insertFollowedStmt = db.prepare(`
  INSERT INTO followed_artists (artist_id, name, picture, user_id, follow_status, sync_auto_approve)
  VALUES (@artist_id, @name, @picture, @user_id, @follow_status, @sync_auto_approve)
`);

const getFollowedByIdStmt = db.prepare(`
  SELECT id, artist_id, name, picture, user_id, follow_status, last_sync_at, created_at
  FROM followed_artists
  WHERE id = ?
  LIMIT 1
`);

const deleteFollowedStmt = db.prepare(`
  DELETE FROM followed_artists
  WHERE id = ? AND user_id = ?
`);

const deleteFollowedAdminStmt = db.prepare(`DELETE FROM followed_artists WHERE id = ?`);

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

// GET /api/artists/followed?include_pending=1&user=self|all|<id>
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
    return res.json({ results });
  } catch (error) {
    console.error('Failed to list followed artists:', error.message);
    return res.status(500).json({ error: 'Failed to load followed artists' });
  }
});

// POST /api/artists/follow
router.post('/follow', (req, res) => {
  const artistId = req.body?.artist_id ? String(req.body.artist_id).trim() : '';
  const name = req.body?.name ? String(req.body.name).trim() : '';
  const picture = req.body?.picture ? String(req.body.picture).trim() : null;
  const userId = sessionUserIdString(req);

  if (!artistId || !name) {
    return res.status(400).json({ error: 'artist_id and name are required' });
  }

  try {
    const existing = getFollowedByUserAndArtistStmt.get(userId, artistId);
    if (existing) {
      if (String(existing.follow_status || '') === 'denied') {
        return res.status(403).json({ error: 'Follow request was denied for this artist' });
      }
      return res.json(existing);
    }

    const s = getFollowSettingsStmt.get();
    const needsApproval = Boolean(Number(s?.follow_artist_requires_approval));
    const follow_status = needsApproval ? 'pending' : 'active';

    const insertResult = insertFollowedStmt.run({
      artist_id: artistId,
      name,
      picture,
      user_id: userId,
      follow_status,
      sync_auto_approve: needsApproval ? 0 : 1,
    });

    const created = getFollowedByIdStmt.get(insertResult.lastInsertRowid);
    const statusCode = needsApproval ? 202 : 201;
    return res.status(statusCode).json(created);
  } catch (error) {
    console.error('Failed to follow artist:', error.message);
    return res.status(500).json({ error: 'Failed to follow artist' });
  }
});

// DELETE /api/artists/follow/:id
router.delete('/follow/:id', (req, res) => {
  const userId = sessionUserIdString(req);
  const isAdmin = req.session?.role === 'admin';
  const followedId = Number(req.params.id);
  if (!Number.isInteger(followedId) || followedId <= 0) {
    return res.status(400).json({ error: 'Invalid followed artist id' });
  }

  try {
    const existing = getFollowedByIdStmt.get(followedId);
    if (!existing) {
      return res.status(404).json({ error: 'Followed artist not found' });
    }

    if (isAdmin) {
      deleteFollowedAdminStmt.run(followedId);
      return res.status(204).send();
    }

    if (existing.user_id !== userId) {
      return res.status(404).json({ error: 'Followed artist not found' });
    }

    if (String(existing.follow_status || '') === 'denied') {
      return res.status(403).json({ error: 'Denied follow requests cannot be removed; contact an admin if needed' });
    }

    deleteFollowedStmt.run(followedId, userId);
    return res.status(204).send();
  } catch (error) {
    console.error('Failed to unfollow artist:', error.message);
    return res.status(500).json({ error: 'Failed to unfollow artist' });
  }
});

module.exports = router;
