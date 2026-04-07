import { ensureLoggedIn } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';
import { createDiscoverFeedCore } from '../js/discover-feed-core.js';
import { startDiscoverTrackStatusPolling } from '../js/discover-track-status-poll.js';
import {
  collectDeezerTrackIdsForPreviewHydrate,
  waitForTrackFlowTrackCardPatch,
} from '../js/deezer-preview-expiry.js';
import '../js/track-list-shared.js';
import '../js/track-card-shared.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await initAppNavAuth(__tfMe);

const searchInput = document.getElementById('searchInput');
const discoverFeedShell = document.getElementById('discoverFeedShell');
const searchResultsShell = document.getElementById('searchResultsShell');

const discoverRecommendedSection = document.getElementById('discoverRecommendedSection');
const discoverRecommendedArtistsSection = document.getElementById('discoverRecommendedArtistsSection');
const discoverTrendingTracksSection = document.getElementById('discoverTrendingTracksSection');
const discoverNewTracksSection = document.getElementById('discoverNewTracksSection');
const discoverTrendingPlaylistsSection = document.getElementById('discoverTrendingPlaylistsSection');
const discoverPopularArtistsSection = document.getElementById('discoverPopularArtistsSection');
const discoverNewAlbumsSection = document.getElementById('discoverNewAlbumsSection');
const discoverRecommendedList = document.getElementById('discoverRecommendedList');
const discoverRecommendedArtistsList = document.getElementById('discoverRecommendedArtistsList');
const discoverTrendingTracksList = document.getElementById('discoverTrendingTracksList');
const discoverNewTracksList = document.getElementById('discoverNewTracksList');
const discoverTrendingPlaylistsList = document.getElementById('discoverTrendingPlaylistsList');
const discoverPopularArtistsList = document.getElementById('discoverPopularArtistsList');
const discoverNewAlbumsList = document.getElementById('discoverNewAlbumsList');
const discoverRecentList = document.getElementById('discoverRecentList');
const discoverGenresSection = document.getElementById('discoverGenresSection');
const discoverGenresList = document.getElementById('discoverGenresList');

const tracksSection = document.getElementById('tracksSection');
const artistsSection = document.getElementById('artistsSection');
const albumsSection = document.getElementById('albumsSection');
const playlistsSection = document.getElementById('playlistsSection');
const tracksList = document.getElementById('tracksList');
const artistsList = document.getElementById('artistsList');
const albumsList = document.getElementById('albumsList');
const playlistsList = document.getElementById('playlistsList');
let lastQuery = '';
let isSearching = false;
let stopDiscoverTrackStatusPoll = null;
const optimisticRequestStatusById = new Map();

function shouldPollDiscoverOrSearch() {
  const onDiscover = Boolean(discoverFeedShell && !discoverFeedShell.hidden);
  const onSearch = Boolean(searchResultsShell && !searchResultsShell.hidden);
  return onDiscover || onSearch;
}

/** (Re)start track badge + entity follow polling for Discover home and search results. */
function armDiscoverTrackStatusPoll() {
  if (stopDiscoverTrackStatusPoll) {
    stopDiscoverTrackStatusPoll();
    stopDiscoverTrackStatusPoll = null;
  }
  stopDiscoverTrackStatusPoll = startDiscoverTrackStatusPolling(
    [
      discoverRecommendedList,
      discoverTrendingTracksList,
      discoverNewTracksList,
      tracksList,
    ],
    {
      shouldPoll: shouldPollDiscoverOrSearch,
      refreshEntityFollowUi,
    },
  );
}

const core = createDiscoverFeedCore(optimisticRequestStatusById);
const {
  MAX_ITEMS_PER_SECTION,
  initHorizontalScrollBlocks,
  scheduleSyncAllScrollBlocks,
  trackCardOptions,
  fillDiscoverTrackSection,
  fillDiscoverEntitySection,
  refreshEntityFollowUi,
} = core;

initHorizontalScrollBlocks();

/** Path to this Discover document (preserves subdirectory deploys). */
function getDiscoverPathBase() {
  const p = window.location.pathname || '';
  if (/index\.html$/i.test(p)) {
    return p;
  }
  if (p === '/' || p === '') {
    return '/';
  }
  return p;
}

