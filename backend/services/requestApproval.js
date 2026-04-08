const fs = require('fs');
const { getDb } = require('../db');
const slskd = require('./slskd');
const { fileExistsInLibraryForRequestSync, loadTracksPresencePool } = require('./tracksDb');
const { enrichRequestRow } = require('./requestDisplayStatus');
const { getMaxConcurrentDownloads } = require('../routes/settings');
const runtimeConfig = require('./runtimeConfig');

const db = getDb();

const LIBRARY_FILE_WAIT_MS = 60_000;
const LIBRARY_FILE_POLL_MS = 2000;

const getRequestByIdStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests
  WHERE id = ?
`);

const listProcessingNonCancelledStmt = db.prepare(`
  SELECT id, deezer_id, title, artist, album, user_id, status, duration_seconds, cancelled, processing_phase, created_at, request_type
  FROM requests
  WHERE status = 'processing' AND IFNULL(cancelled, 0) != 1
  ORDER BY id ASC
`);

const resetProcessingRowForResumeStmt = db.prepare(`
  UPDATE requests
  SET processing_phase = 'queued', slskd_expected_basename = NULL
  WHERE id = ? AND status = 'processing'
`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay after a job finishes before refilling slots (legacy 200ms when concurrency is 1).
 * Configurable in Settings; when unset, parallel mode uses 0 stagger.
 */
function getDownloadStaggerMs() {
  return runtimeConfig.getDownloadStaggerMs(getMaxConcurrentDownloads());
}

/**
 * After move to LIBRARY_PATH, wait until the track appears in the library cache or the request is cancelled.
 */
async function waitForLibraryMatch(requestId) {
  const deadline = Date.now() + LIBRARY_FILE_WAIT_MS;
  while (Date.now() < deadline) {
    const row = getRequestByIdStmt.get(requestId);
    if (!row || row.status !== 'processing' || Number(row.cancelled) === 1) {
      return false;
    }
    if (fileExistsInLibraryForRequestSync(row)) {
      return true;
    }
    await sleep(LIBRARY_FILE_POLL_MS);
  }
  const finalRow = getRequestByIdStmt.get(requestId);
  return finalRow ? fileExistsInLibraryForRequestSync(finalRow) : false;
}

const setProcessingStmt = db.prepare(`
  UPDATE requests
  SET status = 'processing', cancelled = 0, processing_phase = 'queued'
  WHERE id = ?
`);

const setCompletedStmt = db.prepare(`
  UPDATE requests
  SET status = 'completed', processing_phase = NULL
  WHERE id = ?
`);

const setFailedStmt = db.prepare(`
  UPDATE requests
  SET status = 'failed', processing_phase = NULL
  WHERE id = ?
