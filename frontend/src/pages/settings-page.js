import { ensureLoggedIn } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
if (__tfMe && __tfMe.role !== 'admin') {
  window.location.replace('/index.html');
  await new Promise(() => {});
}
if (__tfMe?.role === 'admin') {
  await initAppNavAuth(__tfMe);
}

const settingsGlobalMessage = document.getElementById('settingsGlobalMessage');
const displayTimezone = document.getElementById('displayTimezone');
const autoApprove = document.getElementById('autoApprove');
const followRequestsAutoApprove = document.getElementById('followRequestsAutoApprove');
const jukeboxRequestsAutoApprove = document.getElementById('jukeboxRequestsAutoApprove');
const completedRequestAutoClearDays = document.getElementById('completedRequestAutoClearDays');
const failedRequestAutoRetryDays = document.getElementById('failedRequestAutoRetryDays');
const preferredFormat = document.getElementById('preferredFormat');
const maxConcurrentDownloads = document.getElementById('maxConcurrentDownloads');
const maxDownloadAttempts = document.getElementById('maxDownloadAttempts');
const plexIntegration = document.getElementById('plexIntegration');
const plexPlayHistoryRecommendations = document.getElementById('plexPlayHistoryRecommendations');
const fileNamingPattern = document.getElementById('fileNamingPattern');
const fileNamingPreview = document.getElementById('fileNamingPreview');
const fileNamingError = document.getElementById('fileNamingError');

const libraryPath = document.getElementById('libraryPath');
const libraryScanPathsExtra = document.getElementById('libraryScanPathsExtra');
const saveLibraryBtn = document.getElementById('saveLibraryBtn');
const openManualImportBtn = document.getElementById('openManualImportBtn');
const slskdLocalPath = document.getElementById('slskdLocalPath');
const slskdBaseUrl = document.getElementById('slskdBaseUrl');
const slskdApiKey = document.getElementById('slskdApiKey');
const clearSlskdApiKey = document.getElementById('clearSlskdApiKey');
const slskdMaxFileMiB = document.getElementById('slskdMaxFileMiB');
const slskdAutoClearCompleted = document.getElementById('slskdAutoClearCompleted');
const saveDownloadBtn = document.getElementById('saveDownloadBtn');
const testSlskdBtn = document.getElementById('testSlskdBtn');
const testSlskdMsg = document.getElementById('testSlskdMsg');
const plexUrl = document.getElementById('plexUrl');
const plexToken = document.getElementById('plexToken');
const clearPlexToken = document.getElementById('clearPlexToken');
const plexMusicSectionId = document.getElementById('plexMusicSectionId');
const savePlexBtn = document.getElementById('savePlexBtn');
const testPlexBtn = document.getElementById('testPlexBtn');
const testPlexMsg = document.getElementById('testPlexMsg');
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const checkUpdateMsg = document.getElementById('checkUpdateMsg');
const checkUpdateCurrentVersion = document.getElementById('checkUpdateCurrentVersion');
const plexAuthForLogin = document.getElementById('plexAuthForLogin');
const orphanCleanupEnabled = document.getElementById('orphanCleanupEnabled');
const orphanCleanupIntervalMinutes = document.getElementById('orphanCleanupIntervalMinutes');
const followSyncIntervalMinutes = document.getElementById('followSyncIntervalMinutes');
const discoverCacheRefreshMinutes = document.getElementById('discoverCacheRefreshMinutes');
const libraryScanIntervalMinutes = document.getElementById('libraryScanIntervalMinutes');
const plexScanIntervalMinutes = document.getElementById('plexScanIntervalMinutes');
const jobDiscoverCacheEnabled = document.getElementById('jobDiscoverCacheEnabled');
const jobLibraryScanEnabled = document.getElementById('jobLibraryScanEnabled');
const jobFollowSyncEnabled = document.getElementById('jobFollowSyncEnabled');
const jobPlexSyncEnabled = document.getElementById('jobPlexSyncEnabled');
const plexRunLibraryScanBeforeSync = document.getElementById('plexRunLibraryScanBeforeSync');
const jobCompletedRequestClearEnabled = document.getElementById('jobCompletedRequestClearEnabled');
const jobCompletedRequestClearIntervalMinutes = document.getElementById(
  'jobCompletedRequestClearIntervalMinutes',
);
const jobStatusEmailEnabled = document.getElementById('jobStatusEmailEnabled');
const statusEmailIntervalMinutes = document.getElementById('statusEmailIntervalMinutes');
const smtpHost = document.getElementById('smtpHost');
const smtpPort = document.getElementById('smtpPort');
const smtpSecure = document.getElementById('smtpSecure');
const smtpUser = document.getElementById('smtpUser');
const smtpPassword = document.getElementById('smtpPassword');
const clearSmtpPassword = document.getElementById('clearSmtpPassword');
const emailFromAddress = document.getElementById('emailFromAddress');
const statusEmailTo = document.getElementById('statusEmailTo');
const saveEmailBtn = document.getElementById('saveEmailBtn');
const saveEmailMsg = document.getElementById('saveEmailMsg');
const testEmailBtn = document.getElementById('testEmailBtn');
const testEmailMsg = document.getElementById('testEmailMsg');

const formatValues = new Set(['prefer_mp3', 'prefer_flac', 'mp3', 'flac']);

const DEFAULT_FILE_NAMING = '%artist%/%artist% - %title%';

const JOB_SCHEDULE_KEYS = [
  'discover_cache',
  'library_scan',
  'follow_sync',
  'orphan_cleanup',
  'completed_request_clear',
  'status_email',
  'plex_sync',
];

function resolveDisplayTz(data) {
  if (typeof data?.display_timezone === 'string' && data.display_timezone.trim()) {
    return data.display_timezone.trim();
  }
  if (displayTimezone && typeof displayTimezone.value === 'string' && displayTimezone.value.trim()) {
    return displayTimezone.value.trim();
  }
  return 'UTC';
}

function formatJobTimestampIso(iso, tz) {
  if (!iso || typeof iso !== 'string') {
    return '—';
  }
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) {
    return '—';
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: tz || 'UTC',
    }).format(new Date(d));
  } catch {
    return new Date(d).toISOString();
  }
}

function formatJobScheduleNext(entry, tz) {
  if (!entry || typeof entry !== 'object') {
    return '—';
  }
  if (!entry.schedule_active) {
    return entry.schedule_note || 'Off';
  }
  if (entry.next_scheduled_at) {
    return formatJobTimestampIso(entry.next_scheduled_at, tz);
  }
  return 'Not yet run';
}

