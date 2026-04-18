import '../js/request-display-shared.js';
import { ensureLoggedIn } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await initAppNavAuth(__tfMe);

const isAdmin = __tfMe?.role === 'admin';
if (isAdmin) {
  document.body.classList.add('admin-view');
}
const sessionUserIdStr = __tfMe?.id != null ? String(__tfMe.id) : '';

let displayTimezone = 'UTC';
let currentResults = [];
let currentFollowRows = [];

const requestsBody = document.getElementById('requestsBody');
const followRequestsBody = document.getElementById('followRequestsBody');
const trackFilterChecks = [...document.querySelectorAll('input[data-track-filter]')];
const followFilterChecks = [...document.querySelectorAll('input[data-follow-filter]')];
const trackFilterAll = document.querySelector('input[data-track-filter-all]');
const followFilterAll = document.querySelector('input[data-follow-filter-all]');
const trackFilterBtn = document.getElementById('trackFilterBtn');
const followFilterBtn = document.getElementById('followFilterBtn');
const trackFilterMenu = document.getElementById('trackFilterMenu');
const followFilterMenu = document.getElementById('followFilterMenu');

const followApproveAllBtn = document.getElementById('followApproveAllBtn');
const followDenyAllBtn = document.getElementById('followDenyAllBtn');
const followClearStatusSelect = document.getElementById('followClearStatusSelect');
const followClearStatusBtn = document.getElementById('followClearStatusBtn');
const followBulkSummary = document.getElementById('followBulkSummary');
const followBulkButtons = [followApproveAllBtn, followDenyAllBtn, followClearStatusBtn].filter(Boolean);

const approveAllBtn = document.getElementById('approveAllBtn');
const cancelAllBtn = document.getElementById('cancelAllBtn');
const denyAllBtn = document.getElementById('denyAllBtn');
const retryFailedBtn = document.getElementById('retryFailedBtn');
const trackClearStatusSelect = document.getElementById('trackClearStatusSelect');
const trackClearStatusBtn = document.getElementById('trackClearStatusBtn');
const trackBulkSummary = document.getElementById('trackBulkSummary');
const trackBulkButtons = [approveAllBtn, cancelAllBtn, denyAllBtn, retryFailedBtn, trackClearStatusBtn].filter(Boolean);

const activeColSpan = isAdmin ? 10 : 9;
const followRequestsColSpan = 6;

let sortState = { key: 'title', dir: 'asc' };

const TRACK_FILTER_DEFAULTS = new Set(['pending', 'processing']);
const FOLLOW_FILTER_DEFAULTS = new Set(['pending']);

function checkedValues(checks, attrName) {
  const out = new Set();
  for (const check of checks) {
    if (check.checked) {
      out.add(String(check.getAttribute(attrName) || '').trim());
    }
  }
  return out;
}

function setDefaultChecks(checks, attrName, defaults) {
  for (const check of checks) {
    const key = String(check.getAttribute(attrName) || '').trim();
    check.checked = defaults.has(key);
  }
}

function wireAutoApplyChecks(checks, allCheck, attrName, onChange) {
  const syncAll = () => {
    const allOn = checks.length > 0 && checks.every((c) => c.checked);
    if (allCheck) {
      allCheck.checked = allOn;
    }
  };
  for (const check of checks) {
    check.addEventListener('change', () => {
      const active = checkedValues(checks, attrName);
      if (active.size === 0) {
        check.checked = true;
      }
      syncAll();
      onChange();
    });
  }
  if (allCheck) {
    allCheck.addEventListener('change', () => {
      for (const check of checks) {
        check.checked = allCheck.checked;
      }
      if (!allCheck.checked && checks[0]) {
        checks[0].checked = true;
      }
      syncAll();
      onChange();
    });
  }
  syncAll();
}

function wireFilterDropdown(triggerEl, menuEl) {
  if (!triggerEl || !menuEl) {
    return;
  }
  triggerEl.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menuEl.hidden = !menuEl.hidden;
  });
  menuEl.addEventListener('click', (ev) => {
    ev.stopPropagation();
  });
  document.addEventListener('click', () => {
    menuEl.hidden = true;
  });
}

