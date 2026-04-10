// Create pending track requests from raw Deezer track payloads; optional auto-approve.

const { getDb } = require('../db');
const { approveRequestById } = require('./requestApproval');
const { isTrackAlreadyInLibraryOrPlex } = require('./libraryAvailability');
const { normMeta } = require('./tracksDb');

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

function durationsClose(a, b, tol = 2) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  return Math.abs(Math.round(x) - Math.round(y)) <= tol;
}

function tracksLikelySameRequest(a, b) {
  const aid = a?.deezerId != null ? String(a.deezerId).trim() : '';
  const bid = b?.deezerId != null ? String(b.deezerId).trim() : '';
  if (aid && bid && aid === bid) {
    return true;
  }

  const aa = normMeta(a?.artist);
  const at = normMeta(a?.title);
  const ba = normMeta(b?.artist);
  const bt = normMeta(b?.title);
  if (!aa || !at || !ba || !bt) {
    return false;
  }

  const artistOk = aa === ba || aa.includes(ba) || ba.includes(aa);
  const titleOk = at === bt || at.includes(bt) || bt.includes(at);
  if (!artistOk || !titleOk) {
    return false;
  }

  const ad = a?.durationSeconds;
  const bd = b?.durationSeconds;
  if (ad == null || bd == null) {
    return true;
  }
  return durationsClose(ad, bd, 2);
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
  const listComparableRequestRowsStmt = db.prepare(`
    SELECT deezer_id, title, artist, duration_seconds, status, cancelled
    FROM requests
    WHERE status IN ('pending', 'requested', 'processing', 'completed', 'available')
       OR (status = 'failed' AND COALESCE(cancelled, 0) = 0)
  `);

  const insertRequestStmt = db.prepare(`
    INSERT INTO requests (deezer_id, title, artist, album, user_id, status, duration_seconds, request_type)
    VALUES (@deezer_id, @title, @artist, @album, @user_id, 'pending', @duration_seconds, @request_type)
  `);

  const safeTracks = Array.isArray(rawTracks) ? rawTracks : [];
  const existingComparable = listComparableRequestRowsStmt.all();
  /** @type {Array<{ deezerId: string|null, title: string, artist: string, durationSeconds: number|null }>} */
  const seenThisBatch = [];
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

    const candidate = { deezerId, title, artist, durationSeconds };
    const hasSimilarExisting = existingComparable.some((row) =>
      tracksLikelySameRequest(candidate, {
        deezerId: row?.deezer_id != null ? String(row.deezer_id).trim() : null,
        title: row?.title,
        artist: row?.artist,
        durationSeconds:
          row?.duration_seconds != null && Number.isFinite(Number(row.duration_seconds))
            ? Math.round(Number(row.duration_seconds))
            : null,
      }),
    );
    if (hasSimilarExisting) {
      skipped_existing += 1;
      continue;
    }

    const hasSimilarInBatch = seenThisBatch.some((prev) => tracksLikelySameRequest(candidate, prev));
    if (hasSimilarInBatch) {
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
    seenThisBatch.push(candidate);
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
