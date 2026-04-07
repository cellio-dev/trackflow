/**
 * Attach library / request / Plex display fields to Deezer-shaped track rows (search + discover).
 */

const { getDb } = require('../db');
const { computeDisplayFields } = require('./requestDisplayStatus');
const {
  batchDiscoverFilesInLibrary,
  getAvailabilitySettingsSync,
  isPlexAvailabilityActive,
  isSearchTrackConsideredInLibrary,
} = require('./libraryAvailability');
const { batchPlexFlagsFromDb } = require('./tracksDb');

const db = getDb();

const getRequestByDeezerIdStmt = db.prepare(`
  SELECT id, status, plex_status, processing_phase, cancelled,
         title, artist, album, duration_seconds
  FROM requests
  WHERE deezer_id = ?
  ORDER BY id DESC
  LIMIT 1
`);

/**
 * @param {object[]} trackRows — Deezer-shaped { id, title, artist, duration, ... }
 * @returns {Promise<object[]>}
 */
async function enrichDeezerTrackRows(trackRows) {
  const tracks = Array.isArray(trackRows) ? trackRows : [];
  const settings = getAvailabilitySettingsSync();

  const fileFlags = await batchDiscoverFilesInLibrary(tracks);
  const plexFlags = batchPlexFlagsFromDb(tracks);

  const plexCounts = isPlexAvailabilityActive(settings);

  return tracks.map((track, i) => {
    const existsInMusicLibrary = Boolean(fileFlags[i]);
    const plexFromDb = Boolean(plexFlags[i]);
    const existsInPlex = plexCounts ? plexFromDb : false;
    const isInUserLibrary = isSearchTrackConsideredInLibrary(
      existsInMusicLibrary,
      plexFromDb,
      settings,
    );
    const deezerId = String(track.id);
    const row = getRequestByDeezerIdStmt.get(deezerId);
    const requestStatus = row ? row.status : null;
    const requestId = row ? row.id : null;
    const requestPlexStatus = row ? row.plex_status : null;
    const requestCancelled = row ? Number(row.cancelled) === 1 : false;
    let requestDisplayStatus = null;
    let requestProcessingStatus = null;
    if (row) {
      try {
        const computed = computeDisplayFields({
          ...row,
          library_file_match: existsInMusicLibrary,
          library_plex_available: existsInPlex,
        });
        requestDisplayStatus = computed.displayStatus || null;
        requestProcessingStatus = computed.processingStatus || null;
      } catch (err) {
        console.warn('Track enrich: computeDisplayFields failed for deezer_id', deezerId, err?.message || err);
      }
    }

    return {
      ...track,
      existsInMusicLibrary,
      existsInPlex,
      isInUserLibrary,
      requestStatus,
      requestCancelled,
      requestId,
      requestPlexStatus,
      requestDisplayStatus,
      requestProcessingStatus,
    };
  });
}

module.exports = {
  enrichDeezerTrackRows,
};