function formatJobScheduleResult(entry) {
  if (!entry || typeof entry !== 'object') {
    return { text: '—', title: '', failure: false };
  }
  const r = entry.last_result;
  if (r === 'success') {
    return { text: 'Success', title: entry.last_error || '', failure: false };
  }
  if (r === 'failure') {
    return { text: 'Failure', title: entry.last_error || 'Failed', failure: true };
  }
  return { text: '—', title: '', failure: false };
}

function applyJobScheduleStatus(data) {
  const status = data?.job_schedule_status;
  const tz = resolveDisplayTz(data);
  if (!status || typeof status !== 'object') {
    for (const key of JOB_SCHEDULE_KEYS) {
      const lastEl = document.querySelector(`[data-job-last="${key}"]`);
      const resEl = document.querySelector(`[data-job-result="${key}"]`);
      const nextEl = document.querySelector(`[data-job-next="${key}"]`);
      if (lastEl) {
        lastEl.textContent = '—';
      }
      if (resEl) {
        resEl.textContent = '—';
        resEl.classList.remove('job-result-failure');
        resEl.removeAttribute('title');
      }
      if (nextEl) {
        nextEl.textContent = '—';
        nextEl.removeAttribute('title');
      }
    }
    return;
  }
  for (const key of JOB_SCHEDULE_KEYS) {
    const entry = status[key];
    const lastEl = document.querySelector(`[data-job-last="${key}"]`);
    const resEl = document.querySelector(`[data-job-result="${key}"]`);
    const nextEl = document.querySelector(`[data-job-next="${key}"]`);
    if (lastEl) {
      lastEl.textContent = formatJobTimestampIso(entry?.last_run_at, tz);
    }
    if (resEl) {
      const fr = formatJobScheduleResult(entry);
      resEl.textContent = fr.text;
      resEl.classList.toggle('job-result-failure', Boolean(fr.failure));
      if (fr.title) {
        resEl.title = fr.title;
      } else {
        resEl.removeAttribute('title');
      }
    }
    if (nextEl) {
      nextEl.textContent = formatJobScheduleNext(entry, tz);
      if (!entry.schedule_active && entry.schedule_note) {
        nextEl.title = entry.schedule_note;
      } else {
        nextEl.removeAttribute('title');
      }
    }
  }
}

let fileNamingPreviewTimer = null;

function applyFileNamingPreviewFromServer(previewPath) {
  if (previewPath) {
    fileNamingPreview.textContent = `Preview: ${previewPath}`;
    fileNamingPreview.classList.add('is-ok');
    fileNamingError.hidden = true;
    fileNamingError.textContent = '';
  } else {
    fileNamingPreview.textContent = '';
    fileNamingPreview.classList.remove('is-ok');
  }
}

async function refreshFileNamingPreview(pattern) {
  try {
    const response = await fetch('/api/settings/preview-file-naming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pattern }),
    });
    const data = await response.json().catch(() => ({}));
    if (data.ok && data.preview_path) {
      applyFileNamingPreviewFromServer(data.preview_path);
    } else {
      fileNamingPreview.textContent = '';
      fileNamingPreview.classList.remove('is-ok');
      if (String(pattern || '').trim()) {
        fileNamingError.hidden = false;
        fileNamingError.textContent = data.error || 'Invalid pattern.';
      } else {
        fileNamingError.hidden = true;
        fileNamingError.textContent = '';
      }
    }
  } catch {
    fileNamingPreview.textContent = '';
    fileNamingPreview.classList.remove('is-ok');
  }
}

function scheduleFileNamingPreview() {
  if (!fileNamingPattern) return;
  clearTimeout(fileNamingPreviewTimer);
  fileNamingPreviewTimer = setTimeout(() => {
    refreshFileNamingPreview(fileNamingPattern.value);
  }, 300);
}

async function refreshJobScheduleFromServer() {
  try {
    const response = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    applyJobScheduleStatus(data);
  } catch (e) {
    console.error(e);
  }
}

