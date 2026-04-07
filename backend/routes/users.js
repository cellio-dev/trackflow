const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { cancelAllActive } = require('../services/requestBulkActions');
const { teardownPlexSyncForFollowedPlaylist } = require('../services/plexPlaylistSync');

const router = express.Router();
router.use(requireAdmin);

const db = getDb();

const listUsersStmt = db.prepare(`
  SELECT id, username, role, is_system_admin, created_at, auth_provider, jukebox_enabled
  FROM users
  ORDER BY id ASC
`);

const getUserByIdStmt = db.prepare(`
  SELECT id, username, role, is_system_admin, auth_provider, jukebox_enabled
  FROM users
  WHERE id = ?
`);

const insertUserStmt = db.prepare(`
  INSERT INTO users (username, password_hash, role, is_system_admin, jukebox_enabled)
  VALUES (@username, @password_hash, @role, 0, 0)
`);

const deleteUserStmt = db.prepare(`DELETE FROM users WHERE id = ? AND is_system_admin = 0`);

/** Pending / queued track requests, plus cancelled failures (e.g. former `processing` after cancelAllActive). */
const deletePendingPipelineRequestsForUserStmt = db.prepare(`
  DELETE FROM requests
  WHERE user_id = ?
    AND (
      status IN ('pending', 'requested')
      OR (status = 'failed' AND IFNULL(cancelled, 0) = 1)
    )
`);

const deleteFollowedArtistsForUserStmt = db.prepare(`DELETE FROM followed_artists WHERE user_id = ?`);

const deleteFollowedPlaylistsForUserStmt = db.prepare(`DELETE FROM followed_playlists WHERE user_id = ?`);

const listFollowedPlaylistsForUserStmt = db.prepare(`
  SELECT id, playlist_id, title, picture, user_id, follow_status, last_sync_at, created_at, plex_sync_enabled, plex_playlist_rating_key
  FROM followed_playlists
  WHERE user_id = ?
`);

const getUserPlexTokenStmt = db.prepare(`SELECT plex_user_token FROM users WHERE id = ?`);

const updateUserRoleStmt = db.prepare(`
  UPDATE users
  SET role = ?
  WHERE id = ? AND is_system_admin = 0
`);

const updateUserPasswordStmt = db.prepare(`
  UPDATE users
  SET password_hash = ?
  WHERE id = ?
`);

const updateUserUsernameStmt = db.prepare(`
  UPDATE users
  SET username = ?
  WHERE id = ? AND is_system_admin = 0
`);

const updateUserJukeboxEnabledStmt = db.prepare(`
  UPDATE users
  SET jukebox_enabled = ?
  WHERE id = ?
`);

function normalizeUsername(value) {
  return String(value || '').trim();
}

const ALLOWED_ROLES = new Set(['admin', 'user']);

// GET /api/users
router.get('/', (req, res) => {
  try {
    const rows = listUsersStmt.all();
    return res.json({
      results: rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: r.role,
        is_system_admin: Boolean(Number(r.is_system_admin)),
        created_at: r.created_at,
        auth_provider:
          typeof r.auth_provider === 'string' && r.auth_provider.trim()
            ? r.auth_provider.trim().toLowerCase()
            : 'local',
        jukebox_enabled: Number(r.jukebox_enabled) === 1,
      })),
    });
  } catch (e) {
    console.error('list users:', e.message);
    return res.status(500).json({ error: 'Failed to list users' });
  }
});

