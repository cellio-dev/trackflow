/**
 * Availability settings + DB-backed track presence (tracks table only; no live FS/Plex here).
 */

const { getDb } = require('../db');
const {
  fileExistsInLibraryForRequestSync,
  batchDiscoverFromDb,
  enrichRequestRowFromTracksSync,
  trackBlocksNewRequest,
  findPresentTrackForProbe,
} = require('./tracksDb');

const getAvailSettingsStmt = getDb().prepare(`
  SELECT plex_integration_enabled, require_plex_for_available
  FROM settings
  WHERE id = 1
`);

function getAvailabilitySettingsSync() {
  try {
    const row = getAvailSettingsStmt.get();
    const plexOn = Number(row?.plex_integration_enabled) === 1;
    return {
      plex_integration_enabled: plexOn,
      require_plex_for_available: Number(row?.require_plex_for_available) === 1,
    };
  } catch {
    return {
      plex_integration_enabled: false,
      require_plex_for_available: false,
    };
  }
}

/** No-op: library state is driven by scan jobs + download upsert. */
function invalidateLibraryAvailabilityCache() {}

async function fileExistsInLibraryForRequest(row) {
  return fileExistsInLibraryForRequestSync(row);
}

async function discoverTrackInLibrary(track) {
  const r = findPresentTrackForProbe({
    deezer_id: track.id != null ? String(track.id) : null,
    artist: track.artist,
    title: track.title,
    duration_seconds:
      track.duration != null && Number.isFinite(Number(track.duration))
        ? Math.round(Number(track.duration))
        : null,
  });
  return r != null && Number(r.db_exists) === 1;
}

async function batchDiscoverFilesInLibrary(tracks) {
  return batchDiscoverFromDb(tracks);
}

async function enrichRequestRowsForApi(rows) {
  const { enrichRequestRow } = require('./requestDisplayStatus');
  const { usernamesByIds, usernameForId } = require('./userDisplay');
  const enriched = await Promise.all(
    rows.map((r) => enrichRequestRow(enrichRequestRowFromTracksSync(r))),
  );
  const nameMap = usernamesByIds(enriched.map((r) => r.user_id));
  return enriched.map((r) => ({
    ...r,
    requested_by_username: usernameForId(nameMap, r.user_id),
  }));
}

async function enrichRequestRowWithLibraryMatch(row) {
  return enrichRequestRowFromTracksSync(row);
}

/**
 * Legacy name: values come from tracks DB via enrich (library_file_match).
 * No live filesystem fallback.
 */
function resolveFileMatchForDisplaySync(row) {
  if (row.library_file_match === true || row.library_file_match === false) {
    return row.library_file_match;
  }
  return false;
}

function isFileLibraryAvailableForDisplay(row) {
  return resolveFileMatchForDisplaySync(row);
}

function isUserFacingLibraryAvailable(row) {
  const s = getAvailabilitySettingsSync();
  const file =
    row.library_file_match === true || row.library_file_match === false
      ? row.library_file_match
      : resolveFileMatchForDisplaySync(row);
  const plex =
    row.library_plex_available === true || row.library_plex_available === false
      ? row.library_plex_available
      : String(row.plex_status || '') === 'found';
  if (!isPlexAvailabilityActive(s)) {
    return Boolean(file);
  }
  if (s.require_plex_for_available) {
    return Boolean(plex);
  }
  return Boolean(file || plex);
}

/** When false, `plex_available` / request `plex_status` must not affect availability. */
function isPlexAvailabilityActive(settings) {
  const s = settings || getAvailabilitySettingsSync();
  return Boolean(s.plex_integration_enabled);
}

function isSearchTrackConsideredInLibrary(fileMatch, plexMatch, settings) {
  const s = settings || getAvailabilitySettingsSync();
  if (!isPlexAvailabilityActive(s)) {
    return Boolean(fileMatch);
  }
  if (s.require_plex_for_available) {
    return Boolean(plexMatch);
  }
  if (plexMatch) {
    return true;
  }
  return Boolean(fileMatch);
}

/** POST /api/requests duplicate guard (DB-backed only). */
function isTrackAlreadyInLibraryOrPlex(probe) {
  return trackBlocksNewRequest(probe, getAvailabilitySettingsSync());
}

module.exports = {
  getAvailabilitySettingsSync,
  isPlexAvailabilityActive,
  invalidateLibraryAvailabilityCache,
  fileExistsInLibraryForRequest,
  discoverTrackInLibrary,
  batchDiscoverFilesInLibrary,
  enrichRequestRowWithLibraryMatch,
  enrichRequestRowsForApi,
  resolveFileMatchForDisplaySync,
  isFileLibraryAvailableForDisplay,
  isUserFacingLibraryAvailable,
  isSearchTrackConsideredInLibrary,
  trackBlocksNewRequest,
  isTrackAlreadyInLibraryOrPlex,
};
