// Load .env from this folder so SLSKD/PLEX keys work when cwd is not `backend/`
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { ensureSessionSecret } = require('./bootstrap/sessionSecret');
ensureSessionSecret();

// Basic Express server for the TrackFlow backend.
// Routes should stay thin; move real business logic into `services/`.

const express = require('express');
const session = require('express-session');

const searchRoutes = require('./routes/search');
const discoverRoutes = require('./routes/discover');
const requestsRoutes = require('./routes/requests');
const adminRoutes = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const playlistsRoutes = require('./routes/playlists');
const artistsRoutes = require('./routes/artists');
const authRoutes = require('./routes/auth');
const jukeboxAuthRoutes = require('./routes/jukebox');
const jukeboxPanelRoutes = require('./routes/jukeboxPanel');
const jukeboxPublicRoutes = require('./routes/jukeboxPublic');
const usersRoutes = require('./routes/users');
const manualImportRoutes = require('./routes/manualImport');
const { requireAuth, requireAdmin, requireJukeboxEnabled } = require('./middleware/auth');

const app = express();

// So express-session cookie.secure: 'auto' matches the client connection behind TLS termination.
const trustProxyRaw = process.env.TRUST_PROXY;
if (trustProxyRaw === '1' || /^true$/i.test(String(trustProxyRaw || '').trim())) {
  app.set('trust proxy', 1);
} else if (trustProxyRaw != null && String(trustProxyRaw).trim() !== '') {
  const n = parseInt(trustProxyRaw, 10);
  if (Number.isFinite(n) && n > 0) {
    app.set('trust proxy', n);
  }
}

// Parse JSON request bodies
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: 'auto',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

// Wire routes
app.use('/api/auth', authRoutes);
app.use('/api/jukebox', requireAuth, requireJukeboxEnabled, jukeboxPanelRoutes);
const jukeboxCombined = express.Router();
jukeboxCombined.use(jukeboxPublicRoutes);
jukeboxCombined.use(requireAuth, requireJukeboxEnabled, jukeboxAuthRoutes);
app.use('/api/jukeboxes', jukeboxCombined);
app.use('/api/users', usersRoutes);
app.use('/api/search', requireAuth, searchRoutes);
app.use('/api/discover', requireAuth, discoverRoutes);
app.use('/api/requests', requireAuth, requestsRoutes);
app.use('/api/admin', requireAdmin, adminRoutes);
app.use('/api/settings', requireAdmin, settingsRoutes);
app.use('/api/library', requireAdmin, manualImportRoutes);
app.use('/api/playlists', requireAuth, playlistsRoutes);
app.use('/api/artists', requireAuth, artistsRoutes);
const frontendDir = path.join(__dirname, '../frontend');
const frontendDist = path.join(frontendDir, 'dist');
const useBuiltFrontend = fs.existsSync(path.join(frontendDist, 'index.html'));
if (useBuiltFrontend) {
  app.use(express.static(frontendDist));
} else {
  // Dev-style: Vite `public/` + source tree (use `vite` on port 5173 for JS/CSS).
  app.use(express.static(path.join(frontendDir, 'public')));
  app.use(express.static(frontendDir));
}

// 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Generic error handler (keep this last)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const { getDb } = require('./db');
const { resumeProcessingRequestsAfterRestart } = require('./services/requestApproval');
const { runLibraryScanJob } = require('./jobs/libraryScanJob');
const { runPlexSyncJob } = require('./jobs/plexSyncJob');
const {
  runOrphanDownloadsCleanup,
  parseIntervalMs,
  isEnabled: isOrphanDownloadsCleanupEnabled,
} = require('./jobs/orphanDownloadsCleanup');
const { runFollowSyncJob } = require('./jobs/followSyncJob');
const { runDiscoverCacheRefreshJob } = require('./jobs/discoverCacheRefreshJob');
const { clearCompletedRequestsOlderThanDays } = require('./services/requestBulkActions');
const {
  withJobTelemetry,
  withJobTelemetrySync,
  JOB_KEYS,
} = require('./services/jobScheduleTelemetry');
const { runStatusEmailJob, isStatusEmailDeliveryReady } = require('./jobs/statusEmailJob');

const getJobScheduleRowStmt = getDb().prepare(`
  SELECT
    job_library_scan_enabled,
    library_scan_interval_minutes,
    job_plex_sync_enabled,
    plex_scan_interval_minutes,
    plex_integration_enabled,
    job_follow_sync_enabled,
    follow_sync_interval_minutes,
    job_discover_cache_enabled,
    discover_cache_refresh_minutes,
    job_completed_request_clear_enabled,
    job_completed_request_clear_interval_minutes,
    completed_request_auto_clear_days,
    job_status_email_enabled,
    status_email_interval_minutes,
    smtp_host,
    email_from_address,
    status_email_to
  FROM settings
  WHERE id = 1
`);

