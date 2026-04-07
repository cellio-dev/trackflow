const { getDb } = require('../db');

const DEFAULT_DISCOVER_CACHE_REFRESH_MINUTES = 240;
const MIN_DISCOVER_CACHE_REFRESH_MINUTES = 30;
const MAX_DISCOVER_CACHE_REFRESH_MINUTES = 10080; // 7 days

function getDiscoverCacheRefreshMinutes() {
  try {
    const row = getDb()
      .prepare(`SELECT discover_cache_refresh_minutes FROM settings WHERE id = 1`)
      .get();
    const n = Number(row?.discover_cache_refresh_minutes);
    if (!Number.isFinite(n)) {
      return DEFAULT_DISCOVER_CACHE_REFRESH_MINUTES;
    }
    return Math.min(
      MAX_DISCOVER_CACHE_REFRESH_MINUTES,
      Math.max(MIN_DISCOVER_CACHE_REFRESH_MINUTES, Math.floor(n)),
    );
  } catch {
    return DEFAULT_DISCOVER_CACHE_REFRESH_MINUTES;
  }
}

function getDiscoverCacheTtlMs() {
  return getDiscoverCacheRefreshMinutes() * 60 * 1000;
}

module.exports = {
  getDiscoverCacheRefreshMinutes,
  getDiscoverCacheTtlMs,
  DEFAULT_DISCOVER_CACHE_REFRESH_MINUTES,
  MIN_DISCOVER_CACHE_REFRESH_MINUTES,
  MAX_DISCOVER_CACHE_REFRESH_MINUTES,
};
