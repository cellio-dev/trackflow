const express = require('express');
const {
  getDiscoverHomeResponseForUser,
  getDiscoverGenreResponseForUser,
  fetchPreviewFieldsByDeezerIds,
} = require('../services/discoverCacheService');
const { enrichDeezerTrackRows } = require('../services/searchTrackEnrichment');
const { sessionUserIdString } = require('../middleware/auth');

const router = express.Router();

const MAX_TRACK_STATUS_IDS = 100;

function shapeTrackStatusPatch(row) {
  return {
    requestStatus: row.requestStatus ?? null,
    requestId: row.requestId ?? null,
    requestPlexStatus: row.requestPlexStatus ?? null,
    requestDisplayStatus: row.requestDisplayStatus ?? null,
    requestProcessingStatus: row.requestProcessingStatus ?? null,
    isInUserLibrary: row.isInUserLibrary,
    existsInMusicLibrary: row.existsInMusicLibrary,
    existsInPlex: row.existsInPlex,
  };
}

// POST /api/discover/track-status — live request/library fields for visible Deezer ids (no cache)
router.post('/track-status', async (req, res) => {
  const raw = req.body?.ids;
  const ids = Array.isArray(raw)
    ? [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].slice(0, MAX_TRACK_STATUS_IDS)
    : [];
  if (ids.length === 0) {
    return res.json({ byId: {} });
  }

  try {
    const stubs = ids.map((id) => ({ id }));
    const enriched = await enrichDeezerTrackRows(stubs);
    const byId = {};
    for (const row of enriched) {
      byId[String(row.id)] = shapeTrackStatusPatch(row);
    }
    return res.json({ byId });
  } catch (error) {
    console.error('Discover track-status:', error?.message || error);
    return res.status(500).json({ error: 'Failed to load track statuses' });
  }
});

// POST /api/discover/track-previews — { ids } → { byId: { [deezerId]: { preview?, albumCover? } } }
router.post('/track-previews', async (req, res) => {
  const raw = req.body?.ids;
  const ids = Array.isArray(raw) ? raw : [];
  try {
    const byId = await fetchPreviewFieldsByDeezerIds(ids);
    return res.json({ byId });
  } catch (error) {
    console.error('Discover track-previews:', error?.message || error);
    return res.status(500).json({ error: 'Failed to load track previews' });
  }
});

// GET /api/discover/genre/:id — cached global genre payload, filtered per user
router.get('/genre/:id', async (req, res) => {
  const gid = Number(req.params.id);
  if (!Number.isInteger(gid) || gid <= 0) {
    return res.status(400).json({ error: 'Invalid genre id' });
  }

  try {
    const userId = sessionUserIdString(req);
    const payload = await getDiscoverGenreResponseForUser(userId, gid);
    return res.json(payload);
  } catch (error) {
    if (error?.message === 'Genre not found') {
      return res.status(404).json({ error: 'Genre not found' });
    }
    console.error('Discover genre:', error?.message || error);
    return res.status(500).json({ error: 'Failed to load genre discover feed' });
  }
});

// GET /api/discover — per-user cache + global Deezer cache; recently added always live
router.get('/', async (req, res) => {
  try {
    const userId = sessionUserIdString(req);
    const payload = await getDiscoverHomeResponseForUser(userId);
    return res.json(payload);
  } catch (error) {
    console.error('Discover feed:', error?.message || error);
    return res.status(500).json({ error: 'Failed to load discover feed' });
  }
});

module.exports = router;
