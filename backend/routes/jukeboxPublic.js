const express = require('express');
const fs = require('fs');
const path = require('path');
const deezer = require('../services/deezer');
const { enrichDeezerTrackRows } = require('../services/searchTrackEnrichment');
const jukeSvc = require('../services/jukeboxService');
const { sessionUserIdString, requireJukeboxEnabled, sessionUserHasJukeboxEnabled } = require('../middleware/auth');

const router = express.Router();

/** Host control panel: playback merge order with current track pinned first. */
const HOST_QUEUE_STATE_OPTS = { queuePlaybackMerge: true, queuePinCurrentFirst: true };

function mapJukeboxEnrichedTrack(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist?.name || t.artist,
    album: t.album?.title || t.album,
    duration: t.duration,
    albumCover: t.albumCover,
    isInUserLibrary: Boolean(t.isInUserLibrary),
    existsInMusicLibrary: Boolean(t.existsInMusicLibrary),
    existsInPlex: Boolean(t.existsInPlex),
    requestStatus: t.requestStatus != null ? t.requestStatus : null,
    requestCancelled: Boolean(t.requestCancelled),
    requestDisplayStatus: t.requestDisplayStatus ?? null,
    requestProcessingStatus: t.requestProcessingStatus ?? null,
  };
}

function guestToken(req) {
  return (req.query.token || req.body?.token || '').trim();
}

/** Host control API: signed-in owner (or admin) only; query token is not sufficient. */
function requireJukeboxOwnerForHost(req, res, next) {
  if (!req.session || req.session.userId == null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const jukeboxId = Number(req.params.jukeboxId);
  if (!Number.isFinite(jukeboxId) || jukeboxId < 1) {
    return res.status(400).json({ error: 'Invalid jukebox id' });
  }
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!row) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (String(row.user_id) !== sessionUserIdString(req) && req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req._jukeHostToken = row.host_token;
  next();
}

function requireSession(req, res, next) {
  if (!req.session || req.session.userId == null) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const guestRouter = express.Router({ mergeParams: true });
guestRouter.use(requireSession);
guestRouter.use(requireJukeboxEnabled);
const hostRouter = express.Router({ mergeParams: true });
hostRouter.use(requireJukeboxOwnerForHost);
hostRouter.use(requireJukeboxEnabled);

guestRouter.get('/state', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!jukeSvc.assertGuestToken(row, guestToken(req))) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  const limits = jukeSvc.getJukeboxGuestDisplayLimits(jukeboxId);
  const state = jukeSvc.buildState(jukeboxId, { queueLimit: limits.queue });
  if (!state) {
    return res.status(404).json({ error: 'Not found' });
  }
  const includeDiscovery = String(req.query.discovery || '1') !== '0';
  try {
    await jukeSvc.enrichGuestPlayerCovers(state);
    let play_history = jukeSvc.buildPlayHistoryDisplay(jukeboxId, limits.history);
    play_history = await jukeSvc.enrichDiscoveryRowsAlbumCovers(play_history);
    if (!includeDiscovery) {
      return res.json({ ...state, play_history });
    }
    const excludeLibIds = jukeSvc.collectLibraryIdsForGuestExclude(jukeboxId);
    const discovery = await jukeSvc.buildGuestDiscovery(jukeboxId, excludeLibIds);
    return res.json({
      ...state,
      play_history,
      top_tracks: discovery.top_tracks,
      fresh_tracks: discovery.fresh_tracks,
      recent_mix: discovery.recent_mix,
    });
  } catch (e) {
    console.error('jukebox guest state:', e);
    return res.status(500).json({ error: 'Failed to load state' });
  }
});

guestRouter.post('/queue', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!jukeSvc.assertGuestToken(row, guestToken(req))) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  try {
    const out = await jukeSvc.addGuestTrack(jukeboxId, req.body || {});
    return res.json(out);
  } catch (e) {
    if (e.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Jukebox closed or not found' });
    }
    const m = e?.message || '';
    if (m.includes('required') || m.includes('library') || m.includes('cannot be queued')) {
      return res.status(400).json({ error: m });
    }
    console.error('jukebox guest queue:', e);
    return res.status(500).json({ error: 'Failed to add to queue' });
  }
});

guestRouter.post('/play-next', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!jukeSvc.assertGuestToken(row, guestToken(req))) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  try {
    const out = await jukeSvc.guestPlayNext(jukeboxId, guestToken(req), req.body?.pin, req.body || {});
    return res.json(out);
  } catch (e) {
    if (e.message === 'PIN_REQUIRED') {
      return res.status(401).json({ error: 'PIN required', pinRequired: true });
    }
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    if (e.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Jukebox closed or not found' });
    }
    const m = e?.message || '';
    if (m.includes('required') || m.includes('library') || m.includes('cannot be queued')) {
      return res.status(400).json({ error: m });
    }
    console.error('jukebox play-next:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

guestRouter.post('/action', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!jukeSvc.assertGuestToken(row, guestToken(req))) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  const action = (req.body?.action || '').trim();
  try {
    const out = jukeSvc.guestSkipOrClose(jukeboxId, guestToken(req), req.body?.pin, action);
    return res.json(out);
  } catch (e) {
    if (e.message === 'PIN_REQUIRED') {
      return res.status(401).json({ error: 'PIN required', pinRequired: true });
    }
    return res.status(400).json({ error: e.message || 'Bad request' });
  }
});

