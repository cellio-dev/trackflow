// Auto-acquire tracks from a Deezer playlist into requests (no scheduler yet).

const { getDb } = require('../db');
const { approveRequestById } = require('./requestApproval');
const { isTrackAlreadyInLibraryOrPlex } = require('./libraryAvailability');
const { fetchDeezerJson } = require('./deezer');

const PLAYLIST_ID = '9086228225'; // hardcoded Deezer playlist (e.g. editorial chart)

const db = getDb();

function resolveAutoAcquireUserId() {
  const row = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  return row?.id != null ? String(row.id) : '1';
}

const insertRequestStmt = db.prepare(`
  INSERT INTO requests (deezer_id, title, artist, album, user_id, status, duration_seconds, request_type)
  VALUES (@deezer_id, @title, @artist, @album, @user_id, @status, @duration_seconds, @request_type)
`);

const getRequestByIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, plex_status, processing_phase, created_at, request_type
  FROM requests
  WHERE id = ?
`);

const getRequestByDeezerIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, plex_status, processing_phase, created_at, request_type
  FROM requests
  WHERE deezer_id = ?
`);

const getAutoApproveSettingStmt = db.prepare(`
  SELECT auto_approve
  FROM settings
  WHERE id = 1
`);

/**
 * Fetch playlist tracks from Deezer, insert up to 20 new requests when allowed.
 * @returns {Promise<{ processed: number, added: number, skipped: number, details: Array<{ deezer_id: string, action: string }> }>}
 */
async function runAutoAcquire() {
  const url = `https://api.deezer.com/playlist/${PLAYLIST_ID}`;
  const playlist = await fetchDeezerJson(url);
  const rawTracks = Array.isArray(playlist?.tracks?.data)
    ? playlist.tracks.data
    : [];
  const tracks = rawTracks.slice(0, 20);

  const autoApproveEnabled = Boolean(getAutoApproveSettingStmt.get()?.auto_approve);

  const details = [];
  let added = 0;
  let skipped = 0;

  for (const track of tracks) {
    const deezerId = track?.id != null ? String(track.id) : null;
    const title = String(track?.title || '').trim();
    const artist = String(track?.artist?.name || '').trim();
    const album =
      track?.album?.title != null ? String(track.album.title).trim() : null;

    if (!deezerId || !title || !artist) {
      skipped += 1;
      details.push({ deezer_id: deezerId || 'unknown', action: 'skip_invalid' });
      continue;
    }

    const existing = getRequestByDeezerIdStmt.get(deezerId);
    if (existing) {
      skipped += 1;
      details.push({ deezer_id: deezerId, action: 'skip_already_requested' });
      continue;
    }

    const durationSeconds =
      track?.duration != null && Number.isFinite(Number(track.duration))
        ? Math.round(Number(track.duration))
        : null;

    const probe = {
      deezer_id: deezerId,
      title,
      artist,
      album: album || null,
      duration_seconds: durationSeconds,
    };
    if (isTrackAlreadyInLibraryOrPlex(probe)) {
      skipped += 1;
      details.push({ deezer_id: deezerId, action: 'skip_in_library_or_plex' });
      continue;
    }

    const insertResult = insertRequestStmt.run({
      deezer_id: deezerId,
      title,
      artist,
      album: album || null,
      user_id: resolveAutoAcquireUserId(),
      status: 'pending',
      duration_seconds: durationSeconds,
      request_type: 'Track',
    });

    let created = getRequestByIdStmt.get(insertResult.lastInsertRowid);
    added += 1;
    details.push({ deezer_id: deezerId, action: 'added' });

    if (autoApproveEnabled) {
      await approveRequestById(created.id);
      created = getRequestByIdStmt.get(created.id);
    }
  }

  return {
    processed: tracks.length,
    added,
    skipped,
    details,
  };
}

module.exports = {
  runAutoAcquire,
  PLAYLIST_ID,
};
