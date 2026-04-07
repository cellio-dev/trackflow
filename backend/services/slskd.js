const {
  moveCompletedDownloadToLibrary,
  resolveLocalPathAfterDownload,
  tryRemovePartialDownloadAndEmptyParent,
} = require('./libraryMove');
const { getPreferredFormat, getMaxDownloadAttempts } = require('../routes/settings');
const { getDb } = require('../db');
const { setProcessingPhase } = require('./requestDisplayStatus');
const runtimeConfig = require('./runtimeConfig');

const getRequestDownloadAbortStmt = getDb().prepare(`
  SELECT cancelled, status
  FROM requests
  WHERE id = ?
`);

/** Set while a file is expected under SLSKD_LOCAL_DOWNLOAD_PATH (active download / cancel-deferred cleanup). */
const setSlskdExpectedBasenameStmt = getDb().prepare(`
  UPDATE requests
  SET slskd_expected_basename = ?
  WHERE id = ?
`);

const clearSlskdExpectedBasenameStmt = getDb().prepare(`
  UPDATE requests
  SET slskd_expected_basename = NULL
  WHERE id = ?
`);

/**
 * Live check: user cancelled (cancelled=1), row removed, or status is no longer `processing`.
 * Stops download/retry/move so the local queue can advance.
 * @param {object} request — row from DB with numeric id
 * @returns {boolean} true if caller should abort
 */
function abortIfDownloadCancelled(request) {
  const id = request?.id;
  if (id == null) {
    return false;
  }
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid <= 0) {
    return false;
  }
  const row = getRequestDownloadAbortStmt.get(rid);
  if (!row) {
    console.log('Download aborted (request row gone):', rid);
    return true;
  }
  if (Number(row.cancelled) === 1) {
    console.log('Download cancelled, stopping:', rid);
    return true;
  }
  if (String(row.status || '') !== 'processing') {
    console.log('Download aborted (request no longer processing):', rid, row.status);
    return true;
  }
  return false;
}

const SEARCH_POLL_ATTEMPTS = 30;
const SEARCH_POLL_INTERVAL_MS = 2000;
/** slskd can report isComplete before Responses are persisted; brief retries fix empty /responses. */
const SEARCH_RESPONSES_LOAD_ATTEMPTS = 25;
const SEARCH_RESPONSES_LOAD_INTERVAL_MS = 400;
const DOWNLOAD_VERIFY_INTERVAL_MS = 2000;
/** Max time to wait for a download to reach a terminal success/failure state */
const DOWNLOAD_VERIFY_TIMEOUT_MS = 300_000; // 5 minutes

