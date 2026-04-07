const fs = require('fs');
const path = require('path');
const { buildLibraryRelativePath, sanitizePathSegment } = require('./fileNaming');
const { getFileNamingPattern } = require('./appSettings');
const runtimeConfig = require('./runtimeConfig');

/** Same rules as fileNaming path segments (incl. Windows trailing . / space). */
function sanitizeFilenamePart(value) {
  return sanitizePathSegment(value);
}

/**
 * Best-effort local disk path from slskd GET /transfers/downloads match after success.
 */
function extractCompletedDownloadLocalPath(match) {
  if (!match || typeof match !== 'object') {
    return null;
  }
  const candidates = [
    match.localFilename,
    match.LocalFilename,
    match.localPath,
    match.LocalPath,
    match.savedPath,
    match.actualFilename,
    match.downloadPath,
    match?.transfer?.localFilename,
    match?.transfer?.LocalFilename,
    match?.transfer?.localPath,
    match?.transfer?.LocalPath,
    match?.file?.localFilename,
    match?.file?.localPath,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return resolveCompletedDownloadPath(c.trim());
    }
  }
  return null;
}

function assertDestInsideLibraryRoot(libraryRoot, destPath) {
  const root = path.resolve(libraryRoot);
  const dest = path.resolve(destPath);
  const rel = path.relative(root, dest);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Library destination escapes LIBRARY_PATH');
  }
}

/**
 * @param {string} libraryRoot - absolute library root
 * @param {string} relativePath - path segments joined with path.sep, includes file + ext
 * @returns {{ destPath: string, parentDir: string }}
 */
function resolveUniqueLibraryRelativePath(libraryRoot, relativePath) {
  const parts = String(relativePath)
    .split(path.sep)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error('Invalid library relative path');
  }
  for (const p of parts) {
    if (p === '..' || p === '.') {
      throw new Error('Invalid path segment in library path');
    }
  }
  const fileName = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);
  let parentDir = path.resolve(libraryRoot);
  for (const d of dirParts) {
    parentDir = path.join(parentDir, d);
  }
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(parentDir, fileName);
  assertDestInsideLibraryRoot(libraryRoot, candidate);
  let n = 0;
  while (fs.existsSync(candidate)) {
    n += 1;
    if (n >= 10_000) {
      throw new Error('Could not find a free destination filename');
    }
    candidate = path.join(parentDir, `${stem} (${n})${ext}`);
    assertDestInsideLibraryRoot(libraryRoot, candidate);
  }
  return { destPath: candidate, parentDir };
}

function pathExistsWithNumberedVariants(fullPath) {
  if (fs.existsSync(fullPath)) {
    return true;
  }
  const dir = path.dirname(fullPath);
  const ext = path.extname(fullPath);
  const stem = path.basename(fullPath, ext);
  let n = 1;
  while (n < 10_000) {
    const p = path.join(dir, `${stem} (${n})${ext}`);
    if (fs.existsSync(p)) {
      return true;
    }
    n += 1;
  }
  return false;
}

function getLibraryPath() {
  return runtimeConfig.getLibraryPath();
}

/** Base directory for slskd completed downloads (Settings or env fallback). */
function getSlskdLocalDownloadPath() {
  return runtimeConfig.getSlskdLocalDownloadPath();
}

/**
 * Resolve a path from slskd against SLSKD_LOCAL_DOWNLOAD_PATH when needed.
 */
function resolveCompletedDownloadPath(fromApi) {
  if (typeof fromApi !== 'string' || !fromApi.trim()) {
    return null;
  }
  let candidate = path.normalize(fromApi.trim());
  const base = getSlskdLocalDownloadPath();

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  if (!base) {
    return candidate;
  }

  const baseResolved = path.resolve(base);
  if (!path.isAbsolute(candidate)) {
    const joined = path.join(baseResolved, candidate);
    if (fs.existsSync(joined)) {
      return joined;
    }
  }
  const byName = path.join(baseResolved, path.basename(candidate));
  if (fs.existsSync(byName)) {
    return byName;
  }

  return candidate;
}

/**
 * Recursively find a file named targetName under dir (exact name, case-insensitive fallback).
 */
function findFile(dir, targetName, depth = 0) {
  if (depth > 50) {
    return null;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const targetLower = String(targetName).toLowerCase();

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = findFile(fullPath, targetName, depth + 1);
      if (found) {
        return found;
      }
    }

    if (
      entry.isFile() &&
      (entry.name === targetName || entry.name.toLowerCase() === targetLower)
    ) {
      return fullPath;
    }
  }

  return null;
}

