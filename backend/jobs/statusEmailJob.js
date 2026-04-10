/**
 * Sends a periodic HTML digest to admins (requests + job telemetry).
 */

const nodemailer = require('nodemailer');
const { getDb } = require('../db');
const { buildJobScheduleStatusPayload, JOB_KEYS } = require('../services/jobScheduleTelemetry');

const db = getDb();

const requestOverviewStmt = db.prepare(`
  SELECT
    SUM(CASE WHEN status IN ('pending', 'requested') THEN 1 ELSE 0 END) AS requested,
    SUM(CASE WHEN status = 'processing' AND IFNULL(cancelled, 0) = 0 THEN 1 ELSE 0 END) AS processing,
    SUM(
      CASE
        WHEN status = 'failed' AND IFNULL(cancelled, 0) = 0 THEN 1
        WHEN IFNULL(cancelled, 0) = 1 AND status IN ('failed', 'processing') THEN 1
        ELSE 0
      END
    ) AS needs_attention,
    SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied,
    SUM(CASE WHEN status IN ('completed', 'available') THEN 1 ELSE 0 END) AS completed,
    COUNT(*) AS total
  FROM requests
`);

const pendingPlaylistFollowsStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM followed_playlists WHERE follow_status = 'pending'
`);
const pendingArtistFollowsStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM followed_artists WHERE follow_status = 'pending'
`);

const JOB_EMAIL_LABELS = {
  [JOB_KEYS.discover_cache]: 'Refresh discover and recommendations cache',
  [JOB_KEYS.library_scan]: 'Scan library files in folder',
  [JOB_KEYS.follow_sync]: 'Sync followed artists and playlists tracks',
  [JOB_KEYS.orphan_cleanup]: 'Completed download folder cleanup',
  [JOB_KEYS.completed_request_clear]: 'Clear completed requests and retry failed',
  [JOB_KEYS.status_email]: 'Send status email (digest)',
  [JOB_KEYS.plex_sync]: 'Plex Sync (rating keys + playlists)',
};

const JOB_EMAIL_ORDER = [
  JOB_KEYS.discover_cache,
  JOB_KEYS.library_scan,
  JOB_KEYS.follow_sync,
  JOB_KEYS.orphan_cleanup,
  JOB_KEYS.completed_request_clear,
  JOB_KEYS.status_email,
  JOB_KEYS.plex_sync,
];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatVersionWithVPrefix(version) {
  const s = String(version || '').trim() || '0.0.0';
  return /^v\d/i.test(s) ? (s.startsWith('V') ? `v${s.slice(1)}` : s) : `v${s}`;
}

function formatReleaseTagForDisplay(tag) {
  const t = String(tag || '').trim();
  if (!t) {
    return '';
  }
  return /^v\d/i.test(t) ? (t.startsWith('V') ? `v${t.slice(1)}` : t) : `v${t}`;
}

/**
 * Plain-text line for the digest (escaped for HTML). Uses GitHub latest release when reachable.
 */
async function buildDigestVersionLineHtmlEscaped() {
  const { readLocalPackageVersion, checkTrackflowUpdate } = require('../services/trackflowUpdateCheck');
  const cur = formatVersionWithVPrefix(readLocalPackageVersion());
  try {
    const u = await checkTrackflowUpdate();
    if (u.updateAvailable) {
      const lt = formatReleaseTagForDisplay(u.latestTag);
      return escapeHtml(`New Version Available (${lt || u.latestTag})`);
    }
    return escapeHtml(`Current version: ${cur} - Up to date`);
  } catch {
    return escapeHtml(`Current version: ${cur} - Update check unavailable`);
  }
}

