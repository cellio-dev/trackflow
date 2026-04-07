/**
 * Scheduled Plex scan: updates `tracks.plex_available`; syncs completed requests' plex_status.
 */

const runtimeConfig = require('../services/runtimeConfig');
const {
  assertConfiguredMusicSectionValid,
  fetchAllTracksInMusicSection,
  extractTrackflowIdFromPlexItem,
  getPlexMusicSectionId,
  tryReadTrackflowIdFromPlexMediaFile,
} = require('../services/plex');
const { getLibraryPath } = require('../services/libraryMove');
const { getAvailabilitySettingsSync } = require('../services/libraryAvailability');
const { getTrackById } = require('../services/deezer');
const {
  clearAllPlexAvailableFlags,
  insertOrUpdateTrackFromPlex,
  syncRequestPlexStatusFromTracks,
} = require('../services/tracksDb');

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

  clearAllPlexAvailableFlags();

  const libraryRoot = getLibraryPath();
  const items = await fetchAllTracksInMusicSection();
  let n = 0;
  for (const item of items) {
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
      try {
        const dz = await getTrackById(fromId);
        if (dz?.artist) {
          artist = String(dz.artist).trim() || artist;
        }
        if (dz?.title) {
          title = String(dz.title).trim() || title;
        }
        if (dz?.album) {
          album = String(dz.album).trim() || album;
        }
      } catch {
        /* Plex tags only */
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
    insertOrUpdateTrackFromPlex(meta, plexDurationToSeconds(item));
    n += 1;
  }

  syncRequestPlexStatusFromTracks();
  return { ok: true, plexTracks: n };
}

module.exports = { runPlexLibraryScanJob };