async function loadSettings() {
  try {
    const response = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error('Failed to load settings');
    }
    const data = await response.json();
    applyJobScheduleStatus(data);

    if (autoApprove) {
      autoApprove.checked = Boolean(data.auto_approve);
    }
    const pf = data.preferred_format;
    if (preferredFormat) {
      if (typeof pf === 'string' && formatValues.has(pf)) {
        preferredFormat.value = pf;
      } else {
        preferredFormat.value = 'prefer_mp3';
      }
      preferredFormat.dataset.lastValue = preferredFormat.value;
    }

    if (maxConcurrentDownloads) {
      const mc = Number(data.max_concurrent_downloads);
      if (Number.isFinite(mc) && mc >= 1 && mc <= 50) {
        maxConcurrentDownloads.value = String(Math.floor(mc));
      } else {
        maxConcurrentDownloads.value = '1';
      }
      maxConcurrentDownloads.dataset.lastValue = maxConcurrentDownloads.value;
    }

    if (maxDownloadAttempts) {
      const ma = Number(data.max_download_attempts);
      if (Number.isFinite(ma) && ma >= 1 && ma <= 20) {
        maxDownloadAttempts.value = String(Math.floor(ma));
      } else {
        maxDownloadAttempts.value = '3';
      }
      maxDownloadAttempts.dataset.lastValue = maxDownloadAttempts.value;
    }

    if (plexIntegration) {
      plexIntegration.checked = Boolean(data.plex_integration_enabled);
    }
    if (plexPlayHistoryRecommendations) {
      plexPlayHistoryRecommendations.checked = Boolean(data.plex_play_history_recommendations);
    }
    if (plexAuthForLogin) {
      plexAuthForLogin.checked = Boolean(data.plex_auth_enabled);
    }
    if (plexRunLibraryScanBeforeSync) {
      plexRunLibraryScanBeforeSync.checked = Boolean(data.plex_run_library_scan_before_sync);
    }

    if (displayTimezone) {
      displayTimezone.value =
        typeof data.display_timezone === 'string' && data.display_timezone.trim()
          ? data.display_timezone.trim()
          : 'UTC';
      displayTimezone.dataset.lastValue = displayTimezone.value;
    }
    applyJobScheduleStatus(data);

    if (followRequestsAutoApprove) {
      followRequestsAutoApprove.checked = Boolean(data.follow_requests_auto_approve);
    }
    if (jukeboxRequestsAutoApprove) {
      jukeboxRequestsAutoApprove.checked = Boolean(data.jukebox_requests_auto_approve);
    }

    if (completedRequestAutoClearDays) {
      const c = data.completed_request_auto_clear_days;
      completedRequestAutoClearDays.value =
        c != null && Number.isFinite(Number(c)) && Number(c) >= 0
          ? String(Math.floor(Number(c)))
          : '0';
      completedRequestAutoClearDays.dataset.lastValue = completedRequestAutoClearDays.value;
    }
    if (failedRequestAutoRetryDays) {
      const v = data.failed_request_auto_retry_days;
      failedRequestAutoRetryDays.value =
        v != null && Number.isFinite(Number(v)) && Number(v) >= 0
          ? String(Math.floor(Number(v)))
          : '0';
      failedRequestAutoRetryDays.dataset.lastValue = failedRequestAutoRetryDays.value;
    }

    if (jobDiscoverCacheEnabled) {
      jobDiscoverCacheEnabled.checked = Boolean(data.job_discover_cache_enabled);
    }
    if (jobLibraryScanEnabled) {
      jobLibraryScanEnabled.checked = Boolean(data.job_library_scan_enabled);
    }
    if (jobFollowSyncEnabled) {
      jobFollowSyncEnabled.checked = Boolean(data.job_follow_sync_enabled);
    }
    if (jobPlexSyncEnabled) {
      jobPlexSyncEnabled.checked = Boolean(data.job_plex_sync_enabled);
    }
    if (jobCompletedRequestClearEnabled) {
      jobCompletedRequestClearEnabled.checked = Boolean(data.job_completed_request_clear_enabled);
    }
    if (jobCompletedRequestClearIntervalMinutes) {
      const j = data.job_completed_request_clear_interval_minutes;
      jobCompletedRequestClearIntervalMinutes.value =
        j != null && Number.isFinite(Number(j)) ? String(Math.floor(Number(j))) : '1440';
      jobCompletedRequestClearIntervalMinutes.dataset.lastValue =
        jobCompletedRequestClearIntervalMinutes.value;
    }

    if (jobStatusEmailEnabled) {
      jobStatusEmailEnabled.checked = Boolean(data.job_status_email_enabled);
    }
    if (statusEmailIntervalMinutes) {
      const se = data.status_email_interval_minutes;
      statusEmailIntervalMinutes.value =
        se != null && Number.isFinite(Number(se)) ? String(Math.floor(Number(se))) : '1440';
      statusEmailIntervalMinutes.dataset.lastValue = statusEmailIntervalMinutes.value;
    }

    if (smtpHost) {
      smtpHost.value = typeof data.smtp_host === 'string' ? data.smtp_host : '';
    }
    if (smtpPort) {
      const sp = data.smtp_port;
      smtpPort.value =
        sp != null && Number.isFinite(Number(sp)) ? String(Math.floor(Number(sp))) : '587';
    }
    if (smtpSecure) {
      smtpSecure.checked = Boolean(data.smtp_secure);
    }
    if (smtpUser) {
      smtpUser.value = typeof data.smtp_user === 'string' ? data.smtp_user : '';
    }
    if (smtpPassword) {
      smtpPassword.value = '';
    }
    if (clearSmtpPassword) {
      clearSmtpPassword.checked = false;
    }
    if (emailFromAddress) {
      emailFromAddress.value =
        typeof data.email_from_address === 'string' ? data.email_from_address : '';
    }
    if (statusEmailTo) {
      statusEmailTo.value = typeof data.status_email_to === 'string' ? data.status_email_to : '';
    }

    if (libraryScanIntervalMinutes) {
      const lib = data.library_scan_interval_minutes;
      libraryScanIntervalMinutes.value =
        lib != null && Number.isFinite(Number(lib)) ? String(Math.floor(Number(lib))) : '60';
      libraryScanIntervalMinutes.dataset.lastValue = libraryScanIntervalMinutes.value;
    }
    if (plexScanIntervalMinutes) {
      const pm = data.plex_scan_interval_minutes;
      plexScanIntervalMinutes.value =
        pm != null && Number.isFinite(Number(pm)) ? String(Math.floor(Number(pm))) : '30';
      plexScanIntervalMinutes.dataset.lastValue = plexScanIntervalMinutes.value;
    }
    if (discoverCacheRefreshMinutes) {
      const d = data.discover_cache_refresh_minutes;
      discoverCacheRefreshMinutes.value =
        d != null && Number.isFinite(Number(d)) ? String(Math.floor(Number(d))) : '240';
      discoverCacheRefreshMinutes.dataset.lastValue = discoverCacheRefreshMinutes.value;
    }

    if (fileNamingPattern) {
      const fnp =
        typeof data.file_naming_pattern === 'string' && data.file_naming_pattern.trim()
          ? data.file_naming_pattern
          : DEFAULT_FILE_NAMING;
      fileNamingPattern.value = fnp;
      fileNamingPattern.dataset.lastValue = fnp;
      if (data.file_naming_preview) {
        applyFileNamingPreviewFromServer(data.file_naming_preview);
      } else {
        scheduleFileNamingPreview();
      }
    }

    if (libraryPath) {
      const prim =
        typeof data.primary_library_path === 'string' && data.primary_library_path.trim()
          ? data.primary_library_path
          : typeof data.library_path === 'string'
            ? data.library_path
            : '';
      libraryPath.value = prim;
    }
    if (libraryScanPathsExtra) {
      const extra = Array.isArray(data.library_paths) ? data.library_paths : [];
      libraryScanPathsExtra.value = extra.join('\n');
    }
    if (slskdLocalPath) {
      slskdLocalPath.value =
        typeof data.slskd_local_download_path === 'string' ? data.slskd_local_download_path : '';
    }
    if (slskdBaseUrl) {
      slskdBaseUrl.value = typeof data.slskd_base_url === 'string' ? data.slskd_base_url : '';
    }
    if (slskdApiKey) {
      slskdApiKey.value = '';
    }
    if (clearSlskdApiKey) {
      clearSlskdApiKey.checked = false;
    }
    if (slskdMaxFileMiB) {
      const b = data.slskd_max_file_size_bytes;
      if (b != null && Number.isFinite(Number(b)) && Number(b) > 0) {
        slskdMaxFileMiB.value = String(Math.round(Number(b) / (1024 * 1024)));
      } else {
        slskdMaxFileMiB.value = '';
      }
    }
    if (slskdAutoClearCompleted) {
      slskdAutoClearCompleted.checked = Boolean(data.slskd_auto_clear_completed_downloads);
    }
    if (plexUrl) {
      plexUrl.value = typeof data.plex_url === 'string' ? data.plex_url : '';
    }
    if (plexToken) {
      plexToken.value = '';
    }
    if (clearPlexToken) {
      clearPlexToken.checked = false;
    }
    if (plexMusicSectionId) {
      plexMusicSectionId.value =
        typeof data.plex_music_section_id === 'string' && data.plex_music_section_id.trim()
          ? data.plex_music_section_id
          : '4';
    }
    if (orphanCleanupEnabled) {
      orphanCleanupEnabled.checked = Boolean(data.slskd_orphan_cleanup_enabled);
    }
    if (orphanCleanupIntervalMinutes) {
      const om = data.slskd_orphan_cleanup_interval_minutes;
      if (om != null && Number.isFinite(Number(om))) {
        orphanCleanupIntervalMinutes.value = String(Math.floor(Number(om)));
      } else {
        const ms = data.slskd_orphan_cleanup_interval_ms;
        if (ms != null && Number.isFinite(Number(ms))) {
          orphanCleanupIntervalMinutes.value = String(Math.max(1, Math.round(Number(ms) / 60000)));
        } else {
          const h = data.slskd_orphan_cleanup_interval_hours;
          if (h != null && Number.isFinite(Number(h))) {
            orphanCleanupIntervalMinutes.value = String(Math.floor(Number(h) * 60));
          } else {
            orphanCleanupIntervalMinutes.value = '240';
          }
        }
      }
      orphanCleanupIntervalMinutes.dataset.lastValue = orphanCleanupIntervalMinutes.value;
    }
    if (followSyncIntervalMinutes) {
      const fs = data.follow_sync_interval_minutes;
      followSyncIntervalMinutes.value =
        fs != null && Number.isFinite(Number(fs)) ? String(Math.floor(Number(fs))) : '120';
      followSyncIntervalMinutes.dataset.lastValue = followSyncIntervalMinutes.value;
    }

    syncPlexJobRowDisabledState();
  } catch (error) {
    console.error(error);
    if (settingsGlobalMessage) {
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Could not load settings.';
    }
  }
}

