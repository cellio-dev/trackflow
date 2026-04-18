import { ensureLoggedIn } from '../js/auth-guard.js';
import '../js/app-back-nav.js';

const me = await ensureLoggedIn();
if (!me) {
  await new Promise(() => {});
}
if (me.role !== 'admin') {
  window.location.replace('/index.html');
  await new Promise(() => {});
}

const miFile = document.getElementById('miFile');
const miFileHint = document.getElementById('miFileHint');
const miAnalyzeBtn = document.getElementById('miAnalyzeBtn');
const miYoutubeUrl = document.getElementById('miYoutubeUrl');
const miYoutubeBtn = document.getElementById('miYoutubeBtn');
const miSearch = document.getElementById('miSearch');
const miSearchBtn = document.getElementById('miSearchBtn');
const miResults = document.getElementById('miResults');
const miSummarySection = document.getElementById('miSummarySection');
const miFileSummary = document.getElementById('miFileSummary');
const miDeezerSummary = document.getElementById('miDeezerSummary');
const miConfirmBtn = document.getElementById('miConfirmBtn');
const miMessage = document.getElementById('miMessage');
const miRequestHint = document.getElementById('miRequestHint');

const qs = new URLSearchParams(window.location.search);
const requestIdFromUrl = (qs.get('requestId') || qs.get('request_id') || '').trim();
const deezerIdFromUrl = (qs.get('deezerId') || qs.get('deezer_id') || '').trim();

/** @type {string|null} */
let uploadToken = null;
/** @type {object|null} */
let fileMeta = null;
/** @type {object|null} */
let selectedTrack = null;
/** @type {string|null} */
let lockedDeezerId = deezerIdFromUrl || null;

function showMessage(text, ok) {
  miMessage.textContent = text;
  miMessage.hidden = !text;
  miMessage.className = `mi-msg ${ok ? 'mi-msg--ok' : 'mi-msg--err'}`;
}

function esc(s) {
  const t = String(s ?? '');
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {Array<{ artist?: string, title?: string, file_path?: string }>} matches
 * @returns {Promise<'add_copy' | 'overwrite' | null>}
 */
function showLibraryDuplicateDialog(matches) {
  const dlg = document.getElementById('miDupDialog');
  const listEl = document.getElementById('miDupList');
  const btnAdd = document.getElementById('miDupAddCopy');
  const btnOw = document.getElementById('miDupOverwrite');
  const btnCan = document.getElementById('miDupCancel');
  if (!dlg || !listEl || !btnAdd || !btnOw || !btnCan) {
    return Promise.resolve(null);
  }
  const items = (matches || []).slice(0, 5).map((m) => {
    const sub = m.file_path ? ` <span style="opacity:.75">(${esc(m.file_path)})</span>` : '';
    return `<li>${esc(m.artist)} — ${esc(m.title)}${sub}</li>`;
  });
  listEl.innerHTML = items.length ? items.join('') : '<li>(no details)</li>';
  dlg.hidden = false;

  return new Promise((resolve) => {
    const finish = (v) => {
      dlg.hidden = true;
      btnAdd.removeEventListener('click', onAdd);
      btnOw.removeEventListener('click', onOw);
      btnCan.removeEventListener('click', onCan);
      dlg.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onAdd = () => finish('add_copy');
    const onOw = () => finish('overwrite');
    const onCan = () => finish(null);
    const onBackdrop = (ev) => {
      if (ev.target === dlg) {
        finish(null);
      }
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        finish(null);
      }
    };
    btnAdd.addEventListener('click', onAdd);
    btnOw.addEventListener('click', onOw);
    btnCan.addEventListener('click', onCan);
    dlg.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKey);
  });
}

function renderMeta(dl, obj) {
  const rows = [
    ['Artist', obj.artist || '—'],
    ['Title', obj.title || '—'],
    ['Album', obj.album || '—'],
  ];
  dl.innerHTML = rows
    .map(
      ([k, v]) =>
        `<dt>${esc(k)}</dt><dd>${typeof v === 'string' ? esc(v) : esc(String(v))}</dd>`,
    )
    .join('');
}

function updateSummary() {
  if (!fileMeta || !selectedTrack) {
    miSummarySection.hidden = true;
    miConfirmBtn.disabled = true;
    return;
  }
  miSummarySection.hidden = false;
  renderMeta(miFileSummary, fileMeta);
  renderMeta(miDeezerSummary, {
    artist: selectedTrack.artist,
    title: selectedTrack.title,
    album: selectedTrack.album,
  });
  miConfirmBtn.disabled = false;
}

