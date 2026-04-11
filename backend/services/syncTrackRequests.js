// Create pending track requests from raw Deezer track payloads; optional auto-approve.

const { getDb } = require('../db');
const { approveRequestById } = require('./requestApproval');
const { isTrackAlreadyInLibraryOrPlex } = require('./libraryAvailability');
const { normMeta } = require('./tracksDb');
const { yieldToEventLoop } = require('./cooperativeYield');

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

const OUTER_CHUNK = 80;
const INNER_YIELD_EVERY = 40;

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
  const existingDeezerIds = new Set(
    db
      .prepare(`SELECT deezer_id FROM requests WHERE deezer_id IS NOT NULL`)
      .all()
      .map((r) => (r.deezer_id != null ? String(r.deezer_id).trim() : ''))
      .filter(Boolean),
  );

  /** @type {Array<{ deezerId: string|null, title: string, artist: string, durationSeconds: number|null }>} */
  const seenThisBatch = [];
  let newly_requested = 0;
  let skipped_existing = 0;
  let skipped_in_library = 0;

  const auto = syncAutoApprove || globalAutoApprove;

  for (let outer = 0; outer < safeTracks.length; outer += OUTER_CHUNK) {
    const slice = safeTracks.slice(outer, outer + OUTER_CHUNK);
    /** @type {Array<{ payload: object, candidate: object }>} */
    const pendingRows = [];
    let innerI = 0;
    for (const track of slice) {
      innerI += 1;
      if (innerI % INNER_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }

      const { deezerId, title, artist, album, durationSeconds } = normalizeRawTrack(track);
      if (!deezerId || !title || !artist) {
        continue;
      }

      if (existingDeezerIds.has(deezerId)) {
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

      pendingRows.push({
        payload: {
          deezer_id: deezerId,
          title,
          artist,
          album,
          user_id: userId,
          duration_seconds: durationSeconds,
          request_type: requestType,
        },
        candidate,
      });
    }

    if (pendingRows.length === 0) {
      await yieldToEventLoop();
      continue;
    }

    const insertBatch = db.transaction((payloads) => {
      /** @type {number[]} */
      const ids = [];
      for (const payload of payloads) {
        const insertResult = insertRequestStmt.run(payload);
        ids.push(Number(insertResult.lastInsertRowid));
      }
      return ids;
    });

    const ids = insertBatch(pendingRows.map((r) => r.payload));
    newly_requested += ids.length;

    for (let j = 0; j < pendingRows.length; j += 1) {
      const { candidate, payload } = pendingRows[j];
      const id = ids[j];
      existingDeezerIds.add(payload.deezer_id);
      existingComparable.push({
        deezer_id: payload.deezer_id,
        title: payload.title,
        artist: payload.artist,
        duration_seconds: payload.duration_seconds,
        status: 'pending',
        cancelled: 0,
      });
      seenThisBatch.push(candidate);
      if (auto) {
        await approveRequestById(id);
        await yieldToEventLoop();
      }
    }

    await yieldToEventLoop();
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