function syncPlexJobRowDisabledState() {
  const plexOn = plexIntegration?.checked;
  if (jobPlexSyncEnabled) {
    jobPlexSyncEnabled.disabled = !plexOn;
  }
  if (plexScanIntervalMinutes) {
    plexScanIntervalMinutes.disabled = !plexOn;
  }
  const plexRun = document.querySelector(
    '[data-trigger="/api/settings/trigger-plex-sync"].job-run-btn',
  );
  if (plexRun) {
    plexRun.disabled = !plexOn;
  }
}

if (autoApprove) {
  autoApprove.addEventListener('change', async () => {
    const value = autoApprove.checked;
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ auto_approve: value }),
      });
      if (!response.ok) {
        throw new Error('Update failed');
      }
      settingsGlobalMessage.hidden = true;
    } catch (error) {
      console.error(error);
      autoApprove.checked = !value;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Could not save setting.';
    }
  });
}

async function postBooleanSetting(field, checked) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ [field]: checked }),
  });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || 'Update failed');
  }
  settingsGlobalMessage.hidden = true;
}

if (fileNamingPattern) {
  fileNamingPattern.addEventListener('input', () => {
    fileNamingError.hidden = true;
    fileNamingError.textContent = '';
    scheduleFileNamingPreview();
  });

  fileNamingPattern.addEventListener('blur', async () => {
    const v = fileNamingPattern.value;
    const previous =
      fileNamingPattern.dataset.lastValue != null && fileNamingPattern.dataset.lastValue !== ''
        ? fileNamingPattern.dataset.lastValue
        : DEFAULT_FILE_NAMING;
    if (v === previous) {
      return;
    }
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ file_naming_pattern: v }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Could not save pattern.');
      }
      const data = await response.json();
      const saved =
        typeof data.file_naming_pattern === 'string' && data.file_naming_pattern.trim()
          ? data.file_naming_pattern
          : DEFAULT_FILE_NAMING;
      fileNamingPattern.value = saved;
      fileNamingPattern.dataset.lastValue = saved;
      applyFileNamingPreviewFromServer(data.file_naming_preview);
      settingsGlobalMessage.hidden = true;
    } catch (error) {
      console.error(error);
      fileNamingPattern.value = previous;
      fileNamingPattern.dataset.lastValue = previous;
      await refreshFileNamingPreview(previous);
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = error.message || 'Could not save file naming pattern.';
    }
  });
}

if (saveLibraryBtn) {
  saveLibraryBtn.addEventListener('click', async () => {
    settingsGlobalMessage.hidden = true;
    saveLibraryBtn.disabled = true;
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          primary_library_path: libraryPath ? libraryPath.value.trim() : '',
          library_paths: libraryScanPathsExtra
            ? libraryScanPathsExtra.value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        }),
      });
      const errData = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(errData.error || 'Save failed');
      }
      await loadSettings();
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Library folders saved.';
    } catch (error) {
      console.error(error);
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = error.message || 'Could not save.';
    } finally {
      saveLibraryBtn.disabled = false;
    }
  });
}

if (saveDownloadBtn) {
  saveDownloadBtn.addEventListener('click', async () => {
    settingsGlobalMessage.hidden = true;
    saveDownloadBtn.disabled = true;
    try {
      const mibRaw = slskdMaxFileMiB ? slskdMaxFileMiB.value.trim() : '';
      let slskd_max_file_size_bytes = null;
      if (mibRaw !== '') {
        const mib = Number(mibRaw);
        if (!Number.isFinite(mib) || mib < 1) {
          throw new Error('Max file size must be at least 1 MiB or empty.');
        }
        slskd_max_file_size_bytes = Math.floor(mib * 1024 * 1024);
      }

      const mc = parseInt(maxConcurrentDownloads?.value || '1', 10);
      const ma = parseInt(maxDownloadAttempts?.value || '3', 10);
      if (!Number.isFinite(mc) || mc < 1 || mc > 50) {
        throw new Error('Max simultaneous processing must be 1–50.');
      }
      if (!Number.isFinite(ma) || ma < 1 || ma > 20) {
        throw new Error('Max download attempts must be 1–20.');
      }

      const body = {
        slskd_local_download_path: slskdLocalPath ? slskdLocalPath.value.trim() : '',
        slskd_base_url: slskdBaseUrl ? slskdBaseUrl.value.trim() : '',
        slskd_auto_clear_completed_downloads: slskdAutoClearCompleted
          ? slskdAutoClearCompleted.checked
          : true,
        slskd_max_file_size_bytes,
        preferred_format: preferredFormat ? preferredFormat.value : 'prefer_mp3',
        max_concurrent_downloads: mc,
        max_download_attempts: ma,
      };

      if (slskdApiKey && slskdApiKey.value.trim()) {
        body.slskd_api_key = slskdApiKey.value.trim();
      }
      if (clearSlskdApiKey && clearSlskdApiKey.checked) {
        body.clear_slskd_api_key = true;
      }

      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const errData = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(errData.error || 'Save failed');
      }
      if (slskdApiKey) {
        slskdApiKey.value = '';
      }
      if (clearSlskdApiKey) {
        clearSlskdApiKey.checked = false;
      }
      await loadSettings();
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Download settings saved.';
    } catch (error) {
      console.error(error);
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = error.message || 'Could not save.';
    } finally {
      saveDownloadBtn.disabled = false;
    }
  });
}