`);

const pendingDownloads = [];
/** Number of downloadTrack jobs currently in flight */
let activeDownloadSlots = 0;
let pumpQueued = false;

async function runOneDownloadJob(job) {
  try {
    const fresh = getRequestByIdStmt.get(job.requestId);
    if (!fresh || String(fresh.status) !== 'processing' || Number(fresh.cancelled) === 1) {
      return;
    }
    const downloadResult = await slskd.downloadTrack(fresh);
    if (downloadResult?.cancelled) {
      return;
    }
    const afterDownload = getRequestByIdStmt.get(job.requestId);
    if (afterDownload?.status !== 'processing') {
      return;
    }
    const libraryPath =
      downloadResult?.selected?.libraryPath != null
        ? String(downloadResult.selected.libraryPath)
        : '';
    const movedOk = libraryPath && fs.existsSync(libraryPath);
    let hasFile = movedOk || fileExistsInLibraryForRequestSync(afterDownload);
    if (!hasFile) {
      hasFile = await waitForLibraryMatch(job.requestId);
    }
    if (hasFile) {
      setCompletedStmt.run(job.requestId);
      console.log('Request marked completed (library file present):', job.requestId);
    } else {
      console.warn(
        'Download finished but library file not found by naming pattern; leaving processing:',
        job.requestId,
      );
    }
  } catch (error) {
    setFailedStmt.run(job.requestId);
    console.error('Background download failed:', error.message);
  } finally {
    activeDownloadSlots -= 1;
    const stagger = getDownloadStaggerMs();
    if (stagger > 0) {
      await sleep(stagger);
    }
    scheduleDownloadPump();
  }
}

/**
 * Fill free slots from pendingDownloads up to getMaxConcurrentDownloads().
 * Uses a single microtask gate so concurrent job completions don't double-start workers.
 */
function scheduleDownloadPump() {
  if (pumpQueued) {
    return;
  }
  pumpQueued = true;
  queueMicrotask(() => {
    pumpQueued = false;
    const max = getMaxConcurrentDownloads();
    while (activeDownloadSlots < max && pendingDownloads.length > 0) {
      const job = pendingDownloads.shift();
      activeDownloadSlots += 1;
      void runOneDownloadJob(job);
    }
  });
}

function enqueueDownload(requestId, request) {
  pendingDownloads.push({ requestId, request });
  scheduleDownloadPump();
}

/**
 * Remove queued (not yet started) jobs so cancel does not still run slskd work for those ids.
 * @param {Iterable<number|string>} ids — request ids
 */
function dropPendingDownloadsForRequestIds(ids) {
  if (ids == null) {
    return;
  }
  const wantDrop = new Set();
  for (const x of ids) {
    const n = Number(x);
    if (Number.isInteger(n) && n > 0) {
      wantDrop.add(n);
    }
  }
  if (wantDrop.size === 0) {
    return;
  }
  let write = 0;
  for (let i = 0; i < pendingDownloads.length; i += 1) {
    const j = pendingDownloads[i];
    if (!wantDrop.has(Number(j.requestId))) {
      pendingDownloads[write++] = j;
    }
  }
  pendingDownloads.length = write;
}

/**
 * After a server restart, `pendingDownloads` is empty but DB may still have `processing` rows.
 * Re-queue them (or mark completed if the track file is already in the library).
 */
async function resumeProcessingRequestsAfterRestart() {
  await new Promise((resolve) => setImmediate(resolve));

  const rows = listProcessingNonCancelledStmt.all();
  if (rows.length === 0) {
    return;
  }

  /** Without a shared pool, each row could call loadPoolStmt.all() (50k rows) — blocking the event loop for minutes. */
  const pool = loadTracksPresencePool();

  let completedFromLibrary = 0;
  let requeued = 0;
  let i = 0;

  for (const row of rows) {
    if (fileExistsInLibraryForRequestSync(row, pool)) {
      setCompletedStmt.run(row.id);
      completedFromLibrary += 1;
      console.log('Resume after restart: request', row.id, 'already in library → marked completed');
    } else {
      resetProcessingRowForResumeStmt.run(row.id);
      const fresh = getRequestByIdStmt.get(row.id);
      if (fresh && fresh.status === 'processing' && Number(fresh.cancelled) !== 1) {
        enqueueDownload(row.id, fresh);
        requeued += 1;
      }
    }

    i += 1;
    if (i % 40 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (completedFromLibrary > 0 || requeued > 0) {
    console.log(
      'Resume after restart:',
      requeued,
      'request(s) re-queued for download;',
      completedFromLibrary,
      'marked completed (file already present).',
    );
  }
}

async function approveRequestById(requestId) {
  const existingRequest = getRequestByIdStmt.get(requestId);
  if (!existingRequest) {
    return { ok: false, code: 'NOT_FOUND' };
  }

  if (!['pending', 'failed', 'requested'].includes(existingRequest.status)) {
    return { ok: false, code: 'ALREADY_PROCESSED' };
  }

  setProcessingStmt.run(requestId);
  const updatedRequest = getRequestByIdStmt.get(requestId);

  enqueueDownload(requestId, updatedRequest);

  return { ok: true, request: enrichRequestRow(updatedRequest) };
}

module.exports = {
  approveRequestById,
  resumeProcessingRequestsAfterRestart,
  dropPendingDownloadsForRequestIds,
};
