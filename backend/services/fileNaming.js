/**
 * Configurable library file paths from `file_naming_pattern` (settings).
 * Last path segment = base filename; extension is always .{format} from the download.
 */

const path = require('path');

const DEFAULT_PATTERN = '%artist%/%artist% - %title%';

const INVALID_IN_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Windows: do not end a folder/file name with space or period (shell / API); avoids 8.3 short names like T51N1A~S. */
const TRAILING_WINDOWS_ILLEGAL = /[.\s\u00A0\uFEFF]+$/u;

const WIN_RESERVED = new Set(
  ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'].map(
    (s) => s.toUpperCase(),
  ),
);

const PREVIEW_SAMPLE = Object.freeze({
  artist: 'Drake',
  album: 'Views',
  title: 'One Dance',
  year: '2016',
  track_number: 1,
  format: 'flac',
});

function normalizePatternString(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function sanitizePathSegment(segment) {
  let s = String(segment ?? '')
    .replace(INVALID_IN_SEGMENT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  while (TRAILING_WINDOWS_ILLEGAL.test(s)) {
    s = s.replace(TRAILING_WINDOWS_ILLEGAL, '').trim();
  }
  return s.length > 0 ? s : 'Unknown';
}

function emptyToUnknown(value) {
  const s = String(value ?? '').trim();
  return s ? s : 'Unknown';
}

function formatTrackNumber(value) {
  if (value == null || value === '') {
    return 'Unknown';
  }
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) {
    const int = Math.floor(n);
    return String(int).padStart(2, '0');
  }
  const t = String(value).trim();
  return t ? sanitizePathSegment(t) : 'Unknown';
}

function extensionToFormat(ext) {
  const e = String(ext || '').trim();
  if (!e) {
    return 'bin';
  }
  const withDot = e.startsWith('.') ? e : `.${e}`;
  return sanitizePathSegment(withDot.slice(1)) || 'bin';
}

function substituteVariables(template, values) {
  let s = template;
  const pairs = [
    ['%artist%', values.artist],
    ['%album%', values.album],
    ['%title%', values.title],
    ['%year%', values.year],
    ['%track_number%', values.track_number],
    ['%format%', values.format],
  ];
  for (const [key, val] of pairs) {
    s = s.split(key).join(val);
  }
  return s;
}

function buildValuesFromMeta(meta, formatStr) {
  return {
    artist: emptyToUnknown(meta?.artist),
    album: emptyToUnknown(meta?.album),
    title: emptyToUnknown(meta?.title),
    year: emptyToUnknown(meta?.year),
    track_number: formatTrackNumber(meta?.track_number),
    format: formatStr,
  };
}

/**
 * @param {string} pattern - raw user pattern (slashes = folders)
 * @param {object} meta - { artist, album, title, year?, track_number? }
 * @param {string} sourceExtension - e.g. ".flac" or "flac"
 * @returns {{ relativePath: string }} full path under library root including file extension
 */
function buildLibraryRelativePath(pattern, meta, sourceExtension) {
  const normalizedPattern = normalizePatternString(pattern);
  if (!normalizedPattern) {
    throw new Error('File naming pattern is empty');
  }
  const formatStr = extensionToFormat(sourceExtension);
  const values = buildValuesFromMeta(meta, formatStr);

  const segments = normalizedPattern.split('/').map((seg) => sanitizePathSegment(substituteVariables(seg, values)));
  const collapsed = segments.filter((seg) => seg.length > 0);
  if (collapsed.length === 0) {
    throw new Error('File naming pattern produced no path segments');
  }

  let baseSegments = collapsed.slice(0, -1);
  let fileStem = collapsed[collapsed.length - 1];
  if (!fileStem) {
    throw new Error('File naming pattern produced an empty filename');
  }

  const endsWithFormat = fileStem.toLowerCase().endsWith(`.${formatStr.toLowerCase()}`);
  if (!endsWithFormat) {
    fileStem = `${fileStem}.${formatStr}`;
  }

  const relParts = [...baseSegments, fileStem];
  for (const part of relParts) {
    if (part === '..' || part === '.') {
      throw new Error('Invalid file naming pattern (path traversal)');
    }
  }
  const relativePath = relParts.join(path.sep);

  return { relativePath };
}

function stemIsWindowsReserved(stemWithPossibleExt) {
  const base = path.basename(stemWithPossibleExt, path.extname(stemWithPossibleExt));
  const upper = base.toUpperCase();
  return WIN_RESERVED.has(upper);
}

/**
 * @returns {{ ok: true, relativePath: string } | { ok: false, error: string }}
 */
function validateFileNamingPattern(pattern, meta = PREVIEW_SAMPLE, sourceExtension = '.flac') {
  const p = String(pattern ?? '').trim();
  if (!p.includes('%title%')) {
    return { ok: false, error: 'Pattern must include %title%.' };
  }
  let relativePath;
  try {
    relativePath = buildLibraryRelativePath(p, meta, sourceExtension).relativePath;
  } catch (e) {
    return { ok: false, error: e?.message || 'Invalid pattern.' };
  }
  const parts = relativePath.split(path.sep).filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, error: 'Pattern must produce a valid file path.' };
  }
  const last = parts[parts.length - 1];
  if (!last || !path.extname(last)) {
    return { ok: false, error: 'Pattern must produce a filename with an extension.' };
  }
  for (const part of parts) {
    if (stemIsWindowsReserved(part)) {
      return { ok: false, error: `Segment "${part}" is reserved on Windows.` };
    }
  }
  if (relativePath.length > 240) {
    return { ok: false, error: 'Resulting path is too long (max ~240 characters).' };
  }
  return { ok: true, relativePath };
}

function previewFileNamingPattern(pattern) {
  return validateFileNamingPattern(pattern, PREVIEW_SAMPLE, '.flac');
}

module.exports = {
  DEFAULT_PATTERN,
  PREVIEW_SAMPLE,
  normalizePatternString,
  sanitizePathSegment,
  buildLibraryRelativePath,
  validateFileNamingPattern,
  previewFileNamingPattern,
  extensionToFormat,
};
