/**
 * Plex metadata pass: maps Plex rating keys onto existing file-backed `tracks` rows only.
 * Does not affect availability (filesystem scan is source of truth).
 */

const runtimeConfig = require('../services/runtimeConfig');
const { getLibraryPath } = runtimeConfig;
const {
  assertConfiguredMusicSectionValid,
  fetchAllTracksInMusicSection,
  extractTrackflowIdFromPlexItem,
  getPlexMusicSectionId,
  tryReadTrackflowIdFromPlexMediaFile,
} = require('../services/plex');
const { getAvailabilitySettingsSync } = require('../services/libraryAvailability');
const { getTrackById } = require('../services/deezer');
const { applyPlexRatingKeyFromPlexMetadata } = require('../services/tracksDb');

function plexDurationToSeconds(item) {
  const ms = Number(item?.duration);
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return Math.round(ms / 1000);
}

async function runPlexLibraryScanJob() {
  const s = getAvailabilitySettingsSync();
  if (!s.plex_integration_enabled) {
    return { ok: false, skipped: true };
  }

  const { plexUrl, plexToken } = runtimeConfig.getPlexUrlAndToken();
  if (!plexUrl || !plexToken) {
    throw new Error('Plex URL and token must be configured');
  }
  const base = plexUrl.replace(/\/+$/, '');
  const sectionIdRaw = String(getPlexMusicSectionId() || '').trim();
  await assertConfiguredMusicSectionValid(base, plexToken, sectionIdRaw);

  const libraryRoot = getLibraryPath();
  const tScan = Date.now();
  const items = await fetchAllTracksInMusicSection();
  console.log(
    `[plexLibraryScanJob] loaded ${items.length} Plex track(s) in ${Date.now() - tScan}ms; applying rating keys…`,
  );

  /** One Deezer id → metadata per run (dedupes repeated ids, cuts API volume). */
  const deezerCache = new Map();
  async function enrichFromDeezer(trackflowId) {
    const id = String(trackflowId || '').trim();
    if (!id) {
      return null;
    }
    if (deezerCache.has(id)) {
      return deezerCache.get(id);
    }
    try {
      const dz = await getTrackById(id);
      deezerCache.set(id, dz);
      return dz;
    } catch (e) {
      deezerCache.set(id, null);
      return null;
    }
  }

  let matched = 0;
  const progressEvery = 500;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if ((i + 1) % progressEvery === 0) {
      console.log(
        `[plexLibraryScanJob] progress ${i + 1}/${items.length} tracks processed, ${matched} rating key match(es) so far (${Date.now() - tScan}ms elapsed)`,
      );
    }
    if (i > 0 && i % 250 === 0) {
      await new Promise((r) => setImmediate(r));
    }

    const albumArtistPlex = String(item?.grandparentTitle || '').trim() || null;
    let artist = String(item?.grandparentTitle || item?.originalTitle || '').trim();
    let title = String(item?.title || '').trim();
    let album = item?.parentTitle != null ? String(item.parentTitle).trim() : null;
    if (!title) {
      continue;
    }
    let fromId = extractTrackflowIdFromPlexItem(item);
    if (!fromId) {
      fromId = tryReadTrackflowIdFromPlexMediaFile(item, libraryRoot);
    }
    if (fromId) {
      const dz = await enrichFromDeezer(fromId);
      if (dz) {
        if (dz.artist) {
          artist = String(dz.artist).trim() || artist;
        }
        if (dz.title) {
          title = String(dz.title).trim() || title;
        }
        if (dz.album) {
          album = String(dz.album).trim() || album;
        }
      }
    }
    const meta = {
      trackflow_id: fromId,
      artist: artist || albumArtistPlex || 'Unknown',
      album_artist: albumArtistPlex,
      title,
      album,
      year: item?.year != null ? String(item.year) : null,
      plex_rating_key: item?.ratingKey != null ? String(item.ratingKey) : null,
    };
    const id = applyPlexRatingKeyFromPlexMetadata(meta, plexDurationToSeconds(item));
    if (id != null) {
      matched += 1;
    }
  }

  console.log(
    `[plexLibraryScanJob] finished ${items.length} track(s), ${matched} rating key match(es), deezer cache entries ${deezerCache.size} (${Date.now() - tScan}ms)`,
  );

  return { ok: true, plexTracks: items.length, ratingKeyMatches: matched };
}

module.exports = { runPlexLibraryScanJob };
