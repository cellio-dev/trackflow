const express = require('express');
const { requireAuth, sessionUserIdString } = require('../middleware/auth');
const jukeSvc = require('../services/jukeboxService');

const router = express.Router();

function viewerFilterUserId(req) {
  const q = (req.query.user || '').trim();
  if (req.session?.role === 'admin' && (q === 'all' || /^\d+$/.test(q))) {
    return q;
  }
  return 'self';
}

router.get('/', requireAuth, (req, res) => {
  try {
    const list = jukeSvc.listJukeboxes(sessionUserIdString(req), req.session.role, viewerFilterUserId(req));
    return res.json({ results: list });
  } catch (e) {
    console.error('jukebox list:', e);
    return res.status(500).json({ error: 'Failed to list jukeboxes' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const created = await jukeSvc.createJukebox(sessionUserIdString(req), req.body || {});
    return res.status(201).json(created);
  } catch (e) {
    const m = e?.message || '';
    if (m.includes('required')) {
      return res.status(400).json({ error: m });
    }
    console.error('jukebox create:', e);
    return res.status(500).json({ error: 'Failed to create jukebox' });
  }
});

router.get('/:id', requireAuth, (req, res) => {
  if (req.params.id === 'guest' || req.params.id === 'host' || req.params.id === 'stream') {
    return res.status(404).json({ error: 'Not found' });
  }
  const row = jukeSvc.getJukeboxById(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Not found' });
  }
  const uid = sessionUserIdString(req);
  if (String(row.user_id) !== uid && req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return res.json(jukeSvc.serializeJukeboxDetail(row));
});

router.patch('/:id', requireAuth, async (req, res) => {
  if (req.params.id === 'guest' || req.params.id === 'host' || req.params.id === 'stream') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const updated = await jukeSvc.updateJukebox(
      Number(req.params.id),
      sessionUserIdString(req),
      req.session.role === 'admin',
      req.body || {},
    );
    return res.json(updated);
  } catch (e) {
    if (e.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const m = e?.message || '';
    if (m.includes('must be 3')) {
      return res.status(400).json({ error: m });
    }
    console.error('jukebox patch:', e);
    return res.status(500).json({ error: 'Failed to update jukebox' });
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  if (req.params.id === 'guest' || req.params.id === 'host' || req.params.id === 'stream') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    jukeSvc.deleteJukebox(Number(req.params.id), sessionUserIdString(req), req.session.role === 'admin');
    return res.json({ ok: true });
  } catch (e) {
    if (e.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (e.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    console.error('jukebox delete:', e);
    return res.status(500).json({ error: 'Failed to delete jukebox' });
  }
});

module.exports = router;
