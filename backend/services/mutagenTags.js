const { spawn, spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'trackflow_mutagen.py');

function pythonCmd() {
  const fromEnv = process.env.TRACKFLOW_PYTHON || process.env.PYTHON;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  if (process.platform === 'win32') {
    return 'C:\\Python314\\python.exe';
  }
  return 'python3';
}

/**
 * @returns {object|null} parsed tag object with ok, trackflow_id, artist, title, album, duration_seconds
 */
function pythonEnv() {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}

function parseLastJsonLine(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) {
    return null;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) {
      continue;
    }
    try {
      return JSON.parse(line);
    } catch {
      /* continue */
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const READ_TAGS_TIMEOUT_MS = 20_000;

/**
 * Async tag read (non-blocking vs sync spawn). Same JSON shape as `readTagsForFileSync`.
 * @param {string} filePath
 * @returns {Promise<object>}
 */
function readTagsForFile(filePath) {
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finishOnce = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(value);
    };

    let child;
    try {
      child = spawn(pythonCmd(), [SCRIPT, 'read', filePath], {
        encoding: 'utf8',
        env: pythonEnv(),
        windowsHide: true,
      });
    } catch (e) {
      finishOnce({
        ok: false,
        error: 'read_tags_exception',
        details: String(e?.message || e),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finishOnce({ ok: false, error: 'timeout', details: 'read_tags_timeout' });
    }, READ_TAGS_TIMEOUT_MS);

    child.on('error', (err) => {
      const stderrTrim = String(stderr || '').trim();
      if (stderrTrim) {
        console.error('[mutagen] readTagsForFile: stderr', filePath, stderrTrim.slice(0, 800));
      }
      console.error('[mutagen] readTagsForFile: spawn error', filePath, err?.message || err);
      finishOnce(
        parseLastJsonLine(stdout) || {
          ok: false,
          error: 'python_spawn_failed',
          details: String(err?.message || err),
        },
      );
    });

    child.on('close', (code) => {
      const parsed = parseLastJsonLine(stdout);
      const stderrTrim = String(stderr || '').trim();

      if (code !== 0) {
        if (stderrTrim) {
          console.error('[mutagen] readTagsForFile: stderr', filePath, stderrTrim.slice(0, 800));
        }
        finishOnce(
          parsed || {
            ok: false,
            error: 'python_exit_nonzero',
            details: String(code),
          },
        );
        return;
      }

      if (parsed && typeof parsed === 'object') {
        finishOnce(parsed);
        return;
      }
      finishOnce({ ok: false, error: 'empty_or_invalid_json' });
    });
  });
}

function readTagsForFileSync(filePath) {
  try {
    const r = spawnSync(pythonCmd(), [SCRIPT, 'read', filePath], {
      encoding: 'utf8',
      timeout: READ_TAGS_TIMEOUT_MS,
      windowsHide: true,
      env: pythonEnv(),
    });
    const parsed = parseLastJsonLine(r.stdout);
    const stderr = String(r.stderr || '').trim();

    if (r.error) {
      if (stderr) {
        console.error('[mutagen] readTagsForFileSync: stderr', filePath, stderr.slice(0, 800));
      }
      console.error('[mutagen] readTagsForFileSync: spawn error', filePath, r.error.message || r.error);
      return (
        parsed || {
          ok: false,
          error: 'python_spawn_failed',
          details: String(r.error.message || r.error),
        }
      );
    }

    if (r.status !== 0) {
      if (stderr) {
        console.error('[mutagen] readTagsForFileSync: stderr', filePath, stderr.slice(0, 800));
      }
      return (
        parsed || {
          ok: false,
          error: 'python_exit_nonzero',
          details: String(r.status),
        }
      );
    }

    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return { ok: false, error: 'empty_or_invalid_json' };
  } catch (e) {
    console.error('[mutagen] readTagsForFileSync: exception', filePath, e?.message || e);
    return { ok: false, error: 'read_tags_exception', details: String(e?.message || e) };
  }
}

/**
 * @returns {boolean}
 */
function writeTagsForFileSync(filePath, payload) {
  const json = JSON.stringify(payload);
  console.log('[mutagen] writeTagsForFileSync: invoking Python', {
    filePath,
    payload,
    script: SCRIPT,
    python: pythonCmd(),
  });
  try {
    const r = spawnSync(pythonCmd(), [SCRIPT, 'write', filePath, '-'], {
      encoding: 'utf8',
      input: json,
      timeout: 30_000,
      windowsHide: true,
      env: pythonEnv(),
    });
    const stdout = String(r.stdout || '').trim();
    const stderr = String(r.stderr || '').trim();
    console.log('[mutagen] writeTagsForFileSync: process finished', {
      filePath,
      status: r.status,
      stdout,
      stderr: stderr || '(empty)',
    });
    if (r.error) {
      console.error('[mutagen] writeTagsForFileSync: spawn error', filePath, r.error);
      return false;
    }
    if (r.status !== 0) {
      console.error('[mutagen] writeTagsForFileSync: non-zero exit', filePath, {
        status: r.status,
        stdout,
        stderr,
      });
      return false;
    }
    let out;
    try {
      out = JSON.parse(stdout || '{}');
    } catch (parseErr) {
      console.error('[mutagen] writeTagsForFileSync: invalid JSON from Python', filePath, stdout, parseErr.message);
      return false;
    }
    if (!out.ok) {
      console.error('[mutagen] writeTagsForFileSync: Python reported failure', filePath, out);
      return false;
    }
    console.log('[mutagen] writeTagsForFileSync: Python ok', filePath, out);
    const verifyRead = readTagsForFileSync(filePath);
    console.log('[mutagen] writeTagsForFileSync: read-back after write', filePath, verifyRead);
    const expectedId = String(payload.deezer_id || '').trim();
    if (!verifyRead || !verifyRead.ok) {
      console.error('[mutagen] writeTagsForFileSync: read-back failed or not ok', filePath, verifyRead);
      return false;
    }
    if (expectedId && String(verifyRead.trackflow_id || '') !== expectedId) {
      console.error('[mutagen] writeTagsForFileSync: TRACKFLOW_ID mismatch after write', {
        filePath,
        expected: expectedId,
        got: verifyRead.trackflow_id,
      });
      return false;
    }
    return true;
  } catch (e) {
    console.error('[mutagen] writeTagsForFileSync: exception', filePath, e.message);
    return false;
  }
}

let mutagenProbe = null;

function isMutagenAvailable() {
  if (mutagenProbe === null) {
    const r = spawnSync(pythonCmd(), ['-c', 'import mutagen'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      env: pythonEnv(),
    });
    mutagenProbe = r.status === 0;
  }
  return mutagenProbe;
}

module.exports = {
  readTagsForFile,
  readTagsForFileSync,
  writeTagsForFileSync,
  isMutagenAvailable,
};
