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
const playlistId = params.get('id');
const playlistCover = document.getElementById('playlistCover');
const playlistTitle = document.getElementById('playlistTitle');
const resultsList = document.getElementById('resultsList');
const optimisticRequestStatusById = new Map();
let followedRow = null;
let currentPlaylist = null;
let lastPlaylistTracks = [];

const STATUS_SYNC_INTERVAL_MS = 12_000;
const requestAllButton = document.getElementById('requestAllButton');
const requestAllFeedback = document.getElementById('requestAllFeedback');
const tracksSectionHeading = document.getElementById('tracksSectionHeading');
const plexSyncToggle = document.getElementById('plexSyncToggle');
const plexSyncFeedback = document.getElementById('plexSyncFeedback');

function updateTracksHeading(count) {
  if (!tracksSectionHeading) {
    return;
  }
  const n = Math.max(0, Math.floor(Number(count)) || 0);
  tracksSectionHeading.textContent = `${n} Track${n === 1 ? '' : 's'}`;
}

function setRequestAllFeedback(text, variant) {
  requestAllFeedback.textContent = text || '';
  requestAllFeedback.classList.remove('is-error', 'is-success');
  if (variant === 'error') {
    requestAllFeedback.classList.add('is-error');
  } else if (variant === 'success') {
    requestAllFeedback.classList.add('is-success');
  }
}

async function refreshPlaylistTracksOnly() {
  if (!playlistId || !playlistId.trim()) {
    return;
  }
  try {
    const response = await fetch(
      `/api/search/playlist/${encodeURIComponent(playlistId.trim())}`,
      { credentials: 'same-origin' },
    );
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    const result = data.result;
    if (!result || !Array.isArray(result.tracks)) {
      return;
    }
    const fresh = result.tracks;
    TrackFlowTrackList.mergeEnrichedIntoTrackArray(lastPlaylistTracks, fresh);
    TrackFlowTrackList.syncTrackListRows(resultsList, fresh, optimisticRequestStatusById);
  } catch (e) {
    console.warn('Could not refresh track statuses:', e);
  }
}

async function runRequestAll() {
  if (!playlistId || !playlistId.trim()) {
    return;
  }
  requestAllButton.dataset.loading = '1';
  requestAllButton.disabled = true;
  setRequestAllFeedback('Requesting…', null);
  try {
    const response = await fetch(
      `/api/playlists/${encodeURIComponent(playlistId.trim())}/request-all`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({}),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error || 'Request failed';
      throw new Error(msg);
    }
    const x = Number(data.newly_requested) || 0;
    const y = Number(data.skipped_existing) || 0;
    const lib = Number(data.skipped_in_library) || 0;
    const plex = Number(data.skipped_in_plex) || 0;
    const parts = [`${x} tracks requested`, `${y} already in requests`];
    const skippedAvailable = lib + plex;
    if (skippedAvailable > 0) {
      parts.push(`${skippedAvailable} skipped (Available)`);
    }
    setRequestAllFeedback(parts.join(', '), 'success');
    await refreshPlaylistTracksOnly();
  } catch (err) {
    console.error('Request all failed:', err);
    setRequestAllFeedback(err?.message || 'Request failed', 'error');
  } finally {
    delete requestAllButton.dataset.loading;
    updateRequestAllButtonState();
  }
}

function renderTracks(results) {
  const list = Array.isArray(results) ? results : [];
  lastPlaylistTracks = list;
  updateTracksHeading(list.length);
  TrackFlowTrackList.renderTrackList(
    resultsList,
    list,
    optimisticRequestStatusById,
    loadPlaylistPage,
    { showArtistLink: true, neutralHoverLinks: true },
  );
}

function setPlexSyncFeedback(text, variant) {
  if (!plexSyncFeedback) {
    return;
  }
  plexSyncFeedback.textContent = text || '';
  plexSyncFeedback.hidden = !text;
  plexSyncFeedback.classList.remove('is-error');
  if (variant === 'error') {
    plexSyncFeedback.classList.add('is-error');
  }
}

function updatePlexSyncToggle() {
  if (!plexSyncToggle) {
    return;
  }
  const isPlex = String(__tfMe?.auth_provider || '').toLowerCase() === 'plex';
  const show = Boolean(isPlex && followedRow && followedRow.follow_status === 'active');
  plexSyncToggle.hidden = !show;
  if (!show) {
    setPlexSyncFeedback('');
    return;
  }
  plexSyncToggle.textContent = followedRow.plex_sync_enabled
    ? 'Disable Plex Sync'
    : 'Enable Plex Sync';
}

function renderFollowButton() {
  const followButton = document.getElementById('followButton');
  if (!followButton) {
    return;
  }
  followButton.classList.remove('is-pending-follow', 'is-active-follow');
  if (!followedRow) {
    followButton.textContent = 'Follow';
  } else if (followedRow.follow_status === 'pending') {
    followButton.textContent = 'Pending approval';
    followButton.classList.add('is-pending-follow');
  } else {
    followButton.textContent = 'Unfollow';
    followButton.classList.add('is-active-follow');
  }
  followButton.disabled = !currentPlaylist;
  updatePlexSyncToggle();
}

