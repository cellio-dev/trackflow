/**
 * Plex Media Server playback history for music (session history API).
 * Used when recommendations are driven by recent Plex plays instead of followed artists.
 */

const runtimeConfig = require('./runtimeConfig');

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_ROWS = 400;

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asMetadataArray(data) {
  const m = data?.MediaContainer?.Metadata;
  if (m == null) {
    return [];
  }
  return Array.isArray(m) ? m : [m];
}

function durationMsFromMeta(meta) {
  const raw =
    meta?.duration ??
    meta?.Duration ??
    meta?.Media?.[0]?.duration ??
    meta?.media?.[0]?.duration;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function viewOffsetMsFromMeta(meta) {
  const raw = meta?.viewOffset ?? meta?.viewoffset;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * When duration and a non-zero viewOffset are present, require at least half the track played
 * (small offsets = skipped). Offset 0 or missing is treated as unknown / full play — keep the row.
 */
function qualifiesByPlayProgress(meta) {
  const totalMs = durationMsFromMeta(meta);
  const playedMs = viewOffsetMsFromMeta(meta);
  if (totalMs == null || totalMs <= 0 || playedMs == null || playedMs === 0) {
    return true;
  }
  return playedMs >= totalMs / 2;
}

function artistTitleFromTrackMeta(meta) {
  const artist = trimText(meta?.grandparentTitle || meta?.parentTitle);
  const title = trimText(meta?.title);
  if (!artist || !title) {
    return null;
  }
  return { artist, title };
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

function parseXmlAttrString(attrStr) {
  const o = {};
  if (typeof attrStr !== 'string') {
    return o;
  }
  const r = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = r.exec(attrStr)) !== null) {
    o[m[1]] = m[2];
  }
  return o;
}

/** Fallback when PMS returns XML instead of JSON for session history. */
function parsePlexSessionHistoryXml(text) {
  const metadata = [];
  const re = /<Track\s+([^>]+)\s*\/?>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    metadata.push(parseXmlAttrString(m[1]));
  }
  return { MediaContainer: { Metadata: metadata } };
}

function parseHistoryResponseBody(text) {
  const t = String(text || '').trim();
  if (!t) {
    return { MediaContainer: { Metadata: [] } };
  }
  if (t.startsWith('{') || t.startsWith('[')) {
    return JSON.parse(t);
  }
  if (t.includes('<Track') || t.includes('<track')) {
    return parsePlexSessionHistoryXml(t);
  }
  throw new Error('Plex history: response was not JSON or Track XML');
}

async function fetchHistoryPageJson(base, userPlexToken, { librarySectionId, start, pageSize }) {
  const qs = new URLSearchParams();
  qs.set('librarySectionID', String(librarySectionId));
  qs.set('sort', 'viewedAt:desc');
  qs.set('X-Plex-Container-Start', String(start));
  qs.set('X-Plex-Container-Size', String(pageSize));
  const tok = encodeURIComponent(userPlexToken);
  const url = `${base}/status/sessions/history/all?${qs.toString()}&X-Plex-Token=${tok}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'X-Plex-Token': userPlexToken,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    throw enrichPlexFetchError(e);
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Plex history failed (${response.status}): ${errText || response.statusText}`);
  }
  const text = await response.text();
  try {
    return parseHistoryResponseBody(text);
  } catch (e) {
    throw new Error(e?.message || 'Plex history: failed to parse response');
  }
}

/**
 * Recent music track plays from PMS, newest first, filtered by music library section and play progress.
 * @param {string} userPlexToken — users.plex_user_token (Plex user auth)
 * @returns {Promise<{ artist: string, title: string, viewedAt: number }[]>}
 */
async function fetchQualifyingPlexMusicPlayRows(userPlexToken) {
  const token = trimText(userPlexToken);
  if (!token) {
    return [];
  }

  const { plexUrl } = runtimeConfig.getPlexUrlAndToken();
  const base = trimText(plexUrl).replace(/\/+$/, '');
  if (!base) {
    throw new Error('Plex URL is not configured');
  }

  const sectionId = trimText(runtimeConfig.getPlexMusicSectionId());
  if (!sectionId) {
    throw new Error('Plex music library section ID is empty');
  }

  const out = [];
  /** One entry per artist (most recent qualifying play), keyed by lowercased artist name. */
  const byArtist = new Map();
  let start = 0;
  const pageSize = DEFAULT_PAGE_SIZE;

  while (start < DEFAULT_MAX_ROWS) {
    const data = await fetchHistoryPageJson(base, token, {
      librarySectionId: sectionId,
      start,
      pageSize,
    });

    const meta = asMetadataArray(data);
    if (meta.length === 0) {
      break;
    }

    for (const row of meta) {
      if (String(row?.type || '').toLowerCase() !== 'track') {
        continue;
      }
      if (String(row?.librarySectionID ?? '') !== String(sectionId)) {
        continue;
      }
      if (!qualifiesByPlayProgress(row)) {
        continue;
      }
      const at = artistTitleFromTrackMeta(row);
      if (!at) {
        continue;
      }
      const viewedAt = Number(row.viewedAt) || 0;
      const aKey = at.artist.toLowerCase();
      const prev = byArtist.get(aKey);
      if (!prev || viewedAt > prev.viewedAt) {
        byArtist.set(aKey, { ...at, viewedAt });
      }
      if (byArtist.size >= DEFAULT_MAX_ROWS) {
        break;
      }
    }

    start += meta.length;
    if (meta.length < pageSize || byArtist.size >= DEFAULT_MAX_ROWS) {
      break;
    }
  }

  out.push(...byArtist.values());
  out.sort((a, b) => b.viewedAt - a.viewedAt);
  return out;
}

module.exports = {
  fetchQualifyingPlexMusicPlayRows,
  qualifiesByPlayProgress,
};
