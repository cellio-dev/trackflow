const { getDb } = require('../db');
const jukeboxEnabledStmt = getDb().prepare(`SELECT jukebox_enabled FROM users WHERE id = ?`);

function requireAuth(req, res, next) {
  if (req.session && req.session.userId != null) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

/** Logged-in user must have jukebox_enabled in the database (Settings → Users). */
function requireJukeboxEnabled(req, res, next) {
  if (!req.session || req.session.userId == null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const row = jukeboxEnabledStmt.get(req.session.userId);
  if (!row || Number(row.jukebox_enabled) !== 1) {
    return res.status(403).json({ error: 'Jukebox is not enabled for this account' });
  }
  return next();
}

function sessionUserHasJukeboxEnabled(req) {
  if (!req.session || req.session.userId == null) {
    return false;
  }
  const row = jukeboxEnabledStmt.get(req.session.userId);
  return Boolean(row && Number(row.jukebox_enabled) === 1);
}

function requireAdmin(req, res, next) {
  if (!req.session || req.session.userId == null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
}

function sessionUserIdString(req) {
  return String(req.session.userId);
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireJukeboxEnabled,
  sessionUserHasJukeboxEnabled,
  sessionUserIdString,
};