function setBulkSummary(el, text, variant) {
  if (!el) {
    return;
  }
  el.textContent = text || '';
  el.classList.remove('is-error', 'is-success');
  if (variant === 'error') {
    el.classList.add('is-error');
  } else if (variant === 'success') {
    el.classList.add('is-success');
  }
}

function setBulkRunning(buttons, running) {
  for (const btn of buttons) {
    if (btn) {
      btn.disabled = running;
    }
  }
}

async function runBulkPost(path, confirmMessage, formatSuccess, options = {}) {
  const summaryEl = options.summaryEl;
  const buttons = options.buttons || [];
  const body = options.body || {};
  if (!window.confirm(confirmMessage)) {
    return;
  }
  setBulkRunning(buttons, true);
  setBulkSummary(summaryEl, 'Working...', null);
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || 'Request failed');
    }
    const msg = typeof formatSuccess === 'function' ? formatSuccess(data) : `${Number(data.updated) || 0} updated`;
    setBulkSummary(summaryEl, msg, 'success');
    await loadAll();
  } catch (err) {
    console.error('Bulk action failed:', err);
    setBulkSummary(summaryEl, err?.message || 'Failed', 'error');
  } finally {
    setBulkRunning(buttons, false);
  }
}

function displayRequestSource(requestType) {
  const s = String(requestType || 'Track').trim();
  return s || 'Track';
}

function parseDbTimestampAsUtc(value) {
  if (value == null || value === '') {
    return null;
  }
  const s = String(value).trim();
  if (!s) {
    return null;
  }
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(`${normalized}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime(iso) {
  const d = parseDbTimestampAsUtc(iso);
  if (!d) {
    return iso ? String(iso) : '';
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: displayTimezone || 'UTC',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

function applyComputeDisplay(rows) {
  return rows.map((r) => {
    const hasDisplay = r.displayStatus != null && r.displayStatus !== '' && r.processingStatus != null;
    if (hasDisplay) {
      return r;
    }
    const d = window.TrackFlowRequestDisplay.computeDisplayFields(r);
    return { ...r, displayStatus: d.displayStatus, processingStatus: d.processingStatus };
  });
}

function normalizeTrackFilterToken(row) {
  const display = String(row.displayStatus || '').toLowerCase();
  const st = String(row.status || '').toLowerCase();
  const cancelled = Number(row.cancelled) === 1;
  if (st === 'pending' || st === 'requested') return 'pending';
  if (st === 'processing' && cancelled) return 'needs_attention';
  if (st === 'processing') return 'processing';
  if (display === 'available' || st === 'available' || st === 'completed') return 'available';
  if (
    display === 'needs attention' ||
    (st === 'failed' && cancelled) ||
    (st === 'failed' && !cancelled)
  ) {
    return 'needs_attention';
  }
  if (display === 'denied' || st === 'denied') return 'denied';
  return '';
}

function normalizeFollowFilterToken(row) {
  const s = String(row.followStatus || '').toLowerCase();
  if (s === 'pending' || s === 'approved' || s === 'denied') return s;
  return 'pending';
}

function getSortValue(row, key) {
  switch (key) {
    case 'title': return row.title ?? '';
    case 'artist': return row.artist ?? '';
    case 'album': return row.album ?? '';
    case 'user': return row.requested_by_username ?? '';
    case 'source': return displayRequestSource(row.request_type);
    case 'requested': return row.created_at ?? '';
    case 'processed': return row.processed_at ?? '';
    case 'status': return row.displayStatus ?? '';
    case 'processing': return row.processingStatus ?? '';
    default: return '';
  }
}

function compareRows(a, b, key, dir) {
  const sa = String(getSortValue(a, key));
  const sb = String(getSortValue(b, key));
  const n = sa.localeCompare(sb, undefined, { sensitivity: 'base', numeric: true });
  return dir === 'asc' ? n : -n;
}

function sortRows(rows, key, dir) {
  const out = [...rows];
  out.sort((a, b) => compareRows(a, b, key, dir));
  return out;
}

function updateSortIndicators() {
  const buttons = document.querySelectorAll('.track-requests-section .requests-sort-btn[data-sort]');
  for (const btn of buttons) {
    const key = btn.getAttribute('data-sort');
    const ind = btn.querySelector('.sort-indicator');
    const th = btn.closest('th');
    if (key === sortState.key) {
      btn.classList.add('is-active');
      if (ind) ind.textContent = sortState.dir === 'asc' ? '^' : 'v';
      if (th) th.setAttribute('aria-sort', sortState.dir === 'asc' ? 'ascending' : 'descending');
    } else {
      btn.classList.remove('is-active');
      if (ind) ind.textContent = '';
      if (th) th.setAttribute('aria-sort', 'none');
    }
  }
}

function wireSortHeaders() {
  const buttons = document.querySelectorAll('.track-requests-section .requests-sort-btn[data-sort]');
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-sort');
      if (!key) return;
      if (sortState.key === key) {
        sortState = { key, dir: sortState.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        sortState = { key, dir: 'asc' };
      }
      updateSortIndicators();
      renderTrackTable();
    });
  }
  updateSortIndicators();
}

async function approveRequest(requestId) {
  const response = await fetch(`/api/admin/requests/${requestId}/approve`, { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || 'Approve failed');
  }
}

async function denyRequest(requestId) {
  const response = await fetch(`/api/admin/requests/${requestId}/deny`, { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || 'Deny failed');
  }
}

async function cancelRequest(requestId) {
  const response = await fetch(`/api/admin/requests/${requestId}/cancel`, { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || 'Cancel failed');
  }
}

/** Matches backend userMayDeleteRequestViaUserApi (finished / canceled rows only; not pending/requested). */
function trackRowMayClear(request) {
  const st = String(request?.status || '');
  const cancelled = Number(request?.cancelled) === 1;
  if (st === 'pending' || st === 'requested') {
    return false;
  }
  if (st === 'completed' || st === 'denied' || st === 'available') {
    return true;
  }
  if (st === 'failed' && cancelled) {
    return true;
  }
  if (st === 'processing' && cancelled) {
    return true;
  }
  return false;
}

function appendManualImportButton(actionsTd, request) {
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.textContent = 'Import';
  importBtn.addEventListener('click', () => {
    const did = request.deezer_id != null ? String(request.deezer_id).trim() : '';
    if (!did) {
      window.alert('This request has no Deezer id.');
      return;
    }
    window.location.assign(
      `/manual-import.html?requestId=${encodeURIComponent(String(request.id))}&deezerId=${encodeURIComponent(did)}`,
    );
  });
  actionsTd.appendChild(importBtn);
  actionsTd.appendChild(document.createTextNode(' '));
}

function appendTrackClearButton(actionsTd, request) {
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      const res = await fetch(`/api/requests/${request.id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Clear failed');
      }
      await loadAll();
    } catch (e) {
      console.error(e);
      clearBtn.disabled = false;
    }
  });
  actionsTd.appendChild(clearBtn);
}

