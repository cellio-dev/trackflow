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
const artistId = params.get('id');
const resultsList = document.getElementById('resultsList');
const albumsGrid = document.getElementById('albumsGrid');
const requestAllBtn = document.getElementById('requestAllBtn');
const artistCover = document.getElementById('artistCover');
const artistTitle = document.getElementById('artistTitle');
const followButton = document.getElementById('followButton');
const tracksSectionHeading = document.getElementById('tracksSectionHeading');
const optimisticRequestStatusById = new Map();
let lastTopTracks = [];
let currentArtist = null;
let followedRow = null;

const STATUS_SYNC_INTERVAL_MS = 12_000;

async function syncArtistTrackStatusesQuietly() {
  if (!artistId || !artistId.trim()) {
    return;
  }
  try {
    const tracksRes = await fetch(`/api/search/artist/${encodeURIComponent(artistId.trim())}`, {
      credentials: 'same-origin',
    });
    if (!tracksRes.ok) {
      return;
    }
    const tracksData = await tracksRes.json();
    const fresh = Array.isArray(tracksData.results) ? tracksData.results : [];
    TrackFlowTrackList.mergeEnrichedIntoTrackArray(lastTopTracks, fresh);
    TrackFlowTrackList.syncTrackListRows(resultsList, fresh, optimisticRequestStatusById);
  } catch {
    /* ignore background sync errors */
  }
}

function updateTopTracksHeading(count) {
  if (!tracksSectionHeading) {
    return;
  }
  const n = Math.max(0, Math.floor(Number(count)) || 0);
  tracksSectionHeading.textContent = `Top ${n} Track${n === 1 ? '' : 's'}`;
}

function renderFollowButton() {
  if (!followButton) {
    return;
  }
  followButton.classList.remove('is-pending-follow', 'is-active-follow', 'is-denied-follow');
  if (!followedRow) {
    followButton.textContent = 'Follow';
  } else if (followedRow.follow_status === 'pending') {
    followButton.textContent = 'Pending approval';
    followButton.classList.add('is-pending-follow');
  } else if (followedRow.follow_status === 'denied') {
    followButton.textContent = 'Follow denied';
    followButton.classList.add('is-denied-follow');
  } else {
    followButton.textContent = 'Unfollow';
    followButton.classList.add('is-active-follow');
  }
  followButton.disabled = !currentArtist || followedRow?.follow_status === 'denied';
}