function getConfig() {
  return runtimeConfig.getSlskdConfig();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function slskdFetch(path, options = {}) {
  let baseUrl;
  let apiKey;
  try {
    const cfg = getConfig();
    baseUrl = cfg.baseUrl;
    apiKey = cfg.apiKey;
  } catch (err) {
    throw err;
  }

  if (!apiKey) {
    throw new Error(
      'slskd API key is not configured. Open Settings, enter the Soulseek / slskd API key, and save.',
    );
  }

  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': apiKey,
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    const detail = [code, err?.message].filter(Boolean).join(' ');
    throw new Error(
      `Cannot reach slskd at ${baseUrl} (${detail || 'network error'}). ` +
        'Check that slskd is running, the IP/port are correct, and this machine can reach that host (firewall/VPN).',
    );
  }

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `slskd rejected the API key (${response.status}). Check SLSKD_API_KEY matches slskd config.`,
      );
    }
    throw new Error(`slskd request failed (${response.status}): ${message || response.statusText}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Request with no body and no Content-Type — only X-API-Key (matches slskd-python-api session usage).
 * @param {'DELETE'|'POST'|'GET'} method
 */
async function slskdFetchMinimal(path, method = 'DELETE') {
  let baseUrl;
  let apiKey;
  try {
    const cfg = getConfig();
    baseUrl = cfg.baseUrl;
    apiKey = cfg.apiKey;
  } catch (err) {
    throw err;
  }

  if (!apiKey) {
    throw new Error(
      'slskd API key is not configured. Open Settings, enter the Soulseek / slskd API key, and save.',
    );
  }

  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'follow',
      headers: {
        'X-API-Key': apiKey,
      },
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    const detail = [code, err?.message].filter(Boolean).join(' ');
    throw new Error(
      `Cannot reach slskd at ${baseUrl} (${detail || 'network error'}). ` +
        'Check that slskd is running, the IP/port are correct, and this machine can reach that host (firewall/VPN).',
    );
  }

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `slskd rejected the API key (${response.status}). Check SLSKD_API_KEY matches slskd config.`,
      );
    }
    throw new Error(`slskd request failed (${response.status}): ${message || response.statusText}`);
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function slskdFetchMinimalWithFallback(paths, method = 'DELETE') {
  let lastError = null;
  for (const path of paths) {
    try {
      return await slskdFetchMinimal(path, method);
    } catch (error) {
      lastError = error;
      if (!String(error?.message || '').includes('404')) {
        throw error;
      }
    }
  }
  throw lastError || new Error('slskd request failed');
}

async function slskdFetchWithFallback(paths, options = {}) {
  let lastError = null;
  for (const path of paths) {
    try {
      return await slskdFetch(path, options);
    } catch (error) {
      lastError = error;
      if (!String(error?.message || '').includes('404')) {
        throw error;
      }
    }
  }
  throw lastError || new Error('slskd request failed');
}

/** One-at-a-time search creation + optional stagger — avoids slskd/soulseek overload when many downloads start together. */
let slskdSearchCreateChain = Promise.resolve();

async function postSlskdNewSearch(searchBody) {
  const body = JSON.stringify(searchBody);
  const op = slskdSearchCreateChain.then(async () => {
    const stagger = runtimeConfig.getSlskdSearchCreateStaggerMs();
    if (stagger > 0) {
      await sleep(stagger);
    }
    return slskdFetchWithFallback(['/api/v0/searches', '/searches'], {
      method: 'POST',
      body,
    });
  });
  slskdSearchCreateChain = op.catch(() => {});
  return op;
}

function extractFileSize(entry) {
  const size =
    Number(entry?.size) ||
    Number(entry?.Size) ||
    Number(entry?.fileSize) ||
    Number(entry?.filesize) ||
    Number(entry?.file?.size);
  return Number.isFinite(size) ? size : null;
}

/** Audio duration in whole seconds when present on a search file (not byte size). */
function extractCandidateDurationSeconds(entry) {
  if (entry == null || typeof entry !== 'object') {
    return null;
  }
  const direct =
    Number(entry.duration) ||
    Number(entry.durationSeconds) ||
    Number(entry.lengthSeconds) ||
    Number(entry.Length);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.round(direct);
  }
  const len = Number(entry.length ?? entry.Length);
  if (Number.isFinite(len) && len > 0 && len <= 7200) {
    return Math.round(len);
  }
  if (entry.file && typeof entry.file === 'object' && entry.file !== entry) {
    return extractCandidateDurationSeconds(entry.file);
  }
  return null;
}

function isSearchComplete(searchPayload) {
  if (!searchPayload || typeof searchPayload !== 'object') {
    return false;
  }

  if (searchPayload.isComplete === true || searchPayload.complete === true) {
    return true;
  }

  const status = String(searchPayload.status || searchPayload.state || '').toLowerCase();
  if (['complete', 'completed', 'finished', 'done'].includes(status)) {
    return true;
  }
  // e.g. "Completed, ResponseLimitReached"
  if (/\bcompleted\b/.test(status) && !/\bincomplete\b/.test(status)) {
    return true;
  }

  if (searchPayload.search && typeof searchPayload.search === 'object') {
    return isSearchComplete(searchPayload.search);
  }

  return false;
}

function extractSearchResponseRows(responsesPayload) {
  if (Array.isArray(responsesPayload)) {
    return responsesPayload;
  }
  if (!responsesPayload || typeof responsesPayload !== 'object') {
    return [];
  }
  if (Array.isArray(responsesPayload.responses)) {
    return responsesPayload.responses;
  }
  if (Array.isArray(responsesPayload.Responses)) {
    return responsesPayload.Responses;
  }
  return [];
}

function flattenResponseFiles(responsesPayload) {
  const responses = extractSearchResponseRows(responsesPayload);

  return responses.flatMap((responseItem) => {
    const username =
      responseItem?.username ||
      responseItem?.Username ||
      responseItem?.user ||
      responseItem?.User;
    const files = [
      ...(Array.isArray(responseItem?.files) ? responseItem.files : []),
      ...(Array.isArray(responseItem?.Files) ? responseItem.Files : []),
      ...(Array.isArray(responseItem?.lockedFiles) ? responseItem.lockedFiles : []),
      ...(Array.isArray(responseItem?.LockedFiles) ? responseItem.LockedFiles : []),
    ];
    if (!username || files.length === 0) {
      return [];
    }

    const queueLengthRaw =
      responseItem?.queueLength ?? responseItem?.QueueLength ?? null;

    return files.map((file) => ({
      username: String(username),
      file,
      size: extractFileSize(file),
      candidateDurationSeconds: extractCandidateDurationSeconds(file),
      hasFreeUploadSlot: responseItem?.hasFreeUploadSlot ?? responseItem?.HasFreeUploadSlot,
      queueLength:
        queueLengthRaw != null && Number.isFinite(Number(queueLengthRaw))
          ? Number(queueLengthRaw)
          : null,
    }));
  });
}

function searchSummaryExpectsFiles(searchPayload) {
  if (!searchPayload || typeof searchPayload !== 'object') {
    return false;
  }
  /** Completed searches often report 0 counts briefly while /responses is still filling — keep retrying. */
  if (isSearchComplete(searchPayload)) {
    return true;
  }
  const rc = Number(searchPayload.responseCount ?? searchPayload.ResponseCount) || 0;
  const fc = Number(searchPayload.fileCount ?? searchPayload.FileCount) || 0;
  if (rc > 0 || fc > 0) {
    return true;
  }
  if (searchPayload.search && typeof searchPayload.search === 'object') {
    return searchSummaryExpectsFiles(searchPayload.search);
  }
  return false;
}

/**
 * Fetch search result files; retries while slskd finalizes Responses in the DB.
 * Tries GET .../responses then GET ...?includeResponses=true (slskd API parity with web UI).
 */
async function loadSearchResultFiles(searchId, searchSummary, request) {
  const encodedSearchId = encodeURIComponent(String(searchId));
  const responsePaths = [
    `/api/v0/searches/${encodedSearchId}/responses`,
    `/searches/${encodedSearchId}/responses`,
  ];
  const includePaths = [
    `/api/v0/searches/${encodedSearchId}?includeResponses=true`,
    `/searches/${encodedSearchId}?includeResponses=true`,
  ];

  const expects = searchSummaryExpectsFiles(searchSummary);

  for (let attempt = 0; attempt < SEARCH_RESPONSES_LOAD_ATTEMPTS; attempt += 1) {
    if (request && abortIfDownloadCancelled(request)) {
      return [];
    }

    if (attempt > 0) {
      await sleep(SEARCH_RESPONSES_LOAD_INTERVAL_MS);
    }

    let fromResponses = [];
    try {
      const payload = await slskdFetchWithFallback(responsePaths, { method: 'GET' });
      fromResponses = flattenResponseFiles(payload);
    } catch (err) {
      console.warn('slskd: search /responses fetch failed:', err?.message || err);
    }
    if (fromResponses.length > 0) {
      if (attempt > 0) {
        console.log('slskd: /responses returned files after', attempt, 'retry cycle(s)');
      }
      return fromResponses;
    }

    try {
      const withIncluded = await slskdFetchWithFallback(includePaths, { method: 'GET' });
      const fromIncluded = flattenResponseFiles(withIncluded);
      if (fromIncluded.length > 0) {
        if (attempt > 0) {
          console.log('slskd: includeResponses returned files after', attempt, 'retry cycle(s)');
        }
        return fromIncluded;
      }
    } catch (err) {
      console.warn('slskd: search includeResponses fetch failed:', err?.message || err);
    }

    if (!expects) {
      break;
    }
  }

  return [];
}

function toDownloadFilePath(fileEntry) {
  if (typeof fileEntry === 'string') {
    return fileEntry;
  }
  if (!fileEntry || typeof fileEntry !== 'object') {
    return null;
  }

  const path =
    fileEntry.file ||
    fileEntry.filename ||
    fileEntry.Filename ||
    fileEntry.path ||
    fileEntry.name ||
    fileEntry.filePath ||
    null;
  return path ? String(path) : null;
}

/** Lowercase, remove punctuation, collapse spaces (for scoring / matching). */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Unicode-aware normalize for artist compatibility (substring + token overlap). */
function normalizeForCompatibleArtistMatch(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True if the Soulseek path/file artist string matches the requested artist (substring or ≥60% token overlap).
 */
function isCompatibleArtist(requestArtist, candidateArtist) {
  const r = normalizeForCompatibleArtistMatch(requestArtist);
  const c = normalizeForCompatibleArtistMatch(candidateArtist);
  if (!r) {
    return true;
  }
  if (!c) {
    return false;
  }
  if (c.includes(r) || r.includes(c)) {
    return true;
  }
  const rTokens = r.split(/\s+/).filter(Boolean);
  const cTokens = c.split(/\s+/).filter(Boolean);
  if (rTokens.length === 0) {
    return true;
  }
  const overlap = rTokens.filter((t) => cTokens.includes(t)).length;
  return overlap / rTokens.length >= 0.6;
}

/**
 * Titles that are mostly digits (e.g. "24") or very short / one short word match many unrelated paths.
 * For these we require the request artist to appear in the file basename (see basenameContainsRequestArtist).
 */
function isShortOrGenericTitle(title) {
  const t = normalizeForCompatibleArtistMatch(title);
  if (!t) {
    return false;
  }
  const compact = t.replace(/\s+/g, '');
  if (/^\d+$/.test(compact)) {
    return true;
  }
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1 && t.length <= 4) {
    return true;
  }
  if (t.length <= 2) {
    return true;
  }
  return false;
}

const BASENAME_ARTIST_STOPWORDS = new Set(['the', 'a', 'an', 'dj', 'mc', 'vs', 'feat', 'ft']);

/**
 * Request artist must appear in the leaf filename stem (Unicode-normalized).
 * Uses substring for full artist string, or substantive tokens (length ≥ 3, not a leading article/DJ prefix).
 */
function basenameContainsRequestArtist(requestArtist, rawPath) {
  const stem = basenameFromPath(rawPath).replace(/\.[^.]+$/i, '').trim();
  if (!stem) {
    return false;
  }
  const normBase = normalizeForCompatibleArtistMatch(stem);
  const normArt = normalizeForCompatibleArtistMatch(requestArtist);
  if (!normArt) {
    return true;
  }
  if (normBase.includes(normArt)) {
    return true;
  }
  const artTokens = normArt
    .split(/\s+/)
    .filter((tok) => tok.length >= 3 && !BASENAME_ARTIST_STOPWORDS.has(tok));
  if (artTokens.length === 0) {
    return normBase.includes(normArt);
  }
  return artTokens.every((tok) => normBase.includes(tok));
}

function basenameFromPath(filePath) {
  const s = String(filePath || '');
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}

function extractArtistCandidatesFromPath(rawPath) {
  const s = String(rawPath || '').trim();
  if (!s) {
    return [];
  }
  const seen = new Set();
  const out = [];
  const push = (v) => {
    const t = String(v || '').trim();
    if (!t) {
      return;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) {
      return;
    }
    seen.add(k);
    out.push(t);
  };

  const base = basenameFromPath(s);
  const stem = base.replace(/\.[^.]+$/i, '').trim();
  const dashParts = stem.split(/\s*[-–—_:]\s*/);
  if (dashParts.length >= 2) {
    push(dashParts[0]);
  }
  push(stem);

  const parts = s.split(/[/\\]/).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    push(parts[i]);
  }
  return out;
}

/** True if any path-derived artist string (or full path) is compatible with the request. */
function searchItemHasCompatibleArtist(requestArtist, trackTitle, item) {
  const rawPath = toDownloadFilePath(item.file);
  if (!rawPath) {
    return false;
  }
  const ra = String(requestArtist || '').trim();
  if (!ra) {
    return true;
  }
  if (isShortOrGenericTitle(trackTitle) && !basenameContainsRequestArtist(ra, rawPath)) {
    return false;
  }
  for (const extracted of extractArtistCandidatesFromPath(rawPath)) {
    if (isCompatibleArtist(ra, extracted)) {
      return true;
    }
  }
  const stem = basenameFromPath(rawPath).replace(/\.[^.]+$/i, '').trim();
  if (stem && isCompatibleArtist(ra, stem)) {
    return true;
  }
  return isCompatibleArtist(ra, rawPath);
}

const MB = 1024 * 1024;

/**
 * Advanced score for one search result (full path, format, size, duration, peer hints, penalties).
 * @param {number|null|undefined} expectedDurationSeconds — Deezer track length in seconds (rounded).
 */
function scoreSlskdResult(item, normTitle, normArtist, normAlbum, expectedDurationSeconds) {
  let score = 0;
  const rawPath = toDownloadFilePath(item.file);
  if (!rawPath) {
    return Number.NEGATIVE_INFINITY;
  }

  const fullPath = normalize(rawPath);
  if (normTitle && fullPath.includes(normTitle)) score += 50;
  if (normArtist && fullPath.includes(normArtist)) score += 30;
  if (normAlbum && fullPath.includes(normAlbum)) score += 15;

  const lowerPath = rawPath.toLowerCase();
  const isFlac = lowerPath.endsWith('.flac');
  const isMp3 = lowerPath.endsWith('.mp3');
  if (isFlac) score += 30;
  if (isMp3) score += 20;

  const bytes = item.size;
  if (Number.isFinite(bytes) && bytes > 0) {
    const sizeMb = bytes / MB;
    if (isMp3) {
      if (sizeMb >= 3 && sizeMb <= 12) score += 20;
      else if (sizeMb < 3) score -= 30;
      else if (sizeMb > 20) score -= 10;
    }
    if (isFlac) {
      if (sizeMb >= 15 && sizeMb <= 40) score += 25;
      else if (sizeMb < 10) score -= 30;
      else if (sizeMb > 60) score -= 10;
    }
  }

  if (item.hasFreeUploadSlot === true) score += 20;
  if (item.queueLength === 0) score += 10;
  if (item.hasFreeUploadSlot === false) score -= 50;

  if (fullPath.includes('instrumental')) score -= 50;
  if (fullPath.includes('acoustic')) score -= 30;
  if (fullPath.includes('live')) score -= 30;
  if (fullPath.includes('remix')) score -= 30;
  if (fullPath.includes('karaoke')) score -= 50;

  const base = basenameFromPath(rawPath);
  if (/^\d{1,3}[\s._-]/i.test(base)) score += 5;

  const normBase = normalize(base);
  if (
    normArtist &&
    normTitle &&
    (normBase.includes(`${normArtist} - ${normTitle}`) ||
      normBase.includes(`${normArtist}- ${normTitle}`) ||
      normBase.startsWith(`${normArtist} - `))
  ) {
    score += 10;
  }

  const expected =
    expectedDurationSeconds != null && Number.isFinite(Number(expectedDurationSeconds))
      ? Math.round(Number(expectedDurationSeconds))
      : null;
  const candidate = item.candidateDurationSeconds;
  if (expected != null && candidate != null && Number.isFinite(candidate)) {
    const diff = Math.abs(Math.round(candidate) - expected);
    console.log("Duration diff:", diff);
    if (diff <= 2) score += 40;
    else if (diff <= 5) score += 25;
    else if (diff <= 10) score += 10;
    else if (diff > 15) score -= 30;
  }

  return score;
}

/**
 * Strict extension filter before scoring. prefer_mp3 / prefer_flac: no filtering (scoring only).
 */
function filterSearchResultsByPreferredFormat(allFiles, preferred_format) {
  const pf = String(preferred_format || '');
  if (pf === 'prefer_mp3' || pf === 'prefer_flac') {
    return allFiles;
  }
  if (pf === 'mp3') {
    return allFiles.filter((item) => {
      const p = toDownloadFilePath(item.file);
      return Boolean(p && p.toLowerCase().endsWith('.mp3'));
    });
  }
  if (pf === 'flac') {
    return allFiles.filter((item) => {
      const p = toDownloadFilePath(item.file);
      return Boolean(p && p.toLowerCase().endsWith('.flac'));
    });
  }
  return allFiles;
}

/**
 * Pick best candidate using scored ranking on full paths (inputs are already artist-filtered).
 * @returns {{ chosen: object, pool: object[], results: { item: object, score: number }[] }}
 */
function selectBestFileEntry(allFiles, artist, title, album, expectedDurationSeconds) {
  const normTitle = normalize(title);
  const normArtist = normalize(artist);
  const normAlbum = normalize(album || '');

  const filtered = allFiles.filter((item) => Boolean(toDownloadFilePath(item.file)));

  const results = filtered.map((item) => ({
    item,
    score: scoreSlskdResult(item, normTitle, normArtist, normAlbum, expectedDurationSeconds),
  }));

  results.sort((a, b) => b.score - a.score);

  if (results.length === 0) {
    throw new Error('No slskd results with usable file paths');
  }

  console.log('Top 5 scored:', results.slice(0, 5));

  const chosen = results[0].item;

  return { chosen, pool: filtered, results, resultsSorted: results };
}

/** Remote Soulseek path string from a transfer row (slskd may use string or nested filename). */
function transferRemotePathString(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  const fn =
    entry.filename ??
    entry.Filename ??
    entry.file ??
    entry.remoteFilename ??
    entry?.transfer?.filename ??
    entry?.transfer?.file;
  if (fn == null) {
    return '';
  }
  if (typeof fn === 'string') {
    return fn.trim();
  }
  if (typeof fn === 'object') {
    const s =
      fn.fullName ||
      fn.FullName ||
      fn.name ||
      fn.Name ||
      fn.path ||
      fn.Path ||
      fn.value;
    return typeof s === 'string' ? s.trim() : '';
  }
  return String(fn).trim();
}

/**
 * Collect transfer-like objects from slskd GET /transfers/downloads.
 * Current slskd groups by user: [{ username, directories: [{ files: [...] }] }].
 * Older builds used flatter shapes — we still recurse for those.
 */
function collectTransferCandidates(payload, out = []) {
  if (payload == null) {
    return out;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      collectTransferCandidates(item, out);
    }
    return out;
  }
  if (typeof payload !== 'object') {
    return out;
  }

  const dirs = payload.directories ?? payload.Directories;
  const topUser = payload.username ?? payload.user ?? payload.Username ?? payload.User;
  if (Array.isArray(dirs) && topUser) {
    const un = String(topUser).trim();
    for (const dir of dirs) {
      const files = dir?.files ?? dir?.Files;
      if (!Array.isArray(files)) {
        continue;
      }
      for (const f of files) {
        if (!f || typeof f !== 'object') {
          continue;
        }
        const fp = transferRemotePathString(f);
        if (!fp || !un) {
          continue;
        }
        out.push({
          ...f,
          username: f.username ?? f.user ?? un,
          user: f.user ?? f.username ?? un,
        });
      }
    }
    return out;
  }

  const username = String(
    payload.username || payload.user || payload.Username || payload.User || '',
  ).trim();
  const filePath = transferRemotePathString(payload);

  if (username && filePath) {
    out.push(payload);
  }

  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') {
      collectTransferCandidates(value, out);
    }
  }
  return out;
}

/** Human-readable state from slskd transfer object (may be compound). */
function getTransferStatusString(entry) {
  const parts = [
    entry?.state,
    entry?.status,
    entry?.transfer?.state,
    entry?.transfer?.status,
  ]
    .filter((v) => v != null && String(v).trim() !== '')
    .map((v) => String(v).trim());
  return parts.length ? [...new Set(parts)].join(', ') : '';
}

/**
 * Strict terminal classification — only explicit success proceeds; unknown keeps polling until timeout.
 * @returns {'success'|'failed'|'downloading'|'queued_remotely'|'unknown'}
 */
function classifySlskdDownloadState(stateDisplay) {
  const s = String(stateDisplay || '').trim();
  if (!s) {
    return 'unknown';
  }
  const lower = s.toLowerCase();

  if (
    /\brejected\b/i.test(s) ||
    /\bfailed\b/i.test(s) ||
    /\bfailure\b/i.test(s) ||
    /\baborted\b/i.test(s) ||
    /\bcancel(?:led|ed)?\b/i.test(s) ||
    /\berrored?\b/i.test(s) ||
    /\btimed out\b/i.test(lower) ||
    /\btimeout\b/i.test(lower)
  ) {
    return 'failed';
  }

  if (/\bsucceeded\b/i.test(s) || /\bsuccess\b/i.test(s)) {
    return 'success';
  }
  if (/\bcomplete(?:d)?\b/i.test(s) && !/\bincomplete\b/i.test(lower)) {
    return 'success';
  }

  /** e.g. "Queued, Remotely" — slskd waiting on remote peer (distinct from TrackFlow's download queue) */
  if (/\bqueued\b/i.test(s) && /\bremote/i.test(s)) {
    return 'queued_remotely';
  }

  if (
    /\bdownload/i.test(s) ||
    /\bqueued\b/i.test(s) ||
    /\bqueue\b/i.test(lower) ||
    /\binprogress\b/i.test(lower) ||
    /\bin progress\b/i.test(s) ||
    /\binitializ/i.test(s) ||
    /\bstarted\b/i.test(s) ||
    /\brequest/i.test(lower) ||
    /\bnegotiat/i.test(lower) ||
    /\bpending\b/i.test(s)
  ) {
    return 'downloading';
  }

  return 'unknown';
}

function transferMatchesExpected(entry, expectedUsername, expectedFilePath) {
  const u = String(entry?.username || entry?.user || entry?.transfer?.username || '').trim();
  const f = transferRemotePathString(entry);
  if (!f || !expectedFilePath) {
    return false;
  }

  const userOk =
    !expectedUsername ||
    u.toLowerCase() === String(expectedUsername).trim().toLowerCase();
  if (!userOk) {
    return false;
  }

  const exp = String(expectedFilePath).trim();
  const expBase = basenameFromPath(exp);
  const fLower = f.toLowerCase();
  const expLower = exp.toLowerCase();
  const baseLower = expBase.toLowerCase();

  if (f === exp || fLower === expLower) {
    return true;
  }
  if (fLower.endsWith(expLower) || fLower.endsWith(baseLower)) {
    return true;
  }
  if (fLower.includes(expLower) || expLower.includes(fLower)) {
    return true;
  }
  return normalize(f).includes(normalize(expBase));
}

/**
 * Poll until slskd reports success/failure/timeout.
 * If the request is cancelled (cancelled=1), returns null immediately so the local download queue
 * can continue — slskd may still show the transfer as queued remotely until it times out there.
 * @returns {Promise<object|null>} transfer match on success; null if user cancelled
 */
async function waitForDownloadComplete(expectedUsername, expectedFilePath, _request = null) {
  const logName = basenameFromPath(expectedFilePath) || expectedFilePath;
  const deadline = Date.now() + DOWNLOAD_VERIFY_TIMEOUT_MS;

  let attempt = 0;
  do {
    if (_request && abortIfDownloadCancelled(_request)) {
      console.log(
        'slskd: waitForDownloadComplete stopped (cancelled); next queued download can start:',
        logName,
      );
      return null;
    }

    if (attempt > 0) {
      await sleep(DOWNLOAD_VERIFY_INTERVAL_MS);
    }
    if (_request && abortIfDownloadCancelled(_request)) {
      console.log(
        'slskd: waitForDownloadComplete stopped (cancelled after poll wait); next queued download can start:',
        logName,
      );
      return null;
    }
    attempt += 1;

    const data = await slskdFetchWithFallback(['/api/v0/transfers/downloads', '/transfers/downloads'], {
      method: 'GET',
    });

    const candidates = collectTransferCandidates(data, []);
    const match = candidates.find((c) => transferMatchesExpected(c, expectedUsername, expectedFilePath));

    if (match) {
      const state = getTransferStatusString(match);
      console.log('Download status:', state);
      const kind = classifySlskdDownloadState(state);
      if (kind === 'success') {
        console.log('Download complete:', logName);
        return match;
      }
      if (kind === 'failed') {
        throw new Error(`slskd download failed (state: ${state || 'unknown'})`);
      }
      if (_request?.id) {
        if (kind === 'queued_remotely') {
          setProcessingPhase(_request.id, 'queued_remotely');
        } else if (kind === 'downloading') {
          setProcessingPhase(_request.id, 'downloading');
        }
      }
      // downloading | queued_remotely | unknown — keep polling until success, failure, or timeout
    }

    if (_request && abortIfDownloadCancelled(_request)) {
      console.log(
        'slskd: waitForDownloadComplete stopped (cancelled); next queued download can start:',
        logName,
      );
      return null;
    }
  } while (Date.now() < deadline);

  throw new Error('slskd download did not complete within timeout');
}

/**
 * Bulk-remove completed downloads from slskd (non-blocking; never throws).
 * Same as slskd-python-api TransfersApi.remove_completed_downloads():
 * DELETE /transfers/downloads/all/completed
 * @see https://github.com/bigoulours/slskd-python-api/blob/main/slskd_api/apis/transfers.py
 */
async function clearCompletedDownloadsBulk() {
  try {
    await slskdFetchMinimalWithFallback(
      [
        '/api/v0/transfers/downloads/all/completed',
        '/transfers/downloads/all/completed',
      ],
      'DELETE',
    );
    console.log('Cleared completed downloads');
  } catch (err) {
    console.warn('slskd: bulk clear completed downloads failed (ignored):', err?.message);
  }
}

/** After user cancel: delete file in completed-downloads area, then clear slskd completed list (same order as success path). */
async function discardCompletedLocalFileAndClearSlskd(localPath) {
  if (localPath) {
    tryRemovePartialDownloadAndEmptyParent(localPath);
  }
  if (getConfig().autoClearCompletedDownloads) {
    await clearCompletedDownloadsBulk();
  }
}

/**
 * DELETE /api/v0/searches/{searchId} (with legacy path fallback). Never throws.
 */
async function clearSlskdSearchQuiet(searchId) {
  const encodedSearchId = encodeURIComponent(String(searchId));
  try {
    await slskdFetchMinimalWithFallback(
      [`/api/v0/searches/${encodedSearchId}`, `/searches/${encodedSearchId}`],
      'DELETE',
    );
    console.log('Cleared slskd search:', searchId);
  } catch (err) {
    console.error('slskd: failed to clear search (ignored):', searchId, err?.message || err);
  }
}

/**
 * Enqueue one slskd download, wait for completion, resolve local path, move to library.
 * Each slskd search round clears its own search id in runSlskdSearchRound.
 * @returns {Promise<object|null>} payload or null if cancelled
 */
/** Remove (feat.…), (featuring…), (with…) before stripping other brackets. */
function stripSlskdFeatParentheticals(s) {
  let x = String(s || '');
  const patterns = [
    /\(\s*feat\.[^)]*\)/gi,
    /\(\s*featuring[^)]*\)/gi,
    /\(\s*with[^)]*\)/gi,
  ];
  for (const re of patterns) {
    x = x.replace(re, ' ');
  }
  return x;
}

/** Remove all (…) and […]; repeat for edge cases. */
function stripSlskdParenthesesAndBrackets(s) {
  let x = String(s || '');
  let prev;
  do {
    prev = x;
    x = x.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  } while (x !== prev);
  return x;
}

/**
 * Lowercase, strip punctuation (Unicode letters/numbers kept), collapse spaces.
 */
function normalizeForSlskdFallbackQuery(s) {
  let x = String(s || '').trim().toLowerCase();
  x = x.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  return x.replace(/\s+/g, ' ').trim();
}

function stripAndNormalizeSlskdSearchText(s) {
  let x = String(s || '').trim();
  x = stripSlskdFeatParentheticals(x);
  x = stripSlskdParenthesesAndBrackets(x);
  return normalizeForSlskdFallbackQuery(x);
}

/** Up to 3 leading words from cleaned title (1–3 words depending on length). */
function titleLeadingWordsForSlskdFallback(cleanedTitle) {
  const words = String(cleanedTitle || '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return '';
  }
  const n = Math.min(3, words.length);
  return words.slice(0, n).join(' ');
}

/**
 * Ordered slskd search attempts: original → cleaned → title only → artist + partial title.
 * Dedupes case/space-insensitively so we do not repeat identical queries.
 * @returns {{ label: string, query: string }[]}
 */
function buildSlskdSearchFallbackPlan(artist, title) {
  const a = String(artist || '').trim();
  const t = String(title || '').trim();
  const original = `${a} ${t}`.trim();
  const cleanedFull = stripAndNormalizeSlskdSearchText(`${a} ${t}`);
  const cleanedTitle = stripAndNormalizeSlskdSearchText(t);
  const cleanedArtist = stripAndNormalizeSlskdSearchText(a);
  const partial = titleLeadingWordsForSlskdFallback(cleanedTitle);
  const artistPartial =
    cleanedArtist && partial ? `${cleanedArtist} ${partial}`.trim() : '';

  const rawSteps = [
    { label: 'original', query: original },
    { label: 'cleaned_metadata', query: cleanedFull },
    { label: 'title_only', query: cleanedTitle },
    { label: 'artist_partial_title', query: artistPartial },
  ];

  const seen = new Set();
  const out = [];
  for (const step of rawSteps) {
    const q = typeof step.query === 'string' ? step.query.trim() : '';
    if (!q) {
      continue;
    }
    const dedupeKey = q.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    out.push({ label: step.label, query: q });
  }
  return out;
}

/**
 * One slskd search lifecycle: create → poll until complete → load files → DELETE search.
 * @returns {Promise<{ files: object[], cancelled?: boolean }>}
 */
async function runSlskdSearchRound(request, query) {
  let searchId = null;
  try {
    if (abortIfDownloadCancelled(request)) {
      return { cancelled: true, files: [] };
    }

    console.log('Searching slskd:', query);

    const createdSearch = await postSlskdNewSearch({
      searchText: query,
      fileType: 'audio',
      query,
    });

    searchId =
      createdSearch?.id ||
      createdSearch?.searchId ||
      createdSearch?.search?.id;
    if (!searchId) {
      throw new Error('slskd search id missing from create response');
    }

    if (abortIfDownloadCancelled(request)) {
      return { cancelled: true, files: [] };
    }

    let completed = false;
    let lastSearchData = null;
    for (let i = 0; i < SEARCH_POLL_ATTEMPTS; i += 1) {
      if (abortIfDownloadCancelled(request)) {
        return { cancelled: true, files: [] };
      }
      console.log('Polling attempt:', i + 1);
      await sleep(SEARCH_POLL_INTERVAL_MS);

      const encodedSearchId = encodeURIComponent(String(searchId));
      const searchData = await slskdFetchWithFallback(
        [`/api/v0/searches/${encodedSearchId}`, `/searches/${encodedSearchId}`],
        { method: 'GET' },
      );
      lastSearchData = searchData;
      console.log('SLSKD SEARCH RESPONSE:', JSON.stringify(searchData, null, 2));
      if (isSearchComplete(searchData)) {
        completed = true;
        break;
      }
    }

    if (!completed) {
      throw new Error('No slskd results after waiting');
    }

    if (abortIfDownloadCancelled(request)) {
      return { cancelled: true, files: [] };
    }

    const allFiles = await loadSearchResultFiles(searchId, lastSearchData, request);
    if (abortIfDownloadCancelled(request)) {
      return { cancelled: true, files: [] };
    }
    console.log('Total files found:', allFiles.length);
    return { files: allFiles };
  } finally {
    if (searchId != null && String(searchId).length > 0) {
      await clearSlskdSearchQuiet(searchId);
    }
  }
}

async function downloadSingleCandidate(firstResult, artist, title, request) {
  if (abortIfDownloadCancelled(request)) {
    return null;
  }

  const downloadFile = toDownloadFilePath(firstResult.file);
  if (!downloadFile) {
    throw new Error('slskd result is missing downloadable file path');
  }

  const encodedUsername = encodeURIComponent(String(firstResult.username));
  const fileSize = Number(firstResult.size);
  const downloadItems = [
    {
      filename: downloadFile,
      ...(Number.isFinite(fileSize) && fileSize > 0 ? { size: Math.floor(fileSize) } : {}),
    },
  ];

  if (abortIfDownloadCancelled(request)) {
    return null;
  }

  try {
    await slskdFetchWithFallback(
      [
        `/api/v0/transfers/downloads/${encodedUsername}`,
        `/transfers/downloads/${encodedUsername}`,
      ],
      {
        method: 'POST',
        body: JSON.stringify(downloadItems),
      },
    );
  } catch (error) {
    const message = String(error?.message || '');
    if (!message.includes('405') && !message.includes('404')) {
      throw error;
    }

    await slskdFetch('/api/v0/transfers/downloads', {
      method: 'POST',
      body: JSON.stringify({
        username: firstResult.username,
        file: downloadFile,
      }),
    });
  }

  setProcessingPhase(request?.id, 'downloading');

  const rid = Number(request?.id);
  const expectedBasename = basenameFromPath(downloadFile);
  if (Number.isInteger(rid) && rid > 0 && expectedBasename) {
    setSlskdExpectedBasenameStmt.run(expectedBasename, rid);
  }

  try {
    const completedMatch = await waitForDownloadComplete(
      firstResult.username,
      downloadFile,
      request,
    );
    if (!completedMatch) {
      return null;
    }

    let localPath;
    try {
      localPath = resolveLocalPathAfterDownload(completedMatch, downloadFile, artist, title);
    } catch (err) {
      if (abortIfDownloadCancelled(request)) {
        console.warn('slskd: cancel after complete but could not resolve local path:', err?.message);
        await discardCompletedLocalFileAndClearSlskd(null);
        return { cancelledAfterComplete: true };
      }
      throw err;
    }

    if (abortIfDownloadCancelled(request)) {
      console.log(
        'slskd: request cancelled after download finished — discarding completed file (no library move)',
      );
      await discardCompletedLocalFileAndClearSlskd(localPath);
      return { cancelledAfterComplete: true };
    }

    const newPath = await moveCompletedDownloadToLibrary(localPath, artist, title, {
      deezer_id: request?.deezer_id,
      album: request?.album,
      duration_seconds: request?.duration_seconds,
      year: request?.year ?? request?.release_year,
      track_number: request?.track_number ?? request?.track_no,
    });
    console.log('Moved file to library:', newPath);
    setProcessingPhase(request?.id, 'moved');

    return {
      username: firstResult.username,
      file: downloadFile,
      libraryPath: newPath,
    };
  } finally {
    if (Number.isInteger(rid) && rid > 0) {
      clearSlskdExpectedBasenameStmt.run(rid);
    }
  }
}

async function downloadTrack(request) {
  const artist = String(request?.artist || '').trim();
  const title = String(request?.title || '').trim();
  if (!artist || !title) {
    throw new Error('Request artist/title required for slskd search');
  }

  let query = `${artist} ${title}`.trim();

  try {
    if (abortIfDownloadCancelled(request)) {
      return { cancelled: true };
    }

    setProcessingPhase(request?.id, 'searching');

    const fallbackPlan = buildSlskdSearchFallbackPlan(artist, title);
    let allFiles = [];
    const preferred_format = getPreferredFormat();

    for (let si = 0; si < fallbackPlan.length; si += 1) {
      const step = fallbackPlan[si];
      const round = await runSlskdSearchRound(request, step.query);
      if (round.cancelled) {
        return { cancelled: true };
      }
      const files = round.files;
      if (files.length === 0) {
        const hasMore = si < fallbackPlan.length - 1;
        console.log(
          'slskd search zero results: strategy=%s query=%s%s',
          step.label,
          JSON.stringify(step.query),
          hasMore ? ' — trying next fallback' : ' — no more fallbacks',
        );
        continue;
      }

      let filesForScoring = filterSearchResultsByPreferredFormat(files, preferred_format);
      if (
        filesForScoring.length === 0 &&
        (preferred_format === 'mp3' || preferred_format === 'flac')
      ) {
        console.log(
          'slskd: no files matched strict format (%s), using all results for artist filter',
          preferred_format,
        );
        filesForScoring = files;
      }

      const compatible = filesForScoring.filter((item) =>
        searchItemHasCompatibleArtist(artist, title, item),
      );
      if (compatible.length > 0) {
        allFiles = compatible;
        query = step.query;
        console.log(
          'slskd search results: strategy=%s query=%s rawFiles=%s artistCompatible=%s',
          step.label,
          JSON.stringify(step.query),
          String(files.length),
          String(compatible.length),
        );
        break;
      }

      const hasMore = si < fallbackPlan.length - 1;
      console.log(
        'slskd: no artist-compatible candidates for strategy=%s query=%s (raw files=%s)%s',
        step.label,
        JSON.stringify(step.query),
        String(files.length),
        hasMore ? ' — trying next fallback' : ' — no more fallbacks',
      );
    }

    if (allFiles.length === 0) {
      throw new Error('No slskd results found with a compatible artist');
    }

    if (abortIfDownloadCancelled(request)) {
      return { cancelled: true };
    }

    const expectedDurationSeconds =
      request?.duration_seconds != null && Number.isFinite(Number(request.duration_seconds))
        ? Math.round(Number(request.duration_seconds))
        : null;

    console.log('Format filter (settings):', preferred_format, 'scoring candidates:', allFiles.length);

    const { resultsSorted } = selectBestFileEntry(
      allFiles,
      artist,
      title,
      request?.album,
      expectedDurationSeconds,
    );

    const candidates = resultsSorted;
    const triedKeys = new Set();
    const maxAttempts = getMaxDownloadAttempts();
    const MAX_SLOTS = Math.min(maxAttempts, candidates.length);
    let success = false;
    let lastError = null;
    let selectedPayload = null;
    let attemptNumber = 0;

    if (abortIfDownloadCancelled(request)) {
      return { cancelled: true };
    }

    for (let i = 0; i < MAX_SLOTS; i += 1) {
      if (abortIfDownloadCancelled(request)) {
        return { cancelled: true };
      }
      const scoredRow = candidates[i];
      const candidate = scoredRow.item;
      const downloadFile = toDownloadFilePath(candidate.file);
      if (!downloadFile) {
        continue;
      }
      const dedupeKey = `${String(candidate.username).toLowerCase()}\0${downloadFile}`;
      if (triedKeys.has(dedupeKey)) {
        continue;
      }
      triedKeys.add(dedupeKey);
      attemptNumber += 1;

      const tryName = candidate.file?.filename ?? downloadFile;
      console.log('Attempt:', attemptNumber);
      console.log('Trying:', tryName);

      try {
        const payload = await downloadSingleCandidate(candidate, artist, title, request);
        if (payload?.cancelledAfterComplete) {
          return { cancelled: true };
        }
        if (!payload) {
          return { cancelled: true };
        }
        selectedPayload = payload;
        success = true;
        break;
      } catch (err) {
        lastError = err;
        console.error('Download failed:', tryName);
      }
    }

    if (!success) {
      throw lastError || new Error('All slskd download attempts failed');
    }

    if (getConfig().autoClearCompletedDownloads) {
      await clearCompletedDownloadsBulk();
    }

    return {
      success: true,
      query,
      selected: selectedPayload,
    };
  } catch (err) {
    // Propagate to caller (e.g. mark request failed). Each slskd search round clears its own search id.
    throw err;
  }
}

async function getSlskdStatus() {
  try {
    const cfg = getConfig();
    return {
      connected: Boolean(cfg.apiKey),
      baseUrl: cfg.baseUrl,
      autoClearCompletedDownloads: cfg.autoClearCompletedDownloads,
    };
  } catch {
    return {
      connected: false,
      baseUrl: null,
      autoClearCompletedDownloads: true,
    };
  }
}

/**
 * User cancelled in admin: sets cancelled=1 in DB. While polling slskd, `waitForDownloadComplete`
 * exits early so the next TrackFlow-queued download can start. If the file already finished to
 * slskd’s completed area, the worker still discards it and clears completed downloads (no library move).
 * The transfer may remain visible as queued in slskd until slskd drops it.
 */
async function cancelActiveDownloadForRequest(request) {
  console.log(
    'slskd: cancel registered for request',
    request?.id,
    '— worker will stop waiting on this transfer when it sees cancelled=1',
  );
  return { deferred: true };
}

async function testSlskdConnection() {
  await slskdFetchWithFallback(['/api/v0/application', '/application'], { method: 'GET' });
  return { ok: true };
}

module.exports = {
  downloadTrack,
  getSlskdStatus,
  cancelActiveDownloadForRequest,
  testSlskdConnection,
};

