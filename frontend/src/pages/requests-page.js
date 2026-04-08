import '../js/request-display-shared.js';
import { ensureLoggedIn } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await initAppNavAuth(__tfMe);

/** Processing status + User columns are admin-only on track requests; Actions is shown to all users (withdraw vs admin tools). */
const isAdmin = __tfMe?.role === 'admin';
if (isAdmin) {
  document.body.classList.add('admin-view');
}

const sessionUserIdStr = __tfMe?.id != null ? String(__tfMe.id) : '';

let displayTimezone = 'UTC';

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
    // keep previous value
  }
}

await refreshRequestDisplayTimezone();

const requestsBody = document.getElementById('requestsBody');
const requestHistoryBody = document.getElementById('requestHistoryBody');
const followRequestsBody = document.getElementById('followRequestsBody');
const statusFilter = document.getElementById('statusFilter');
const historyTypeFilter = document.getElementById('historyTypeFilter');

const followApproveAllBtn = document.getElementById('followApproveAllBtn');
const followDenyAllBtn = document.getElementById('followDenyAllBtn');
const followBulkSummary = document.getElementById('followBulkSummary');
const followBulkButtons = [followApproveAllBtn, followDenyAllBtn].filter(Boolean);

const approveAllBtn = document.getElementById('approveAllBtn');
const cancelAllBtn = document.getElementById('cancelAllBtn');
const denyAllBtn = document.getElementById('denyAllBtn');
const retryFailedBtn = document.getElementById('retryFailedBtn');
const trackBulkSummary = document.getElementById('trackBulkSummary');
const trackBulkButtons = [approveAllBtn, cancelAllBtn, denyAllBtn, retryFailedBtn].filter(Boolean);

const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const historyBulkSummary = document.getElementById('historyBulkSummary');
const historyStatusClearBtns = [...document.querySelectorAll('.history-status-clear-btn')];
const historyFollowClearBtns = [...document.querySelectorAll('.history-follow-clear-btn')];
const historyBulkButtons = [
  clearHistoryBtn,
  ...historyStatusClearBtns,
  ...historyFollowClearBtns,
].filter(Boolean);

const optimisticStatusById = new Map();
let currentResults = [];
let currentFollowHistory = [];
/** @type {{ playlists: object[], artists: object[] }} */
let followRequestsCache = { playlists: [], artists: [] };

const activeColSpan = isAdmin ? 9 : 8;
const followRequestsColSpan = 5;
const historyColSpan = 10;

/** @type {{ key: string, dir: 'asc' | 'desc' }} */
let sortState = { key: 'title', dir: 'asc' };

/** @type {{ key: string, dir: 'asc' | 'desc' }} */
let historySortState = { key: 'when', dir: 'desc' };

function resolveTrackDisplayForActiveCheck(r) {
  let ds = String(r?.displayStatus || '').trim();
  let ps = String(r?.processingStatus || '').trim();
  if (!ds || !ps) {
    const compute =
      typeof window !== 'undefined' && window.TrackFlowRequestDisplay?.computeDisplayFields;
    if (typeof compute === 'function') {
      const d = compute(r);
      ds = String(d?.displayStatus || '').trim();
      ps = String(d?.processingStatus || '').trim();
    }
  }
  return { displayStatus: ds, processingStatus: ps };
}

/** Active queue: excludes terminal rows (completed / denied / canceled failed, etc.). */
function isTrackActiveRow(r) {
  const st = String(r?.status || '');
  const cancelled = Number(r?.cancelled) === 1;
  if (st === 'denied' || st === 'completed' || st === 'available') {
    return false;
  }
  if (st === 'failed' && cancelled) {
    return false;
  }
  if (st === 'processing' && cancelled) {
    return false;
  }
  return true;
}

