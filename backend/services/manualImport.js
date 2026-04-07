const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const deezer = require('./deezer');
const { readTagsForFileSync } = require('./mutagenTags');
const { moveCompletedDownloadToLibrary } = require('./libraryMove');

const pending = new Map();

/** @type {number} */
const PENDING_TTL_MS = 60 * 60 * 1000;

/** Per-upload session dirs under system temp — same pattern as slskd (file + empty parent removed after move). */
const MANUAL_IMPORT_STAGING_REL = 'trackflow-manual-import';

function manualImportStagingRoot() {
  return path.resolve(path.join(os.tmpdir(), MANUAL_IMPORT_STAGING_REL));
}

/** Unique per-upload directory (multer destination). */
function createManualImportUploadSessionDir() {
  const dir = path.join(manualImportStagingRoot(), crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isResolvedPathUnderParent(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) {
    return true;
  }
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Remove upload file and any now-empty directories up through `trackflow-manual-import`
 * (analyze errors, TTL GC, expired token). Mirrors slskd empty-folder cleanup.
 * @param {string} filePath
 */
function unlinkManualImportFileAndEmptySessionDir(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return;
  }
  const resolvedFile = path.resolve(filePath.trim());
  const stagingRoot = manualImportStagingRoot();
  try {
    if (fs.existsSync(resolvedFile)) {
      const st = fs.statSync(resolvedFile);
      if (st.isFile()) {
        fs.unlinkSync(resolvedFile);
      }
    }
  } catch {
    // ignore
  }
  let dir = path.dirname(resolvedFile);
  for (let i = 0; i < 8; i++) {
    const d = path.resolve(dir);
    if (!isResolvedPathUnderParent(d, stagingRoot)) {
      break;
    }
    try {
      if (!fs.existsSync(d)) {
        break;
      }
      if (!fs.statSync(d).isDirectory()) {
        break;
      }
      if (fs.readdirSync(d).length > 0) {
        break;
      }
      fs.rmdirSync(d);
      dir = path.dirname(d);
    } catch {
      break;
    }
  }
  try {
    if (fs.existsSync(stagingRoot) && fs.statSync(stagingRoot).isDirectory() && fs.readdirSync(stagingRoot).length === 0) {
      fs.rmdirSync(stagingRoot);
    }
  } catch {
    // ignore
  }
}

function tryRemoveEmptyManualImportStagingRoot() {
  const stagingRoot = manualImportStagingRoot();
  try {
    if (
      fs.existsSync(stagingRoot) &&
      fs.statSync(stagingRoot).isDirectory() &&
      fs.readdirSync(stagingRoot).length === 0
    ) {
      fs.rmdirSync(stagingRoot);
    }
  } catch {
    // ignore
  }
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function gcPending() {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    if (now - v.createdAt > PENDING_TTL_MS) {
      unlinkManualImportFileAndEmptySessionDir(v.path);
      pending.delete(k);
    }
  }
}

function filenameGuessMeta(originalName) {
  const base = path.basename(String(originalName || ''), path.extname(String(originalName || '')));
  const m = base.match(/^(.+?)\s*-\s*(.+)$/);
  if (m) {
    return { artist: m[1].trim(), title: m[2].trim(), album: null };
  }
  return { artist: null, title: base || null, album: null };
}

/**
 * @param {string} absPath — temp upload path
 * @param {string} originalName
 * @returns {{ uploadToken: string, file: object }}
 */
function analyzeUploadedFile(absPath, originalName) {
  gcPending();
  const tags = readTagsForFileSync(absPath);
  const guess = filenameGuessMeta(originalName);
  const tagOk = tags && tags.ok === true;
  const file = {
    artist: (tagOk && trimText(tags.artist)) || guess.artist || null,
    title: (tagOk && trimText(tags.title)) || guess.title || null,
    album: (tagOk && trimText(tags.album)) || guess.album || null,
    trackflow_id: tagOk && tags.trackflow_id != null ? String(tags.trackflow_id).trim() || null : null,
  };
  const uploadToken = crypto.randomBytes(24).toString('hex');
  pending.set(uploadToken, {
    path: path.resolve(absPath),
    originalName: String(originalName || ''),
    createdAt: Date.now(),
  });
  return { uploadToken, file };
}

/**
 * @param {string} uploadToken
 * @param {string|number} deezerId
 * @returns {Promise<{ libraryPath: string, artist: string, title: string, album: string|null, deezer_id: string }>}
 */
async function confirmImport(uploadToken, deezerId) {
  gcPending();
  const token = String(uploadToken || '').trim();
  if (!token) {
    throw new Error('uploadToken is required');
  }
  const row = pending.get(token);
  if (!row) {
    throw new Error('Upload expired or invalid. Select the file again.');
  }
  if (Date.now() - row.createdAt > PENDING_TTL_MS) {
    pending.delete(token);
    unlinkManualImportFileAndEmptySessionDir(row.path);
    throw new Error('Upload expired. Select the file again.');
  }
  const id = String(deezerId).trim();
  if (!id) {
    throw new Error('Deezer track id is required');
  }

  const url = `https://api.deezer.com/track/${encodeURIComponent(id)}`;
  const data = await deezer.fetchDeezerJson(url);
  const err = data?.error;
  if (err) {
    throw new Error(err.message || String(err.type || 'Deezer track not found'));
  }

  const artist = trimText(data.artist?.name);
  const title = trimText(data.title);
  if (!artist || !title) {
    throw new Error('Deezer track is missing artist or title');
  }
  const album = trimText(data.album?.title) || null;
  const year =
    typeof data.release_date === 'string' && data.release_date.length >= 4
      ? data.release_date.slice(0, 4)
      : null;
  const track_number =
    data.track_position != null && Number.isFinite(Number(data.track_position))
      ? Math.round(Number(data.track_position))
      : null;

  const destPath = await moveCompletedDownloadToLibrary(row.path, artist, title, {
    deezer_id: id,
    album,
    year,
    track_number,
  });
  pending.delete(token);
  // Same as slskd: moveCompletedDownloadToLibrary removes the empty per-upload folder; drop staging root if unused.
  tryRemoveEmptyManualImportStagingRoot();

  return {
    libraryPath: destPath,
    artist,
    title,
    album,
    deezer_id: id,
  };
}

module.exports = {
  analyzeUploadedFile,
  confirmImport,
  createManualImportUploadSessionDir,
  unlinkManualImportFileAndEmptySessionDir,
  manualImportStagingRoot,
  gcPending,
};