function renderTrackActionsCell(request) {
  const actionsTd = document.createElement('td');
  const status = String(request.status || '');
  if (isAdmin) {
    if (status === 'pending' || status === 'requested') {
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.textContent = 'Approve';
      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.textContent = 'Deny';
      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true; denyBtn.disabled = true;
        try { await approveRequest(request.id); await loadAll(); } catch (e) { console.error(e); approveBtn.disabled = false; denyBtn.disabled = false; }
      });
      denyBtn.addEventListener('click', async () => {
        approveBtn.disabled = true; denyBtn.disabled = true;
        try { await denyRequest(request.id); await loadAll(); } catch (e) { console.error(e); approveBtn.disabled = false; denyBtn.disabled = false; }
      });
      actionsTd.appendChild(approveBtn);
      actionsTd.appendChild(document.createTextNode(' '));
      actionsTd.appendChild(denyBtn);
      return actionsTd;
    }
    if (status === 'processing') {
      if (Number(request.cancelled) === 1) {
        appendManualImportButton(actionsTd, request);
        appendTrackClearButton(actionsTd, request);
        return actionsTd;
      }
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        try { await cancelRequest(request.id); await loadAll(); } catch (e) { console.error(e); cancelBtn.disabled = false; }
      });
      actionsTd.appendChild(cancelBtn);
      return actionsTd;
    }
    if (status === 'failed' && Number(request.cancelled) !== 1) {
      appendManualImportButton(actionsTd, request);
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.textContent = 'Retry';
      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.textContent = 'Deny';
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true; denyBtn.disabled = true;
        try { await approveRequest(request.id); await loadAll(); } catch (e) { console.error(e); retryBtn.disabled = false; denyBtn.disabled = false; }
      });
      denyBtn.addEventListener('click', async () => {
        retryBtn.disabled = true; denyBtn.disabled = true;
        try { await denyRequest(request.id); await loadAll(); } catch (e) { console.error(e); retryBtn.disabled = false; denyBtn.disabled = false; }
      });
      actionsTd.appendChild(retryBtn);
      actionsTd.appendChild(document.createTextNode(' '));
      actionsTd.appendChild(denyBtn);
      actionsTd.appendChild(document.createTextNode(' '));
      appendTrackClearButton(actionsTd, request);
      return actionsTd;
    }
    if (trackRowMayClear(request)) {
      if (isAdmin && normalizeTrackFilterToken(request) === 'needs_attention') {
        const did = request.deezer_id != null ? String(request.deezer_id).trim() : '';
        if (did) {
          appendManualImportButton(actionsTd, request);
        }
      }
      appendTrackClearButton(actionsTd, request);
    }
    return actionsTd;
  }

  const own = String(request.user_id || '') === sessionUserIdStr;
  if (own && (status === 'pending' || status === 'requested')) {
    const withdrawBtn = document.createElement('button');
    withdrawBtn.type = 'button';
    withdrawBtn.textContent = 'Withdraw';
    withdrawBtn.addEventListener('click', async () => {
      try {
        withdrawBtn.disabled = true;
        const res = await fetch(`/api/requests/${request.id}`, { method: 'DELETE', credentials: 'same-origin' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || 'Withdraw failed');
        }
        await loadAll();
      } catch (e) {
        console.error(e);
        withdrawBtn.disabled = false;
      }
    });
    actionsTd.appendChild(withdrawBtn);
  } else if (own && trackRowMayClear(request)) {
    appendTrackClearButton(actionsTd, request);
  }
  return actionsTd;
}

