const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const {
  isPlexAuthEnabled,
  createPlexPin,
  checkPlexPin,
  getOrCreatePlexOAuthClientId,
  fetchPlexAccount,
  upsertUserFromPlexAccount,
} = require('../services/plexAuth');

const router = express.Router();
const db = getDb();

const getUserByIdStmt = db.prepare(`
  SELECT id, username, role, is_system_admin, password_hash, auth_provider, jukebox_enabled
  FROM users
  WHERE id = ?
`);

const getUserByUsernameStmt = db.prepare(`
  SELECT id, username, role, is_system_admin, password_hash, auth_provider, jukebox_enabled
  FROM users
  WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
`);

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/** Public: login UI and Plex PIN flow. */
router.get('/config', (req, res) => {
  try {
    const row = db.prepare(`SELECT plex_auth_enabled FROM settings WHERE id = 1`).get();
    return res.json({
      plex_auth_enabled: Boolean(Number(row?.plex_auth_enabled)),
    });
  } catch (e) {
    console.error('auth config:', e.message);
    return res.json({ plex_auth_enabled: false });
  }
});

router.post('/plex/pin', async (req, res) => {
  if (!isPlexAuthEnabled()) {
    return res.status(403).json({ error: 'Plex authentication is not enabled' });
  }
  try {
    const { pinId, authUrl } = await createPlexPin();
    return res.json({ pinId, authUrl });
  } catch (e) {
    console.error('plex pin:', e.message);
    return res.status(500).json({ error: e.message || 'Could not start Plex sign-in' });
  }
});

router.get('/plex/pin/:pinId/status', async (req, res) => {
  if (!isPlexAuthEnabled()) {
    return res.status(403).json({ done: false, error: 'Plex authentication is not enabled' });
  }
  const pinId = req.params.pinId;
  if (!pinId || !/^\d{1,24}$/.test(String(pinId))) {
    return res.status(400).json({ done: false, error: 'Invalid pin' });
  }
  try {
    const clientId = getOrCreatePlexOAuthClientId();
    const { done, authToken } = await checkPlexPin(pinId, clientId);
    if (!done || !authToken) {
      return res.json({ done: false });
    }
    const account = await fetchPlexAccount(authToken);
    const user = upsertUserFromPlexAccount(account, authToken);
    const full = getUserByIdStmt.get(user.id);
    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;
    return res.json({
      done: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        is_system_admin: Boolean(Number(user.is_system_admin)),
        auth_provider: 'plex',
        jukebox_enabled: Number(full?.jukebox_enabled) === 1,
      },
    });
  } catch (e) {
    console.error('plex pin status:', e.message);
    return res.status(500).json({ done: false, error: e.message || 'Plex sign-in failed' });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const username = req.body?.username != null ? String(req.body.username) : '';
  const password = req.body?.password != null ? String(req.body.password) : '';

  if (!username.trim() || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = getUserByUsernameStmt.get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const provider = String(user.auth_provider || 'local').toLowerCase();
  if (provider === 'plex') {
    return res.status(400).json({
      error: 'This account signs in with Plex. Use “Sign in with Plex” on the login page.',
    });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.regenerate((regenErr) => {
    if (regenErr) {
      console.error('session regenerate:', regenErr.message);
      return res.status(500).json({ error: 'Login failed' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;

    return res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        is_system_admin: Boolean(Number(user.is_system_admin)),
        auth_provider: String(user.auth_provider || 'local').toLowerCase(),
        jukebox_enabled: Number(user.jukebox_enabled) === 1,
      },
    });
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('session destroy:', err.message);
      return res.status(500).json({ error: 'Logout failed' });
    }
    return res.status(204).send();
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (req.session?.userId == null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = getUserByIdStmt.get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {
      res.status(401).json({ error: 'Unauthorized' });
    });
    return;
  }

  return res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    is_system_admin: Boolean(Number(user.is_system_admin)),
    auth_provider: String(user.auth_provider || 'local').toLowerCase(),
    jukebox_enabled: Number(user.jukebox_enabled) === 1,
  });
});

module.exports = router;
