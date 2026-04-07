const express = require('express');
const { sessionUserIdString } = require('../middleware/auth');
const jukeSvc = require('../services/jukeboxService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const jb = await jukeSvc.ensureDefaultJukeboxForUser(sessionUserIdString(req));
    if (!jb) {
      return res.status(500).json({ error: 'Failed to initialize jukebox' });
    }
    const detail = jukeSvc.serializeJukeboxDetail(jb);
    const state = jukeSvc.buildState(jb.id, { queueLimit: 0 });
    if (state) {
      await jukeSvc.enrichGuestPlayerCovers(state);
    }
    const current = state?.current ?? null;
    const active = state ? jukeSvc.isPanelPlaybackActive(state) : false;
    return res.json({
      ...detail,
      panel: {
        status: active ? 'active' : 'idle',
        current,
      },
    });
  } catch (e) {
    console.error('jukebox panel get:', e);
    return res.status(500).json({ error: 'Failed to load jukebox' });
  }
});

router.post('/clear-history', async (req, res) => {
  try {
    const uid = sessionUserIdString(req);
    await jukeSvc.ensureDefaultJukeboxForUser(uid);
    const out = jukeSvc.clearPlayHistoryForUserDefault(uid, req.session.role === 'admin');
    return res.json(out);
  } catch (e) {
    if (e.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'No jukebox' });
    }
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    console.error('jukebox clear-history:', e);
    return res.status(500).json({ error: 'Failed to clear history' });
  }
});

module.exports = router;