if (savePlexBtn) {
  savePlexBtn.addEventListener('click', async () => {
    settingsGlobalMessage.hidden = true;
    savePlexBtn.disabled = true;
    try {
      const body = {
        plex_integration_enabled: plexIntegration ? plexIntegration.checked : false,
        plex_play_history_recommendations: plexPlayHistoryRecommendations
          ? plexPlayHistoryRecommendations.checked
          : false,
        plex_auth_enabled: plexAuthForLogin ? plexAuthForLogin.checked : false,
        plex_run_library_scan_before_sync: plexRunLibraryScanBeforeSync
          ? plexRunLibraryScanBeforeSync.checked
          : false,
        plex_url: plexUrl ? plexUrl.value.trim() : '',
        plex_music_section_id: plexMusicSectionId ? plexMusicSectionId.value.trim() || '4' : '4',
      };
      if (plexToken && plexToken.value.trim()) {
        body.plex_token = plexToken.value.trim();
      }
      if (clearPlexToken && clearPlexToken.checked) {
        body.clear_plex_token = true;
      }
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const errData = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(errData.error || 'Save failed');
      }
      if (plexToken) {
        plexToken.value = '';
      }
      if (clearPlexToken) {
        clearPlexToken.checked = false;
      }
      await loadSettings();
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Plex settings saved.';
    } catch (error) {
      console.error(error);
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = error.message || 'Could not save.';
    } finally {
      savePlexBtn.disabled = false;
    }
  });
}

if (testSlskdBtn) {
  testSlskdBtn.addEventListener('click', async () => {
    testSlskdMsg.textContent = 'Testing…';
    try {
      const res = await fetch('/api/settings/test-slskd', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed');
      }
      testSlskdMsg.textContent = 'Connected.';
    } catch (e) {
      testSlskdMsg.textContent = e.message || 'Failed.';
    }
  });
}

if (testPlexBtn) {
  testPlexBtn.addEventListener('click', async () => {
    testPlexMsg.textContent = 'Testing…';
    try {
      const res = await fetch('/api/settings/test-plex', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed');
      }
      testPlexMsg.textContent = 'Plex server and music library OK.';
    } catch (e) {
      testPlexMsg.textContent = e.message || 'Failed.';
    }
  });
}

async function loadAppVersionLabel() {
  if (!checkUpdateCurrentVersion) {
    return;
  }
  try {
    const res = await fetch('/api/settings/app-version', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.version) {
      checkUpdateCurrentVersion.textContent = data.version;
    }
  } catch {
    /* ignore */
  }
}

if (checkUpdateBtn && checkUpdateMsg) {
  checkUpdateBtn.addEventListener('click', async () => {
    checkUpdateMsg.textContent = 'Checking…';
    checkUpdateBtn.disabled = true;
    try {
      const res = await fetch('/api/settings/check-update', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Update check failed');
      }
      if (checkUpdateCurrentVersion && data.current) {
        checkUpdateCurrentVersion.textContent = data.current;
      }
      checkUpdateMsg.replaceChildren();
      if (data.updateAvailable) {
        checkUpdateMsg.append(
          document.createTextNode(
            `A newer version is available: ${data.latestTag} (current version: ${data.current}). `,
          ),
        );
        if (data.html_url) {
          const a = document.createElement('a');
          a.href = data.html_url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'View release';
          checkUpdateMsg.appendChild(a);
          checkUpdateMsg.appendChild(document.createTextNode('.'));
        }
      } else if (data.relation === 'equal') {
        checkUpdateMsg.textContent = `You are on the latest release (${data.latestTag}).`;
      } else if (data.relation === 'ahead') {
        checkUpdateMsg.textContent = `Current version (${data.current}) is newer than the latest GitHub release (${data.latestTag}).`;
      } else {
        checkUpdateMsg.textContent = `Latest on GitHub: ${data.latestTag}. Current version: ${data.current}. Version formats could not be compared automatically; see GitHub if unsure.`;
      }
    } catch (e) {
      checkUpdateMsg.textContent = e.message || 'Update check failed.';
    } finally {
      checkUpdateBtn.disabled = false;
    }
  });
}

if (discoverCacheRefreshMinutes) {
  discoverCacheRefreshMinutes.addEventListener('change', async () => {
    const n = parseInt(discoverCacheRefreshMinutes.value, 10);
    const prev = discoverCacheRefreshMinutes.dataset.lastValue || '240';
    if (!Number.isFinite(n) || n < 30 || n > 10080) {
      discoverCacheRefreshMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Discover cache refresh must be 30–10080 minutes.';
      return;
    }
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ discover_cache_refresh_minutes: Math.floor(n) }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Update failed');
      }
      discoverCacheRefreshMinutes.dataset.lastValue = String(Math.floor(n));
      settingsGlobalMessage.hidden = true;
    } catch (error) {
      console.error(error);
      discoverCacheRefreshMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = error.message || 'Could not save.';
    }
  });
}

if (followSyncIntervalMinutes) {
  followSyncIntervalMinutes.addEventListener('change', async () => {
    const n = parseInt(followSyncIntervalMinutes.value, 10);
    const prev = followSyncIntervalMinutes.dataset.lastValue || '120';
    if (!Number.isFinite(n) || n < 5 || n > 1440) {
      followSyncIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Follow sync interval must be 5–1440 minutes.';
      return;
    }
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ follow_sync_interval_minutes: Math.floor(n) }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Update failed');
      }
      followSyncIntervalMinutes.dataset.lastValue = String(Math.floor(n));
      settingsGlobalMessage.hidden = true;
    } catch (error) {
      console.error(error);
      followSyncIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = error.message || 'Could not save.';
    }
  });
}

async function postSettingsField(body) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || 'Update failed');
  }
  settingsGlobalMessage.hidden = true;
}

if (displayTimezone) {
  displayTimezone.addEventListener('change', async () => {
    const prev = displayTimezone.dataset.lastValue || 'UTC';
    try {
      await postSettingsField({ display_timezone: displayTimezone.value.trim() || 'UTC' });
      displayTimezone.dataset.lastValue = displayTimezone.value.trim() || 'UTC';
    } catch (e) {
      displayTimezone.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save timezone.';
    }
  });
}

