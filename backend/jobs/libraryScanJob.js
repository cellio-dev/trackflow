/**
 * Recurring library folder scan: sync `tracks` with files on disk (db_exists, metadata).
 * Scans primary download folder + optional extra roots (see libraryPaths).
 */

const fs = require('fs');
const path = require('path');
const { getLibraryScanRoots } = require('../services/libraryPaths');
const { readTagsForFile } = require('../services/mutagenTags');
const {
  upsertTracksFromLibraryScanInTransaction,
  markLibraryFilesMissing,
} = require('../services/tracksDb');
const { yieldToEventLoop } = require('../services/cooperativeYield');

const MAX_LIBRARY_FILES = 8000;
const MAX_SCAN_DEPTH = 10;
/** Yield after this many directory reads while walking the tree */
const READDIR_YIELD_EVERY = 48;
/** Tag read + DB upsert batch size */
const FILE_PROCESS_CHUNK = 24;

/**
 * @param {string} rootDir
 * @param {{ out: string[], readdirCount: { n: number } }} ctx
 */
async function walkCollectAudioFiles(dir, depth, ctx) {
  if (ctx.out.length >= MAX_LIBRARY_FILES || depth > MAX_SCAN_DEPTH) {
    return;
  }
  let ents;
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  ctx.readdirCount.n += 1;
  if (ctx.readdirCount.n % READDIR_YIELD_EVERY === 0) {
    await yieldToEventLoop();
  }
  for (const e of ents) {
    if (ctx.out.length >= MAX_LIBRARY_FILES) {
      return;
    }
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        await walkCollectAudioFiles(full, depth + 1, ctx);
      } else if (/\.(mp3|flac|m4a|aac|ogg|opus|wav|wma)$/i.test(e.name)) {
        ctx.out.push(full);
      }
    } catch {
      /* ignore per-entry errors */
    }
  }
}

/**
 * @param {string} rootAbs
 * @param {string} relUnix — stored in DB (may include S1/ prefix)
 * @returns {Promise<string[]>} relative paths seen (unix-style)
 */
async function scanOneRoot(rootAbs, relUnix) {
  const resolved = path.resolve(rootAbs);
  try {
    const st = await fs.promises.stat(resolved);
    if (!st.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const ctx = { out: [], readdirCount: { n: 0 } };
  await walkCollectAudioFiles(resolved, 0, ctx);

  const seen = [];
  for (let i = 0; i < ctx.out.length; i += FILE_PROCESS_CHUNK) {
    const slice = ctx.out.slice(i, i + FILE_PROCESS_CHUNK);
    const batch = [];
    for (const abs of slice) {
      const rel = path.relative(resolved, abs);
      const inner = rel.split(path.sep).join('/');
      const fullRel = relUnix ? `${relUnix}${inner}` : inner;
      seen.push(fullRel);

      const raw = await readTagsForFile(abs);
      const meta =
        raw && raw.ok
          ? {
              trackflow_id: raw.trackflow_id,
              artist: raw.artist,
              title: raw.title,
              album: raw.album,
              year: raw.year,
              duration_seconds: raw.duration_seconds,
            }
          : {
              trackflow_id: null,
              artist: null,
              title: path.basename(abs, path.extname(abs)),
              album: null,
              year: null,
              duration_seconds: null,
            };
      batch.push({ meta, fullRel });
    }
    upsertTracksFromLibraryScanInTransaction(batch);
    await yieldToEventLoop();
  }
  return seen;
}

/**
 * Enumerate audio files under root (async, yields during walk). For admin/diagnostics.
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
async function listLibraryAudioFiles(rootDir) {
  const resolved = path.resolve(rootDir);
  const ctx = { out: [], readdirCount: { n: 0 } };
  await walkCollectAudioFiles(resolved, 0, ctx);
  return ctx.out;
}

async function runLibraryScanJob() {
  const roots = getLibraryScanRoots();
  if (!roots.length) {
    return { ok: false, reason: 'no library path' };
  }
  const allSeen = [];
  for (const root of roots) {
    const prefix = root.prefix || '';
    const chunk = await scanOneRoot(root.abs, prefix);
    allSeen.push(...chunk);
    await yieldToEventLoop();
  }
  await markLibraryFilesMissing(allSeen);
  return { ok: true, files: allSeen.length, roots: roots.length };
}

module.exports = { runLibraryScanJob, listLibraryAudioFiles };
