const { getDb } = require('../db');
const {
  buildAndStoreGlobalHomeCache,
  refreshDiscoverGenreGlobalCaches,
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
    const homePayload = await buildAndStoreGlobalHomeCache();
    const genreWarm = await refreshDiscoverGenreGlobalCaches(homePayload);
    if (genreWarm.warmed > 0 || genreWarm.failed > 0) {
      console.log(
        `discoverCacheRefreshJob: genre global cache warmed ${genreWarm.warmed}, failed ${genreWarm.failed}`,
      );
    }

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
      `discoverCacheRefreshJob: global home + genre caches refreshed; ${usersProcessed}/${ids.length} user cache(s) updated in ${ms}ms`,
    );
    return {
      ok: true,
      usersProcessed,
      userCount: ids.length,
      genreCachesWarmed: genreWarm.warmed,
      genreCachesFailed: genreWarm.failed,
      durationMs: ms,
    };
  } finally {
    jobRunning = false;
  }
}

module.exports = {
  runDiscoverCacheRefreshJob,
  USER_STAGGER_MS,
};
