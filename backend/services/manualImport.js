const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const deezer = require('./deezer');
const { readTagsForFileSync } = require('./mutagenTags');
const { moveCompletedDownloadToLibrary } = require('./libraryMove');
const { findLibraryTracksMetaMatching } = require('./tracksDb');
const { getDb } = require('../db');
const { dropPendingDownloadsForRequestIds } = require('./requestApproval');

const pending = new Map();

/** @type {number} */
const PENDING_TTL_MS = 60 * 60 * 1000;

/** Per-upload session dirs under system temp — same pattern as slskd (file + empty parent removed after move). */
const MANUAL_IMPORT_STAGING_REL = 'trackflow-manual-import';

const YT_DLP_TIMEOUT_MS = 15 * 60 * 1000;

const db = getDb();

const getRequestRowForManualStmt = db.prepare(`
  SELECT id, deezer_id, status, cancelled
  FROM requests
  WHERE id = ?
`);

const markRequestCompletedAfterManualImportStmt = db.prepare(`
  UPDATE requests
  SET status = 'completed', cancelled = 0, processing_phase = NULL, processed_at = datetime('now'), slskd_expected_basename = NULL
  WHERE id = ?
    AND TRIM(CAST(deezer_id AS TEXT)) = TRIM(CAST(? AS TEXT))
    AND (status = 'failed' OR (status = 'processing' AND IFNULL(cancelled, 0) = 1))
`);

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

function getYtDlpExecutable() {
  const fromEnv = process.env.TF_YTDLP || process.env.YT_DLP;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  const packaged = path.join(__dirname, '..', 'bin', 'yt-dlp');
  try {
    if (fs.existsSync(packaged)) {
      return packaged;
    }
  } catch {
    /* ignore */
  }
  const usrLocal = '/usr/local/bin/yt-dlp';
  try {
    if (process.platform !== 'win32' && fs.existsSync(usrLocal)) {
      return usrLocal;
    }
  } catch {
    /* ignore */
  }
  return 'yt-dlp';
}

function isAllowedYouTubeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) {
    return false;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return false;
    }
    const h = u.hostname.toLowerCase();
    return (
      h === 'youtube.com' ||
      h === 'www.youtube.com' ||
      h === 'm.youtube.com' ||
      h === 'music.youtube.com' ||
      h === 'youtu.be'
    );
  } catch {
    return false;
  }
}

function runYtDlpDownloadMp3(bin, watchUrl, outputTemplate) {
  const args = ['-x', '--audio-format', 'mp3', '-o', outputTemplate, '--no-playlist', watchUrl];
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      reject(new Error('YouTube download timed out'));
    }, YT_DLP_TIMEOUT_MS);
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stderr);
      } else {
        const tail = stderr.trim().slice(-1500);
        reject(new Error(tail || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

function findFirstAudioFileInDir(dir) {
  const exts = new Set(['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.flac', '.wav']);
  let best = null;
  let bestMtime = -1;
  const walk = (d) => {
    if (!fs.existsSync(d)) {
      return;
    }
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (exts.has(ext) && st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          best = full;
        }
      }
    }
  };
  walk(dir);
  return best;
}

/**
 * Download audio via yt-dlp into a fresh staging session, then analyze like an upload.
 * @param {string} youtubeUrl
 * @returns {Promise<{ uploadToken: string, file: object }>}
 */
async function importYoutubeAudioForManualImport(youtubeUrl) {
  gcPending();
  const url = String(youtubeUrl || '').trim();
  if (!url) {
    throw new Error('YouTube URL is required');
  }
  if (!isAllowedYouTubeUrl(url)) {
    throw new Error('Only http(s) YouTube or YouTube Music links are allowed');
  }
  const sessionDir = createManualImportUploadSessionDir();
  const outputTemplate = path.join(sessionDir, 'tf-yt-import.%(ext)s');
  const bin = getYtDlpExecutable();
  await runYtDlpDownloadMp3(bin, url, outputTemplate);
  const audioPath = findFirstAudioFileInDir(sessionDir);
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error('Download finished but no audio file was found in the staging folder');
  }
  return analyzeUploadedFile(audioPath, path.basename(audioPath), 'youtube');
}