function clearResults() {
  miResults.innerHTML = '';
  miResults.hidden = true;
}

async function hydrateDeezerFromUrlIfNeeded() {
  if (!deezerIdFromUrl) {
    return;
  }
  try {
    const res = await fetch(`/api/library/manual-import/deezer-lookup/${encodeURIComponent(deezerIdFromUrl)}`, {
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return;
    }
    selectedTrack = {
      id: data.id,
      title: data.title || '',
      artist: data.artist || '',
      album: data.album || null,
    };
    lockedDeezerId = String(data.id);
    miSearch.value = [selectedTrack.artist, selectedTrack.title].filter(Boolean).join(' ');
    clearResults();
    miResults.hidden = false;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mi-track is-selected';
    btn.setAttribute('role', 'option');
    const sub = [selectedTrack.artist, selectedTrack.album].filter(Boolean).join(' · ');
    btn.innerHTML = `<div class="mi-track__title">${esc(selectedTrack.title)}</div><div class="mi-track__sub">${esc(sub)}</div>`;
    btn.addEventListener('click', () => {
      selectedTrack = {
        id: data.id,
        title: data.title || '',
        artist: data.artist || '',
        album: data.album || null,
      };
      updateSummary();
    });
    miResults.appendChild(btn);
    updateSummary();
  } catch {
    /* ignore */
  }
}

async function loadRequestHint() {
  if (!requestIdFromUrl) {
    miRequestHint.hidden = true;
    return;
  }
  try {
    const res = await fetch(`/api/admin/requests/${encodeURIComponent(requestIdFromUrl)}`, {
      credentials: 'same-origin',
    });
    const row = await res.json().catch(() => ({}));
    if (!res.ok) {
      miRequestHint.textContent = 'Could not load request metadata.';
      miRequestHint.hidden = false;
      return;
    }
    const t = [row.artist, row.title].filter(Boolean).join(' — ') || `Request #${requestIdFromUrl}`;
    miRequestHint.textContent = `Completing request: ${t}. The imported track must match this request’s Deezer id.`;
    miRequestHint.hidden = false;
  } catch {
    miRequestHint.textContent = `Completing request #${requestIdFromUrl}.`;
    miRequestHint.hidden = false;
  }
}

miFile?.addEventListener('change', () => {
  uploadToken = null;
  fileMeta = null;
  const f = miFile.files?.[0];
  miAnalyzeBtn.disabled = !f;
  if (f) {
    miFileHint.textContent = f.name;
    miFileHint.hidden = false;
  } else {
    miFileHint.hidden = true;
  }
  updateSummary();
  showMessage('', true);
});

miAnalyzeBtn?.addEventListener('click', async () => {
  const f = miFile?.files?.[0];
  if (!f) {
    return;
  }
  showMessage('', true);
  miAnalyzeBtn.disabled = true;
  miYoutubeBtn.disabled = true;
  try {
    const fd = new FormData();
    fd.append('file', f, f.name);
    const res = await fetch('/api/library/manual-import/analyze', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
    });
    const rawBody = await res.text();
    let data = {};
    try {
      data = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      const hint = rawBody.trim().slice(0, 200);
      throw new Error(
        hint ||
          res.statusText ||
          (res.status ? `Request failed (HTTP ${res.status})` : 'Could not read server response'),
      );
    }
    if (!res.ok) {
      throw new Error(
        data.error ||
          res.statusText ||
          (res.status ? `Request failed (HTTP ${res.status})` : 'Analyze failed'),
      );
    }
    uploadToken = data.uploadToken;
    fileMeta = data.file || {};
    showMessage('Source analyzed. Search Deezer and pick the matching track.', true);
    if (fileMeta.artist || fileMeta.title) {
      miSearch.value = [fileMeta.artist, fileMeta.title].filter(Boolean).join(' ');
    }
    updateSummary();
  } catch (e) {
    uploadToken = null;
    fileMeta = null;
    showMessage(e?.message || 'Analyze failed', false);
    updateSummary();
  } finally {
    miAnalyzeBtn.disabled = !miFile?.files?.[0];
    miYoutubeBtn.disabled = false;
  }
});

