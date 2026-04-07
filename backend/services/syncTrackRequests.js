// Create pending track requests from raw Deezer track payloads; optional auto-approve.

const { getDb } = require('../db');
const { approveRequestById } = require('./requestApproval');
const { isTrackAlreadyInLibraryOrPlex } = require('./libraryAvailability');

function normalizeRawTrack(track) {
  const deezerId = track?.id != null ? String(track.id) : null;
  const title = String(track?.title || '').trim();
  const artist = String(track?.artist?.name || '').trim();
  const album = track?.album?.title != null ? String(track.album.title).trim() : null;
  const durationSeconds =
    track?.duration != null && Number.isFinite(Number(track.duration))
      ? Math.round(Number(track.duration))
      : null;
  return { deezerId, title, artist, album, durationSeconds };
}

/**
 * @param {object[]} rawTracks — Deezer API track objects
 * @param {{ userId: string, requestType: string, syncAutoApprove?: boolean, globalAutoApprove?: boolean }} options
 */
async function ingestRawDeezerTracks(rawTracks, options) {
  const userId = String(options.userId || '1');
  const requestType = String(options.requestType || 'Track');
  const syncAutoApprove = Boolean(options.syncAutoApprove);
  const globalAutoApprove = Boolean(options.globalAutoApprove);

  const db = getDb();
  const getRequestByDeezerIdStmt = db.prepare(`
    SELECT id
    FROM requests
    WHERE deezer_id = ?
  `);

  const insertRequestStmt = db.prepare(`
    INSERT INTO requests (deezer_id, title, artist, album, user_id, status, duration_seconds, request_type)
    VALUES (@deezer_id, @title, @artist, @album, @user_id, 'pending', @duration_seconds, @request_type)
  `);

  const safeTracks = Array.isArray(rawTracks) ? rawTracks : [];
  let newly_requested = 0;
  let skipped_existing = 0;
  let skipped_in_library = 0;

  const auto = syncAutoApprove || globalAutoApprove;

  for (const track of safeTracks) {
    const { deezerId, title, artist, album, durationSeconds } = normalizeRawTrack(track);
    if (!deezerId || !title || !artist) {
      continue;
    }

    if (getRequestByDeezerIdStmt.get(deezerId)) {
      skipped_existing += 1;
      continue;
    }

    if (
      isTrackAlreadyInLibraryOrPlex({
        deezer_id: deezerId,
        title,
        artist,
        album: album || null,
        duration_seconds: durationSeconds,
      })
    ) {
      skipped_in_library += 1;
      continue;
    }

    const insertResult = insertRequestStmt.run({
      deezer_id: deezerId,
      title,
      artist,
      album,
      user_id: userId,
      duration_seconds: durationSeconds,
      request_type: requestType,
    });

    newly_requested += 1;

    if (auto) {
      await approveRequestById(insertResult.lastInsertRowid);
    }
  }

  return {
    total_tracks: safeTracks.length,
    newly_requested,
    skipped_existing,
    skipped_in_library,
    skipped_in_plex: 0,
  };
}

module.exports = {
  ingestRawDeezerTracks,
  normalizeRawTrack,
};