function renderTrackTable() {
  requestsBody.innerHTML = '';
  const prepared = applyComputeDisplay(currentResults || []);
  const tokens = checkedValues(trackFilterChecks, 'data-track-filter');
  const filtered = prepared.filter((r) => tokens.has(normalizeTrackFilterToken(r)));
  const sorted = sortRows(filtered, sortState.key, sortState.dir);

  if (!sorted.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = activeColSpan;
    td.textContent = 'No track requests match this status filter';
    tr.appendChild(td);
    requestsBody.appendChild(tr);
    return;
  }

  for (const request of sorted) {
    const tr = document.createElement('tr');
    const td = (text) => {
      const c = document.createElement('td');
      c.textContent = text ?? '';
      return c;
    };
    tr.appendChild(td(request.title));
    tr.appendChild(td(request.artist));
    tr.appendChild(td(request.album));
    const userTd = td(request.requested_by_username ?? '');
    userTd.className = 'admin-only';
    tr.appendChild(userTd);
    tr.appendChild(td(displayRequestSource(request.request_type)));
    tr.appendChild(td(formatDateTime(request.created_at)));
    tr.appendChild(td(formatDateTime(request.processed_at)));
    tr.appendChild(td(request.displayStatus ?? ''));
    if (isAdmin) tr.appendChild(td(request.processingStatus ?? ''));
    tr.appendChild(renderTrackActionsCell(request));
    requestsBody.appendChild(tr);
  }
}

function followWithdrawPath(r) {
  return r.apiKind === 'playlist' ? `/api/playlists/follow/${r.id}` : `/api/artists/follow/${r.id}`;
}