function isDiscoverIndexLocation() {
  const p = window.location.pathname || '';
  return /index\.html$/i.test(p) || p === '/' || p === '';
}

/**
 * Keep ?q= in the address bar so entity clicks store the right return URL and the history stack
 * includes search state (back from album lands on results, not bare Discover).
 */
function syncDiscoverSearchUrl(trimmedQuery) {
  if (typeof history.replaceState !== 'function') {
    return;
  }
  const base = getDiscoverPathBase();
  const q = String(trimmedQuery || '').trim();
  const nextSearch = q ? `?q=${encodeURIComponent(q)}` : '';
  const nextFull = `${base}${nextSearch}`;
  const curFull = `${window.location.pathname}${window.location.search}`;
  if (curFull === nextFull) {
    return;
  }
  const curParams = new URLSearchParams(window.location.search);
  const curQ = (curParams.get('q') || '').trim();
  if (q && !curQ) {
    history.pushState({ tfDiscover: 1 }, '', nextFull);
  } else {
    history.replaceState({ tfDiscover: 1 }, '', nextFull);
  }
}

/** Match server MAX_PREVIEW_ID_BATCH so one round-trip can cover all Discover track rows (4×20, deduped). */
const DISCOVER_PREVIEW_BATCH = 80;
const PREVIEW_FETCH_RETRY_DELAY_MS = 400;

/** Recommended first so preview batches are not starved when many library rows need refresh. */
function orderedMissingPreviewIds(trackArrays) {
  const seen = new Set();
  const ordered = [];
  for (const tracks of trackArrays) {
    for (const id of collectDeezerTrackIdsForPreviewHydrate(tracks)) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  return ordered;
}

/** Backfill preview/album art after fast GET /api/discover (matches genre page pattern). */
function hydrateDiscoverTrackPreviews(trackArrays, listEls) {
  void (async () => {
    const allIds = orderedMissingPreviewIds(trackArrays);
    if (allIds.length === 0) {
      return;
    }
    const patch = await waitForTrackFlowTrackCardPatch();
    if (!patch) {
      console.warn('Discover preview hydrate: TrackFlowTrackCard not ready');
      return;
    }

    async function patchChunk(chunk) {
      if (chunk.length === 0) {
        return;
      }
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, PREVIEW_FETCH_RETRY_DELAY_MS));
        }
        try {
          const res = await fetch('/api/discover/track-previews', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: chunk }),
          });
          if (!res.ok) {
            lastErr = new Error(`HTTP ${res.status}`);
            continue;
          }
          const data = await res.json();
          const byId = data?.byId && typeof data.byId === 'object' ? data.byId : null;
          if (!byId) {
            lastErr = new Error('Missing byId');
            continue;
          }
          for (const ul of listEls) {
            if (!ul) {
              continue;
            }
            for (const li of ul.querySelectorAll('li[data-trackflow-id]')) {
              const id = li.getAttribute('data-trackflow-id');
              const row = id ? byId[id] : null;
              if (row && (row.preview || row.albumCover)) {
                patch(li, row);
              }
            }
          }
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) {
        console.warn('Discover preview hydrate:', lastErr?.message || lastErr);
      }
    }

    await patchChunk(allIds.slice(0, DISCOVER_PREVIEW_BATCH));
    for (let i = DISCOVER_PREVIEW_BATCH; i < allIds.length; i += DISCOVER_PREVIEW_BATCH) {
      await patchChunk(allIds.slice(i, i + DISCOVER_PREVIEW_BATCH));
    }
  })();
}

function showDiscoverHome() {
  if (discoverFeedShell) {
    discoverFeedShell.hidden = false;
  }
  if (searchResultsShell) {
    searchResultsShell.hidden = true;
  }
}

function hideDiscoverHome() {
  if (discoverFeedShell) {
    discoverFeedShell.hidden = true;
  }
  if (searchResultsShell) {
    searchResultsShell.hidden = false;
  }
}

