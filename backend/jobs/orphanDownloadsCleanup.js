/**
 * Completed-downloads folder maintenance (scheduled from server.js).
 * When enabled and SLSKD_LOCAL_DOWNLOAD_PATH is set, deletes files under that folder whose
 * mtime is at least 10 minutes old (so in-flight / just-finished downloads are not removed),
 * then removes empty subdirectories (never the root).
 *
 * Path safety: uses realpath(root) and realpath(each file) plus path.relative containment checks
 * so symlink/bind mounts, mapped SMB drives (e.g. Z: vs UNC), and mixed path forms still agree.
 * Mtime comes from the SMB client stack; keep the app host clock reasonably in sync with the
 * file server so age thresholds are meaningful.
 *
 * Safe to run while requests are processing because only stale files are unlinked.
 */
const fs = require('fs');
const path = require('path');
const { getSlskdLocalDownloadPath } = require('../services/libraryMove');
const runtimeConfig = require('../services/runtimeConfig');

/** Files must be at least this old before unlink; newly completed files leave within seconds. */
const MIN_ENTRY_AGE_MS = 10 * 60 * 1000;

/**
 * Current instant as milliseconds since Unix epoch (UTC). Same basis as `fs` mtimes in Node.
 * @returns {number}
 */
function utcEpochMsNow() {
  return Date.now();
}

/**
 * File modification time as milliseconds since Unix epoch (UTC), from `fs.Stats`.
 * Uses `mtimeMs` when valid; otherwise `mtime.getTime()` — never local calendar math.
 * @param {import('fs').Stats} stats
 * @returns {number | null}
 */
function getMtimeUtcEpochMs(stats) {
  const raw = stats.mtimeMs;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'bigint') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const d = stats.mtime;
  if (d instanceof Date) {
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * @param {number | null} fileMtimeUtcEpochMs
 * @param {number} nowUtcEpochMs
 */
function isEntryOldEnoughEpoch(fileMtimeUtcEpochMs, nowUtcEpochMs) {
  if (fileMtimeUtcEpochMs == null) {
    return false;
  }
  return nowUtcEpochMs - fileMtimeUtcEpochMs >= MIN_ENTRY_AGE_MS;
}

/**
 * Whether absolutePath is strictly under rootResolved (root itself is never deleted).
 * path.relative avoids brittle string prefix checks on UNC vs drive-letter SMB paths.
 */
function isStrictlyInsideDownloadRoot(rootResolved, absolutePath) {
  let root = path.resolve(rootResolved);
  let file = path.resolve(absolutePath);
  if (process.platform === 'win32') {
    root = root.toLowerCase();
    file = file.toLowerCase();
  }
  if (file === root) {
    return false;
  }
  const rel = path.relative(root, file);
  if (!rel) {
    return false;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

function listFilesRecursive(rootDir, maxDepth = 80) {
  /** @type {string[]} */
  const out = [];

  function walk(dir, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      try {
        if (ent.isSymbolicLink()) {
          out.push(full);
          continue;
        }
        if (ent.isDirectory()) {
          walk(full, depth + 1);
        } else if (ent.isFile()) {
          out.push(full);
        }
      } catch {
        // ignore per-entry errors
      }
    }
  }

  walk(rootDir, 0);
  return out;
}

/** All directories under root (including nested), depth-first post-order (children before parents). */
function listDirsPostOrder(rootDir, maxDepth = 80) {
  /** @type {string[]} */
  const out = [];

  function walk(dir, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) {
        continue;
      }
      if (!ent.isDirectory()) {
        continue;
      }
      const full = path.join(dir, ent.name);
      try {
        walk(full, depth + 1);
        out.push(full);
      } catch {
        // ignore
      }
    }
  }

  walk(rootDir, 0);
  return out;
}

async function safeUnlink(filePath) {
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EPERM')) {
      return false;
    }
    console.warn('completedDownloadsCleanup: unlink failed (ignored):', filePath, err?.message || err);
    return false;
  }
}

async function safeRmdir(dirPath) {
  try {
    await fs.promises.rmdir(dirPath);
    return true;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTEMPTY' || err.code === 'EPERM')) {
      return false;
    }
    console.warn('completedDownloadsCleanup: rmdir failed (ignored):', dirPath, err?.message || err);
    return false;
  }
}

