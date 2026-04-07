/**
 * Plex.tv OAuth-style PIN flow for user sign-in (same pattern as many Plex third-party apps).
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');

const db = getDb();

const getPlexAuthSettingsStmt = db.prepare(`
  SELECT plex_auth_enabled, plex_oauth_client_id FROM settings WHERE id = 1
`);

const setPlexOAuthClientIdStmt = db.prepare(`
  UPDATE settings SET plex_oauth_client_id = ? WHERE id = 1
`);

const getUserByPlexUuidStmt = db.prepare(`
  SELECT id, username, role, is_system_admin, auth_provider, plex_account_uuid
  FROM users
  WHERE plex_account_uuid = ?
`);

const getUserByUsernameStmt = db.prepare(`
  SELECT id, username, role, is_system_admin, auth_provider, plex_account_uuid, password_hash
  FROM users
  WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
`);

const updatePlexUserTokenStmt = db.prepare(`
  UPDATE users SET plex_user_token = ? WHERE id = ?
`);

const insertPlexUserStmt = db.prepare(`
  INSERT INTO users (username, password_hash, role, is_system_admin, auth_provider, plex_account_uuid, plex_user_token)
  VALUES (@username, @password_hash, 'user', 0, 'plex', @plex_account_uuid, @plex_user_token)
`);

function isPlexAuthEnabled() {
  try {
    const row = getPlexAuthSettingsStmt.get();
    return Boolean(Number(row?.plex_auth_enabled));
  } catch {
    return false;
  }
}

function getOrCreatePlexOAuthClientId() {
  const row = getPlexAuthSettingsStmt.get();
  const existing = typeof row?.plex_oauth_client_id === 'string' ? row.plex_oauth_client_id.trim() : '';
  if (existing) {
    return existing;
  }
  const uuid = crypto.randomUUID();
  setPlexOAuthClientIdStmt.run(uuid);
  return uuid;
}

async function createPlexPin() {
  const clientId = getOrCreatePlexOAuthClientId();
  const res = await fetch('https://plex.tv/api/v2/pins?strong=true', {
    method: 'POST',
    headers: {
      'X-Plex-Client-Identifier': clientId,
      'X-Plex-Product': 'TrackFlow',
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Plex pin create failed (${res.status}): ${text || res.statusText}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Plex pin create returned invalid JSON');
  }
  const pinId = data.id;
  const pinCode = data.code;
  if (pinId == null || pinCode == null) {
    throw new Error('Plex pin response missing id or code');
  }
  const idStr = String(pinId);
  const codeStr = String(pinCode);
  const authUrl = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientId)}&code=${encodeURIComponent(codeStr)}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent('TrackFlow')}`;
  return { pinId: idStr, pinCode: codeStr, authUrl };
}

async function checkPlexPin(pinId, clientId) {
  const res = await fetch(`https://plex.tv/api/v2/pins/${encodeURIComponent(String(pinId))}`, {
    headers: {
      'X-Plex-Client-Identifier': clientId,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    return { done: false, authToken: null };
  }
  const data = await res.json().catch(() => ({}));
  const authToken = data.authToken != null ? String(data.authToken) : null;
  if (!authToken) {
    return { done: false, authToken: null };
  }
  return { done: true, authToken };
}

async function fetchPlexAccount(authToken) {
  const res = await fetch('https://plex.tv/api/v2/user', {
    headers: {
      'X-Plex-Token': authToken,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Plex user request failed (${res.status}): ${t || res.statusText}`);
  }
  return res.json();
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,64}$/;

function baseUsernameFromPlexAccount(account) {
  const raw = String(account?.username || account?.friendlyName || '').trim();
  if (USERNAME_RE.test(raw)) {
    return raw;
  }
  const uuid = String(account?.uuid || '').replace(/-/g, '');
  const hex = uuid.slice(0, 16) || crypto.randomBytes(8).toString('hex');
  return `plex_${hex}`;
}

function dummyPasswordHash() {
  return bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
}

/**
 * Create or return existing TrackFlow user for this Plex account.
 * @param {object} account — Plex /api/v2/user JSON
 * @param {string} [authToken] — Plex user token (stored for playlist sync; never exposed via API)
 * @returns {{ id: number, username: string, role: string, is_system_admin: number }}
 */
function upsertUserFromPlexAccount(account, authToken) {
  const plexUuid = String(account?.uuid || '').trim();
  if (!plexUuid) {
    throw new Error('Plex account did not include a uuid');
  }

  const token =
    authToken != null && String(authToken).trim() ? String(authToken).trim() : null;

  const existing = getUserByPlexUuidStmt.get(plexUuid);
  if (existing) {
    if (token) {
      updatePlexUserTokenStmt.run(token, existing.id);
    }
    return {
      id: existing.id,
      username: existing.username,
      role: existing.role,
      is_system_admin: existing.is_system_admin,
    };
  }

  const base = baseUsernameFromPlexAccount(account);
  let candidate = base;
  for (let i = 0; i < 30; i += 1) {
    const other = getUserByUsernameStmt.get(candidate);
    if (!other) {
      const hash = dummyPasswordHash();
      insertPlexUserStmt.run({
        username: candidate,
        password_hash: hash,
        plex_account_uuid: plexUuid,
        plex_user_token: token,
      });
      const created = getUserByPlexUuidStmt.get(plexUuid);
      if (!created) {
        throw new Error('Failed to create Plex user');
      }
      return {
        id: created.id,
        username: created.username,
        role: created.role,
        is_system_admin: created.is_system_admin,
      };
    }
    if (String(other.plex_account_uuid || '') === plexUuid) {
      if (token) {
        updatePlexUserTokenStmt.run(token, other.id);
      }
      return {
        id: other.id,
        username: other.username,
        role: other.role,
        is_system_admin: other.is_system_admin,
      };
    }
    const suffix = i === 0 ? '_2' : `_${i + 2}`;
    candidate = (base + suffix).slice(0, 64);
    if (!USERNAME_RE.test(candidate)) {
      candidate = `plex_${plexUuid.replace(/-/g, '').slice(0, 20)}_${i + 2}`.slice(0, 64);
    }
  }
  throw new Error('Could not allocate a unique username for this Plex account');
}

module.exports = {
  isPlexAuthEnabled,
  getOrCreatePlexOAuthClientId,
  createPlexPin,
  checkPlexPin,
  fetchPlexAccount,
  upsertUserFromPlexAccount,
};