function updateRequestAllButtonState() {
  const busy = requestAllButton?.dataset?.loading === '1';
  if (busy) {
    return;
  }
  requestAllButton.disabled = !currentPlaylist;
}

async function loadFollowState() {
  if (!playlistId || !playlistId.trim()) {
    followedRow = null;
    renderFollowButton();
    return;
  }

  try {
    const response = await fetch('/api/playlists/followed?include_pending=1', {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error('Failed to load followed playlists');
    }
    const data = await response.json();
    const followed = Array.isArray(data.results) ? data.results : [];
    const matched = followed.find((item) => String(item.playlist_id) === playlistId.trim());
    followedRow = matched || null;
  } catch (error) {
    console.error('Load follow state failed:', error);
    followedRow = null;
  }
  renderFollowButton();
}

async function togglePlexSync() {
  if (!plexSyncToggle || !followedRow?.id || followedRow.follow_status !== 'active') {
    return;
  }
  const next = !followedRow.plex_sync_enabled;
  setPlexSyncFeedback('');
  plexSyncToggle.disabled = true;
  try {
    const res = await fetch(`/api/playlists/follow/${followedRow.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ plex_sync_enabled: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Could not update Plex sync');
    }
    followedRow = { ...followedRow, ...data };
    updatePlexSyncToggle();
  } catch (err) {
    console.error('Plex sync toggle failed:', err);
    setPlexSyncFeedback(err?.message || 'Update failed', 'error');
    updatePlexSyncToggle();
  } finally {
    plexSyncToggle.disabled = false;
  }
}

async function toggleFollow() {
  const followButton = document.getElementById('followButton');
  if (!followButton || !currentPlaylist) {
    return;
  }

  followButton.disabled = true;
  try {
    if (followedRow) {
      const response = await fetch(`/api/playlists/follow/${followedRow.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error('Failed to unfollow playlist');
      }
      followedRow = null;
    } else {
      const response = await fetch('/api/playlists/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          playlist_id: String(currentPlaylist.id),
          title: currentPlaylist.title || 'Playlist',
          picture: currentPlaylist.picture || null,
        }),
      });
      if (!response.ok) {
        throw new Error('Failed to follow playlist');
      }
      const created = await response.json();
      followedRow = created && created.id != null ? created : null;
    }
  } catch (error) {
    console.error('Follow toggle failed:', error);
  } finally {
    renderFollowButton();
  }
}

async function loadPlaylistPage() {
  if (!playlistId || !playlistId.trim()) {
    playlistTitle.textContent = 'Missing playlist id';
    playlistCover.removeAttribute('src');
    resultsList.innerHTML = '';
    resultsList.classList.add('track-list-vertical');
    const missingLi = document.createElement('li');
    missingLi.className = 'track-list-empty';
    missingLi.textContent = 'Missing playlist id in URL (?id=...)';
    resultsList.appendChild(missingLi);
    lastPlaylistTracks = [];
    updateTracksHeading(0);
    updateRequestAllButtonState();
    return;
  }

  try {
    const response = await fetch(`/api/search/playlist/${encodeURIComponent(playlistId.trim())}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error('Failed to load playlist');
    }

    const data = await response.json();
    const result = data.result;
    if (!result) {
      throw new Error('Invalid playlist response');
    }

    currentPlaylist = {
      id: result.id,
      title: result.title || 'Playlist',
      picture: result.picture || null,
    };
    playlistTitle.textContent = result.title || 'Playlist';
    playlistCover.src = result.picture || '';
    playlistCover.alt = result.title || 'Playlist cover';
    renderTracks(Array.isArray(result.tracks) ? result.tracks : []);
    await loadFollowState();
    updateRequestAllButtonState();
  } catch (error) {
    console.error('Playlist page error:', error);
    currentPlaylist = null;
    followedRow = null;
    renderFollowButton();
    updateRequestAllButtonState();
    playlistTitle.textContent = 'Error loading playlist';
    resultsList.innerHTML = '';
    resultsList.classList.add('track-list-vertical');
    const errorItem = document.createElement('li');
    errorItem.className = 'track-list-empty';
    errorItem.textContent = 'Error loading playlist tracks';
    resultsList.appendChild(errorItem);
    lastPlaylistTracks = [];
    updateTracksHeading(0);
  }
}

requestAllButton.addEventListener('click', runRequestAll);

const followButtonEl = document.getElementById('followButton');
if (followButtonEl) {
  followButtonEl.addEventListener('click', () => void toggleFollow());
}
plexSyncToggle?.addEventListener('click', () => void togglePlexSync());

renderFollowButton();
loadPlaylistPage();
setInterval(() => {
  void refreshPlaylistTracksOnly();
}, STATUS_SYNC_INTERVAL_MS);