function mergeTracksFromSearch(tracks) {
  const slice = Array.isArray(tracks) ? tracks.slice(0, MAX_ITEMS_PER_SECTION) : [];
  const opts = trackCardOptions();
  const pool = new Map();
  for (const li of [...tracksList.querySelectorAll('li[data-trackflow-id]')]) {
    const id = li.getAttribute('data-trackflow-id');
    if (id) {
      pool.set(id, li);
    }
  }

  let cursor = tracksList.firstChild;
  for (const track of slice) {
    const id = String(track.id);
    let li = pool.get(id);
    if (li) {
      pool.delete(id);
      window.TrackFlowTrackCard.patchTrackListItem(li, track);
    } else {
      li = window.TrackFlowTrackCard.createTrackListItem(track, opts);
      li.dataset.trackflowId = id;
    }
    if (cursor !== li) {
      tracksList.insertBefore(li, cursor);
    }
    cursor = li.nextSibling;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
  for (const li of pool.values()) {
    li.remove();
  }
  showSectionIfHasResults(tracksSection, tracksList);
  scheduleSyncAllScrollBlocks();
}

function renderTrackResult(track) {
  core.renderTrackIntoList(track, tracksList);
}

function fillDiscoverGenresSection(sectionEl, listEl, genres) {
  if (!sectionEl || !listEl) {
    return;
  }
  listEl.innerHTML = '';
  const slice = Array.isArray(genres) ? genres : [];
  for (const g of slice) {
    if (!g || g.id == null) {
      continue;
    }
    const li = document.createElement('li');
    li.className = 'tracks-scroll-row__item tracks-scroll-row__item--genre';
    const a = document.createElement('a');
    a.className = 'genre-card';
    a.href = `/genre.html?id=${encodeURIComponent(String(g.id))}`;
    a.style.setProperty('--genre-bg', g.cardBackground || '#374151');
    if (g.picture) {
      const img = document.createElement('img');
      img.className = 'genre-card__image';
      img.src = g.picture;
      img.alt = '';
      img.decoding = 'async';
      a.appendChild(img);
    }
    const shade = document.createElement('span');
    shade.className = 'genre-card__shade';
    shade.setAttribute('aria-hidden', 'true');
    a.appendChild(shade);
    const label = document.createElement('span');
    label.className = 'genre-card__label';
    label.textContent = g.name || 'Genre';
    a.appendChild(label);
    li.appendChild(a);
    listEl.appendChild(li);
  }
  sectionEl.hidden = slice.length === 0;
  scheduleSyncAllScrollBlocks();
}

async function loadDiscoverFeed() {
  if (
    !discoverRecommendedList ||
    !discoverRecommendedArtistsList ||
    !discoverTrendingTracksList ||
    !discoverNewTracksList ||
    !discoverTrendingPlaylistsList ||
    !discoverPopularArtistsList ||
    !discoverNewAlbumsList
  ) {
    return;
  }
  try {
    const res = await fetch('/api/discover', { credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error('Discover failed');
    }
    const data = await res.json();
    fillDiscoverGenresSection(discoverGenresSection, discoverGenresList, data.genres || []);
    fillDiscoverTrackSection(
      discoverRecommendedSection,
      discoverRecommendedList,
      data.recommendedTracks || [],
    );
    fillDiscoverEntitySection(
      discoverRecommendedArtistsSection,
      discoverRecommendedArtistsList,
      data.recommendedArtists || [],
    );
    fillDiscoverTrackSection(
      discoverTrendingTracksSection,
      discoverTrendingTracksList,
      data.trendingTracks || [],
    );
    fillDiscoverTrackSection(
      discoverNewTracksSection,
      discoverNewTracksList,
      data.newTracks || [],
    );
    fillDiscoverEntitySection(
      discoverTrendingPlaylistsSection,
      discoverTrendingPlaylistsList,
      data.trendingPlaylists || [],
    );
    fillDiscoverEntitySection(
      discoverPopularArtistsSection,
      discoverPopularArtistsList,
      data.popularArtists || [],
    );
    fillDiscoverEntitySection(discoverNewAlbumsSection, discoverNewAlbumsList, data.newAlbums || []);
    void refreshEntityFollowUi();

    void hydrateDiscoverTrackPreviews(
      [
        data.recommendedTracks || [],
        data.trendingTracks || [],
        data.newTracks || [],
      ],
      [
        discoverRecommendedList,
        discoverTrendingTracksList,
        discoverNewTracksList,
      ],
    );

    armDiscoverTrackStatusPoll();
  } catch (e) {
    console.error('Discover feed:', e);
  }
}

function renderSearchResult(item) {
  if (item?.type === 'track') {
    renderTrackResult(item);
    return;
  }
  if (item?.type === 'artist') {
    core.renderEntityCard(item, artistsList);
    return;
  }
  if (item?.type === 'album') {
    core.renderEntityCard(item, albumsList);
    return;
  }
  if (item?.type === 'playlist') {
    core.renderEntityCard(item, playlistsList);
  }
}

function resetSections() {
  tracksList.innerHTML = '';
  artistsList.innerHTML = '';
  albumsList.innerHTML = '';
  playlistsList.innerHTML = '';
  tracksSection.hidden = true;
  artistsSection.hidden = true;
  albumsSection.hidden = true;
  playlistsSection.hidden = true;
}

function showSectionIfHasResults(section, list) {
  section.hidden = list.children.length === 0;
}

function renderResults(sections) {
  resetSections();
  const tracks = Array.isArray(sections?.tracks)
    ? sections.tracks.slice(0, MAX_ITEMS_PER_SECTION)
    : [];
  const artists = Array.isArray(sections?.artists)
    ? sections.artists.slice(0, MAX_ITEMS_PER_SECTION)
    : [];
  const albums = Array.isArray(sections?.albums)
    ? sections.albums.slice(0, MAX_ITEMS_PER_SECTION)
    : [];
  const playlists = Array.isArray(sections?.playlists)
    ? sections.playlists.slice(0, MAX_ITEMS_PER_SECTION)
    : [];

  if (!tracks.length && !artists.length && !albums.length && !playlists.length) {
    scheduleSyncAllScrollBlocks();
    return;
  }

  for (const item of tracks) {
    renderSearchResult(item);
  }
  for (const item of artists) {
    renderSearchResult(item);
  }
  for (const item of albums) {
    renderSearchResult(item);
  }
  for (const item of playlists) {
    renderSearchResult(item);
  }

  showSectionIfHasResults(tracksSection, tracksList);
  showSectionIfHasResults(artistsSection, artistsList);
  showSectionIfHasResults(albumsSection, albumsList);
  showSectionIfHasResults(playlistsSection, playlistsList);
  scheduleSyncAllScrollBlocks();
  void refreshEntityFollowUi();
}

async function runSearch(queryOverride, opts = {}) {
  const soft = Boolean(opts.soft);
  const query = (queryOverride ?? searchInput.value).trim();
  if (!soft) {
    syncDiscoverSearchUrl(query);
  }
  if (!query) {
    lastQuery = '';
    renderResults([]);
    showDiscoverHome();
    armDiscoverTrackStatusPoll();
    return;
  }

  if (isSearching) {
    return;
  }

  lastQuery = query;
  isSearching = true;
  hideDiscoverHome();

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error('Search failed');
    }

    const data = await response.json();
    if (soft) {
      mergeTracksFromSearch(data.tracks || []);
      armDiscoverTrackStatusPoll();
      return;
    }
    renderResults({
      tracks: data.tracks || [],
      artists: data.artists || [],
      albums: data.albums || [],
      playlists: data.playlists || [],
    });
    armDiscoverTrackStatusPoll();
  } catch (error) {
    if (soft) {
      console.warn('Search refresh skipped:', error?.message || error);
      return;
    }
    console.error('Search error:', error);
    resetSections();
    tracksSection.hidden = false;
    const errorItem = document.createElement('li');
    errorItem.className = 'tracks-scroll-error';
    errorItem.textContent = 'Error loading search results';
    tracksList.appendChild(errorItem);
    scheduleSyncAllScrollBlocks();
  } finally {
    isSearching = false;
  }
}

window.addEventListener('popstate', () => {
  if (!isDiscoverIndexLocation()) {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const q = (params.get('q') || '').trim();
  if (searchInput) {
    searchInput.value = q;
  }
  if (q) {
    lastQuery = q;
    hideDiscoverHome();
    void runSearch(q);
  } else {
    lastQuery = '';
    showDiscoverHome();
    void loadDiscoverFeed();
    armDiscoverTrackStatusPoll();
  }
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runSearch();
  }
});

const initialQ = new URLSearchParams(window.location.search).get('q');
const trimmedInitial = initialQ != null ? initialQ.trim() : '';
if (trimmedInitial) {
  hideDiscoverHome();
  searchInput.value = trimmedInitial;
  void runSearch(trimmedInitial);
} else {
  void loadDiscoverFeed();
}