async function loadFollowState() {
  if (!artistId || !artistId.trim()) {
    followedRow = null;
    renderFollowButton();
    return;
  }
  try {
    const response = await fetch('/api/artists/followed?include_pending=1', {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error('Failed to load followed artists');
    }
    const data = await response.json();
    const followed = Array.isArray(data.results) ? data.results : [];
    const matched = followed.find((item) => String(item.artist_id) === artistId.trim());
    followedRow = matched || null;
  } catch (error) {
    console.error('Load follow state failed:', error);
    followedRow = null;
  }
  renderFollowButton();
}

async function toggleFollow() {
  if (!followButton || !currentArtist) {
    return;
  }
  if (followedRow?.follow_status === 'denied') {
    return;
  }
  followButton.disabled = true;
  try {
    if (followedRow) {
      const response = await fetch(`/api/artists/follow/${followedRow.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error('Failed to unfollow artist');
      }
      followedRow = null;
    } else {
      const response = await fetch('/api/artists/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          artist_id: String(currentArtist.id),
          name: currentArtist.name || 'Artist',
          picture: currentArtist.picture || null,
        }),
      });
      if (!response.ok) {
        throw new Error('Failed to follow artist');
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

if (followButton) {
  followButton.addEventListener('click', () => void toggleFollow());
}

function applyArtistHeader(tracks, artistMeta) {
  const t0 = Array.isArray(tracks) && tracks[0];
  if (!t0 && !artistMeta) {
    currentArtist = null;
    followedRow = null;
    if (artistTitle) {
      artistTitle.textContent = 'Artist';
    }
    if (artistCover) {
      artistCover.removeAttribute('src');
      artistCover.alt = '';
    }
    renderFollowButton();
    return;
  }
  const name = (artistMeta && artistMeta.name) || (t0 && t0.artist) || 'Artist';
  if (artistTitle) {
    artistTitle.textContent = name;
  }
  const headerImage =
    (artistMeta && artistMeta.picture) ||
    (t0 && t0.artistPicture) ||
    (t0 && t0.albumCover) ||
    '';
  if (artistCover) {
    if (headerImage) {
      artistCover.src = headerImage;
      artistCover.alt = name;
    } else {
      artistCover.removeAttribute('src');
      artistCover.alt = '';
    }
  }
  currentArtist = {
    id: artistId.trim(),
    name,
    picture:
      (artistMeta && artistMeta.picture) ||
      (t0 && t0.artistPicture) ||
      (t0 && t0.albumCover) ||
      null,
  };
  void loadFollowState();
}

function renderResults(results) {
  const list = Array.isArray(results) ? results : [];
  updateTopTracksHeading(list.length);
  TrackFlowTrackList.renderTrackList(
    resultsList,
    list,
    optimisticRequestStatusById,
    loadArtistPage,
    { showArtistLink: false, neutralHoverLinks: true },
  );
}

function renderAlbums(albums) {
  albumsGrid.innerHTML = '';
  if (!Array.isArray(albums) || albums.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No albums';
    empty.style.fontSize = '13px';
    empty.style.color = '#555';
    albumsGrid.appendChild(empty);
    return;
  }

  for (const album of albums) {
    const link = document.createElement('a');
    link.className = 'album-card';
    link.href = `/album.html?id=${encodeURIComponent(String(album.id))}`;

    const img = document.createElement('img');
    img.className = 'album-cover';
    img.src = album.cover || '';
    img.alt = album.title || 'Album cover';

    const title = document.createElement('div');
    title.className = 'album-title';
    title.textContent = album.title || 'Unknown';

    link.appendChild(img);
    link.appendChild(title);
    albumsGrid.appendChild(link);
  }
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
  const eligible = getEligibleForRequestAll(lastTopTracks);
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
    await loadArtistPage();
  } finally {
    requestAllBtn.disabled = false;
  }
}

requestAllBtn.addEventListener('click', runRequestAll);

async function loadArtistPage() {
  if (!artistId || !artistId.trim()) {
    lastTopTracks = [];
    currentArtist = null;
    followedRow = null;
    renderFollowButton();
    albumsGrid.innerHTML = '';
    resultsList.innerHTML = '';
    resultsList.classList.add('track-list-vertical');
    const item = document.createElement('li');
    item.className = 'track-list-empty';
    item.textContent = 'Missing artist id in URL (?id=...)';
    resultsList.appendChild(item);
    updateTopTracksHeading(0);
    return;
  }

  const id = artistId.trim();

  try {
    const [tracksRes, albumsRes] = await Promise.all([
      fetch(`/api/search/artist/${encodeURIComponent(id)}`, { credentials: 'same-origin' }),
      fetch(`/api/search/artist/${encodeURIComponent(id)}/albums`, { credentials: 'same-origin' }),
    ]);

    if (albumsRes.ok) {
      const albumsData = await albumsRes.json();
      renderAlbums(albumsData.results || []);
    } else {
      albumsGrid.innerHTML = '';
      const errAlbums = document.createElement('p');
      errAlbums.textContent = 'Error loading albums';
      errAlbums.style.fontSize = '13px';
      errAlbums.style.color = '#c00';
      albumsGrid.appendChild(errAlbums);
    }

    if (tracksRes.ok) {
      const tracksData = await tracksRes.json();
      lastTopTracks = tracksData.results || [];
      applyArtistHeader(lastTopTracks, tracksData.artist);
      renderResults(lastTopTracks);
    } else {
      lastTopTracks = [];
      applyArtistHeader([], null);
      resultsList.innerHTML = '';
      resultsList.classList.add('track-list-vertical');
      const errorItem = document.createElement('li');
      errorItem.className = 'track-list-empty';
      errorItem.textContent = 'Error loading artist tracks';
      resultsList.appendChild(errorItem);
      updateTopTracksHeading(0);
    }
  } catch (error) {
    console.error('Artist page error:', error);
    lastTopTracks = [];
    currentArtist = null;
    followedRow = null;
    renderFollowButton();
    albumsGrid.innerHTML = '';
    const errAlbums = document.createElement('p');
    errAlbums.textContent = 'Error loading albums';
    errAlbums.style.fontSize = '13px';
    errAlbums.style.color = '#c00';
    albumsGrid.appendChild(errAlbums);

    resultsList.innerHTML = '';
    resultsList.classList.add('track-list-vertical');
    const errorItem = document.createElement('li');
    errorItem.className = 'track-list-empty';
    errorItem.textContent = 'Error loading artist tracks';
    resultsList.appendChild(errorItem);
    updateTopTracksHeading(0);
  }
}

loadArtistPage();
setInterval(() => {
  void syncArtistTrackStatusesQuietly();
}, STATUS_SYNC_INTERVAL_MS);