function renderFollowTable() {
  followRequestsBody.innerHTML = '';
  const tokens = checkedValues(followFilterChecks, 'data-follow-filter');
  const rows = (currentFollowRows || []).filter((r) => tokens.has(normalizeFollowFilterToken(r)));
  rows.sort((a, b) => (parseDbTimestampAsUtc(b.createdAt)?.getTime() || 0) - (parseDbTimestampAsUtc(a.createdAt)?.getTime() || 0));

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = followRequestsColSpan;
    td.textContent = 'No follow requests match this status filter.';
    tr.appendChild(td);
    followRequestsBody.appendChild(tr);
    return;
  }

  for (const r of rows) {
    const tr = document.createElement('tr');
    const td = (text) => {
      const c = document.createElement('td');
      c.textContent = text ?? '';
      return c;
    };
    tr.appendChild(td(r.displayKind));
    tr.appendChild(td(r.title));
    const userTd = td(r.userLabel);
    userTd.className = 'admin-only';
    tr.appendChild(userTd);
    tr.appendChild(td(formatDateTime(r.createdAt)));
    tr.appendChild(td(r.followStatusLabel));

    const actionsTd = document.createElement('td');
    if (r.followStatus === 'pending') {
      if (isAdmin) {
        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.textContent = 'Approve';
        const denyBtn = document.createElement('button');
        denyBtn.type = 'button';
        denyBtn.textContent = 'Deny';
        approveBtn.addEventListener('click', async () => {
          approveBtn.disabled = true; denyBtn.disabled = true;
          try {
            const res = await fetch(`/api/admin/follows/${r.apiKind}/${r.id}/approve`, { method: 'POST', credentials: 'same-origin' });
            if (!res.ok) throw new Error('Approve failed');
            await loadAll();
          } catch (e) {
            console.error(e);
            approveBtn.disabled = false; denyBtn.disabled = false;
          }
        });
        denyBtn.addEventListener('click', async () => {
          approveBtn.disabled = true; denyBtn.disabled = true;
          try {
            const res = await fetch(`/api/admin/follows/${r.apiKind}/${r.id}/reject`, { method: 'POST', credentials: 'same-origin' });
            if (!res.ok) throw new Error('Deny failed');
            await loadAll();
          } catch (e) {
            console.error(e);
            approveBtn.disabled = false; denyBtn.disabled = false;
          }
        });
        actionsTd.appendChild(approveBtn);
        actionsTd.appendChild(document.createTextNode(' '));
        actionsTd.appendChild(denyBtn);
      } else {
        const withdrawBtn = document.createElement('button');
        withdrawBtn.type = 'button';
        withdrawBtn.textContent = 'Withdraw';
        withdrawBtn.addEventListener('click', async () => {
          try {
            withdrawBtn.disabled = true;
            const res = await fetch(followWithdrawPath(r), { method: 'DELETE', credentials: 'same-origin' });
            if (!res.ok) throw new Error('Withdraw failed');
            await loadAll();
          } catch (e) {
            console.error(e);
            withdrawBtn.disabled = false;
          }
        });
        actionsTd.appendChild(withdrawBtn);
      }
    } else if (isAdmin && (r.followStatus === 'approved' || r.followStatus === 'denied')) {
      const rawId = r.id;
      const histKey = typeof rawId === 'string' && rawId.startsWith('hist-') ? rawId.slice(5) : '';
      const histId = histKey !== '' ? Number(histKey) : NaN;
      if (Number.isInteger(histId) && histId > 0) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.textContent = 'Clear';
        clearBtn.addEventListener('click', async () => {
          clearBtn.disabled = true;
          try {
            const res = await fetch(`/api/requests/follow-history/${histId}`, {
              method: 'DELETE',
              credentials: 'same-origin',
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data?.error || 'Clear failed');
            }
            await loadAll();
          } catch (e) {
            console.error(e);
            clearBtn.disabled = false;
          }
        });
        actionsTd.appendChild(clearBtn);
      }
    }
    tr.appendChild(actionsTd);
    followRequestsBody.appendChild(tr);
  }
}

async function refreshRequestDisplayTimezone() {
  try {
    const tzRes = await fetch('/api/requests/display-config', { credentials: 'same-origin' });
    if (tzRes.ok) {
      const tzData = await tzRes.json();
      if (typeof tzData.display_timezone === 'string' && tzData.display_timezone.trim()) {
        displayTimezone = tzData.display_timezone.trim();
      }
    }
  } catch {
    /* keep previous */
  }
}