// POST /api/users
router.post('/', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password != null ? String(req.body.password) : '';
  let role = 'user';
  if (req.body?.role != null && req.body.role !== '') {
    const r = String(req.body.role).toLowerCase();
    if (!ALLOWED_ROLES.has(r)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    role = r;
  }

  if (username.length < 2 || username.length > 64) {
    return res.status(400).json({ error: 'Username must be 2–64 characters' });
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return res.status(400).json({
      error: 'Username may only contain letters, numbers, dots, underscores, and hyphens',
    });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = insertUserStmt.run({ username, password_hash: hash, role });
    const created = getUserByIdStmt.get(result.lastInsertRowid);
    return res.status(201).json({
      id: created.id,
      username: created.username,
      role: created.role,
      is_system_admin: Boolean(Number(created.is_system_admin)),
      jukebox_enabled: Number(created.jukebox_enabled) === 1,
    });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('create user:', e.message);
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

// PATCH /api/users/:id
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const existing = getUserByIdStmt.get(id);
  if (!existing) {
    return res.status(404).json({ error: 'User not found' });
  }

  const isSystem = Boolean(Number(existing.is_system_admin));
  const hasRole = Object.prototype.hasOwnProperty.call(req.body, 'role');
  const hasPassword = Object.prototype.hasOwnProperty.call(req.body, 'password');
  const hasUsername = Object.prototype.hasOwnProperty.call(req.body, 'username');
  const hasJukeboxEnabled = Object.prototype.hasOwnProperty.call(req.body, 'jukebox_enabled');

  if (hasRole && isSystem) {
    return res.status(400).json({ error: 'The built-in admin account role cannot be changed' });
  }

  if (hasPassword && String(existing.auth_provider || 'local').toLowerCase() === 'plex') {
    return res.status(400).json({ error: 'Plex users sign in with Plex; password cannot be set here.' });
  }

  if (hasUsername && String(existing.auth_provider || 'local').toLowerCase() === 'plex') {
    return res.status(400).json({ error: 'Plex usernames come from Plex sign-in and cannot be changed here.' });
  }

  if (hasUsername && isSystem) {
    return res.status(400).json({ error: 'The built-in admin username cannot be changed here' });
  }

  if (!hasRole && !hasPassword && !hasUsername && !hasJukeboxEnabled) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  try {
    if (hasUsername) {
      const un = normalizeUsername(req.body.username);
      if (un.length < 2 || un.length > 64) {
        return res.status(400).json({ error: 'Username must be 2–64 characters' });
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(un)) {
        return res.status(400).json({
          error: 'Username may only contain letters, numbers, dots, underscores, and hyphens',
        });
      }
      const updatedName = updateUserUsernameStmt.run(un, id);
      if (!updatedName.changes) {
        return res.status(400).json({ error: 'Could not update username' });
      }
    }

    if (hasRole) {
      const r = String(req.body.role || '').toLowerCase();
      if (!ALLOWED_ROLES.has(r)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      const updated = updateUserRoleStmt.run(r, id);
      if (!updated.changes) {
        return res.status(400).json({ error: 'Could not update role' });
      }
    }

    if (hasPassword) {
      const pw = String(req.body.password);
      if (pw.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      const hash = bcrypt.hashSync(pw, 10);
      updateUserPasswordStmt.run(hash, id);
    }

    if (hasJukeboxEnabled) {
      const raw = req.body.jukebox_enabled;
      const on = raw === true || raw === 1 || raw === '1';
      updateUserJukeboxEnabledStmt.run(on ? 1 : 0, id);
    }

    const fresh = getUserByIdStmt.get(id);
    return res.json({
      id: fresh.id,
      username: fresh.username,
      role: fresh.role,
      is_system_admin: Boolean(Number(fresh.is_system_admin)),
      auth_provider:
        typeof fresh.auth_provider === 'string' && fresh.auth_provider.trim()
          ? fresh.auth_provider.trim().toLowerCase()
          : 'local',
      jukebox_enabled: Number(fresh.jukebox_enabled) === 1,
    });
  } catch (e) {
    console.error('patch user:', e.message);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const existing = getUserByIdStmt.get(id);
  if (!existing) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (Boolean(Number(existing.is_system_admin))) {
    return res.status(400).json({ error: 'The built-in admin account cannot be deleted' });
  }
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'You cannot delete your own account while logged in' });
  }

  const uid = String(id);
  try {
    await cancelAllActive({ userId: uid });
    const plRows = listFollowedPlaylistsForUserStmt.all(uid);
    for (const pl of plRows) {
      const ownerNum = Number(pl.user_id);
      const tokRow = Number.isFinite(ownerNum) ? getUserPlexTokenStmt.get(ownerNum) : null;
      await teardownPlexSyncForFollowedPlaylist(pl, tokRow?.plex_user_token || null);
    }
    const runDelete = db.transaction(() => {
      deletePendingPipelineRequestsForUserStmt.run(uid);
      deleteFollowedArtistsForUserStmt.run(uid);
      deleteFollowedPlaylistsForUserStmt.run(uid);
      const result = deleteUserStmt.run(id);
      if (!result.changes) {
        throw new Error('USER_DELETE_NO_CHANGES');
      }
    });
    runDelete();
    return res.status(204).send();
  } catch (e) {
    if (e && e.message === 'USER_DELETE_NO_CHANGES') {
      return res.status(400).json({ error: 'User could not be deleted' });
    }
    console.error('delete user:', e.message);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