guestRouter.post('/report-playback', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.guestReportPlayback(jukeboxId, guestToken(req), req.body || {});
    return res.json({ ok: true });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(400).json({ error: e.message || 'Bad request' });
  }
});

guestRouter.post('/pause', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.guestSetPause(jukeboxId, guestToken(req), req.body || {});
    const lim = jukeSvc.getJukeboxGuestDisplayLimits(jukeboxId).queue;
    const state = jukeSvc.buildState(jukeboxId, { queueLimit: lim });
    await jukeSvc.enrichGuestPlayerCovers(state);
    return res.json({ ok: true, ...state });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(400).json({ error: e.message || 'Bad request' });
  }
});

guestRouter.post('/advance', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!jukeSvc.assertGuestToken(row, guestToken(req))) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  const itemId = Number(req.body?.queue_item_id);
  const cur = jukeSvc.getJukeboxById(jukeboxId);
  const curQ = cur?.current_queue_item_id;
  if (!itemId || curQ == null || Number(curQ) !== itemId) {
    return res.json({ ok: true });
  }
  jukeSvc.recordPlayAndAdvance(jukeboxId, itemId);
  return res.json({ ok: true });
});

guestRouter.post('/verify-pin', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    const out = jukeSvc.verifyPinAction(jukeboxId, guestToken(req), req.body?.pin, 'guest');
    return res.json(out);
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }
});

guestRouter.get('/search', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!jukeSvc.assertGuestToken(row, guestToken(req))) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q required' });
  }
  try {
    const rawTracks = await deezer.searchTracks(q, 28);
    const list = Array.isArray(rawTracks?.results) ? rawTracks.results.slice(0, 28) : [];
    const enriched = await enrichDeezerTrackRows(list);
    const tracks = enriched.map(mapJukeboxEnrichedTrack);
    return res.json({ tracks });
  } catch (e) {
    console.error('jukebox guest search:', e);
    return res.status(500).json({ error: 'Search failed' });
  }
});

guestRouter.get('/browse/album/:albumId/tracks', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!jukeSvc.assertGuestToken(row, guestToken(req))) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  const albumId = String(req.params.albumId || '').trim();
  if (!albumId) {
    return res.status(400).json({ error: 'album id required' });
  }
  try {
    const data = await deezer.getAlbumTracks(albumId);
    const slice = Array.isArray(data.tracks) ? data.tracks.slice(0, 30) : [];
    const enriched = await enrichDeezerTrackRows(slice);
    const tracks = enriched.map(mapJukeboxEnrichedTrack);
    return res.json({
      albumTitle: data.albumTitle,
      artist: data.artist,
      cover: data.cover,
      tracks,
    });
  } catch (e) {
    console.error('jukebox guest album tracks:', e);
    return res.status(500).json({ error: 'Failed to load album' });
  }
});

guestRouter.get('/browse/artist/:artistId/tracks', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!jukeSvc.assertGuestToken(row, guestToken(req))) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  const artistId = String(req.params.artistId || '').trim();
  if (!artistId) {
    return res.status(400).json({ error: 'artist id required' });
  }
  try {
    const raw = await deezer.getArtistTopTracks(artistId);
    const list = Array.isArray(raw?.results) ? raw.results.slice(0, 30) : [];
    const enriched = await enrichDeezerTrackRows(list);
    const tracks = enriched.map(mapJukeboxEnrichedTrack);
    return res.json({ tracks });
  } catch (e) {
    console.error('jukebox guest artist tracks:', e);
    return res.status(500).json({ error: 'Failed to load artist' });
  }
});

hostRouter.get('/state', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  const state = jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS);
  if (!state) {
    return res.status(404).json({ error: 'Not found' });
  }
  await jukeSvc.enrichGuestPlayerCovers(state);
  return res.json(state);
});

hostRouter.post('/skip', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.hostSkip(jukeboxId, req._jukeHostToken);
    return res.json({ ok: true, ...jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS) });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: 'Failed' });
  }
});

hostRouter.post('/pause-volume', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.hostSetPauseVolume(jukeboxId, req._jukeHostToken, req.body || {});
    return res.json({ ok: true, ...jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS) });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: 'Failed' });
  }
});

hostRouter.post('/seek', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.hostSeek(jukeboxId, req._jukeHostToken, req.body || {});
    return res.json({ ok: true, ...jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS) });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    if (e.message === 'Nothing playing' || e.message === 'position_seconds required') {
      return res.status(400).json({ error: e.message });
    }
    return res.status(500).json({ error: 'Failed' });
  }
});

hostRouter.post('/reorder', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.hostReorder(jukeboxId, req._jukeHostToken, req.body?.ordered_ids);
    return res.json({ ok: true, ...jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS) });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(400).json({ error: e.message || 'Bad request' });
  }
});

