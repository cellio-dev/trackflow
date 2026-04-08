import { ensureLoggedIn } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';
import '../js/track-list-shared.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await initAppNavAuth(__tfMe);

const TrackFlowTrackList = window.TrackFlowTrackList;

const params = new URLSearchParams(window.location.search);
const albumId = params.get('id');
const resultsList = document.getElementById('resultsList');
const albumCover = document.getElementById('albumCover');
const albumTitle = document.getElementById('albumTitle');
const artistLink = document.getElementById('artistLink');
const optimisticRequestStatusById = new Map();
const requestAllBtn = document.getElementById('requestAllBtn');
const tracksSectionHeading = document.getElementById('tracksSectionHeading');

let currentArtistId = null;
let lastAlbumTracks = [];

const STATUS_SYNC_INTERVAL_MS = 12_000;

async function syncAlbumTrackStatusesQuietly() {
  if (!albumId || !albumId.trim()) {
    return;
  }
  try {
    const response = await fetch(`/api/search/album/${encodeURIComponent(albumId.trim())}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    const result = data.result;
    const fresh = Array.isArray(result?.tracks) ? result.tracks : [];
    TrackFlowTrackList.mergeEnrichedIntoTrackArray(lastAlbumTracks, fresh);
    TrackFlowTrackList.syncTrackListRows(resultsList, fresh, optimisticRequestStatusById);
  } catch {
    /* ignore background sync errors */
  }
}

function updateTracksHeading(count) {
  if (!tracksSectionHeading) {
    return;
  }
  const n = Math.max(0, Math.floor(Number(count)) || 0);
  tracksSectionHeading.textContent = `${n} Track${n === 1 ? '' : 's'}`;
}

function renderResults(results) {
  const list = Array.isArray(results) ? results : [];
  updateTracksHeading(list.length);
  TrackFlowTrackList.renderTrackList(
    resultsList,
    results,
    optimisticRequestStatusById,
    loadAlbumPage,
    { showArtistLink: true, freezeRowMeta: true, neutralHoverLinks: true },
  );
}

function getEligibleForRequestAll(tracks) {
  const seen = new Set();
  const out = [];
  for (const t of tracks) {
    if (t.requestStatus !== null && t.requestStatus !== undefined) continue;
    if (t.existsInMusicLibrary === true || t.isInUserLibrary === true) {
      continue;
    }
    const key = String(t.id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

async function runRequestAll() {
  const eligible = getEligibleForRequestAll(lastAlbumTracks);
  if (eligible.length === 0) return;
  requestAllBtn.disabled = true;
  try {
    for (const track of eligible) {
      try {
        await TrackFlowTrackList.createRequest(track);
      } catch (err) {
        console.warn('Request All: skip or fail for track', track.id, err.message);
      }
    }
    await loadAlbumPage();
  } finally {
    requestAllBtn.disabled = false;
  }
}

requestAllBtn.addEventListener('click', runRequestAll);

async function loadAlbumPage() {
  if (!albumId || !albumId.trim()) {
    lastAlbumTracks = [];
    albumCover.removeAttribute('src');
    albumTitle.textContent = 'Album';
    artistLink.textContent = 'Missing album id';
    artistLink.removeAttribute('href');
    resultsList.innerHTML = '';
    resultsList.classList.add('track-list-vertical');
    const item = document.createElement('li');
    item.className = 'track-list-empty';
    item.textContent = 'Missing album id in URL (?id=...)';
    resultsList.appendChild(item);
    updateTracksHeading(0);
    return;
  }

  const id = albumId.trim();

  try {
    const response = await fetch(`/api/search/album/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error('Failed to load album');
    }

    const data = await response.json();
    const result = data.result;
    if (!result) {
      throw new Error('Invalid response');
    }

    currentArtistId = result.artistId != null ? String(result.artistId) : null;

    albumCover.src = result.cover || '';
    albumCover.alt = result.albumTitle || 'Album cover';
    albumTitle.textContent = result.albumTitle || 'Album';
    artistLink.textContent = result.artist || 'Unknown artist';

    if (currentArtistId) {
      const artistHref = `/artist.html?id=${encodeURIComponent(currentArtistId)}`;
      artistLink.href = artistHref;
    } else {
      artistLink.removeAttribute('href');
    }

    lastAlbumTracks = result.tracks || [];
    renderResults(lastAlbumTracks);
  } catch (error) {
    console.error('Album page error:', error);
    lastAlbumTracks = [];
    albumCover.removeAttribute('src');
    albumTitle.textContent = 'Album';
    artistLink.textContent = 'Error';
    artistLink.removeAttribute('href');
    resultsList.innerHTML = '';
    resultsList.classList.add('track-list-vertical');
    const errorItem = document.createElement('li');
    errorItem.className = 'track-list-empty';
    errorItem.textContent = 'Error loading album';
    resultsList.appendChild(errorItem);
    updateTracksHeading(0);
  }
}

loadAlbumPage();
setInterval(() => {
  void syncAlbumTrackStatusesQuietly();
}, STATUS_SYNC_INTERVAL_MS);
