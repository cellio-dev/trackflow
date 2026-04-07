/**
 * Ensures process.env.SESSION_SECRET is set after dotenv loads.
 * If missing, generates 32 random bytes (base64), appends to backend/.env, and assigns env.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

function ensureSessionSecret() {
  const existing = process.env.SESSION_SECRET;
  if (typeof existing === 'string' && existing.trim() !== '') {
    return;
  }

  const generated = crypto.randomBytes(32).toString('base64');

  let prefix = '';
  try {
    if (fs.existsSync(ENV_FILE)) {
      const cur = fs.readFileSync(ENV_FILE, 'utf8');
      if (cur.length > 0 && !cur.endsWith('\n')) {
        prefix = '\n';
      }
    }
  } catch {
    // if read fails, still try append
  }

  try {
    fs.appendFileSync(ENV_FILE, `${prefix}SESSION_SECRET=${generated}\n`, 'utf8');
  } catch (err) {
    console.error('[TrackFlow] Failed to write SESSION_SECRET to .env:', err?.message || err);
    process.exit(1);
  }

  process.env.SESSION_SECRET = generated;
  console.log('[TrackFlow] SESSION_SECRET generated and saved to .env');
}

module.exports = { ensureSessionSecret, ENV_FILE };
