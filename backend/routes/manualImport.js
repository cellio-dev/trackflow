const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const manualImport = require('../services/manualImport');
const deezer = require('../services/deezer');
const runtimeConfig = require('../services/runtimeConfig');

const router = express.Router();

function maxUploadBytes() {
  try {
    return Math.max(
      runtimeConfig.DEFAULT_MAX_FILE_SIZE_BYTES,
      Number(runtimeConfig.getSlskdConfig().maxFileSizeBytes) || 0,
    );
  } catch {
    return runtimeConfig.DEFAULT_MAX_FILE_SIZE_BYTES;
  }
}

const audioExtRe = /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|aiff?)$/i;

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      cb(null, manualImport.createManualImportUploadSessionDir());
    } catch (e) {
      cb(e);
    }
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || '') || '.bin';
    const safeExt = audioExtRe.test(ext) ? ext : '.audio';
    cb(null, `tf-manual-${crypto.randomBytes(12).toString('hex')}${safeExt}`);
  },
});

function createUploadMiddleware() {
  return multer({
    storage,
    // Resolve from settings/env at request time (not process startup),
    // so raising max file size applies immediately.
    limits: { fileSize: maxUploadBytes() },
    fileFilter(_req, file, cb) {
      const name = file.originalname || '';
      if (audioExtRe.test(path.extname(name))) {
        return cb(null, true);
      }
      cb(new Error('Unsupported file type. Use a common audio format (mp3, flac, m4a, etc.).'));
    },
  });
}

router.post('/manual-import/analyze', (req, res, next) => {
  createUploadMiddleware().single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const cap = maxUploadBytes();
          return res.status(400).json({
            error: `File too large (max ${Math.round(cap / (1024 * 1024))} MiB).`,
          });
        }
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, (req, res) => {
  if (!req.file?.path) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    const out = manualImport.analyzeUploadedFile(req.file.path, req.file.originalname);
    return res.json(out);
  } catch (e) {
    manualImport.unlinkManualImportFileAndEmptySessionDir(req.file.path);
    console.error('[manualImport] analyze failed:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Failed to analyze file' });
  }
});

const jsonParser = express.json({ limit: '32kb' });

router.get('/manual-import/deezer-lookup/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(400).json({ error: 'Deezer track id is required' });
  }
  try {
    const data = await deezer.fetchDeezerJson(`https://api.deezer.com/track/${encodeURIComponent(id)}`);
    if (data?.error) {
      return res.status(404).json({ error: data.error.message || 'Track not found' });
    }
    return res.json({
      id: data.id,
      title: data.title || '',
      artist: data.artist?.name || '',
      album: data.album?.title || null,
    });
  } catch (e) {
    console.error('[manualImport] deezer lookup failed:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Lookup failed' });
  }
});

router.post('/manual-import/youtube', jsonParser, async (req, res) => {
  const url = req.body?.url ?? req.body?.youtubeUrl;
  try {
    const out = await manualImport.importYoutubeAudioForManualImport(url);
    return res.json(out);
  } catch (e) {
    const msg = e?.message || String(e);
    const isClient =
      /required|allowed|youtube|yt-dlp|timed out|not found|unsupported/i.test(msg) ||
      msg.includes('Only http');
    console.error('[manualImport] youtube failed:', msg);
    return res.status(isClient ? 400 : 500).json({ error: msg });
  }
});

router.post('/manual-import/confirm', jsonParser, async (req, res) => {
  const uploadToken = req.body?.uploadToken;
  const deezerId = req.body?.deezerId ?? req.body?.deezer_id;
  const acknowledgeDuplicate = Boolean(req.body?.acknowledgeDuplicate);
  const libraryDuplicateAction = req.body?.libraryDuplicateAction ?? req.body?.library_duplicate_action;
  const requestId = req.body?.requestId ?? req.body?.request_id;
  try {
    const result = await manualImport.confirmImport(uploadToken, deezerId, {
      acknowledgeDuplicate,
      libraryDuplicateAction,
      requestId,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    const msg = e?.message || String(e);
    if (e && e.code === 'DUPLICATE') {
      return res.status(409).json({
        error: msg,
        code: 'DUPLICATE',
        matches: Array.isArray(e.matches) ? e.matches : [],
        actions: ['add_copy', 'overwrite'],
      });
    }
    const isClient =
      /required|expired|invalid|not found|missing|does not match|not in a state/i.test(msg) ||
      msg.includes('Deezer');
    console.error('[manualImport] confirm failed:', msg);
    return res.status(isClient ? 400 : 500).json({ error: msg });
  }
});

module.exports = router;
