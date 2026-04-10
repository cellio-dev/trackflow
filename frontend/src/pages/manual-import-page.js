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
const miSearch = document.getElementById('miSearch');
const miSearchBtn = document.getElementById('miSearchBtn');
const miResults = document.getElementById('miResults');
const miSummarySection = document.getElementById('miSummarySection');
const miFileSummary = document.getElementById('miFileSummary');
const miDeezerSummary = document.getElementById('miDeezerSummary');
const miConfirmBtn = document.getElementById('miConfirmBtn');
const miMessage = document.getElementById('miMessage');

/** @type {string|null} */
let uploadToken = null;
/** @type {object|null} */
let fileMeta = null;
/** @type {object|null} */
let selectedTrack = null;
let selectedFileLabel = '';

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

miFile?.addEventListener('change', () => {
  uploadToken = null;
  fileMeta = null;
  const f = miFile.files?.[0];
  miAnalyzeBtn.disabled = !f;
  if (f) {
    selectedFileLabel = f.name;
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
    showMessage('File analyzed. Search Deezer and pick the matching track.', true);
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

miConfirmBtn?.addEventListener('click', async () => {
  if (!uploadToken || !selectedTrack?.id) {
    return;
  }
  showMessage('', true);
  miConfirmBtn.disabled = true;
  try {
    const res = await fetch('/api/library/manual-import/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ uploadToken, deezerId: selectedTrack.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText);
    }
    showMessage(`Imported: ${data.libraryPath || 'library'}`, true);
    uploadToken = null;
    fileMeta = null;
    selectedTrack = null;
    if (miFile) {
      miFile.value = '';
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