async function loadRequests() {
  await refreshRequestDisplayTimezone();
  const response = await fetch('/api/requests', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Failed to load requests');
  const data = await response.json();
  currentResults = Array.isArray(data.results) ? data.results : [];
}

async function loadFollowRows() {
  if (isAdmin) {
    const [pendingRes, histRes] = await Promise.all([
      fetch('/api/admin/pending-follows', { credentials: 'same-origin' }),
      fetch('/api/requests/follow-history', { credentials: 'same-origin' }),
    ]);
    if (!pendingRes.ok || !histRes.ok) throw new Error('Failed to load follow requests');
    const pending = await pendingRes.json().catch(() => ({}));
    const hist = await histRes.json().catch(() => ({}));
    const rows = [];
    for (const r of Array.isArray(pending.playlists) ? pending.playlists : []) {
      rows.push({ id: r.id, apiKind: 'playlist', displayKind: 'Playlist', title: r.title || r.playlist_id, userLabel: r.requested_by_username || '', createdAt: r.created_at, followStatus: 'pending', followStatusLabel: 'Pending' });
    }
    for (const r of Array.isArray(pending.artists) ? pending.artists : []) {
      rows.push({ id: r.id, apiKind: 'artist', displayKind: 'Artist', title: r.name || r.artist_id, userLabel: r.requested_by_username || '', createdAt: r.created_at, followStatus: 'pending', followStatusLabel: 'Pending' });
    }
    for (const r of Array.isArray(hist.results) ? hist.results : []) {
      rows.push({ id: `hist-${r.id}`, apiKind: r.follow_kind === 'playlist' ? 'playlist' : 'artist', displayKind: r.follow_kind === 'playlist' ? 'Playlist' : 'Artist', title: r.title || '', userLabel: r.requested_by_username || '', createdAt: r.requested_at || r.resolved_at, followStatus: r.outcome === 'approved' ? 'approved' : 'denied', followStatusLabel: r.outcome === 'approved' ? 'Approved' : 'Denied' });
    }
    currentFollowRows = rows;
    return;
  }

  const [plRes, arRes] = await Promise.all([
    fetch('/api/playlists/followed?include_pending=1', { credentials: 'same-origin' }),
    fetch('/api/artists/followed?include_pending=1', { credentials: 'same-origin' }),
  ]);
  if (!plRes.ok || !arRes.ok) throw new Error('Failed to load follow requests');
  const plData = await plRes.json().catch(() => ({}));
  const arData = await arRes.json().catch(() => ({}));
  const rows = [];
  for (const r of Array.isArray(plData.results) ? plData.results : []) {
    if (r.follow_status === 'pending') {
      rows.push({ id: r.id, apiKind: 'playlist', displayKind: 'Playlist', title: r.title || r.playlist_id, userLabel: '', createdAt: r.created_at, followStatus: 'pending', followStatusLabel: 'Pending' });
    } else if (r.follow_status === 'denied') {
      rows.push({ id: r.id, apiKind: 'playlist', displayKind: 'Playlist', title: r.title || r.playlist_id, userLabel: '', createdAt: r.created_at, followStatus: 'denied', followStatusLabel: 'Denied' });
    }
  }
  for (const r of Array.isArray(arData.results) ? arData.results : []) {
    if (r.follow_status === 'pending') {
      rows.push({ id: r.id, apiKind: 'artist', displayKind: 'Artist', title: r.name || r.artist_id, userLabel: '', createdAt: r.created_at, followStatus: 'pending', followStatusLabel: 'Pending' });
    } else if (r.follow_status === 'denied') {
      rows.push({ id: r.id, apiKind: 'artist', displayKind: 'Artist', title: r.name || r.artist_id, userLabel: '', createdAt: r.created_at, followStatus: 'denied', followStatusLabel: 'Denied' });
    }
  }
  currentFollowRows = rows;
}

async function loadAvailabilitySettingsForDisplay() {
  if (!isAdmin) return;
  try {
    const response = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!response.ok) return;
    const data = await response.json();
    if (window.TrackFlowRequestDisplay?.configureSettings) {
      window.TrackFlowRequestDisplay.configureSettings(data);
    }
  } catch {
    /* ignore */
  }
}

