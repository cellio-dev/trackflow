const { getDb } = require('../db');
const {
  buildAndStoreGlobalHomeCache,
  rebuildUserDiscoverCacheRow,
} = require('../services/discoverCacheService');

const db = getDb();

let jobRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Space per-user recommendation rebuilds so Deezer quota is not stacked back-to-back. */
const USER_STAGGER_MS = 8000;

/**
 * Refresh global home Deezer cache, then recompute recommendation + discover user cache per user.
 */
async function runDiscoverCacheRefreshJob() {
  if (jobRunning) {
    return { skipped: true, reason: 'already_running' };
  }
  jobRunning = true;
  const started = Date.now();
  try {
    await buildAndStoreGlobalHomeCache();

    const users = db.prepare(`SELECT id FROM users ORDER BY id ASC`).all();
    const ids = users.map((r) => String(r.id)).filter(Boolean);

    let usersProcessed = 0;
    for (let i = 0; i < ids.length; i += 1) {
      if (i > 0) {
        await sleep(USER_STAGGER_MS);
      }
      try {
        await rebuildUserDiscoverCacheRow(ids[i]);
        usersProcessed += 1;
      } catch (e) {
        console.warn('discoverCacheRefreshJob user', ids[i], e?.message || e);
      }
    }

    const ms = Date.now() - started;
    console.log(
      `discoverCacheRefreshJob: global home refreshed; ${usersProcessed}/${ids.length} user cache(s) updated in ${ms}ms`,
    );
    return { ok: true, usersProcessed, userCount: ids.length, durationMs: ms };
  } finally {
    jobRunning = false;
  }
}

module.exports = {
  runDiscoverCacheRefreshJob,
  USER_STAGGER_MS,
};