function applyComputeDisplay(rows) {
  return rows.map((r) => {
    const missingDisplay =
      r.displayStatus == null ||
      r.displayStatus === '' ||
      r.processingStatus == null ||
      r.processingStatus === '';
    if (!missingDisplay) {
      return r;
    }
    const d = window.TrackFlowRequestDisplay.computeDisplayFields(r);
    return { ...r, displayStatus: d.displayStatus, processingStatus: d.processingStatus };
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

function bulkBodyPayload() {
  return JSON.stringify({});
}

async function runBulkPost(path, confirmMessage, formatSuccess, options = {}) {
  const summaryEl = options.summaryEl || historyBulkSummary;
  const buttons = options.buttons || historyBulkButtons;
  if (!window.confirm(confirmMessage)) {
    return;
  }
  setBulkRunning(buttons, true);
  setBulkSummary(summaryEl, 'Working…', null);
  try {
    const payload =
      options.body !== undefined && options.body !== null
        ? JSON.stringify(options.body)
        : bulkBodyPayload();
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: payload,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || 'Request failed');
    }
    let msg;
    if (typeof formatSuccess === 'function') {
      msg = formatSuccess(data);
    } else if (data.updated != null) {
      msg = `${Number(data.updated) || 0} updated`;
    } else {
      msg = 'Done';
    }
    setBulkSummary(summaryEl, msg, 'success');
    optimisticStatusById.clear();
    await loadRequests();
    await loadFollowRequests();
    if (isAdmin) {
      await loadFollowHistory();
    }
  } catch (err) {
    console.error('Bulk action failed:', err);
    setBulkSummary(summaryEl, err?.message || 'Failed', 'error');
  } finally {
    setBulkRunning(buttons, false);
  }
}

function displayRequestSource(requestType) {
  const s = String(requestType || 'Track').trim();
  if (s === 'Artist' || s === 'Playlist' || s === 'Track') {
    return s;
  }
  return s || 'Track';
}

/**
 * SQLite / API often returns `YYYY-MM-DD HH:mm:ss` with no timezone; those values are UTC from the server.
 * Parsing them as local breaks `Intl` timeZone conversion (e.g. America/Chicago would still look like UTC).
 */
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
  if (iso == null || iso === '') {
    return '';
  }
  const d = parseDbTimestampAsUtc(iso);
  if (!d) {
    return String(iso);
  }
  const tz = displayTimezone && String(displayTimezone).trim() ? String(displayTimezone).trim() : 'UTC';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: tz,
    }).format(d);
  } catch {
    try {
      return d.toLocaleString(undefined, { timeZone: 'UTC' });
    } catch {
      return d.toLocaleString();
    }
  }
}

function historyScopePhrase() {
  return "all users'";
}

function getHistorySortComparable(row, key) {
  const k = key || historySortState.key;
  if (row.historyKind === 'follow') {
    switch (k) {
      case 'type':
        return row.follow_kind === 'playlist' ? 'Playlist' : 'Artist';
      case 'title':
        return row.title ?? '';
      case 'artist':
        return '—';
      case 'album':
        return '—';
      case 'user':
        return row.requested_by_username ?? '';
      case 'source':
        return 'Follow';
      case 'when':
        return historyRequestedMs(row);
      case 'status':
        return row.outcome === 'approved' ? 'Approved' : 'Denied';
      case 'processing':
        return '—';
      default:
        return '';
    }
  }
  switch (k) {
    case 'type':
      return 'Track';
    case 'title':
      return row.title ?? '';
    case 'artist':
      return row.artist ?? '';
    case 'album':
      return row.album ?? '';
    case 'user':
      return row.requested_by_username ?? '';
    case 'source':
      return displayRequestSource(row.request_type);
    case 'when':
      return historyRequestedMs(row);
    case 'status':
      return row.displayStatus ?? '';
    case 'processing':
      return row.processingStatus ?? '';
    default:
      return '';
  }
}

function compareHistoryRows(a, b, key, dir) {
  const va = getHistorySortComparable(a, key);
  const vb = getHistorySortComparable(b, key);
  if (typeof va === 'number' && typeof vb === 'number') {
    const n = va - vb;
    return dir === 'asc' ? n : -n;
  }
  const sa = String(va);
  const sb = String(vb);
  const n = sa.localeCompare(sb, undefined, { sensitivity: 'base', numeric: true });
  return dir === 'asc' ? n : -n;
}

function updateHistorySortIndicators() {
  const buttons = document.querySelectorAll(
    '.request-history-section .requests-sort-btn[data-history-sort]',
  );
  for (const btn of buttons) {
    const key = btn.getAttribute('data-history-sort');
    const ind = btn.querySelector('.sort-indicator');
    const th = btn.closest('th');
    if (key === historySortState.key) {
      btn.classList.add('is-active');
      if (ind) {
        ind.textContent = historySortState.dir === 'asc' ? '▲' : '▼';
      }
      if (th) {
        th.setAttribute('aria-sort', historySortState.dir === 'asc' ? 'ascending' : 'descending');
      }
    } else {
      btn.classList.remove('is-active');
      if (ind) {
        ind.textContent = '';
      }
      if (th) {
        th.setAttribute('aria-sort', 'none');
      }
    }
  }
}

function wireHistorySortHeaders() {
  const buttons = document.querySelectorAll(
    '.request-history-section .requests-sort-btn[data-history-sort]',
  );
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-history-sort');
      if (!key) {
        return;
      }
      if (historySortState.key === key) {
        historySortState = { key, dir: historySortState.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        historySortState = { key, dir: key === 'when' ? 'desc' : 'asc' };
      }
      updateHistorySortIndicators();
      renderHistorySection();
    });
  }
  updateHistorySortIndicators();
}