let lastDiscoverCacheJobAt = Date.now();
let lastLibraryScanAt = 0;
let lastStatusEmailAt = 0;
let lastPlexSyncAt = 0;
let lastFollowSyncAt = 0;
let lastCompletedRequestClearAt = 0;
let lastOrphanCleanupAt = Date.now();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`TrackFlow backend listening on port ${PORT}`);
  /** Defer first Plex Sync: lastPlexSyncAt === 0 makes the first tick treat the job as already due. */
  lastPlexSyncAt = Date.now();
  /** Defer first status email the same way (minimum interval must pass after process start). */
  lastStatusEmailAt = Date.now();
  /** Defer resume so the process can accept HTTP immediately; resume does DB work and must not block the event loop. */
  setImmediate(() => {
    void resumeProcessingRequestsAfterRestart();
  });

  function tickScheduledJobs() {
    const now = Date.now();
    let row;
    try {
      row = getJobScheduleRowStmt.get();
    } catch {
      return;
    }
    if (!row) {
      return;
    }

    const libOn = row.job_library_scan_enabled == null || Number(row.job_library_scan_enabled) !== 0;
    const libMin = Math.max(5, Math.min(1440, Number(row.library_scan_interval_minutes) || 60));
    if (libOn && now - lastLibraryScanAt >= libMin * 60_000) {
      lastLibraryScanAt = now;
      void withJobTelemetry(JOB_KEYS.library_scan, () => runLibraryScanJob()).catch((err) =>
        console.error('libraryScanJob failed:', err?.message || err),
      );
    }

    const statusEmailMin = Math.max(
      240,
      Math.min(10080, Math.floor(Number(row.status_email_interval_minutes) || 1440)),
    );
    if (isStatusEmailDeliveryReady(row) && now - lastStatusEmailAt >= statusEmailMin * 60_000) {
      lastStatusEmailAt = now;
      void withJobTelemetry(JOB_KEYS.status_email, () => runStatusEmailJob()).catch((err) =>
        console.error('statusEmailJob failed:', err?.message || err),
      );
    }

    const plexSyncJobOn = row.job_plex_sync_enabled == null || Number(row.job_plex_sync_enabled) !== 0;
    const plexOn = Number(row.plex_integration_enabled) === 1;
    const plexMin = Math.max(5, Math.min(720, Number(row.plex_scan_interval_minutes) || 30));
    if (plexSyncJobOn && plexOn && now - lastPlexSyncAt >= plexMin * 60_000) {
      lastPlexSyncAt = now;
      void withJobTelemetry(JOB_KEYS.plex_sync, () => runPlexSyncJob()).catch((err) =>
        console.error('plexSyncJob failed:', err?.message || err, err?.stack || ''),
      );
    }

    const followOn = row.job_follow_sync_enabled == null || Number(row.job_follow_sync_enabled) !== 0;
    const followMin = Math.max(5, Math.min(1440, Number(row.follow_sync_interval_minutes) || 120));
    if (followOn && now - lastFollowSyncAt >= followMin * 60_000) {
      lastFollowSyncAt = now;
      void withJobTelemetry(JOB_KEYS.follow_sync, () => runFollowSyncJob()).catch((err) =>
        console.error('followSyncJob failed:', err?.message || err),
      );
    }

    const discoverOn =
      row.job_discover_cache_enabled == null || Number(row.job_discover_cache_enabled) !== 0;
    const discoverMin = Math.max(30, Math.min(10080, Number(row.discover_cache_refresh_minutes) || 240));
    const discoverMs = discoverMin * 60_000;
    if (discoverOn && now - lastDiscoverCacheJobAt >= discoverMs) {
      lastDiscoverCacheJobAt = now;
      void withJobTelemetry(JOB_KEYS.discover_cache, () => runDiscoverCacheRefreshJob()).catch((err) =>
        console.error('discoverCacheRefreshJob failed:', err?.message || err),
      );
    }

    const clearOn = Number(row.job_completed_request_clear_enabled) === 1;
    const clearDays = Math.max(0, Math.min(3650, Math.floor(Number(row.completed_request_auto_clear_days) || 0)));
    const clearIntMin = Math.max(
      5,
      Math.min(10080, Math.floor(Number(row.job_completed_request_clear_interval_minutes) || 1440)),
    );
    if (clearOn && clearDays >= 1 && now - lastCompletedRequestClearAt >= clearIntMin * 60_000) {
      lastCompletedRequestClearAt = now;
      try {
        withJobTelemetrySync(JOB_KEYS.completed_request_clear, () => {
          clearCompletedRequestsOlderThanDays({ older_than_days: clearDays });
        });
      } catch (err) {
        console.error('completed request history clear failed:', err?.message || err);
      }
    }

    const orphanMs = parseIntervalMs();
    if (isOrphanDownloadsCleanupEnabled() && now - lastOrphanCleanupAt >= orphanMs) {
      lastOrphanCleanupAt = now;
      void withJobTelemetry(JOB_KEYS.orphan_cleanup, () => runOrphanDownloadsCleanup()).catch((err) =>
        console.error('completedDownloadsCleanup job failed:', err?.message || err),
      );
    }
  }

  setInterval(tickScheduledJobs, 60_000);
  console.log(
    'Scheduled jobs: library, status email, Plex Sync, follow sync, discover cache, completed-request clear, orphan cleanup (intervals from settings; checked each minute)',
  );

  setTimeout(() => {
    tickScheduledJobs();
  }, 35_000);
  setTimeout(() => {
    void withJobTelemetry(JOB_KEYS.library_scan, () => runLibraryScanJob()).catch((e) =>
      console.error('initial library scan:', e?.message || e),
    );
  }, 4000);
  setTimeout(() => {
    void withJobTelemetry(JOB_KEYS.follow_sync, () => runFollowSyncJob()).catch((e) =>
      console.error('initial follow sync:', e?.message || e),
    );
  }, 12_000);
  setTimeout(() => {
    void withJobTelemetry(JOB_KEYS.discover_cache, () => runDiscoverCacheRefreshJob())
      .then(() => {
        lastDiscoverCacheJobAt = Date.now();
      })
      .catch((e) => console.error('initial discoverCacheRefreshJob:', e?.message || e));
  }, 20_000);
});

// Default Node request timeout (5 min) can abort long admin jobs (e.g. library file scan).
server.requestTimeout = 3_600_000;

module.exports = app;

