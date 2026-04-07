const { getDb } = require('../db');
const {
  DEFAULT_PATTERN,
  normalizePatternString,
  validateFileNamingPattern,
} = require('./fileNaming');

const fileNamingPatternStmt = getDb().prepare(
  'SELECT file_naming_pattern FROM settings WHERE id = 1',
);

function getFileNamingPattern() {
  try {
    const row = fileNamingPatternStmt.get();
    const raw = row?.file_naming_pattern;
    const fnp =
      typeof raw === 'string' && raw.trim() ? normalizePatternString(raw) : DEFAULT_PATTERN;
    const v = validateFileNamingPattern(fnp);
    return v.ok ? fnp : DEFAULT_PATTERN;
  } catch {
    return DEFAULT_PATTERN;
  }
}

module.exports = {
  getFileNamingPattern,
};