function getSortValue(row, key) {
  switch (key) {
    case 'title':
      return row.title ?? '';
    case 'artist':
      return row.artist ?? '';
    case 'album':
      return row.album ?? '';
    case 'user':
      return row.requested_by_username ?? '';
    case 'source':
      return displayRequestSource(row.request_type);
    case 'requested':
      return row.created_at ?? '';
    case 'status':
      return row.displayStatus ?? '';
    case 'processing':
      return row.processingStatus ?? '';
    default:
      return '';
  }
}

function compareRows(a, b, key, dir) {
  const va = getSortValue(a, key);
  const vb = getSortValue(b, key);
  const sa = String(va);
  const sb = String(vb);
  const n = sa.localeCompare(sb, undefined, { sensitivity: 'base', numeric: true });
  return dir === 'asc' ? n : -n;
}

function filterByStatus(rows, filterValue) {
  if (!filterValue) {
    return rows;
  }
  return rows.filter((r) => r.status === filterValue);
}

function filterHistoryByType(rows, filterValue) {
  if (!filterValue) {
    return rows;
  }
  if (filterValue === 'track') {
    return rows.filter((r) => r.historyKind === 'track');
  }
  if (filterValue === 'follow') {
    return rows.filter((r) => r.historyKind === 'follow');
  }
  return rows;
}

function sortRows(rows, key, dir) {
  const copy = [...rows];
  copy.sort((a, b) => compareRows(a, b, key, dir));
  return copy;
}

function updateSortIndicators() {
  const buttons = document.querySelectorAll('.track-requests-section .requests-sort-btn[data-sort]');
  for (const btn of buttons) {
    const key = btn.getAttribute('data-sort');
    const ind = btn.querySelector('.sort-indicator');
    const th = btn.closest('th');
    if (key === sortState.key) {
      btn.classList.add('is-active');
      if (ind) {
        ind.textContent = sortState.dir === 'asc' ? '▲' : '▼';
      }
      if (th) {
        th.setAttribute('aria-sort', sortState.dir === 'asc' ? 'ascending' : 'descending');
      }
    } else {
      btn.classList.remove('is-active');
      if (ind) {
        ind.textContent = '';
      }
      if (th) {
        th.setAttribute('aria-sort', 'none');
      }
    }
  }
}

function wireSortHeaders() {
  const buttons = document.querySelectorAll('.track-requests-section .requests-sort-btn[data-sort]');
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-sort');
      if (!key) {
        return;
      }
      if (sortState.key === key) {
        sortState = { key, dir: sortState.dir === 'asc' ? 'desc' : 'asc' };
      } else {
        sortState = { key, dir: 'asc' };
      }
      updateSortIndicators();
      renderActiveTable(currentResults);
    });
  }
  updateSortIndicators();
}

function appendActiveEmptyRow(message) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = activeColSpan;
  td.textContent = message;
  tr.appendChild(td);
  requestsBody.appendChild(tr);
}

function appendHistoryEmpty(message) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = historyColSpan;
  td.textContent = message;
  tr.appendChild(td);
  requestHistoryBody.appendChild(tr);
}

function historyRequestedMs(row) {
  if (row.historyKind === 'follow') {
    const t = row.requested_at || row.resolved_at;
    const d = parseDbTimestampAsUtc(t);
    return d ? d.getTime() : 0;
  }
  const d = parseDbTimestampAsUtc(row.created_at);
  return d ? d.getTime() : 0;
}