function parseRecipients(raw) {
  return String(raw || '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Mirrors Settings `display_timezone` validation (IANA or `UTC`). */
function resolveDisplayTimezone(row) {
  const s = String(row?.display_timezone ?? '').trim();
  if (!s || s.length > 80 || !/^[\w/+\-]+$/.test(s)) {
    return 'UTC';
  }
  return s;
}

function formatDigestTimestamp(iso, timeZone) {
  if (!iso || typeof iso !== 'string') {
    return '—';
  }
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) {
    return '—';
  }
  const tz = timeZone && String(timeZone).trim() ? String(timeZone).trim() : 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: tz,
    }).format(new Date(d));
  } catch {
    try {
      return new Intl.DateTimeFormat('en-US', {
        dateStyle: 'short',
        timeStyle: 'medium',
        timeZone: 'UTC',
      }).format(new Date(d));
    } catch {
      return new Date(d).toISOString();
    }
  }
}

function isStatusEmailDeliveryReady(row) {
  if (!row || Number(row.job_status_email_enabled) !== 1) {
    return false;
  }
  const host = String(row.smtp_host || '').trim();
  const fromAddr = String(row.email_from_address || '').trim();
  const to = String(row.status_email_to || '').trim();
  return Boolean(host && fromAddr && to);
}

function buildTransporter(row) {
  const port = Number(row.smtp_port);
  const p = Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.floor(port) : 587;
  const secure = Number(row.smtp_secure) === 1;
  const user = String(row.smtp_user || '').trim();
  const pass = row.smtp_password != null ? String(row.smtp_password) : '';
  return nodemailer.createTransport({
    host: String(row.smtp_host).trim(),
    port: p,
    secure,
    auth: user ? { user, pass: pass || undefined } : undefined,
  });
}