if (followRequestsAutoApprove) {
  followRequestsAutoApprove.addEventListener('change', async () => {
    const v = followRequestsAutoApprove.checked;
    try {
      await postSettingsField({ follow_requests_auto_approve: v });
    } catch (e) {
      followRequestsAutoApprove.checked = !v;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (jukeboxRequestsAutoApprove) {
  jukeboxRequestsAutoApprove.addEventListener('change', async () => {
    const v = jukeboxRequestsAutoApprove.checked;
    try {
      await postSettingsField({ jukebox_requests_auto_approve: v });
    } catch (e) {
      jukeboxRequestsAutoApprove.checked = !v;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (completedRequestAutoClearDays) {
  completedRequestAutoClearDays.addEventListener('change', async () => {
    const n = parseInt(completedRequestAutoClearDays.value, 10);
    const prev = completedRequestAutoClearDays.dataset.lastValue || '0';
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      completedRequestAutoClearDays.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Value must be 0–3650.';
      return;
    }
    try {
      await postSettingsField({ completed_request_auto_clear_days: Math.floor(n) });
      completedRequestAutoClearDays.dataset.lastValue = String(Math.floor(n));
    } catch (e) {
      completedRequestAutoClearDays.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (failedRequestAutoRetryDays) {
  failedRequestAutoRetryDays.addEventListener('change', async () => {
    const n = parseInt(failedRequestAutoRetryDays.value, 10);
    const prev = failedRequestAutoRetryDays.dataset.lastValue || '0';
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      failedRequestAutoRetryDays.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Value must be 0–3650.';
      return;
    }
    try {
      await postSettingsField({ failed_request_auto_retry_days: Math.floor(n) });
      failedRequestAutoRetryDays.dataset.lastValue = String(Math.floor(n));
    } catch (e) {
      failedRequestAutoRetryDays.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (plexPlayHistoryRecommendations) {
  plexPlayHistoryRecommendations.addEventListener('change', async () => {
    const v = plexPlayHistoryRecommendations.checked;
    try {
      await postSettingsField({ plex_play_history_recommendations: v });
    } catch (e) {
      plexPlayHistoryRecommendations.checked = !v;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (plexIntegration) {
  plexIntegration.addEventListener('change', async () => {
    const v = plexIntegration.checked;
    try {
      await postBooleanSetting('plex_integration_enabled', v);
      syncPlexJobRowDisabledState();
    } catch (e) {
      plexIntegration.checked = !v;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (plexAuthForLogin) {
  plexAuthForLogin.addEventListener('change', async () => {
    const v = plexAuthForLogin.checked;
    try {
      await postBooleanSetting('plex_auth_enabled', v);
    } catch (e) {
      plexAuthForLogin.checked = !v;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (plexRunLibraryScanBeforeSync) {
  plexRunLibraryScanBeforeSync.addEventListener('change', async () => {
    const v = plexRunLibraryScanBeforeSync.checked;
    try {
      await postBooleanSetting('plex_run_library_scan_before_sync', v);
    } catch (e) {
      plexRunLibraryScanBeforeSync.checked = !v;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

function wireJobBooleanCheckbox(el, apiKey) {
  if (!el) return;
  el.addEventListener('change', async () => {
    const v = el.checked;
    try {
      await postSettingsField({ [apiKey]: v });
    } catch (e) {
      el.checked = !v;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

wireJobBooleanCheckbox(jobDiscoverCacheEnabled, 'job_discover_cache_enabled');
wireJobBooleanCheckbox(jobLibraryScanEnabled, 'job_library_scan_enabled');
wireJobBooleanCheckbox(jobFollowSyncEnabled, 'job_follow_sync_enabled');
wireJobBooleanCheckbox(jobPlexSyncEnabled, 'job_plex_sync_enabled');
wireJobBooleanCheckbox(jobCompletedRequestClearEnabled, 'job_completed_request_clear_enabled');
wireJobBooleanCheckbox(jobStatusEmailEnabled, 'job_status_email_enabled');

if (statusEmailIntervalMinutes) {
  statusEmailIntervalMinutes.addEventListener('change', async () => {
    const n = parseInt(statusEmailIntervalMinutes.value, 10);
    const prev = statusEmailIntervalMinutes.dataset.lastValue || '1440';
    if (!Number.isFinite(n) || n < 240 || n > 10080) {
      statusEmailIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Status email interval must be 240–10080 minutes (4 hours–1 week).';
      return;
    }
    try {
      await postSettingsField({ status_email_interval_minutes: Math.floor(n) });
      statusEmailIntervalMinutes.dataset.lastValue = String(Math.floor(n));
      settingsGlobalMessage.hidden = true;
    } catch (e) {
      statusEmailIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

function collectEmailFormPayload() {
  const portRaw = smtpPort ? parseInt(smtpPort.value, 10) : 587;
  if (!Number.isFinite(portRaw) || portRaw < 1 || portRaw > 65535) {
    return { error: 'SMTP port must be 1–65535.' };
  }
  const payload = {
    smtp_host: smtpHost ? smtpHost.value.trim() : '',
    smtp_port: Math.floor(portRaw),
    smtp_secure: Boolean(smtpSecure?.checked),
    smtp_user: smtpUser ? smtpUser.value.trim() : '',
    email_from_address: emailFromAddress ? emailFromAddress.value.trim() : '',
    status_email_to: statusEmailTo ? statusEmailTo.value.trim() : '',
    clear_smtp_password: Boolean(clearSmtpPassword?.checked),
  };
  if (smtpPassword && smtpPassword.value.trim()) {
    payload.smtp_password = smtpPassword.value;
  }
  return { payload };
}

if (saveEmailBtn) {
  saveEmailBtn.addEventListener('click', async () => {
    if (saveEmailMsg) {
      saveEmailMsg.textContent = '';
    }
    if (testEmailMsg) {
      testEmailMsg.textContent = '';
    }
    settingsGlobalMessage.hidden = true;
    const collected = collectEmailFormPayload();
    if (collected.error) {
      if (saveEmailMsg) {
        saveEmailMsg.textContent = collected.error;
      }
      return;
    }
    saveEmailBtn.disabled = true;
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(collected.payload),
      });
      const errData = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(errData.error || 'Save failed');
      }
      await loadSettings();
      if (saveEmailMsg) {
        saveEmailMsg.textContent = 'Saved.';
      }
    } catch (e) {
      if (saveEmailMsg) {
        saveEmailMsg.textContent = e.message || 'Save failed.';
      }
    } finally {
      saveEmailBtn.disabled = false;
    }
  });
}

if (testEmailBtn) {
  testEmailBtn.addEventListener('click', async () => {
    if (testEmailMsg) {
      testEmailMsg.textContent = '';
    }
    if (saveEmailMsg) {
      saveEmailMsg.textContent = '';
    }
    settingsGlobalMessage.hidden = true;
    const collected = collectEmailFormPayload();
    if (collected.error) {
      if (testEmailMsg) {
        testEmailMsg.textContent = collected.error;
      }
      return;
    }
    testEmailBtn.disabled = true;
    testEmailMsg.textContent = 'Sending…';
    try {
      const res = await fetch('/api/settings/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(collected.payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Test failed');
      }
      testEmailMsg.textContent = 'Sent. Check the inbox for your recipients.';
    } catch (e) {
      testEmailMsg.textContent = e.message || 'Test failed.';
    } finally {
      testEmailBtn.disabled = false;
    }
  });
}

if (orphanCleanupEnabled) {
  orphanCleanupEnabled.addEventListener('change', async () => {
    const v = orphanCleanupEnabled.checked;
    try {
      await postSettingsField({ slskd_orphan_cleanup_enabled: v });
    } catch (e) {
      orphanCleanupEnabled.checked = !v;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (orphanCleanupIntervalMinutes) {
  orphanCleanupIntervalMinutes.addEventListener('change', async () => {
    const n = parseInt(orphanCleanupIntervalMinutes.value, 10);
    const prev = orphanCleanupIntervalMinutes.dataset.lastValue || '240';
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      orphanCleanupIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Orphan cleanup interval must be 1–1440 minutes.';
      return;
    }
    try {
      await postSettingsField({
        slskd_orphan_cleanup_interval_minutes: Math.floor(n),
        slskd_orphan_cleanup_interval_ms: null,
        slskd_orphan_cleanup_interval_hours: null,
      });
      orphanCleanupIntervalMinutes.dataset.lastValue = String(Math.floor(n));
    } catch (e) {
      orphanCleanupIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (libraryScanIntervalMinutes) {
  libraryScanIntervalMinutes.addEventListener('change', async () => {
    const n = parseInt(libraryScanIntervalMinutes.value, 10);
    const prev = libraryScanIntervalMinutes.dataset.lastValue || '60';
    if (!Number.isFinite(n) || n < 5 || n > 1440) {
      libraryScanIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Library scan interval must be 5–1440 minutes.';
      return;
    }
    try {
      await postSettingsField({ library_scan_interval_minutes: Math.floor(n) });
      libraryScanIntervalMinutes.dataset.lastValue = String(Math.floor(n));
    } catch (e) {
      libraryScanIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (plexScanIntervalMinutes) {
  plexScanIntervalMinutes.addEventListener('change', async () => {
    const n = parseInt(plexScanIntervalMinutes.value, 10);
    const prev = plexScanIntervalMinutes.dataset.lastValue || '30';
    if (!Number.isFinite(n) || n < 5 || n > 720) {
      plexScanIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Plex Sync interval must be 5–720 minutes.';
      return;
    }
    try {
      await postSettingsField({ plex_scan_interval_minutes: Math.floor(n) });
      plexScanIntervalMinutes.dataset.lastValue = String(Math.floor(n));
    } catch (e) {
      plexScanIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

if (jobCompletedRequestClearIntervalMinutes) {
  jobCompletedRequestClearIntervalMinutes.addEventListener('change', async () => {
    const n = parseInt(jobCompletedRequestClearIntervalMinutes.value, 10);
    const prev = jobCompletedRequestClearIntervalMinutes.dataset.lastValue || '1440';
    if (!Number.isFinite(n) || n < 5 || n > 10080) {
      jobCompletedRequestClearIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = 'Interval must be 5–10080 minutes.';
      return;
    }
    try {
      await postSettingsField({ job_completed_request_clear_interval_minutes: Math.floor(n) });
      jobCompletedRequestClearIntervalMinutes.dataset.lastValue = String(Math.floor(n));
    } catch (e) {
      jobCompletedRequestClearIntervalMinutes.value = prev;
      settingsGlobalMessage.hidden = false;
      settingsGlobalMessage.textContent = e.message || 'Could not save.';
    }
  });
}

document.querySelectorAll('.job-run-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const url = btn.getAttribute('data-trigger');
    if (!url) {
      return;
    }
    if (settingsGlobalMessage) {
      settingsGlobalMessage.hidden = true;
      settingsGlobalMessage.classList.remove('is-info');
    }
    btn.disabled = true;
    try {
      const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      const isPlexManualSync =
        url.includes('plex-sync') || url.includes('plex-scan') || url.includes('plex-playlist-sync');
      if (res.ok && isPlexManualSync && (res.status === 202 || data.started)) {
        if (settingsGlobalMessage) {
          settingsGlobalMessage.hidden = false;
          settingsGlobalMessage.classList.add('is-info');
          settingsGlobalMessage.textContent =
            data.message ||
            'Plex sync started in the background. Check job status when it completes.';
        }
        await loadSettings();
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || 'Failed');
      }
      await loadSettings();
    } catch (e) {
      if (settingsGlobalMessage) {
        settingsGlobalMessage.hidden = false;
        settingsGlobalMessage.classList.remove('is-info');
        settingsGlobalMessage.textContent = e.message || 'Job failed.';
      }
    } finally {
      btn.disabled = false;
      if (
        (url.includes('plex-sync') || url.includes('plex-scan') || url.includes('plex-playlist-sync')) &&
        plexIntegration &&
        !plexIntegration.checked
      ) {
        btn.disabled = true;
      }
    }
  });
});

function initSettingsTabs() {
  const tabs = [...document.querySelectorAll('.settings-tab[data-panel]')];
  const panels = {
    general: document.getElementById('settings-panel-general'),
    users: document.getElementById('settings-panel-users'),
    download: document.getElementById('settings-panel-download'),
    integrations: document.getElementById('settings-panel-integrations'),
    jobs: document.getElementById('settings-panel-jobs'),
  };
  if (!tabs.length || !panels.general) {
    return;
  }

  function activate(which) {
    for (const t of tabs) {
      const id = t.getAttribute('data-panel');
      const on = id === which;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const [key, panel] of Object.entries(panels)) {
      if (panel) {
        panel.hidden = key !== which;
      }
    }
  }

  for (const t of tabs) {
    t.addEventListener('click', () => {
      const id = t.getAttribute('data-panel') || 'general';
      activate(id);
      if (id === 'users') {
        void loadUsersTable();
      }
      if (id === 'jobs') {
        void refreshJobScheduleFromServer();
      }
    });
  }
}

const usersTableBody = document.getElementById('usersTableBody');
const addUserForm = document.getElementById('addUserForm');
const usersFormMessage = document.getElementById('usersFormMessage');

function appendPasswordRevealControls(parent, u) {
  const pwWrap = document.createElement('span');
  pwWrap.className = 'users-password-editor';

  const pw = document.createElement('input');
  pw.type = 'password';
  pw.placeholder = 'New password';
  pw.setAttribute('autocomplete', 'new-password');

  const savePw = document.createElement('button');
  savePw.type = 'button';
  savePw.textContent = 'Save';

  async function applyPassword() {
    if (!pw.value || pw.value.length < 6) {
      if (usersFormMessage) {
        usersFormMessage.textContent = 'Password must be at least 6 characters.';
      }
      return;
    }
    try {
      const r = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: pw.value }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || 'Failed');
      }
      pw.value = '';
      pwWrap.classList.remove('is-open');
      togglePw.textContent = 'Set password';
      if (usersFormMessage) {
        usersFormMessage.textContent = `Password updated for ${u.username}.`;
      }
    } catch (e) {
      if (usersFormMessage) {
        usersFormMessage.textContent = e.message || 'Password update failed';
      }
    }
  }

  savePw.addEventListener('click', () => void applyPassword());

  const togglePw = document.createElement('button');
  togglePw.type = 'button';
  togglePw.textContent = 'Set password';
  togglePw.addEventListener('click', () => {
    const open = pwWrap.classList.contains('is-open');
    if (open) {
      pwWrap.classList.remove('is-open');
      pw.value = '';
      togglePw.textContent = 'Set password';
    } else {
      pwWrap.classList.add('is-open');
      togglePw.textContent = 'Cancel';
      pw.focus();
    }
  });

  pwWrap.appendChild(pw);
  pwWrap.appendChild(savePw);
  parent.appendChild(togglePw);
  parent.appendChild(pwWrap);
}

function appendUserDeleteButton(parent, u) {
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) {
      return;
    }
    try {
      const r = await fetch(`/api/users/${u.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || 'Delete failed');
      }
      await loadUsersTable();
      if (usersFormMessage) {
        usersFormMessage.textContent = '';
      }
    } catch (e) {
      if (usersFormMessage) {
        usersFormMessage.textContent = e.message || 'Delete failed';
      }
    }
  });
  parent.appendChild(del);
}

async function loadUsersTable() {
  if (!usersTableBody) {
    return;
  }
  usersTableBody.innerHTML = '';
  try {
    const res = await fetch('/api/users', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to load users');
    }
    const rows = Array.isArray(data.results) ? data.results : [];
    for (const u of rows) {
      const tr = document.createElement('tr');
      const tdUser = document.createElement('td');
      tdUser.textContent = u.username;
      const tdRole = document.createElement('td');
      const isSys = Boolean(u.is_system_admin);
      if (isSys) {
        tdRole.textContent = u.role;
      } else {
        const sel = document.createElement('select');
        sel.innerHTML = `<option value="user">User</option><option value="admin">Admin</option>`;
        sel.value = u.role === 'admin' ? 'admin' : 'user';
        sel.addEventListener('change', async () => {
          try {
            const r = await fetch(`/api/users/${u.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ role: sel.value }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || 'Update failed');
            }
            usersFormMessage.textContent = '';
          } catch (e) {
            usersFormMessage.textContent = e.message || 'Role update failed';
            sel.value = u.role === 'admin' ? 'admin' : 'user';
          }
        });
        tdRole.appendChild(sel);
      }

      const tdJuke = document.createElement('td');
      const jbCb = document.createElement('input');
      jbCb.type = 'checkbox';
      jbCb.checked = Boolean(u.jukebox_enabled);
      jbCb.setAttribute('aria-label', `Jukebox access for ${u.username}`);
      jbCb.addEventListener('change', async () => {
        try {
          const r = await fetch(`/api/users/${u.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ jukebox_enabled: jbCb.checked }),
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.error || 'Update failed');
          }
          usersFormMessage.textContent = '';
        } catch (e) {
          usersFormMessage.textContent = e.message || 'Jukebox setting update failed';
          jbCb.checked = !jbCb.checked;
        }
      });
      tdJuke.appendChild(jbCb);

      const tdProvider = document.createElement('td');
      tdProvider.textContent =
        u.auth_provider === 'plex' ? 'Plex' : u.auth_provider === 'local' ? 'Local' : u.auth_provider || 'local';
      const isPlex = String(u.auth_provider || '').toLowerCase() === 'plex';
      const tdAct = document.createElement('td');
      if (isPlex) {
        tdAct.className = 'settings-users-actions';
        appendUserDeleteButton(tdAct, u);
      } else {
        tdAct.className = 'settings-users-actions';
        if (isSys) {
          appendPasswordRevealControls(tdAct, u);
        } else {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Edit';
        edit.addEventListener('click', async () => {
          const next = window.prompt('New username', u.username);
          if (next == null) {
            return;
          }
          const trimmed = String(next).trim();
          if (!trimmed || trimmed === u.username) {
            return;
          }
          try {
            const r = await fetch(`/api/users/${u.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ username: trimmed }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || 'Update failed');
            }
            usersFormMessage.textContent = 'Username updated.';
            await loadUsersTable();
          } catch (e) {
            usersFormMessage.textContent = e.message || 'Username update failed';
          }
        });
        appendPasswordRevealControls(tdAct, u);
        tdAct.appendChild(edit);
        appendUserDeleteButton(tdAct, u);
        }
      }
      tr.appendChild(tdUser);
      tr.appendChild(tdProvider);
      tr.appendChild(tdRole);
      tr.appendChild(tdJuke);
      tr.appendChild(tdAct);
      usersTableBody.appendChild(tr);
    }
  } catch (e) {
    usersTableBody.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = e.message || 'Could not load users';
    tr.appendChild(td);
    usersTableBody.appendChild(tr);
  }
}

if (addUserForm) {
  addUserForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const usernameEl = document.getElementById('newUsername');
    const passwordEl = document.getElementById('newPassword');
    const roleEl = document.getElementById('newUserRole');
    if (!usernameEl || !passwordEl || !roleEl) {
      return;
    }
    usersFormMessage.textContent = '';
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: usernameEl.value.trim(),
          password: passwordEl.value,
          role: roleEl.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Create failed');
      }
      usernameEl.value = '';
      passwordEl.value = '';
      roleEl.value = 'user';
      await loadUsersTable();
      usersFormMessage.textContent = 'User created.';
    } catch (e) {
      usersFormMessage.textContent = e.message || 'Could not create user';
    }
  });
}

if (openManualImportBtn) {
  openManualImportBtn.addEventListener('click', () => {
    window.location.assign('/manual-import.html');
  });
}

if (__tfMe?.role === 'admin') {
  initSettingsTabs();
  loadSettings();
  void loadAppVersionLabel();
}
