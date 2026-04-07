const { getDb } = require('../db');

/**
 * @param {Array<string | number | null | undefined>} userIds
 * @returns {Map<string, string>} map of string user id -> username
 */
function usernamesByIds(userIds) {
  const db = getDb();
  const uniqueNums = new Set();
  for (const raw of userIds) {
    if (raw == null || raw === '') {
      continue;
    }
    const n = Number(String(raw).trim());
    if (Number.isInteger(n) && n > 0) {
      uniqueNums.add(n);
    }
  }
  const nums = [...uniqueNums];
  if (!nums.length) {
    return new Map();
  }
  const placeholders = nums.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
    .all(...nums);
  const map = new Map();
  for (const r of rows) {
    map.set(String(r.id), r.username);
  }
  return map;
}

/**
 * @param {Map<string, string>} map
 * @param {string | number | null | undefined} userId
 */
function usernameForId(map, userId) {
  if (userId == null || userId === '') {
    return '';
  }
  const s = String(userId).trim();
  return map.get(s) || '';
}

module.exports = {
  usernamesByIds,
  usernameForId,
};