miYoutubeBtn?.addEventListener('click', async () => {
  const url = (miYoutubeUrl?.value || '').trim();
  if (!url) {
    showMessage('Paste a YouTube or YouTube Music link.', false);
    return;
  }
  showMessage('Downloading with yt-dlp (this may take a while)…', true);
  miYoutubeBtn.disabled = true;
  miAnalyzeBtn.disabled = true;
  try {
    const res = await fetch('/api/library/manual-import/youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || 'YouTube import failed');
    }
    uploadToken = data.uploadToken;
    fileMeta = data.file || {};
    showMessage('YouTube audio analyzed. Search Deezer and pick the matching track.', true);
    if (fileMeta.artist || fileMeta.title) {
      miSearch.value = [fileMeta.artist, fileMeta.title].filter(Boolean).join(' ');
    }
    updateSummary();
  } catch (e) {
    uploadToken = null;
    fileMeta = null;
    showMessage(e?.message || 'YouTube import failed', false);
    updateSummary();
  } finally {
    miYoutubeBtn.disabled = false;
    miAnalyzeBtn.disabled = !miFile?.files?.[0];
  }
});

async function runSearch() {
  const q = (miSearch?.value || '').trim();
  if (!q) {
    showMessage('Enter a search query.', false);
    return;
  }
  clearResults();
  showMessage('', true);
  miSearchBtn.disabled = true;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || res.statusText);
    }
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (tracks.length === 0) {
      miResults.hidden = false;
      miResults.innerHTML =
        '<div class="mi-track" style="cursor:default;color:var(--tf-muted,#a1a1aa)">No tracks found.</div>';
      return;
    }
    miResults.hidden = false;
    for (const t of tracks) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mi-track';
      btn.setAttribute('role', 'option');
      const sub = [t.artist, t.album].filter(Boolean).join(' · ');
      btn.innerHTML = `<div class="mi-track__title">${esc(t.title)}</div><div class="mi-track__sub">${esc(sub)}</div>`;
      btn.addEventListener('click', () => {
        if (requestIdFromUrl && lockedDeezerId && String(t.id) !== String(lockedDeezerId)) {
          const ok = window.confirm(
            'This request is tied to a different Deezer track. Continue anyway? (The server will reject import if ids do not match.)',
          );
          if (!ok) {
            return;
          }
        }
        selectedTrack = t;
        miResults.querySelectorAll('.mi-track').forEach((el) => el.classList.remove('is-selected'));
        btn.classList.add('is-selected');
        updateSummary();
      });
      miResults.appendChild(btn);
    }
  } catch (e) {
    showMessage(e?.message || 'Search failed', false);
  } finally {
    miSearchBtn.disabled = false;
  }
}

miSearchBtn?.addEventListener('click', () => void runSearch());
miSearch?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    void runSearch();
  }
});

async function postConfirm(body) {
  const res = await fetch('/api/library/manual-import/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.code === 'DUPLICATE') {
    const choice = await showLibraryDuplicateDialog(data.matches || []);
    if (!choice) {
      return { ok: false, cancelled: true };
    }
    return postConfirm({ ...body, libraryDuplicateAction: choice });
  }
  if (!res.ok) {
    throw new Error(data.error || res.statusText);
  }
  return { ok: true, data };
}

miConfirmBtn?.addEventListener('click', async () => {
  if (!uploadToken || !selectedTrack?.id) {
    return;
  }
  if (requestIdFromUrl && lockedDeezerId && String(selectedTrack.id) !== String(lockedDeezerId)) {
    window.alert('Pick the Deezer track that matches this request, or cancel.');
    return;
  }
  showMessage('', true);
  miConfirmBtn.disabled = true;
  try {
    const body = {
      uploadToken,
      deezerId: selectedTrack.id,
      requestId: requestIdFromUrl || undefined,
    };
    const out = await postConfirm(body);
    if (out.cancelled) {
      miConfirmBtn.disabled = false;
      return;
    }
    const data = out.data || {};
    showMessage(`Imported: ${data.libraryPath || 'library'}`, true);
    uploadToken = null;
    fileMeta = null;
    selectedTrack = null;
    if (miFile) {
      miFile.value = '';
    }
    if (miYoutubeUrl) {
      miYoutubeUrl.value = '';
    }
    miAnalyzeBtn.disabled = true;
    miFileHint.hidden = true;
    clearResults();
    miSummarySection.hidden = true;
    miConfirmBtn.disabled = true;
  } catch (e) {
    showMessage(e?.message || 'Import failed', false);
    miConfirmBtn.disabled = false;
  }
});

if (deezerIdFromUrl) {
  lockedDeezerId = deezerIdFromUrl;
  selectedTrack = { id: deezerIdFromUrl, title: '', artist: '', album: null };
}
void hydrateDeezerFromUrlIfNeeded();
void loadRequestHint();