function parseIntervalMs() {
  return runtimeConfig.getOrphanCleanupIntervalMs();
}

function isEnabled() {
  return runtimeConfig.isOrphanCleanupEnabled();
}

/**
 * When enabled: delete files under the slskd completed-download folder whose modification time
 * (UTC epoch ms) is at least 10 minutes before now (UTC epoch ms), then remove empty directories
 * (except root). Runs even if a request is `processing`; young files are skipped.
 * @returns {Promise<{ scanned?: number, removedFiles?: number, removedDirs?: number, skipped?: string }>}
 */
async function runOrphanDownloadsCleanup() {
  if (!isEnabled()) {
    return { scanned: 0, removedFiles: 0, removedDirs: 0, disabled: true };
  }

  const rawRoot = getSlskdLocalDownloadPath();
  if (!rawRoot) {
    console.log('completedDownloadsCleanup: SLSKD_LOCAL_DOWNLOAD_PATH unset, skip');
    return { scanned: 0, removedFiles: 0, removedDirs: 0, skip: 'no_path' };
  }

  const root = path.resolve(rawRoot);
  if (!fs.existsSync(root)) {
    console.log('completedDownloadsCleanup: download root missing, skip:', root);
    return { scanned: 0, removedFiles: 0, removedDirs: 0, skip: 'missing_root' };
  }

  const stat = await fs.promises.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.log('completedDownloadsCleanup: download root is not a directory, skip:', root);
    return { scanned: 0, removedFiles: 0, removedDirs: 0, skip: 'not_dir' };
  }

  // Must match realpath(file) — if root is a symlink/bind mount, unresolved root breaks prefix checks.
  const rootCanonical = await fs.promises.realpath(root).catch(() => root);

  const files = listFilesRecursive(root);
  let removedFiles = 0;
  const nowEpochMs = utcEpochMsNow();

  for (const filePath of files) {
    let resolved = path.resolve(filePath);
    try {
      resolved = await fs.promises.realpath(resolved).catch(() => resolved);
    } catch {
      continue;
    }
    if (!isStrictlyInsideDownloadRoot(rootCanonical, resolved)) {
      continue;
    }

    let st;
    try {
      st = await fs.promises.stat(resolved);
    } catch {
      try {
        st = await fs.promises.lstat(resolved);
      } catch {
        continue;
      }
    }
    if (!st.isFile() && !st.isSymbolicLink()) {
      continue;
    }

    const fileMtimeEpochMs = getMtimeUtcEpochMs(st);
    if (!isEntryOldEnoughEpoch(fileMtimeEpochMs, nowEpochMs)) {
      continue;
    }

    const didRemove = await safeUnlink(resolved);
    if (didRemove) {
      removedFiles += 1;
      console.log('completedDownloadsCleanup: removed file:', resolved);
    }
  }

  let removedDirs = 0;
  /** After old files are gone, remove empty subfolders bottom-up (mtime not required — avoids stale dir mtimes blocking cleanup). */
  let pruned = true;
  while (pruned) {
    pruned = false;
    const dirsPostOrder = listDirsPostOrder(root);
    for (const dirPath of dirsPostOrder) {
      let resolved = path.resolve(dirPath);
      try {
        resolved = await fs.promises.realpath(resolved).catch(() => resolved);
      } catch {
        continue;
      }
      if (resolved === rootCanonical || !isStrictlyInsideDownloadRoot(rootCanonical, resolved)) {
        continue;
      }

      let st;
      try {
        st = await fs.promises.lstat(resolved);
      } catch {
        continue;
      }
      if (!st.isDirectory()) {
        continue;
      }

      let names;
      try {
        names = await fs.promises.readdir(resolved);
      } catch {
        continue;
      }
      if (names.length > 0) {
        continue;
      }

      const didRm = await safeRmdir(resolved);
      if (didRm) {
        removedDirs += 1;
        pruned = true;
        console.log('completedDownloadsCleanup: removed empty folder:', resolved);
      }
    }
  }

  console.log(
    `completedDownloadsCleanup: done filesSeen=${files.length} removedFiles=${removedFiles} removedDirs=${removedDirs}`,
  );
  return { scanned: files.length, removedFiles, removedDirs };
}

module.exports = {
  runOrphanDownloadsCleanup,
  parseIntervalMs,
  isEnabled,
};
