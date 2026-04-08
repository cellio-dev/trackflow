/**
 * Availability: filesystem / `tracks.db_exists` only (library scan is source of truth).
 */

const { getDb } = require('../db');
const {
  fileExistsInLibraryForRequestSync,
  enrichRequestRowFromTracksSync,
  trackBlocksNewRequest,
  findPresentTrackForProbe,
} = require('./tracksDb');

const getAvailSettingsStmt = getDb().prepare(`
  SELECT plex_integration_enabled FROM settings WHERE id = 1
`);

function getAvailabilitySettingsSync() {
  try {
    const row = getAvailSettingsStmt.get();
    return {
      plex_integration_enabled: Number(row?.plex_integration_enabled) === 1,
    };
  } catch {
    return { plex_integration_enabled: false };
  }
}

/** No-op: kept for API compatibility with older callers. */
function invalidateLibraryAvailabilityCache() {}

async function fileExistsInLibraryForRequest(row) {
  return fileExistsInLibraryForRequestSync(row);
}

async function discoverTrackInLibrary(track) {
  return fileExistsInLibraryForRequestSync(
    {
      deezer_id: track.id != null ? String(track.id) : null,
      artist: track.artist,
      title: track.title,
      duration_seconds:
        track.duration != null && Number.isFinite(Number(track.duration))
          ? Math.round(Number(track.duration))
          : null,
    },
    null,
  );
}

async function batchDiscoverFilesInLibrary(tracks) {
  const { batchDiscoverFromDb } = require('./tracksDb');
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

function resolveFileMatchForDisplaySync(row) {
  if (row.library_file_match === true || row.library_file_match === false) {
    return row.library_file_match;
  }
  return false;
}

function isFileLibraryAvailableForDisplay(row) {
  return resolveFileMatchForDisplaySync(row);
}

/** User-facing “in library” for cards and request rows. */
function isUserFacingLibraryAvailable(row) {
  const file =
    row.library_file_match === true || row.library_file_match === false
      ? row.library_file_match
      : resolveFileMatchForDisplaySync(row);
  return Boolean(file);
}

function isSearchTrackConsideredInLibrary(fileMatch) {
  return Boolean(fileMatch);
}

/** POST /api/requests duplicate guard (DB-backed file rows only). */
function isTrackAlreadyInLibraryOrPlex(probe) {
  return trackBlocksNewRequest(probe);
}

function isPlexAvailabilityActive() {
  return false;
}

module.exports = {
  invalidateLibraryAvailabilityCache,
  fileExistsInLibraryForRequest,
  discoverTrackInLibrary,
  batchDiscoverFilesInLibrary,
  enrichRequestRowsForApi,
  enrichRequestRowWithLibraryMatch,
  isFileLibraryAvailableForDisplay,
  isUserFacingLibraryAvailable,
  getAvailabilitySettingsSync,
  isSearchTrackConsideredInLibrary,
  isTrackAlreadyInLibraryOrPlex,
  isPlexAvailabilityActive,
  findPresentTrackForProbe,
};