/**
 * @param {string} absPath — temp upload path
 * @param {string} originalName
 * @param {'file'|'youtube'} [sourceKind]
 * @returns {{ uploadToken: string, file: object, sourceKind: string }}
 */
function analyzeUploadedFile(absPath, originalName, sourceKind = 'file') {
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
  const kind = sourceKind === 'youtube' ? 'youtube' : 'file';
  pending.set(uploadToken, {
    path: path.resolve(absPath),
    originalName: String(originalName || ''),
    createdAt: Date.now(),
    sourceKind: kind,
  });
  return { uploadToken, file, sourceKind: kind };
}

function assertRequestEligibleForManualImportCompletion(requestId, deezerId) {
  const id = Math.floor(Number(requestId));
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid request id');
  }
  const did = String(deezerId || '').trim();
  if (!did) {
    throw new Error('Deezer track id is required');
  }
  const row = getRequestRowForManualStmt.get(id);
  if (!row) {
    throw new Error('Request not found');
  }
  if (String(row.deezer_id || '').trim() !== did) {
    throw new Error('Selected Deezer track does not match this request');
  }
  const st = String(row.status || '');
  const cancelled = Number(row.cancelled) === 1;
  const eligible = st === 'failed' || (st === 'processing' && cancelled);
  if (!eligible) {
    throw new Error('This request is not in a state that can be completed via manual import');
  }
}

function markRequestCompletedAfterManualImportOnly(requestId, deezerId) {
  const id = Math.floor(Number(requestId));
  const did = String(deezerId || '').trim();
  const info = markRequestCompletedAfterManualImportStmt.run(id, did);
  if (!info.changes) {
    throw new Error('Could not update request status');
  }
  dropPendingDownloadsForRequestIds([id]);
}

/**
 * @param {string} uploadToken
 * @param {string|number} deezerId
 * @param {{ acknowledgeDuplicate?: boolean, libraryDuplicateAction?: 'add_copy'|'overwrite', requestId?: string|number|null }} [options]
 * @returns {Promise<{ libraryPath: string, artist: string, title: string, album: string|null, deezer_id: string }>}
 */
async function confirmImport(uploadToken, deezerId, options = {}) {
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
  const duration_seconds =
    data.duration != null && Number.isFinite(Number(data.duration)) ? Math.round(Number(data.duration)) : null;

  const matches = findLibraryTracksMetaMatching(artist, title);
  const rawDup = options.libraryDuplicateAction != null ? String(options.libraryDuplicateAction).trim().toLowerCase() : '';
  const dupFromLegacy = options.acknowledgeDuplicate ? 'add_copy' : null;
  const duplicateAction =
    rawDup === 'overwrite' || rawDup === 'add_copy' ? rawDup : dupFromLegacy;

  if (matches.length > 0 && !duplicateAction) {
    const dupErr = new Error(
      'A track with this artist and title is already in your library. Choose another copy, overwrite the existing file, or cancel.',
    );
    dupErr.code = 'DUPLICATE';
    dupErr.matches = matches;
    throw dupErr;
  }

  if (options.requestId != null && String(options.requestId).trim() !== '') {
    assertRequestEligibleForManualImportCompletion(options.requestId, id);
  }

  // Staged uploads (file or YouTube temp) are always moved out of temp; the original path the user
  // picked in the browser is never accessible to the server.
  const keepSourceFile = false;
  const destinationMode = duplicateAction === 'overwrite' ? 'overwrite' : 'unique';

  const destPath = await moveCompletedDownloadToLibrary(
    row.path,
    artist,
    title,
    {
      deezer_id: id,
      album,
      year,
      track_number,
      duration_seconds,
    },
    { keepSourceFile, destinationMode },
  );
  pending.delete(token);
  tryRemoveEmptyManualImportStagingRoot();

  if (options.requestId != null && String(options.requestId).trim() !== '') {
    markRequestCompletedAfterManualImportOnly(options.requestId, id);
  }

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
  importYoutubeAudioForManualImport,
  createManualImportUploadSessionDir,
  unlinkManualImportFileAndEmptySessionDir,
  manualImportStagingRoot,
  gcPending,
  isAllowedYouTubeUrl,
  getYtDlpExecutable,
};