hostRouter.post('/remove', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.hostRemoveQueueItem(jukeboxId, req._jukeHostToken, Number(req.body?.queue_item_id));
    return res.json({ ok: true, ...jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS) });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(400).json({ error: e.message || 'Bad request' });
  }
});

hostRouter.post('/clear-queue', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.hostClearQueue(jukeboxId, req._jukeHostToken);
    return res.json({ ok: true, ...jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS) });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: 'Failed' });
  }
});

hostRouter.post('/queue', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    const out = await jukeSvc.addGuestTrack(jukeboxId, req.body || {});
    const state = jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS);
    await jukeSvc.enrichGuestPlayerCovers(state);
    return res.json({ ...out, ...state });
  } catch (e) {
    if (e.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Jukebox closed or not found' });
    }
    const m = e?.message || '';
    if (m.includes('required') || m.includes('library') || m.includes('cannot be queued')) {
      return res.status(400).json({ error: m });
    }
    console.error('jukebox host queue:', e);
    return res.status(500).json({ error: 'Failed to add to queue' });
  }
});

hostRouter.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q required' });
  }
  try {
    const rawTracks = await deezer.searchTracks(q, 28);
    const list = Array.isArray(rawTracks?.results) ? rawTracks.results.slice(0, 28) : [];
    const enriched = await enrichDeezerTrackRows(list);
    const tracks = enriched.map(mapJukeboxEnrichedTrack);
    return res.json({ tracks });
  } catch (e) {
    console.error('jukebox host search:', e);
    return res.status(500).json({ error: 'Search failed' });
  }
});

hostRouter.post('/close', (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    jukeSvc.hostClose(jukeboxId, req._jukeHostToken);
    return res.json({ ok: true });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(500).json({ error: 'Failed' });
  }
});

hostRouter.post('/add-playlist', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    const out = await jukeSvc.hostAddPlaylist(jukeboxId, req._jukeHostToken, req.body?.playlist_id);
    return res.json({ ...out, ...jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS) });
  } catch (e) {
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    return res.status(400).json({ error: e.message || 'Bad request' });
  }
});

hostRouter.post('/play-next', async (req, res) => {
  const jukeboxId = Number(req.params.jukeboxId);
  try {
    const out = await jukeSvc.addGuestTrack(jukeboxId, { ...req.body, play_next: true });
    return res.json({ ...out, ...jukeSvc.buildState(jukeboxId, HOST_QUEUE_STATE_OPTS) });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Failed' });
  }
});

function streamMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.flac') {
    return 'audio/flac';
  }
  if (ext === '.m4a' || ext === '.mp4') {
    return 'audio/mp4';
  }
  if (ext === '.ogg') {
    return 'audio/ogg';
  }
  return 'audio/mpeg';
}

function streamLocalLibraryFile(filePath, req, res) {
  const mime = streamMime(filePath);
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.status(416).end();
      return;
    }
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size || end < start) {
      res.status(416).end();
      return;
    }
    const chunkEnd = Math.min(end, stat.size - 1);
    const len = chunkEnd - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${chunkEnd}/${stat.size}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', len);
    res.setHeader('Content-Type', mime);
    fs.createReadStream(filePath, { start, end: chunkEnd }).pipe(res);
    return;
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Type', mime);
  fs.createReadStream(filePath).pipe(res);
}

function streamHandlerAsync(req, res) {
  const jukeboxId = Number(req.query.jukebox_id);
  const libraryTrackId = Number(req.params.libraryTrackId);
  const token = (req.query.token || '').trim();
  const mode = (req.query.mode || 'guest').trim();
  const row = jukeSvc.getJukeboxById(jukeboxId);
  if (!row) {
    res.status(404).end();
    return;
  }
  if (mode === 'host') {
    if (!req.session || req.session.userId == null) {
      res.status(403).end();
      return;
    }
    if (
      String(row.user_id) !== sessionUserIdString(req) &&
      req.session.role !== 'admin'
    ) {
      res.status(403).end();
      return;
    }
    if (!jukeSvc.canHostStreamTrack(jukeboxId, libraryTrackId)) {
      res.status(403).end();
      return;
    }
  } else {
    /* Guest streams: the in-app <audio> tag sends cookies + ?token=. */
    /* Use host-style queue check so a brief queue race doesn’t 403 mid-stream; guest token still required. */
    if (!jukeSvc.assertGuestToken(row, token) || !jukeSvc.canHostStreamTrack(jukeboxId, libraryTrackId)) {
      res.status(403).end();
      return;
    }
    if (req.session && req.session.userId != null && !sessionUserHasJukeboxEnabled(req)) {
      res.status(403).end();
      return;
    }
  }
  const filePath = jukeSvc.resolveStreamPath(libraryTrackId);
  if (filePath) {
    streamLocalLibraryFile(filePath, req, res);
    return;
  }
  res.status(404).end();
}

router.use('/guest/:jukeboxId', guestRouter);
router.use('/host/:jukeboxId', hostRouter);
router.get('/stream/:libraryTrackId', (req, res, next) => {
  try {
    streamHandlerAsync(req, res);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