async function loadAll() {
  try {
    await Promise.all([loadRequests(), loadFollowRows()]);
    renderTrackTable();
    renderFollowTable();
  } catch (e) {
    console.error(e);
    requestsBody.innerHTML = '';
    const trA = document.createElement('tr');
    const tdA = document.createElement('td');
    tdA.colSpan = activeColSpan;
    tdA.textContent = 'Error loading requests';
    trA.appendChild(tdA);
    requestsBody.appendChild(trA);

    followRequestsBody.innerHTML = '';
    const trF = document.createElement('tr');
    const tdF = document.createElement('td');
    tdF.colSpan = followRequestsColSpan;
    tdF.textContent = 'Error loading follow requests';
    trF.appendChild(tdF);
    followRequestsBody.appendChild(trF);
  }
}

if (isAdmin) {
  followApproveAllBtn?.addEventListener('click', () => {
    runBulkPost('/api/admin/follows/approve-all', 'Approve all pending playlist and artist follow requests?', (d) => `${Number(d.updated) || 0} follow request(s) approved`, { summaryEl: followBulkSummary, buttons: followBulkButtons });
  });
  followDenyAllBtn?.addEventListener('click', () => {
    runBulkPost('/api/admin/follows/reject-all', 'Deny all pending follow requests?', (d) => `${Number(d.updated) || 0} follow request(s) denied`, { summaryEl: followBulkSummary, buttons: followBulkButtons });
  });
  followClearStatusBtn?.addEventListener('click', () => {
    const outcome = String(followClearStatusSelect?.value || 'all');
    runBulkPost('/api/requests/clear-follow-status', `Clear follow rows with status ${outcome}?`, (d) => `${Number(d.deletedFollows) || 0} follow row(s) cleared`, { summaryEl: followBulkSummary, buttons: followBulkButtons, body: { follow_outcome: outcome } });
  });

  approveAllBtn?.addEventListener('click', () => {
    runBulkPost('/api/requests/approve-all', 'Approve all pending/requested track requests?', (d) => `${Number(d.updated) || 0} track request(s) approved`, { summaryEl: trackBulkSummary, buttons: trackBulkButtons });
  });
  denyAllBtn?.addEventListener('click', () => {
    runBulkPost('/api/requests/deny-all', 'Deny all pending/requested and failed track requests?', (d) => `${Number(d.updated) || 0} track request(s) denied`, { summaryEl: trackBulkSummary, buttons: trackBulkButtons });
  });
  cancelAllBtn?.addEventListener('click', () => {
    runBulkPost('/api/requests/cancel-all', 'Cancel all active processing track requests?', (d) => `${Number(d.updated) || 0} track request(s) cancelled`, { summaryEl: trackBulkSummary, buttons: trackBulkButtons });
  });
  retryFailedBtn?.addEventListener('click', () => {
    runBulkPost('/api/requests/retry-failed', 'Retry all failed track requests?', (d) => `${Number(d.updated) || 0} track request(s) retried`, { summaryEl: trackBulkSummary, buttons: trackBulkButtons });
  });
  trackClearStatusBtn?.addEventListener('click', () => {
    const trackStatus = String(trackClearStatusSelect?.value || 'all');
    runBulkPost('/api/requests/clear-track-status', `Clear track rows with status ${trackStatus}?`, (d) => `${Number(d.deletedTracks) || 0} track row(s) cleared`, { summaryEl: trackBulkSummary, buttons: trackBulkButtons, body: { track_status: trackStatus } });
  });
}

wireSortHeaders();
setDefaultChecks(trackFilterChecks, 'data-track-filter', TRACK_FILTER_DEFAULTS);
setDefaultChecks(followFilterChecks, 'data-follow-filter', FOLLOW_FILTER_DEFAULTS);
wireAutoApplyChecks(trackFilterChecks, trackFilterAll, 'data-track-filter', renderTrackTable);
wireAutoApplyChecks(followFilterChecks, followFilterAll, 'data-follow-filter', renderFollowTable);
wireFilterDropdown(trackFilterBtn, trackFilterMenu);
wireFilterDropdown(followFilterBtn, followFilterMenu);
await loadAvailabilitySettingsForDisplay();
await loadAll();
setInterval(() => {
  void loadAll();
}, 5000);