function rowHtml(rows) {
  const parts = [];
  for (const [label, value] of rows) {
    parts.push(
      `<tr><td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;color:#3f3f46">${escapeHtml(
        label,
      )}</td><td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;font-weight:600;text-align:right">${escapeHtml(
        String(value),
      )}</td></tr>`,
    );
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:480px;background:#fafafa;border-radius:8px;overflow:hidden">${parts.join('')}</table>`;
}

function formatJobCell(entry, kind, timeZone) {
  if (!entry || typeof entry !== 'object') {
    return '—';
  }
  if (kind === 'next') {
    if (!entry.schedule_active) {
      return entry.schedule_note || 'Off';
    }
    if (entry.next_scheduled_at) {
      return formatDigestTimestamp(entry.next_scheduled_at, timeZone);
    }
    return 'Not yet run';
  }
  if (kind === 'result') {
    const r = entry.last_result;
    if (r === 'success') {
      return 'Success';
    }
    if (r === 'failure') {
      return entry.last_error ? `Failure: ${entry.last_error}` : 'Failure';
    }
    return '—';
  }
  if (entry.last_run_at) {
    return formatDigestTimestamp(entry.last_run_at, timeZone);
  }
  return '—';
}

function jobsTableHtml(schedulePayload, timeZone) {
  const head =
    '<tr style="background:#27272a;color:#fafafa"><th style="padding:10px 8px;text-align:left">Job</th><th style="padding:10px 8px;text-align:left">Last Run</th><th style="padding:10px 8px;text-align:left">Result</th><th style="padding:10px 8px;text-align:left">Next Run</th></tr>';
  const body = [];
  for (const key of JOB_EMAIL_ORDER) {
    const entry = schedulePayload[key];
    const name = JOB_EMAIL_LABELS[key] || key;
    body.push(
      `<tr><td style="padding:8px;border-bottom:1px solid #e4e4e7">${escapeHtml(name)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #e4e4e7;font-size:13px">${escapeHtml(
          formatJobCell(entry, 'last', timeZone),
        )}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #e4e4e7;font-size:13px">${escapeHtml(
          formatJobCell(entry, 'result', timeZone),
        )}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #e4e4e7;font-size:13px">${escapeHtml(
          formatJobCell(entry, 'next', timeZone),
        )}</td></tr>`,
    );
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:720px;margin-top:8px">${head}${body.join('')}</table>`;
}

function buildDigestHtml({
  overview,
  pendingPlaylists,
  pendingArtists,
  schedulePayload,
  timeZone,
  versionLineHtml,
}) {
  const reqRows = [
    ['Pending', overview.requested || 0],
    ['Processing', overview.processing || 0],
    ['Needs Attention', overview.needs_attention || 0],
    ['Denied', overview.denied || 0],
    ['Completed', overview.completed || 0],
    ['Total Requests', overview.total || 0],
  ];
  let followBlock = '';
  if ((pendingPlaylists || 0) > 0 || (pendingArtists || 0) > 0) {
    followBlock = `<p style="margin:16px 0 8px;font-size:15px;font-weight:600;color:#18181b">Follow Requests</p>${rowHtml([
      ['Playlists awaiting approval', pendingPlaylists || 0],
      ['Artists awaiting approval', pendingArtists || 0],
    ])}`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f5;color:#18181b">
  <div style="max-width:720px;margin:0 auto">
    <h1 style="margin:0 0 12px;font-size:22px">TrackFlow status</h1>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.5">${versionLineHtml}</p>
    <h2 style="margin:0 0 8px;font-size:16px;font-weight:600">Track Requests</h2>
    ${rowHtml(reqRows)}
    ${followBlock}
    <h2 style="margin:24px 0 8px;font-size:16px;font-weight:600">Background Jobs</h2>
    ${jobsTableHtml(schedulePayload, timeZone)}
    <p style="margin-top:28px;font-size:12px;color:#a1a1aa">This message was sent by TrackFlow.</p>
  </div></body></html>`;
}

/**
 * @returns {Promise<{ ok: true, messageId?: string }>}
 */
async function runStatusEmailJob() {
  const row = db.prepare(`SELECT * FROM settings WHERE id = 1`).get();
  if (!isStatusEmailDeliveryReady(row)) {
    throw new Error('Status email is not enabled or SMTP/recipients are incomplete.');
  }

  const overview = requestOverviewStmt.get() || {};
  const pp = pendingPlaylistFollowsStmt.get();
  const pa = pendingArtistFollowsStmt.get();
  const pendingPlaylists = Number(pp?.n) || 0;
  const pendingArtists = Number(pa?.n) || 0;
  const schedulePayload = buildJobScheduleStatusPayload(row);
  const timeZone = resolveDisplayTimezone(row);
  const versionLineHtml = await buildDigestVersionLineHtmlEscaped();
  const html = buildDigestHtml({
    overview,
    pendingPlaylists,
    pendingArtists,
    schedulePayload,
    timeZone,
    versionLineHtml,
  });

  const transporter = buildTransporter(row);
  const toList = parseRecipients(row.status_email_to);
  const info = await transporter.sendMail({
    from: String(row.email_from_address).trim(),
    to: toList.join(', '),
    subject: 'TrackFlow Digest',
    html,
  });
  return { ok: true, messageId: info.messageId };
}

/**
 * Send a one-off test message (does not require the status email job to be enabled).
 * @param {object} row — merged SMTP + from + recipients (same shape as settings row fields)
 */
async function sendTestStatusEmail(row) {
  const host = String(row?.smtp_host || '').trim();
  const fromAddr = String(row?.email_from_address || '').trim();
  const toRaw = String(row?.status_email_to || '').trim();
  if (!host) {
    throw new Error('SMTP host is required.');
  }
  if (!fromAddr) {
    throw new Error('From address is required.');
  }
  const toList = parseRecipients(toRaw);
  if (!toList.length) {
    throw new Error('At least one status email recipient is required.');
  }
  const transporter = buildTransporter({ ...row, smtp_host: host });
  await transporter.sendMail({
    from: fromAddr,
    to: toList.join(', '),
    subject: 'TrackFlow test email',
    text: 'This is a test message from TrackFlow. If you received it, SMTP settings are working.',
    html: '<p>This is a test message from <strong>TrackFlow</strong>. If you received it, SMTP settings are working.</p>',
  });
}

module.exports = {
  runStatusEmailJob,
  isStatusEmailDeliveryReady,
  sendTestStatusEmail,
};