/** Pull string values from transfer JSON that look like Windows/local audio paths. */
function collectPathLikeStrings(obj, out, depth) {
  if (depth > 15 || out.length > 80) {
    return;
  }
  if (typeof obj === 'string') {
    const t = obj.trim().replace(/^['"]|['"]$/g, '');
    if (t.length < 4) {
      return;
    }
    const looksLikeWinPath = /^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('\\\\');
    const looksLikePathWithAudioExt =
      (t.includes('\\') || t.includes('/')) && /\.(flac|mp3|m4a|opus|ogg|wav|aac)$/i.test(t);
    if (looksLikeWinPath || looksLikePathWithAudioExt) {
      out.push(t);
    }
    return;
  }
  if (!obj || typeof obj !== 'object') {
    return;
  }
  if (Array.isArray(obj)) {
    for (const x of obj) {
      collectPathLikeStrings(x, out, depth + 1);
    }
    return;
  }
  for (const v of Object.values(obj)) {
    collectPathLikeStrings(v, out, depth + 1);
  }
}

/**
 * Locate file under SLSKD_LOCAL_DOWNLOAD_PATH using basename only (slskd paths are often fake/nested).
 */
function resolveByRecursiveDownloadDir(fileFilename) {
  const baseName = path.basename(String(fileFilename || '').trim().replace(/\\/g, '/'));
  if (!baseName) {
    throw new Error('Could not derive basename from slskd file.filename');
  }

  const downloadRoot = getSlskdLocalDownloadPath();
  if (!downloadRoot) {
    throw new Error(
      'Download folder is not set. Open Settings and set the Soulseek / slskd completed download path.',
    );
  }

  const root = path.resolve(downloadRoot);
  if (!fs.existsSync(root)) {
    throw new Error(`SLSKD_LOCAL_DOWNLOAD_PATH does not exist: ${root}`);
  }

  const fullPath = findFile(root, baseName);
  if (!fullPath) {
    throw new Error(
      `Downloaded file "${baseName}" not found under ${root} (recursive search).`,
    );
  }

  console.log("Resolved file path:", fullPath);
  return fullPath;
}

/**
 * Resolve on-disk path after slskd reports success: prefer API paths, then recursive scan by basename.
 */
function resolveLocalPathAfterDownload(match, remoteFilename, _artist, _title) {
  const tryPath = (p) => {
    if (!p || typeof p !== 'string') {
      return null;
    }
    const normalized = path.normalize(p.trim());
    if (fs.existsSync(normalized)) {
      try {
        if (fs.statSync(normalized).isFile()) {
          return normalized;
        }
      } catch {
        /* ignore */
      }
    }
    const withBase = resolveCompletedDownloadPath(p.trim());
    if (withBase && fs.existsSync(withBase)) {
      try {
        if (fs.statSync(withBase).isFile()) {
          return withBase;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  };

  const fromFields = extractCompletedDownloadLocalPath(match);
  const fromApi = tryPath(fromFields);
  if (fromApi) {
    console.log("Resolved file path:", fromApi);
    return fromApi;
  }

  const pathLike = [];
  collectPathLikeStrings(match, pathLike, 0);
  const seen = new Set();
  for (const s of pathLike) {
    if (seen.has(s)) {
      continue;
    }
    seen.add(s);
    const found = tryPath(s);
    if (found) {
      console.log("Resolved file path:", found);
      return found;
    }
  }

  return resolveByRecursiveDownloadDir(remoteFilename);
}

/**
 * Move completed download from slskd into LIBRARY_PATH using `file_naming_pattern`.
 * @param {object} [tagMeta] — optional { deezer_id, album, duration_seconds, year?, track_number? } for mutagen + naming
 * @returns {Promise<string>} final absolute path
 */
async function moveCompletedDownloadToLibrary(sourcePath, artist, title, tagMeta = null) {
  const libraryRoot = getLibraryPath();
  if (!libraryRoot) {
    throw new Error(
      'Music library folder is not configured. Open Settings and set the library path.',
    );
  }

  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Downloaded file not found at: ${resolvedSource}`);
  }

  const stat = await fs.promises.stat(resolvedSource);
  if (!stat.isFile()) {
    throw new Error(`Expected a file at: ${resolvedSource}`);
  }

  const ext = path.extname(resolvedSource) || path.extname(sourcePath) || '';
  const pattern = getFileNamingPattern();
  const meta = {
    artist,
    title,
    album: tagMeta?.album != null ? tagMeta.album : null,
    year: tagMeta?.year != null ? tagMeta.year : null,
    track_number: tagMeta?.track_number != null ? tagMeta.track_number : null,
  };
  const { relativePath } = buildLibraryRelativePath(pattern, meta, ext);
  const libraryDir = path.resolve(libraryRoot);

  const { destPath, parentDir } = resolveUniqueLibraryRelativePath(libraryDir, relativePath);
  await fs.promises.mkdir(parentDir, { recursive: true });

  try {
    await fs.promises.rename(resolvedSource, destPath);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fs.promises.copyFile(resolvedSource, destPath);
      await fs.promises.unlink(resolvedSource);
    } else {
      throw err;
    }
  }

  try {
    const originalFullPath = resolvedSource;
    const sourceDir = path.dirname(originalFullPath);
    const files = fs.readdirSync(sourceDir);
    if (files.length === 0) {
      fs.rmdirSync(sourceDir);
      console.log('Removed empty folder:', sourceDir);
    }
  } catch (err) {
    console.error(
      'Could not remove empty download folder (ignored):',
      err?.message || err,
    );
  }

  const flow =
    tagMeta && tagMeta.deezer_id != null && String(tagMeta.deezer_id).trim()
      ? String(tagMeta.deezer_id).trim()
      : null;
  if (flow) {
    try {
      const { writeTagsForFileSync } = require('./mutagenTags');
      const performer = String(artist || '').trim();
      const tagPayload = {
        deezer_id: flow,
        artist: performer,
        album_artist: performer,
        title: String(title || '').trim(),
        album: tagMeta.album != null ? String(tagMeta.album).trim() : null,
      };
      console.log('[libraryMove] mutagen: before writeTagsForFileSync', destPath, tagPayload);
      writeTagsForFileSync(destPath, tagPayload);
      console.log('[libraryMove] mutagen: after writeTagsForFileSync', destPath);
    } catch (e) {
      console.warn('libraryMove: mutagen tag write skipped:', e?.message || e);
    }
  }
  try {
    const { upsertTrackAfterDownload } = require('./tracksDb');
    upsertTrackAfterDownload({
      libraryRoot: libraryDir,
      destPathAbsolute: destPath,
      trackflow_id: flow,
      artist,
      title,
      album: tagMeta?.album,
      year: tagMeta?.year,
      duration_seconds: tagMeta?.duration_seconds,
    });
  } catch (te) {
    console.warn('libraryMove: tracks DB upsert failed:', te?.message || te);
  }

  return destPath;
}

/**
 * Delete a partial download file and remove its immediate parent folder if empty (best-effort).
 */
function tryRemovePartialDownloadAndEmptyParent(localPath) {
  if (!localPath || typeof localPath !== 'string') {
    return;
  }
  const resolved = path.resolve(localPath.trim());
  try {
    if (!fs.existsSync(resolved)) {
      return;
    }
    const st = fs.statSync(resolved);
    if (st.isFile()) {
      fs.unlinkSync(resolved);
      console.log('Removed partial download file:', resolved);
    } else {
      return;
    }
    const sourceDir = path.dirname(resolved);
    const files = fs.readdirSync(sourceDir);
    if (files.length === 0) {
      fs.rmdirSync(sourceDir);
      console.log('Removed empty folder:', sourceDir);
    }
  } catch (err) {
    console.warn('Partial download cleanup failed (ignored):', err?.message || err);
  }
}

const LIBRARY_AUDIO_EXT = /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|aiff?)$/i;

/**
 * True if LIBRARY_PATH contains a file matching the current naming pattern (any common audio ext),
 * or legacy flat "Artist - Title.ext" at the library root.
 */
function libraryFileExistsForTrack(artist, title, extraMeta = {}) {
  const libraryRoot = getLibraryPath();
  if (!libraryRoot) {
    return false;
  }
  const root = path.resolve(libraryRoot);
  if (!fs.existsSync(root)) {
    return false;
  }
  const pattern = getFileNamingPattern();
  const meta = {
    artist,
    title,
    album: extraMeta.album != null ? extraMeta.album : null,
    year: extraMeta.year != null ? extraMeta.year : null,
    track_number: extraMeta.track_number != null ? extraMeta.track_number : null,
  };
  const exts = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma'];
  for (const tryExt of exts) {
    try {
      const { relativePath } = buildLibraryRelativePath(pattern, meta, tryExt);
      const full = path.join(root, relativePath);
      if (pathExistsWithNumberedVariants(full)) {
        return true;
      }
    } catch {
      /* pattern build can fail for odd metadata */
    }
  }
  const safeArtist = sanitizeFilenamePart(artist);
  const safeTitle = sanitizeFilenamePart(title);
  if (!safeArtist || !safeTitle) {
    return false;
  }
  const prefix = `${safeArtist} - ${safeTitle}`;
  try {
    const entries = fs.readdirSync(root);
    return entries.some((name) => {
      if (!LIBRARY_AUDIO_EXT.test(name)) {
        return false;
      }
      const stem = path.basename(name, path.extname(name));
      return stem === prefix || stem.startsWith(`${prefix} (`);
    });
  } catch {
    return false;
  }
}

module.exports = {
  extractCompletedDownloadLocalPath,
  findFile,
  resolveLocalPathAfterDownload,
  moveCompletedDownloadToLibrary,
  tryRemovePartialDownloadAndEmptyParent,
  sanitizeFilenamePart,
  getLibraryPath,
  getSlskdLocalDownloadPath,
  libraryFileExistsForTrack,
};
