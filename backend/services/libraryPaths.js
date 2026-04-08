/**
 * Primary library (download target) + optional extra folders scanned for availability.
 * Extra scan roots store `tracks.file_path` as `S1/relative/unix/path.mp3`; primary uses plain relative paths.
 */

const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const runtimeConfig = require('./runtimeConfig');

function trimPath(s) {
  if (s == null || typeof s !== 'string') {
    return '';
  }
  return s.trim().replace(/^['"]+|['"]+$/g, '');
}

const scanJsonStmt = getDb().prepare(`SELECT library_scan_paths_json FROM settings WHERE id = 1`);

function getPrimaryLibraryRootAbs() {
  const p = trimPath(runtimeConfig.getLibraryPath());
  return p ? path.resolve(p) : '';
}

/**
 * Additional directories to scan (not used as download destination unless same as primary).
 * @returns {string[]} absolute paths
 */
function getExtraLibraryScanRootsAbs() {
  const r = scanJsonStmt.get();
  let raw = r?.library_scan_paths_json;
  if (raw == null || String(raw).trim() === '') {
    raw = '[]';
  }
  let arr = [];
  try {
    const parsed = JSON.parse(String(raw));
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    arr = [];
  }
  const envExtra = trimPath(process.env.LIBRARY_SCAN_PATHS || '');
  if (arr.length === 0 && envExtra) {
    arr = envExtra
      .split(/[\n;]/)
      .map((x) => trimPath(x))
      .filter(Boolean);
  }
  const primary = getPrimaryLibraryRootAbs();
  const out = [];
  const seen = new Set();
  if (primary) {
    seen.add(path.resolve(primary));
  }
  for (const item of arr) {
    const t = trimPath(String(item));
    if (!t) {
      continue;
    }
    const abs = path.resolve(t);
    if (seen.has(abs)) {
      continue;
    }
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/**
 * @returns {{ key: string, prefix: string, abs: string }[]} key '' for primary, S1,S2 for extras
 */
function getLibraryScanRoots() {
  const roots = [];
  const primary = getPrimaryLibraryRootAbs();
  if (primary && fs.existsSync(primary)) {
    roots.push({ key: '', prefix: '', abs: primary });
  }
  getExtraLibraryScanRootsAbs().forEach((abs, i) => {
    if (!fs.existsSync(abs)) {
      return;
    }
    const key = `S${i + 1}`;
    roots.push({ key, prefix: `${key}/`, abs });
  });
  return roots;
}

/**
 * @param {string} storedPath — value from tracks.file_path (unix slashes)
 * @returns {string|null} absolute path if file exists and is under a configured root
 */
function resolveStoredLibraryFileToAbsolute(storedPath) {
  const rel = String(storedPath || '').replace(/\\/g, '/').trim();
  if (!rel) {
    return null;
  }
  const m = /^(S\d+)\/(.+)$/.exec(rel);
  if (m) {
    const roots = getLibraryScanRoots();
    const root = roots.find((x) => x.key === m[1]);
    if (!root) {
      return null;
    }
    const full = path.resolve(root.abs, m[2].split('/').join(path.sep));
    const rootResolved = path.resolve(root.abs);
    if (!full.startsWith(rootResolved + path.sep) && full !== rootResolved) {
      return null;
    }
    return fs.existsSync(full) ? full : null;
  }
  const primary = getPrimaryLibraryRootAbs();
  if (!primary) {
    return null;
  }
  const full = path.resolve(primary, rel.split('/').join(path.sep));
  const rootResolved = path.resolve(primary);
  if (!full.startsWith(rootResolved + path.sep) && full !== rootResolved) {
    return null;
  }
  return fs.existsSync(full) ? full : null;
}

module.exports = {
  getPrimaryLibraryRootAbs,
  getExtraLibraryScanRootsAbs,
  getLibraryScanRoots,
  resolveStoredLibraryFileToAbsolute,
};
