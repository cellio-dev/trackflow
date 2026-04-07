// Plex library checks. Metadata-first matching with shared normalization.

const fs = require('fs');
const path = require('path');
const { libraryFileExistsForTrack } = require('./libraryMove');
const runtimeConfig = require('./runtimeConfig');

function getPlexMusicSectionId() {
  return runtimeConfig.getPlexMusicSectionId();
}

/**
 * Normalize for fuzzy track matching:
 * - lowercase
 * - unicode apostrophes → ASCII '
 * - remove (parentheses) segments
 * - strip feat./ft./remaster/explicit/deluxe-style tags
 * - keep only a-z, 0-9, spaces; collapse spaces; trim
 */
function normalizeString(input) {
  let s = String(input ?? '');

  s = s
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/\u02B9/g, "'")
    .replace(/\u02BC/g, "'")
    .replace(/\u2032/g, "'");

  s = s.toLowerCase();

  /** Contractions / possessives: let's → lets, gangsta's → gangstas */
  s = s.replace(/(\w)'(\w)/g, '$1$2');
  s = s.replace(/'/g, ' ');

  let prev;
  do {
    prev = s;
    s = s.replace(/\([^)]*\)/g, ' ');
  } while (s !== prev);

  const tagPatterns = [
    /\bfeat\.[\w\s.'-]*/gi,
    /\bft\.[\w\s.'-]*/gi,
    /\bft\s+[\w\s.'-]+/gi,
    /\bremaster(?:ed)?[\w\s.'-]*/gi,
    /\bexplicit(?:\s*version)?[\w\s.'-]*/gi,
    /\bdeluxe[\w\s.'-]*/gi,
  ];
  for (const re of tagPatterns) {
    s = s.replace(re, ' ');
  }

  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function combinedNormalized(artist, title) {
  const a = String(artist || '').trim();
  const t = String(title || '').trim();
  return normalizeString(`${a} ${t}`);
}

/** Partial match on combined normalized artist + title. */
function partialCombinedMatch(expectedArtist, expectedTitle, plexArtist, plexTitle) {
  const exp = combinedNormalized(expectedArtist, expectedTitle);
  const pl = combinedNormalized(plexArtist, plexTitle);
  if (!exp || !pl) {
    return false;
  }
  return exp.includes(pl) || pl.includes(exp);
}

function getTrackFileBasename(item) {
  const file = item?.Media?.[0]?.Part?.[0]?.file;
  if (typeof file !== 'string' || !file.trim()) {
    return '';
  }
  return path.basename(file.trim(), path.extname(file.trim()));
}

/** Prefer Plex metadata; fallback to normalized filename stem. */
function matchTrackAgainstExpected(expectedArtist, expectedTitle, item) {
  if (!item || item.type !== 'track') {
    return { matched: false, via: null };
  }

  const grand = item.grandparentTitle;
  const plexTitle = item.title;
  const originalTitle = item.originalTitle;
  const parent = item.parentTitle;

  if (partialCombinedMatch(expectedArtist, expectedTitle, grand, plexTitle)) {
    return { matched: true, via: 'metadata' };
  }
  if (originalTitle && partialCombinedMatch(expectedArtist, expectedTitle, grand, originalTitle)) {
    return { matched: true, via: 'metadata_originalTitle' };
  }
  if (parent && partialCombinedMatch(expectedArtist, expectedTitle, parent, plexTitle)) {
    return { matched: true, via: 'metadata_parentTitle' };
  }

  const base = getTrackFileBasename(item);
  if (base) {
    const nFile = normalizeString(base);
    const exp = combinedNormalized(expectedArtist, expectedTitle);
    if (nFile && exp && (nFile.includes(exp) || exp.includes(nFile))) {
      return { matched: true, via: 'filename' };
    }
  }

  return { matched: false, via: null };
}

function logNoMatch(context) {
  const expArtist = String(context.expectedArtist || '').trim();
  const expTitle = String(context.expectedTitle || '').trim();
  console.warn('[plex] track match: no match', {
    phase: context.phase,
    expected: {
      artist: expArtist,
      title: expTitle,
      normalizedCombined: combinedNormalized(expArtist, expTitle),
    },
    detail: context.detail || null,
  });
}

async function searchPlex(_options) {
  return [];
}

function enrichPlexFetchError(e) {
  const c = e?.cause;
  const code = c?.code != null ? String(c.code) : '';
  const msg = c?.message != null ? String(c.message) : '';
  const detail = [code, msg].filter(Boolean).join(': ');
  return new Error(
    detail ? `Plex connection failed (${detail})` : (e?.message || 'Plex connection failed'),
  );
}

async function fetchJson(url, plexToken) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'X-Plex-Token': plexToken,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    throw enrichPlexFetchError(e);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Plex request failed (${response.status}): ${text || response.statusText}`);
  }
  return response.json();
}

/**
 * Ask Plex Media Server to refresh (scan) the configured music library section.
 * @returns {Promise<void>}
 */
async function triggerPlexLibrarySectionRefresh() {
  const { plexUrl, plexToken } = runtimeConfig.getPlexUrlAndToken();
  if (!plexUrl || !plexToken) {
    throw new Error('Plex URL and token must be configured');
  }
  const base = plexUrl.replace(/\/+$/, '');
  const sectionIdRaw = String(getPlexMusicSectionId() || '').trim();
  if (!sectionIdRaw) {
    throw new Error('Plex Music Library ID is empty');
  }
  await assertConfiguredMusicSectionValid(base, plexToken, sectionIdRaw);
  const sectionId = encodeURIComponent(sectionIdRaw);
  const url = `${base}/library/sections/${sectionId}/refresh?X-Plex-Token=${encodeURIComponent(plexToken)}`;
  let response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (e) {
    throw enrichPlexFetchError(e);
  }
  if (!response.ok) {
    const t = await response.text().catch(() => '');
    throw new Error(`Plex library refresh failed (${response.status}): ${t || response.statusText}`);
  }
}

/** Plex often returns a single object instead of an array for one child. */
function asPlexItemArray(x) {
  if (x == null) {
    return [];
  }
  return Array.isArray(x) ? x : [x];
}

/**
 * Plex may return HTTP 200 with an empty MediaContainer for /sections/{badId}/all, so callers must
 * validate the configured section against GET /library/sections.
 *
 * @param {string} base — Plex server URL without trailing slash
 * @param {string} plexToken
 * @param {string} sectionIdRaw — Music library section key from settings
 */
async function assertConfiguredMusicSectionValid(base, plexToken, sectionIdRaw) {
  if (!sectionIdRaw) {
    throw new Error('Music library section ID is empty.');
  }
  const sectionsJson = await fetchJson(`${base}/library/sections`, plexToken);
  const directories = asPlexItemArray(sectionsJson?.MediaContainer?.Directory);
  const match = directories.find((d) => String(d?.key ?? '') === sectionIdRaw);
  if (!match) {
    const ids = directories
      .map((d) => (d?.key != null ? String(d.key) : null))
      .filter(Boolean);
    const detail =
      ids.length > 0
        ? `On this server, library section IDs are: ${ids.join(', ')}.`
        : 'No libraries were returned for this account.';
    throw new Error(`Music library section ID "${sectionIdRaw}" was not found. ${detail}`);
  }
  const sectionType = String(match.type || '').toLowerCase();
  if (sectionType && sectionType !== 'artist') {
    const title = typeof match.title === 'string' ? match.title : '';
    const label = title ? `"${title}" (${sectionIdRaw})` : `"${sectionIdRaw}"`;
    throw new Error(
      `Section ${label} is not a Music library in Plex (type "${match.type}"). Use the section ID of a Music library.`,
    );
  }
}

/** Plex.tv rejects bad account tokens; local PMS GET /identity often returns 200 without checking the token. */
const PLEX_TV_VERIFY_USER_URL = 'https://plex.tv/api/v2/user';

async function assertPlexTokenAcceptedByPlexTv(plexToken) {
  const token = String(plexToken || '').trim();
  if (!token) {
    throw new Error('Plex token is empty');
  }
  let res;
  try {
    res = await fetch(PLEX_TV_VERIFY_USER_URL, {
      method: 'GET',
      headers: {
        'X-Plex-Token': token,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    throw enrichPlexFetchError(e);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'Plex token is invalid or expired. Open Plex Web, sign in, and set a new X-Plex-Token in TrackFlow.',
    );
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Could not verify Plex token with plex.tv (${res.status}): ${t || res.statusText}`);
  }
}

/**
 * Settings test: verify token with Plex.tv, reach local PMS (unauthenticated /identity), then same
 * library checks as the scan (section exists, Music type, one track page).
 */
async function testPlexSettingsConnection() {
  const { plexUrl, plexToken } = runtimeConfig.getPlexUrlAndToken();
  if (!plexUrl || !plexToken) {
    throw new Error('Plex URL and token must be configured');
  }
  const base = plexUrl.replace(/\/+$/, '');

  await assertPlexTokenAcceptedByPlexTv(plexToken);

  let ping;
  try {
    ping = await fetch(`${base}/identity`, { method: 'GET' });
  } catch (e) {
    throw enrichPlexFetchError(e);
  }
  if (!ping.ok) {
    const t = await ping.text().catch(() => '');
    throw new Error(`Could not reach Plex Media Server at ${base} (${ping.status}): ${t || ping.statusText}`);
  }

  const sectionIdRaw = String(getPlexMusicSectionId() || '').trim();
  await assertConfiguredMusicSectionValid(base, plexToken, sectionIdRaw);

  const sectionId = encodeURIComponent(sectionIdRaw);
  const probeUrl = `${base}/library/sections/${sectionId}/all?type=10&X-Plex-Container-Start=0&X-Plex-Container-Size=1`;
  await fetchJson(probeUrl, plexToken);
}

function getSectionScanSize() {
  return runtimeConfig.getPlexTrackScanSize();
}

/**
 * First page of tracks in the music section (metadata + filename fallback).
 */
async function scanSectionTracksPage(plexUrl, sectionId, plexToken, expectedArtist, expectedTitle) {
  const scanSize = getSectionScanSize();
  const scanUrl = `${plexUrl}/library/sections/${sectionId}/all?type=10&X-Plex-Container-Start=0&X-Plex-Container-Size=${scanSize}`;
  const scanData = await fetchJson(scanUrl, plexToken);
  const scanMeta = Array.isArray(scanData?.MediaContainer?.Metadata)
    ? scanData.MediaContainer.Metadata
    : [];

  const samples = [];
  for (const item of scanMeta) {
    if (item?.type !== 'track') {
      continue;
    }
    const { matched } = matchTrackAgainstExpected(expectedArtist, expectedTitle, item);
    if (matched) {
      return { matched: true, scanSize, samples };
    }
    if (samples.length < 5) {
      const base = getTrackFileBasename(item);
      samples.push({
        grandparentTitle: item.grandparentTitle,
        title: item.title,
        originalTitle: item.originalTitle,
        normalizedCombined: combinedNormalized(item.grandparentTitle, item.title),
        fileBasename: base || null,
        normalizedFile: base ? normalizeString(base) : null,
      });
    }
  }
  return { matched: false, scanSize, samples };
}

async function trackExists(_track) {
  const title = String(_track?.title || '').trim();
  const artist = String(_track?.artist || '').trim();
  const { plexUrl, plexToken } = runtimeConfig.getPlexUrlAndToken();

  if (!title || !artist || !plexUrl || !plexToken) {
    return false;
  }

  const sectionId = encodeURIComponent(getPlexMusicSectionId());
  const targetArtistNorm = normalizeString(artist);

  try {
    const artistsUrl =
      `${plexUrl}/library/sections/${sectionId}/all?type=8&title=` + encodeURIComponent(artist);
    const artistsData = await fetchJson(artistsUrl, plexToken);
    const artists = Array.isArray(artistsData?.MediaContainer?.Metadata)
      ? artistsData.MediaContainer.Metadata
      : [];

    const matchedArtist = artists.find((item) => {
      if (item?.type !== 'artist') {
        return false;
      }
      const na = normalizeString(item?.title);
      if (!na || !targetArtistNorm) {
        return false;
      }
      return na.includes(targetArtistNorm) || targetArtistNorm.includes(na);
    });

    if (matchedArtist?.ratingKey) {
      const tracksUrl = `${plexUrl}/library/metadata/${matchedArtist.ratingKey}/allLeaves`;
      const data = await fetchJson(tracksUrl, plexToken);
      const metadata = Array.isArray(data?.MediaContainer?.Metadata)
        ? data.MediaContainer.Metadata
        : [];

      const samples = [];
      for (const item of metadata) {
        if (item?.type !== 'track') {
          continue;
        }
        const { matched } = matchTrackAgainstExpected(artist, title, item);
        if (matched) {
          return true;
        }
        if (samples.length < 5) {
          const base = getTrackFileBasename(item);
          samples.push({
            grandparentTitle: item.grandparentTitle,
            title: item.title,
            originalTitle: item.originalTitle,
            normalizedCombined: combinedNormalized(item.grandparentTitle, item.title),
            fileBasename: base || null,
            normalizedFile: base ? normalizeString(base) : null,
          });
        }
      }

      const sectionScan = await scanSectionTracksPage(
        plexUrl,
        sectionId,
        plexToken,
        artist,
        title,
      );
      if (sectionScan.matched) {
        return true;
      }

      logNoMatch({
        phase: 'artist_leaves_then_section_scan',
        expectedArtist: artist,
        expectedTitle: title,
        detail: {
          matchedArtistTitle: matchedArtist.title,
          sampleLeavesChecked: samples,
          scanSize: sectionScan.scanSize,
          sampleSectionScan: sectionScan.samples,
        },
      });
      return false;
    }

    const sectionScan = await scanSectionTracksPage(
      plexUrl,
      sectionId,
      plexToken,
      artist,
      title,
    );
    if (sectionScan.matched) {
      return true;
    }

    logNoMatch({
      phase: 'artist_lookup_then_section_scan',
      expectedArtist: artist,
      expectedTitle: title,
      detail: {
        artistsReturned: artists.length,
        sampleArtists: artists.slice(0, 8).map((a) => ({
          title: a.title,
          normalized: normalizeString(a.title),
        })),
        scanSize: sectionScan.scanSize,
        sampleSectionScan: sectionScan.samples,
      },
    });
    return false;
  } catch (error) {
    console.error('Plex trackExists failed:', error.message);
    return false;
  }
}

/**
 * Plex metadata match OR file already present under LIBRARY_PATH (TrackFlow naming).
 */
async function trackExistsOrInLibrary(track) {
  if (await trackExists(track)) {
    return true;
  }
  return libraryFileExistsForTrack(track?.artist, track?.title, {
    album: track?.album,
    year: track?.year ?? track?.release_year,
    track_number: track?.track_number ?? track?.track_no,
  });
}

/** Deezer id from Plex guid only when "deezer" appears; otherwise null (caller reads TRACKFLOW_ID from file). */
function extractTrackflowIdFromPlexItem(item) {
  const guid = String(item?.guid || '');
  const m = guid.match(/deezer[^0-9]*(\d+)/i);
  return m ? m[1] : null;
}

function getPlexTrackPartFilePath(item) {
  const file = item?.Media?.[0]?.Part?.[0]?.file;
  return typeof file === 'string' && file.trim() ? file.trim() : null;
}

/**
 * Plex reports paths as seen by the PMS host. Try that path as-is, then paths under
 * LIBRARY_PATH built from matching trailing segments (same folder layout, different mount root).
 * @param {string} plexFileStr
 * @param {string} libraryRoot — resolved music library root on this machine
 * @returns {string|null} absolute path to an existing file
 */
function resolveLocalAudioPathFromPlexPartFile(plexFileStr, libraryRoot) {
  const s = String(plexFileStr || '').trim();
  if (!s) {
    return null;
  }
  const tryFile = (absCandidate) => {
    try {
      const r = path.resolve(absCandidate);
      if (fs.existsSync(r) && fs.statSync(r).isFile()) {
        return r;
      }
    } catch {
      /* missing or unreadable */
    }
    return null;
  };

  const direct = tryFile(s);
  if (direct) {
    return direct;
  }

  const root = libraryRoot != null ? String(libraryRoot).trim() : '';
  if (!root) {
    return null;
  }
  const rootRes = path.resolve(root);
  const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let len = parts.length; len >= 1; len -= 1) {
    const tail = parts.slice(-len).join(path.sep);
    const candidate = path.join(rootRes, tail);
    const ok = tryFile(candidate);
    if (ok) {
      return ok;
    }
  }
  return null;
}

/**
 * When Plex `guid` has no Deezer id, read embedded TRACKFLOW_ID from the library file (mutagen).
 * @param {object} item — Plex track Metadata
 * @param {string|null|undefined} libraryRoot — from settings / LIBRARY_PATH
 * @returns {string|null} numeric Deezer id
 */
function tryReadTrackflowIdFromPlexMediaFile(item, libraryRoot) {
  const partPath = getPlexTrackPartFilePath(item);
  if (!partPath || !String(libraryRoot || '').trim()) {
    return null;
  }
  const localPath = resolveLocalAudioPathFromPlexPartFile(partPath, libraryRoot);
  if (!localPath) {
    return null;
  }
  const { readTagsForFileSync } = require('./mutagenTags');
  const tags = readTagsForFileSync(localPath);
  if (!tags || tags.ok !== true) {
    return null;
  }
  const raw = tags.trackflow_id;
  if (raw == null) {
    return null;
  }
  const id = String(raw).trim();
  if (!id || !/^\d+$/.test(id)) {
    return null;
  }
  return id;
}

/**
 * Paginated type=10 (track) listing for the configured music section.
 * @returns {Promise<object[]>} Plex Metadata track items
 */
async function fetchAllTracksInMusicSection() {
  const { plexUrl, plexToken } = runtimeConfig.getPlexUrlAndToken();
  if (!plexUrl || !plexToken) {
    return [];
  }
  const base = plexUrl.replace(/\/+$/, '');
  const sectionId = encodeURIComponent(String(getPlexMusicSectionId() || '').trim());
  const pageSize = 200;
  let start = 0;
  const all = [];
  let total = Infinity;
  while (start < total) {
    const url = `${base}/library/sections/${sectionId}/all?type=10&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`;
    const data = await fetchJson(url, plexToken);
    const meta = Array.isArray(data?.MediaContainer?.Metadata) ? data.MediaContainer.Metadata : [];
    total = Number(data?.MediaContainer?.totalSize);
    if (!Number.isFinite(total)) {
      total = start + meta.length;
    }
    for (const m of meta) {
      if (m?.type === 'track') {
        all.push(m);
      }
    }
    if (meta.length < pageSize) {
      break;
    }
    start += pageSize;
  }
  return all;
}

module.exports = {
  searchPlex,
  trackExists,
  trackExistsOrInLibrary,
  getPlexMusicSectionId,
  normalizeString,
  combinedNormalized,
  partialCombinedMatch,
  fetchAllTracksInMusicSection,
  extractTrackflowIdFromPlexItem,
  tryReadTrackflowIdFromPlexMediaFile,
  resolveLocalAudioPathFromPlexPartFile,
  testPlexSettingsConnection,
  assertConfiguredMusicSectionValid,
  triggerPlexLibrarySectionRefresh,
};
