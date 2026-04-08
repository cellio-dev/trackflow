/**
 * Recurring library folder scan: sync `tracks` with files on disk (db_exists, metadata).
 * Scans primary download folder + optional extra roots (see libraryPaths).
 */

const fs = require('fs');
const path = require('path');
const { getLibraryScanRoots } = require('../services/libraryPaths');
const { readTagsForFileSync } = require('../services/mutagenTags');
const { upsertTrackFromLibraryScan, markLibraryFilesMissing } = require('../services/tracksDb');

const MAX_LIBRARY_FILES = 8000;
const MAX_SCAN_DEPTH = 10;

function listLibraryAudioFiles(rootDir) {
  const out = [];
  function walk(dir, depth) {
    if (out.length >= MAX_LIBRARY_FILES || depth > MAX_SCAN_DEPTH) {
      return;
    }
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= MAX_LIBRARY_FILES) {
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.(mp3|flac|m4a|aac|ogg|opus|wav|wma)$/i.test(e.name)) {
        out.push(full);
      }
    }
  }
  walk(rootDir, 0);
  return out;
}

/**
 * @param {string} rootAbs
 * @param {string} relUnix — stored in DB (may include S1/ prefix)
 */
function scanOneRoot(rootAbs, relUnix) {
  const resolved = path.resolve(rootAbs);
  if (!fs.existsSync(resolved)) {
    return [];
  }
  const files = listLibraryAudioFiles(resolved);
  const seen = [];
  for (const abs of files) {
    const rel = path.relative(resolved, abs);
    const inner = rel.split(path.sep).join('/');
    const fullRel = relUnix ? `${relUnix}${inner}` : inner;
    seen.push(fullRel);
    const raw = readTagsForFileSync(abs);
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
    upsertTrackFromLibraryScan(meta, fullRel);
  }
  return seen;
}

async function runLibraryScanJob() {
  const roots = getLibraryScanRoots();
  if (!roots.length) {
    return { ok: false, reason: 'no library path' };
  }
  const allSeen = [];
  for (const root of roots) {
    const prefix = root.prefix || '';
    const chunk = scanOneRoot(root.abs, prefix);
    allSeen.push(...chunk);
  }
  markLibraryFilesMissing(allSeen);
  return { ok: true, files: allSeen.length, roots: roots.length };
}

module.exports = { runLibraryScanJob, listLibraryAudioFiles };