async function approveRequest(requestId) {
  const response = await fetch(`/api/admin/requests/${requestId}/approve`, {
    method: 'POST',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let message = 'Action failed';
    try {
      const data = await response.json();
      if (data?.error) {
        message = data.error;
      }
    } catch (_error) {
      // Keep default message.
    }
    throw new Error(message);
  }
}

async function denyRequest(requestId) {
  const response = await fetch(`/api/admin/requests/${requestId}/deny`, {
    method: 'POST',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let message = 'Deny failed';
    try {
      const data = await response.json();
      if (data?.error) {
        message = data.error;
      }
    } catch (_error) {
      // Keep default message.
    }
    throw new Error(message);
  }
}

async function cancelRequest(requestId) {
  const response = await fetch(`/api/admin/requests/${requestId}/cancel`, {
    method: 'POST',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let message = 'Cancel failed';
    try {
      const data = await response.json();
      if (data?.error) {
        message = data.error;
      }
    } catch (_error) {
      // ignore
    }
    throw new Error(message);
  }
}

async function clearRequest(requestId) {
  const response = await fetch(`/api/admin/requests/${requestId}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let message = 'Clear failed';
    try {
      const data = await response.json();
      if (data?.error) {
        message = data.error;
      }
    } catch (_error) {
      // ignore
    }
    throw new Error(message);
  }
}

async function refreshAfterAction() {
  await loadRequests();
  await loadFollowRequests();
  if (isAdmin) {
    await loadFollowHistory();
  }
}

function normalizeResultsWithOptimistic(results) {
  return results.map((request) => {
    const optimisticStatus = optimisticStatusById.get(request.id);
    if (!optimisticStatus) {
      return request;
    }

    if (
      request.status !== 'pending' &&
      request.status !== 'requested' &&
      request.status !== 'failed'
    ) {
      optimisticStatusById.delete(request.id);
      return request;
    }

    const next = { ...request, status: optimisticStatus };
    delete next.displayStatus;
    delete next.processingStatus;
    return next;
  });
}

function renderRow(request) {
  const status = request.status;
  const tr = document.createElement('tr');

  function td(text) {
    const cell = document.createElement('td');
    cell.textContent = text ?? '';
    return cell;
  }

  tr.appendChild(td(request.title));
  tr.appendChild(td(request.artist));
  tr.appendChild(td(request.album));
  const userTd = document.createElement('td');
  userTd.className = 'admin-only';
  userTd.textContent = request.requested_by_username ?? '';
  tr.appendChild(userTd);
  tr.appendChild(td(displayRequestSource(request.request_type)));
  tr.appendChild(td(formatDateTime(request.created_at)));
  tr.appendChild(td(request.displayStatus ?? ''));
  if (isAdmin) {
    tr.appendChild(td(request.processingStatus ?? ''));
  }
  const actionsTd = document.createElement('td');
  if (isAdmin) {
    if (status === 'pending' || status === 'requested') {
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.textContent = 'Approve';
      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.textContent = 'Deny';
      approveBtn.addEventListener('click', async () => {
        try {
          optimisticStatusById.set(request.id, 'processing');
          renderActiveTable(currentResults);
          approveBtn.disabled = true;
          denyBtn.disabled = true;
          await approveRequest(request.id);
          await refreshAfterAction();
        } catch (error) {
          console.error('Request action failed:', error);
          optimisticStatusById.delete(request.id);
          renderActiveTable(currentResults);
          approveBtn.disabled = false;
          denyBtn.disabled = false;
        }
      });
      denyBtn.addEventListener('click', async () => {
        try {
          optimisticStatusById.set(request.id, 'denied');
          renderActiveTable(currentResults);
          approveBtn.disabled = true;
          denyBtn.disabled = true;
          await denyRequest(request.id);
          await refreshAfterAction();
        } catch (error) {
          console.error('Deny failed:', error);
          optimisticStatusById.delete(request.id);
          renderActiveTable(currentResults);
          approveBtn.disabled = false;
          denyBtn.disabled = false;
        }
      });
      actionsTd.appendChild(approveBtn);
      actionsTd.appendChild(document.createTextNode(' '));
      actionsTd.appendChild(denyBtn);
    } else if (status === 'failed') {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', async () => {
        try {
          currentResults = currentResults.filter((r) => r.id !== request.id);
          optimisticStatusById.delete(request.id);
          renderActiveTable(currentResults);
          await clearRequest(request.id);
          await refreshAfterAction();
        } catch (error) {
          console.error('Clear failed:', error);
          await refreshAfterAction();
        }
      });

      const failedCancelled = Number(request.cancelled) === 1;
      if (!failedCancelled) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.textContent = 'Retry';
        const denyBtn = document.createElement('button');
        denyBtn.type = 'button';
        denyBtn.textContent = 'Deny';
        denyBtn.addEventListener('click', async () => {
          try {
            optimisticStatusById.set(request.id, 'denied');
            renderActiveTable(currentResults);
            retryBtn.disabled = true;
            denyBtn.disabled = true;
            clearBtn.disabled = true;
            await denyRequest(request.id);
            await refreshAfterAction();
          } catch (error) {
            console.error('Deny failed:', error);
            optimisticStatusById.delete(request.id);
            renderActiveTable(currentResults);
            retryBtn.disabled = false;
            denyBtn.disabled = false;
            clearBtn.disabled = false;
          }
        });
        retryBtn.addEventListener('click', async () => {
          try {
            optimisticStatusById.set(request.id, 'processing');
            renderActiveTable(currentResults);
            retryBtn.disabled = true;
            denyBtn.disabled = true;
            clearBtn.disabled = true;
            await approveRequest(request.id);
            await refreshAfterAction();
          } catch (error) {
            console.error('Request action failed:', error);
            optimisticStatusById.delete(request.id);
            renderActiveTable(currentResults);
            retryBtn.disabled = false;
            denyBtn.disabled = false;
            clearBtn.disabled = false;
          }
        });
        actionsTd.appendChild(retryBtn);
        actionsTd.appendChild(document.createTextNode(' '));
        actionsTd.appendChild(denyBtn);
        actionsTd.appendChild(document.createTextNode(' '));
      }
      actionsTd.appendChild(clearBtn);
    } else if (status === 'processing') {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', async () => {
        try {
          currentResults = currentResults.map((r) =>
            r.id === request.id ? { ...r, status: 'failed', cancelled: 1 } : r,
          );
          optimisticStatusById.delete(request.id);
          renderActiveTable(currentResults);
          cancelBtn.disabled = true;
          await cancelRequest(request.id);
          await refreshAfterAction();
        } catch (error) {
          console.error('Cancel failed:', error);
          cancelBtn.disabled = false;
          await refreshAfterAction();
        }
      });
      actionsTd.appendChild(cancelBtn);
    }
  } else {
    const st = String(status || '');
    const own = String(request.user_id || '') === sessionUserIdStr;
    if (own && (st === 'pending' || st === 'requested')) {
      const withdrawBtn = document.createElement('button');
      withdrawBtn.type = 'button';
      withdrawBtn.textContent = 'Withdraw';
      withdrawBtn.addEventListener('click', async () => {
        try {
          withdrawBtn.disabled = true;
          const res = await fetch(`/api/requests/${request.id}`, {
            method: 'DELETE',
            credentials: 'same-origin',
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data?.error || 'Withdraw failed');
          }
          await refreshAfterAction();
        } catch (error) {
          console.error(error);
          withdrawBtn.disabled = false;
        }
      });
      actionsTd.appendChild(withdrawBtn);
    }
  }
  tr.appendChild(actionsTd);

  return tr;
}

function renderHistoryFollowRow(row) {
  const tr = document.createElement('tr');
  const typeLabel = row.follow_kind === 'playlist' ? 'Playlist' : 'Artist';
  const statusLabel = row.outcome === 'approved' ? 'Approved' : 'Denied';

  function td(text) {
    const cell = document.createElement('td');
    cell.textContent = text ?? '';
    return cell;
  }

  tr.appendChild(td(typeLabel));
  tr.appendChild(td(row.title));
  tr.appendChild(td('—'));
  tr.appendChild(td('—'));
  const userTd = td(row.requested_by_username ?? '');
  userTd.className = 'admin-only';
  tr.appendChild(userTd);
  tr.appendChild(td('Follow'));
  tr.appendChild(td(formatDateTime(row.requested_at || row.resolved_at)));
  tr.appendChild(td(statusLabel));
  const procTd = td('—');
  procTd.className = 'admin-only';
  tr.appendChild(procTd);

  const actionsTd = document.createElement('td');
  const canClear = isAdmin || String(row.user_id) === sessionUserIdStr;
  if (canClear) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', async () => {
      try {
        const res = await fetch(`/api/requests/follow-history/${row.id}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          throw new Error('Clear failed');
        }
        await loadFollowHistory();
        renderHistorySection();
      } catch (e) {
        console.error(e);
      }
    });
    actionsTd.appendChild(clearBtn);
  }
  tr.appendChild(actionsTd);
  return tr;
}

