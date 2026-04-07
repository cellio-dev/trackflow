import { ensureLoggedIn } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';
import { createDiscoverFeedCore } from '../js/discover-feed-core.js';
import { collectTrackListDeezerIds, startDiscoverTrackStatusPolling } from '../js/discover-track-status-poll.js';
import '../js/track-list-shared.js';
import '../js/track-card-shared.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}

const params = new URLSearchParams(window.location.search);
const genreIdRaw = params.get('id');
const genreId = genreIdRaw != null && String(genreIdRaw).trim() !== '' ? String(genreIdRaw).trim() : '';

const searchInput = document.getElementById('searchInput');
const genrePageTitle = document.getElementById('genrePageTitle');

const genreTrendingTracksSection = document.getElementById('genreTrendingTracksSection');
const genreNewTracksSection = document.getElementById('genreNewTracksSection');
const genreTrendingPlaylistsSection = document.getElementById('genreTrendingPlaylistsSection');
const genrePopularArtistsSection = document.getElementById('genrePopularArtistsSection');
const genreNewAlbumsSection = document.getElementById('genreNewAlbumsSection');
const genreTrendingTracksList = document.getElementById('genreTrendingTracksList');
const genreNewTracksList = document.getElementById('genreNewTracksList');
const genreTrendingPlaylistsList = document.getElementById('genreTrendingPlaylistsList');
const genrePopularArtistsList = document.getElementById('genrePopularArtistsList');
const genreNewAlbumsList = document.getElementById('genreNewAlbumsList');
const genrePageLoading = document.getElementById('genrePageLoading');

function hideGenrePageLoading() {
  if (!genrePageLoading) {
    return;
  }
  genrePageLoading.hidden = true;
  genrePageLoading.removeAttribute('aria-busy');
}

function showGenrePageLoading() {
  if (!genrePageLoading) {
    return;
  }
  genrePageLoading.hidden = false;
  genrePageLoading.setAttribute('aria-busy', 'true');
}

const optimisticRequestStatusById = new Map();
const core = createDiscoverFeedCore(optimisticRequestStatusById);
const {
  initHorizontalScrollBlocks,
  fillDiscoverTrackSection,
  fillDiscoverEntitySection,
  refreshEntityFollowUi,
} = core;

initHorizontalScrollBlocks();

let stopGenreTrackStatusPoll = null;

const GENRE_PREVIEW_CHUNK = 24;

/**
 * Cached genre rows may use trackId/albumArt; cards expect id/albumCover.
 * Strip preview so the first paint is always the disabled play state; previews load async.
 */
function normalizeGenreCachedTrack(t) {
  if (!t || typeof t !== 'object') {
    return t;
  }
  const {
    preview: _p,
    preview_url: _pu,
    trackId,
    albumArt,
    ...rest
  } = t;
  const id = trackId != null ? trackId : rest.id;
  return {
    ...rest,
    id,
    albumCover: albumArt ?? rest.albumCover ?? '',
  };
}

function normalizeGenreTrackList(tracks) {
  return (Array.isArray(tracks) ? tracks : []).map(normalizeGenreCachedTrack);
}

function applyPreviewChunkToLists(listEls, byId) {
  if (!byId || typeof byId !== 'object') {
    return;
  }
  const apply = window.TrackFlowTrackCard?.patchTrackListItem;
  if (typeof apply !== 'function') {
    console.warn('Genre preview load: TrackFlowTrackCard.patchTrackListItem missing');
    return;
  }
  for (const ul of listEls) {
    if (!ul) continue;
    for (const li of ul.querySelectorAll('li[data-trackflow-id]')) {
      const id = li.getAttribute('data-trackflow-id');
      const row = id ? byId[id] : null;
      const preview =
        row && typeof row.preview === 'string' && row.preview.trim() ? row.preview.trim() : '';
      if (!preview) continue;
      const patch = { preview };
      if (row.albumCover && String(row.albumCover).trim()) {
        patch.albumCover = String(row.albumCover).trim();
      }
      apply(li, patch);
    }
  }
}

/** Collect ids from rendered cards, fetch previews in chunks, apply each chunk as it returns. */
async function loadGenrePreviewsAfterRender(listEls) {
  const ids = collectTrackListDeezerIds(listEls);
  if (ids.length === 0) {
    return;
  }
  for (let i = 0; i < ids.length; i += GENRE_PREVIEW_CHUNK) {
    const chunk = ids.slice(i, i + GENRE_PREVIEW_CHUNK);
    try {
      const res = await fetch('/api/discover/track-previews', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk }),
      });
      if (!res.ok) {
        console.warn('Genre preview load:', `HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const byId = data?.byId && typeof data.byId === 'object' ? data.byId : null;
      if (!byId) {
        console.warn('Genre preview load: missing byId');
        continue;
      }
      applyPreviewChunkToLists(listEls, byId);
    } catch (e) {
      console.warn('Genre preview load:', e?.message || e);
    }
  }
}

let genreFeedPromise = Promise.resolve();
if (!genreId || !/^\d+$/.test(genreId)) {
  hideGenrePageLoading();
  genrePageTitle.textContent = 'Genre not found';
} else {
  showGenrePageLoading();
  genreFeedPromise = loadGenreFeed(genreId);
}

await Promise.all([initAppNavAuth(__tfMe), genreFeedPromise]);

searchInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const q = searchInput.value.trim();
    if (q) {
      window.location.href = `/index.html?q=${encodeURIComponent(q)}`;
    }
  }
});

async function loadGenreFeed(id) {
  try {
    const res = await fetch(`/api/discover/genre/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      genrePageTitle.textContent = data?.error || 'Could not load genre';
      return;
    }
    const data = await res.json();
    const name = data.genre?.name || 'Genre';
    genrePageTitle.textContent = name;
    document.title = `${name} · TrackFlow`;

    fillDiscoverTrackSection(
      genreTrendingTracksSection,
      genreTrendingTracksList,
      normalizeGenreTrackList(data.trendingTracks || []),
    );
    fillDiscoverTrackSection(
      genreNewTracksSection,
      genreNewTracksList,
      normalizeGenreTrackList(data.newTracks || []),
    );
    fillDiscoverEntitySection(
      genreTrendingPlaylistsSection,
      genreTrendingPlaylistsList,
      data.trendingPlaylists || [],
    );
    fillDiscoverEntitySection(
      genrePopularArtistsSection,
      genrePopularArtistsList,
      data.popularArtists || [],
    );
    fillDiscoverEntitySection(genreNewAlbumsSection, genreNewAlbumsList, data.newAlbums || []);
    void refreshEntityFollowUi();

    void loadGenrePreviewsAfterRender([genreTrendingTracksList, genreNewTracksList]);

    if (stopGenreTrackStatusPoll) stopGenreTrackStatusPoll();
    stopGenreTrackStatusPoll = startDiscoverTrackStatusPolling(
      [genreTrendingTracksList, genreNewTracksList],
      { refreshEntityFollowUi },
    );
  } catch (e) {
    console.error('Genre feed:', e);
    genrePageTitle.textContent = 'Error loading genre';
  } finally {
    hideGenrePageLoading();
  }
}
