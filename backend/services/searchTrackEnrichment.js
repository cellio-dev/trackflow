/**
 * Attach library / request display fields to Deezer-shaped track rows (search + discover).
 */

const { getDb } = require('../db');
const { computeDisplayFields } = require('./requestDisplayStatus');
const { batchDiscoverFilesInLibrary, isSearchTrackConsideredInLibrary } = require('./libraryAvailability');

const db = getDb();

const getRequestByDeezerIdStmt = db.prepare(`
  SELECT id, status, processing_phase, cancelled,
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

  const fileFlags = await batchDiscoverFilesInLibrary(tracks);

  return tracks.map((track, i) => {
    const existsInMusicLibrary = Boolean(fileFlags[i]);
    const isInUserLibrary = isSearchTrackConsideredInLibrary(existsInMusicLibrary);
    const deezerId = String(track.id);
    const row = getRequestByDeezerIdStmt.get(deezerId);
    const requestStatus = row ? row.status : null;
    const requestId = row ? row.id : null;
    const requestCancelled = row ? Number(row.cancelled) === 1 : false;
    let requestDisplayStatus = null;
    let requestProcessingStatus = null;
    if (row) {
      try {
        const computed = computeDisplayFields({
          ...row,
          library_file_match: existsInMusicLibrary,
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
      existsInPlex: false,
      isInUserLibrary,
      requestStatus,
      requestCancelled,
      requestId,
      requestPlexStatus: null,
      requestDisplayStatus,
      requestProcessingStatus,
    };
  });
}

module.exports = {
  enrichDeezerTrackRows,
};