function renderHistoryTrackRow(request) {
  const tr = document.createElement('tr');

  function td(text) {
    const cell = document.createElement('td');
    cell.textContent = text ?? '';
    return cell;
  }

  tr.appendChild(td('Track'));
  tr.appendChild(td(request.title));
  tr.appendChild(td(request.artist));
  tr.appendChild(td(request.album));
  const userTd = td(request.requested_by_username ?? '');
  userTd.className = 'admin-only';
  tr.appendChild(userTd);
  tr.appendChild(td(displayRequestSource(request.request_type)));
  tr.appendChild(td(formatDateTime(request.created_at)));
  tr.appendChild(td(request.displayStatus ?? ''));
  const procTd = td(request.processingStatus ?? '');
  procTd.className = 'admin-only';
  tr.appendChild(procTd);

  const actionsTd = document.createElement('td');
  const canClearTrackHist = isAdmin || String(request.user_id) === sessionUserIdStr;
  if (canClearTrackHist) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', async () => {
      try {
        const res = await fetch(`/api/requests/${request.id}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || 'Clear failed');
        }
        await refreshAfterAction();
      } catch (error) {
        console.error('Clear failed:', error);
        await refreshAfterAction();
      }
    });
    actionsTd.appendChild(clearBtn);
  }
  tr.appendChild(actionsTd);
  return tr;
}

function renderHistorySection() {
  if (!requestHistoryBody) {
    return;
  }
  requestHistoryBody.innerHTML = '';

  const trackHistoryRaw = (currentResults || []).filter((r) => !isTrackActiveRow(r));
  const trackHistory = applyComputeDisplay(trackHistoryRaw);
  const trackRows = trackHistory.map((r) => ({ ...r, historyKind: 'track' }));
  const followRows = (currentFollowHistory || []).map((r) => ({ ...r, historyKind: 'follow' }));
  const hadAnyBeforeFilter = trackRows.length + followRows.length > 0;
  let merged = [...trackRows, ...followRows];
  merged = filterHistoryByType(merged, historyTypeFilter?.value || '');

  if (!merged.length) {
    appendHistoryEmpty(
      hadAnyBeforeFilter ? 'No history matches this filter' : 'No history yet',
    );
    return;
  }

  merged.sort((a, b) => compareHistoryRows(a, b, historySortState.key, historySortState.dir));

  for (const row of merged) {
    if (row.historyKind === 'follow') {
      requestHistoryBody.appendChild(renderHistoryFollowRow(row));
    } else {
      requestHistoryBody.appendChild(renderHistoryTrackRow(row));
    }
  }
}

function renderActiveTable(sourceResults) {
  const previousScrollY = window.scrollY;
  requestsBody.innerHTML = '';

  const activeOnly = (sourceResults || []).filter(isTrackActiveRow);
  const prepared = applyComputeDisplay(normalizeResultsWithOptimistic(activeOnly));
  const filtered = filterByStatus(prepared, statusFilter.value);
  const sorted = sortRows(filtered, sortState.key, sortState.dir);

  if (!sorted.length) {
    const hasAnyActive = activeOnly.length > 0;
    appendActiveEmptyRow(hasAnyActive ? 'No requests match this status filter' : 'No active track requests');
    window.scrollTo(0, previousScrollY);
    return;
  }

  for (const request of sorted) {
    requestsBody.appendChild(renderRow(request));
  }
  window.scrollTo(0, previousScrollY);
}

function formatFollowRequestedAt(iso) {
  return formatDateTime(iso);
}

function buildFollowRequestRows(playlists, artists) {
  return [
    ...(playlists || []).map((r) => ({
      apiKind: 'playlist',
      displayKind: 'Playlist',
      title: r.title || r.playlist_id,
      userLabel: r.requested_by_username || '',
      createdAt: r.created_at,
      id: r.id,
      userId: r.user_id,
    })),
    ...(artists || []).map((r) => ({
      apiKind: 'artist',
      displayKind: 'Artist',
      title: r.name || r.artist_id,
      userLabel: r.requested_by_username || '',
      createdAt: r.created_at,
      id: r.id,
      userId: r.user_id,
    })),
  ];
}

function filterFollowRequestsByShow(rows, showValue) {
  if (!showValue) {
    return rows;
  }
  if (showValue === 'playlist') {
    return rows.filter((r) => r.apiKind === 'playlist');
  }
  if (showValue === 'artist') {
    return rows.filter((r) => r.apiKind === 'artist');
  }
  return rows;
}

function followWithdrawPath(r) {
  return r.apiKind === 'playlist' ? `/api/playlists/follow/${r.id}` : `/api/artists/follow/${r.id}`;
}

function renderFollowRequestsTable() {
  if (!followRequestsBody) {
    return;
  }
  followRequestsBody.innerHTML = '';

  function cell(text) {
    const tdEl = document.createElement('td');
    tdEl.textContent = text ?? '';
    return tdEl;
  }

  const merged = buildFollowRequestRows(followRequestsCache.playlists, followRequestsCache.artists);
  const filtered = filterFollowRequestsByShow(merged, followTypeFilter?.value || '');
  filtered.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    const na = Number.isNaN(ta) ? 0 : ta;
    const nb = Number.isNaN(tb) ? 0 : tb;
    return nb - na;
  });

  if (merged.length === 0) {
    const tr = document.createElement('tr');
    const tdEl = document.createElement('td');
    tdEl.colSpan = followRequestsColSpan;
    tdEl.textContent = 'No pending follow requests.';
    tr.appendChild(tdEl);
    followRequestsBody.appendChild(tr);
    return;
  }

  if (filtered.length === 0) {
    const tr = document.createElement('tr');
    const tdEl = document.createElement('td');
    tdEl.colSpan = followRequestsColSpan;
    tdEl.textContent = 'No follow requests match this filter.';
    tr.appendChild(tdEl);
    followRequestsBody.appendChild(tr);
    return;
  }

  for (const r of filtered) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(r.displayKind));
    tr.appendChild(cell(r.title));
    const userTd = cell(r.userLabel);
    userTd.classList.add('admin-only');
    tr.appendChild(userTd);
    tr.appendChild(cell(formatFollowRequestedAt(r.createdAt)));

    const actionsTd = document.createElement('td');
    if (isAdmin) {
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.textContent = 'Approve';
      const rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.textContent = 'Reject';
      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        try {
          const res = await fetch(`/api/admin/follows/${r.apiKind}/${r.id}/approve`, {
            method: 'POST',
            credentials: 'same-origin',
          });
          if (!res.ok) {
            throw new Error('Approve failed');
          }
          await loadFollowRequests();
          await loadFollowHistory();
          renderHistorySection();
        } catch (e) {
          console.error(e);
          approveBtn.disabled = false;
          rejectBtn.disabled = false;
        }
      });
      rejectBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        try {
          const res = await fetch(`/api/admin/follows/${r.apiKind}/${r.id}/reject`, {
            method: 'POST',
            credentials: 'same-origin',
          });
          if (!res.ok) {
            throw new Error('Reject failed');
          }
          await loadFollowRequests();
          await loadFollowHistory();
          renderHistorySection();
        } catch (e) {
          console.error(e);
          approveBtn.disabled = false;
          rejectBtn.disabled = false;
        }
      });
      actionsTd.appendChild(approveBtn);
      actionsTd.appendChild(document.createTextNode(' '));
      actionsTd.appendChild(rejectBtn);
    } else {
      const withdrawBtn = document.createElement('button');
      withdrawBtn.type = 'button';
      withdrawBtn.textContent = 'Withdraw';
      withdrawBtn.addEventListener('click', async () => {
        try {
          withdrawBtn.disabled = true;
          const res = await fetch(followWithdrawPath(r), {
            method: 'DELETE',
            credentials: 'same-origin',
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data?.error || 'Withdraw failed');
          }
          await loadFollowRequests();
        } catch (e) {
          console.error(e);
          withdrawBtn.disabled = false;
        }
      });
      actionsTd.appendChild(withdrawBtn);
    }
    tr.appendChild(actionsTd);
    followRequestsBody.appendChild(tr);
  }
}

async function loadFollowHistory() {
  try {
    const res = await fetch('/api/requests/follow-history', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      currentFollowHistory = [];
      return;
    }
    currentFollowHistory = Array.isArray(data.results) ? data.results : [];
  } catch (e) {
    console.error(e);
    currentFollowHistory = [];
  }
}

async function loadFollowRequests() {
  if (!followRequestsBody) {
    return;
  }
  try {
    if (isAdmin) {
      const res = await fetch('/api/admin/pending-follows', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        followRequestsBody.innerHTML = '';
        const tr = document.createElement('tr');
        const tdEl = document.createElement('td');
        tdEl.colSpan = followRequestsColSpan;
        tdEl.textContent = 'Could not load follow requests.';
        tr.appendChild(tdEl);
        followRequestsBody.appendChild(tr);
        return;
      }
      followRequestsCache = {
        playlists: Array.isArray(data.playlists) ? data.playlists : [],
        artists: Array.isArray(data.artists) ? data.artists : [],
      };
      renderFollowRequestsTable();
      return;
    }

    const [plRes, arRes] = await Promise.all([
      fetch('/api/playlists/followed?include_pending=1', { credentials: 'same-origin' }),
      fetch('/api/artists/followed?include_pending=1', { credentials: 'same-origin' }),
    ]);
    const plData = plRes.ok ? await plRes.json().catch(() => ({})) : {};
    const arData = arRes.ok ? await arRes.json().catch(() => ({})) : {};
    if (!plRes.ok || !arRes.ok) {
      followRequestsBody.innerHTML = '';
      const tr = document.createElement('tr');
      const tdEl = document.createElement('td');
      tdEl.colSpan = followRequestsColSpan;
      tdEl.textContent = 'Could not load follow requests.';
      tr.appendChild(tdEl);
      followRequestsBody.appendChild(tr);
      return;
    }
    const playlists = (Array.isArray(plData.results) ? plData.results : []).filter(
      (row) => row.follow_status === 'pending',
    );
    const artists = (Array.isArray(arData.results) ? arData.results : []).filter(
      (row) => row.follow_status === 'pending',
    );
    followRequestsCache = { playlists, artists };
    renderFollowRequestsTable();
  } catch (e) {
    console.error(e);
    followRequestsBody.innerHTML = '';
    const tr = document.createElement('tr');
    const tdEl = document.createElement('td');
    tdEl.colSpan = followRequestsColSpan;
    tdEl.textContent = 'Error loading follow requests.';
    tr.appendChild(tdEl);
    followRequestsBody.appendChild(tr);
  }
}

async function loadRequests() {
  try {
    await refreshRequestDisplayTimezone();
    const response = await fetch('/api/requests', { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error('Failed to load requests');
    }

    const data = await response.json();
    currentResults = Array.isArray(data.results) ? data.results : [];
    renderActiveTable(currentResults);
    if (isAdmin) {
      renderHistorySection();
    }
  } catch (error) {
    console.error('Load requests failed:', error);
    requestsBody.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = activeColSpan;
    td.textContent = 'Error loading requests';
    tr.appendChild(td);
    requestsBody.appendChild(tr);
    if (isAdmin && requestHistoryBody) {
      requestHistoryBody.innerHTML = '';
      appendHistoryEmpty('Error loading requests');
    }
  }
}

statusFilter.addEventListener('change', () => {
  renderActiveTable(currentResults);
});

followTypeFilter?.addEventListener('change', () => {
  renderFollowRequestsTable();
});

historyTypeFilter?.addEventListener('change', () => {
  if (isAdmin) {
    renderHistorySection();
  }
});

if (isAdmin) {
  followApproveAllBtn?.addEventListener('click', () => {
    runBulkPost(
      '/api/admin/follows/approve-all',
      'Approve all pending playlist and artist follow requests?',
      (data) => `${Number(data.updated) || 0} follow request(s) approved`,
      { summaryEl: followBulkSummary, buttons: followBulkButtons },
    );
  });

  followDenyAllBtn?.addEventListener('click', () => {
    runBulkPost(
      '/api/admin/follows/reject-all',
      'Reject all pending follow requests? They will be recorded in history as denied.',
      (data) => `${Number(data.updated) || 0} follow request(s) rejected`,
      { summaryEl: followBulkSummary, buttons: followBulkButtons },
    );
  });

  approveAllBtn?.addEventListener('click', () => {
    runBulkPost(
      '/api/requests/approve-all',
      'Approve all pending/requested track requests? This will start downloads for each.',
      null,
      { summaryEl: trackBulkSummary, buttons: trackBulkButtons },
    );
  });

  cancelAllBtn?.addEventListener('click', () => {
    runBulkPost(
      '/api/requests/cancel-all',
      'Cancel all active (processing) track requests? Downloads will finish then be discarded.',
      null,
      { summaryEl: trackBulkSummary, buttons: trackBulkButtons },
    );
  });

  denyAllBtn?.addEventListener('click', () => {
    runBulkPost('/api/requests/deny-all', 'Deny all pending/requested track rows? They will move to Denied.', null, {
      summaryEl: trackBulkSummary,
      buttons: trackBulkButtons,
    });
  });

  retryFailedBtn?.addEventListener('click', () => {
    runBulkPost(
      '/api/requests/retry-failed',
      'Retry all failed track requests? This will queue downloads again.',
      null,
      { summaryEl: trackBulkSummary, buttons: trackBulkButtons },
    );
  });
}

const HISTORY_TRACK_CLEAR_LABELS = {
  completed: 'Completed',
  denied: 'Denied',
  available: 'Available',
  cancelled: 'Cancelled',
};

if (isAdmin) {
  clearHistoryBtn?.addEventListener('click', () => {
    runBulkPost(
      '/api/requests/clear-history',
      'Permanently remove all finished track requests and all follow decision records from the log? Active track and follow queues are not affected.',
      (data) =>
        `${Number(data.deletedTracks) || 0} track row(s), ${Number(data.deletedFollows) || 0} follow record(s) removed`,
      { summaryEl: historyBulkSummary, buttons: historyBulkButtons },
    );
  });

  for (const btn of historyStatusClearBtns) {
    btn.addEventListener('click', () => {
      const st = btn.getAttribute('data-track-status') || '';
      const label = HISTORY_TRACK_CLEAR_LABELS[st] || st;
      runBulkPost(
        '/api/requests/clear-history-status',
        `Permanently remove ${historyScopePhrase()} ${label} track entries from request history?`,
        (data) => `${Number(data.deletedTracks) || 0} track row(s) removed`,
        {
          body: { track_status: st },
          summaryEl: historyBulkSummary,
          buttons: historyBulkButtons,
        },
      );
    });
  }

  for (const btn of historyFollowClearBtns) {
    btn.addEventListener('click', () => {
      const fo = btn.getAttribute('data-follow-outcome') || '';
      const label = fo === 'approved' ? 'approved' : 'denied';
      runBulkPost(
        '/api/requests/clear-history-status',
        `Permanently remove ${historyScopePhrase()} follow history records marked ${label}?`,
        (data) => `${Number(data.deletedFollows) || 0} follow record(s) removed`,
        {
          body: { follow_outcome: fo },
          summaryEl: historyBulkSummary,
          buttons: historyBulkButtons,
        },
      );
    });
  }

  wireHistorySortHeaders();
}

wireSortHeaders();

async function loadAvailabilitySettingsForDisplay() {
  if (!isAdmin) {
    return;
  }
  try {
    const response = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    if (window.TrackFlowRequestDisplay?.configureSettings) {
      window.TrackFlowRequestDisplay.configureSettings(data);
    }
  } catch (_err) {
    // defaults in request-display-shared are fine
  }
}

loadAvailabilitySettingsForDisplay().then(async () => {
  if (isAdmin) {
    await loadFollowHistory();
  }
  await loadRequests();
  await loadFollowRequests();
});
setInterval(() => {
  void loadRequests();
  void loadFollowRequests();
  if (isAdmin) {
    void loadFollowHistory();
  }
}, 5000);
