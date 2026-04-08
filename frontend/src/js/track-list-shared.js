/**
 * Shared track row rendering (album / artist / playlist): vertical list with
 * Seerr-style hover action bar (preview + status icon; requestable rows show + on hover).
 * Exposes TrackFlowTrackList on window.
 */
import './track-status-shared.js';
import './track-preview-shared.js';
import './track-card-shared.js';

(function (global) {
  const PLAY_SVG =
    '<svg class="search-track-card__play-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  const PAUSE_SVG =
    '<svg class="search-track-card__play-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  const ADD_REQUEST_SVG =
    '<svg class="track-row__status-svg track-row__add-request-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';

  function trackAlreadyOwned(track) {
    if (track.isInUserLibrary === true) {
      return true;
    }
    if (track.existsInMusicLibrary === true) {
      return true;
    }
    return false;
  }

  function resolveUserFacingTrackStatus(track, deezerId, optimisticRequestDisplayById) {
    const fromOpt = optimisticRequestDisplayById.get(deezerId);
    if (fromOpt) {
      return fromOpt;
    }
    if (track.requestDisplayStatus) {
      return track.requestDisplayStatus;
    }
    const proc = track.requestProcessingStatus != null ? String(track.requestProcessingStatus) : '';
    if (proc === 'Failed') {
      return 'Needs Attention';
    }
    if (proc === 'Denied') {
      return 'Denied';
    }
    const fromRequest = global.TrackFlowTrackStatus.userStatusFromRequestStatusOnly(
      track.requestStatus,
    );
    if (fromRequest) {
      return fromRequest;
    }
    if (trackAlreadyOwned(track)) {
      return 'Available';
    }
    return null;
  }

  function getButtonConfig(userFacingStatus) {
    if (userFacingStatus === 'Denied' || userFacingStatus === 'Needs Attention') {
      return { label: userFacingStatus, action: 'none' };
    }
    if (userFacingStatus == null || userFacingStatus === '') {
      return { label: 'Request', action: 'request' };
    }
    return { label: userFacingStatus, action: 'none' };
  }

  function buildListHoverDetails(track, showArtistLink) {
    const wrap = document.createElement('div');
    wrap.className = 'track-row__hover-details-inner';

    const artistRow = document.createElement('div');
    artistRow.className =
      'search-track-card__hover-line search-track-card__hover-line--artist';
    const artistName = track.artist || 'Unknown Artist';
    const artistId = track.artistId;
    if (showArtistLink && artistId != null && artistId !== '') {
      const a = document.createElement('a');
      a.className = 'track-artist-link';
      a.href = `/artist.html?id=${encodeURIComponent(String(artistId))}`;
      a.textContent = artistName;
      artistRow.appendChild(a);
    } else {
      artistRow.textContent = artistName;
    }

    const titleRow = document.createElement('div');
    titleRow.className =
      'search-track-card__hover-line search-track-card__hover-line--title';
    titleRow.textContent = track.title || 'Unknown Title';

    const albumRow = document.createElement('div');
    albumRow.className =
      'search-track-card__hover-line search-track-card__hover-line--album';
    const albumLabel = track.album || 'Unknown Album';
    const albumId = track.albumId;
    if (albumId != null && albumId !== '') {
      const a = document.createElement('a');
      a.className = 'track-album-link';
      a.href = `/album.html?id=${encodeURIComponent(String(albumId))}`;
      a.textContent = albumLabel;
      albumRow.appendChild(a);
    } else {
      albumRow.textContent = albumLabel;
    }

    wrap.appendChild(artistRow);
    wrap.appendChild(titleRow);
    wrap.appendChild(albumRow);
    return wrap;
  }

  function pickEnrichedStatusFields(serverRow) {
    if (!serverRow || typeof serverRow !== 'object') {
      return null;
    }
    return {
      requestStatus: serverRow.requestStatus,
      requestDisplayStatus: serverRow.requestDisplayStatus,
      requestProcessingStatus: serverRow.requestProcessingStatus,
      requestId: serverRow.requestId,
      requestPlexStatus: serverRow.requestPlexStatus,
      existsInMusicLibrary: serverRow.existsInMusicLibrary,
      existsInPlex: false,
      isInUserLibrary: serverRow.isInUserLibrary,
    };
  }

  /**
   * Merge server-enriched fields into an existing track array (same order / ids as on screen).
   */
  function mergeEnrichedIntoTrackArray(destArray, freshArray) {
    if (!Array.isArray(destArray) || !Array.isArray(freshArray)) {
      return;
    }
    const byId = new Map();
    for (const t of freshArray) {
      if (t != null && t.id != null) {
        byId.set(String(t.id), t);
      }
    }
    for (let i = 0; i < destArray.length; i++) {
      const f = byId.get(String(destArray[i].id));
      if (!f) {
        continue;
      }
      const slice = pickEnrichedStatusFields(f);
      if (slice) {
        Object.assign(destArray[i], slice);
      }
    }
  }

  /**
   * Update status icons / request affordances without re-rendering the list (no hover flicker).
   */
  function syncTrackListRows(resultsList, freshTracks, optimisticRequestDisplayById) {
    if (!resultsList || !Array.isArray(freshTracks)) {
      return;
    }
    const byId = new Map();
    for (const t of freshTracks) {
      if (t != null && t.id != null) {
        byId.set(String(t.id), t);
      }
    }
    const rows = resultsList.querySelectorAll('li.track-row[data-tf-deezer-id]');
    for (const li of rows) {
      const id = li.dataset.tfDeezerId;
      if (!id) {
        continue;
      }
      const fresh = byId.get(String(id));
      if (!fresh || typeof li._tfApplyServerTrack !== 'function') {
        continue;
      }
      li._tfApplyServerTrack(fresh);
    }
  }

  async function createRequest(track) {
    const response = await fetch('/api/requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        deezer_id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration_seconds:
          track.duration != null && Number.isFinite(Number(track.duration))
            ? Math.round(Number(track.duration))
            : undefined,
      }),
    });

    if (!response.ok) {
      let message = 'Request failed';
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

  /**
   * @param {HTMLElement} resultsList - <ul>
   * @param {Array} results
   * @param {Map} optimisticRequestDisplayById
   * @param {() => Promise<void>} refreshCallback
   * @param {{ showArtistLink?: boolean }} options
   */
  function renderTrackList(resultsList, results, optimisticRequestDisplayById, refreshCallback, options) {
    const showArtistLink = options?.showArtistLink !== false;
    const freezeRowMeta = Boolean(options?.freezeRowMeta);
    const neutralHoverLinks = Boolean(options?.neutralHoverLinks);
    const TrackFlowTrackPreview = global.TrackFlowTrackPreview;

    resultsList.innerHTML = '';
    resultsList.classList.remove('track-grid');
    resultsList.classList.add('track-list-vertical');
    resultsList.classList.toggle('tf-freeze-row-meta', freezeRowMeta);
    resultsList.classList.toggle('tf-neutral-hover-links', neutralHoverLinks);

    if (!Array.isArray(results) || results.length === 0) {
      const emptyItem = document.createElement('li');
      emptyItem.className = 'track-list-empty';
      emptyItem.textContent = 'No results';
      resultsList.appendChild(emptyItem);
      return;
    }

    for (const track of results) {
      const deezerId = String(track.id);
      const serverStatus = track.requestStatus ?? null;
      if (serverStatus !== null) {
        optimisticRequestDisplayById.delete(deezerId);
      }

      const rowTrack = { ...track };

      const previewUrl =
        typeof rowTrack.preview === 'string' && rowTrack.preview.trim()
          ? rowTrack.preview.trim()
          : null;

      const item = document.createElement('li');
      item.className = 'track-row track-row--card-style';
      item.dataset.tfDeezerId = deezerId;

      const cover = document.createElement('img');
      cover.className = 'track-row__cover';
      cover.src = rowTrack.albumCover || '';
      cover.alt = '';
      cover.decoding = 'async';

      const meta = document.createElement('div');
      meta.className = 'track-row__meta';

      const topMeta = document.createElement('div');
      topMeta.className = 'track-row__top-meta';

      const title = document.createElement('div');
      title.className = 'track-row__title';
      title.textContent = rowTrack.title || 'Unknown Title';

      const artistLine = document.createElement('div');
      artistLine.className = 'track-row__artist';
      const artistName = rowTrack.artist || 'Unknown Artist';
      const artistId = rowTrack.artistId;
      if (showArtistLink && artistId != null && artistId !== '') {
        const artistLink = document.createElement('a');
        artistLink.className = 'track-artist-link';
        artistLink.href = `/artist.html?id=${encodeURIComponent(String(artistId))}`;
        artistLink.textContent = artistName;
        artistLine.appendChild(artistLink);
      } else {
        artistLine.textContent = artistName;
      }

      topMeta.appendChild(title);
      topMeta.appendChild(artistLine);

      const hoverMeta = document.createElement('div');
      hoverMeta.className = 'track-row__hover-meta';
      hoverMeta.appendChild(buildListHoverDetails(rowTrack, showArtistLink));

      const actions = document.createElement('div');
      actions.className = 'track-row__action-bar';

      const iconSlot = document.createElement('div');
      iconSlot.className = 'track-row__status-icon-slot';
      iconSlot.setAttribute('aria-hidden', 'true');

      const primarySlot = document.createElement('div');
      primarySlot.className = 'track-row__hover-primary-slot';

      const actionRight = document.createElement('div');
      actionRight.className = 'track-row__hover-action-right';
      actionRight.appendChild(iconSlot);
      actionRight.appendChild(primarySlot);

      const iconFn = global.TrackFlowTrackCard?.statusIconHtmlForList;
      let lastListStatusKey;

      const requestBtn = document.createElement('button');
      requestBtn.type = 'button';
      requestBtn.className =
        'search-track-card__hover-request tf-action-pill track-row__add-request-btn';
      requestBtn.innerHTML = ADD_REQUEST_SVG;
      requestBtn.setAttribute(
        'aria-label',
        `Add request: ${rowTrack.title || 'track'} by ${rowTrack.artist || 'artist'}`,
      );
      requestBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        requestBtn.disabled = true;
        optimisticRequestDisplayById.set(deezerId, 'Requested');
        mountActionBar();
        try {
          await createRequest(rowTrack);
          await refreshCallback();
        } catch (error) {
          console.error('Request error:', error);
          optimisticRequestDisplayById.delete(deezerId);
          mountActionBar();
          requestBtn.disabled = false;
        }
      });

      primarySlot.appendChild(requestBtn);

      function mountActionBar() {
        const userFacingStatus = resolveUserFacingTrackStatus(
          rowTrack,
          deezerId,
          optimisticRequestDisplayById,
        );
        const key = userFacingStatus == null || userFacingStatus === '' ? '' : String(userFacingStatus);
        if (key !== lastListStatusKey && typeof iconFn === 'function') {
          iconSlot.innerHTML = iconFn(userFacingStatus);
          lastListStatusKey = key;
        }
        const cfg = getButtonConfig(userFacingStatus);
        const showRequest = cfg.action === 'request';
        item.classList.toggle('track-row--list-requestable', showRequest);
        requestBtn.classList.toggle('is-off', !showRequest);
        requestBtn.setAttribute('aria-hidden', showRequest ? 'false' : 'true');
      }

      item._tfApplyServerTrack = (serverRow) => {
        const slice = pickEnrichedStatusFields(serverRow);
        if (!slice) {
          return;
        }
        if (slice.requestStatus != null && slice.requestStatus !== undefined) {
          optimisticRequestDisplayById.delete(deezerId);
        }
        Object.assign(rowTrack, slice);
        mountActionBar();
      };

      mountActionBar();

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'search-track-card__play track-row__preview';
      if (previewUrl) {
        const syncPlayVisual = () => {
          const on = TrackFlowTrackPreview.isPlaying(deezerId);
          playBtn.classList.toggle('is-playing', on);
          playBtn.setAttribute('aria-label', on ? 'Stop preview' : 'Play preview');
          playBtn.innerHTML = on ? PAUSE_SVG : PLAY_SVG;
        };
        syncPlayVisual();
        playBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          TrackFlowTrackPreview.toggle(
            previewUrl,
            deezerId,
            () => syncPlayVisual(),
            () => syncPlayVisual(),
          );
        });
      } else {
        playBtn.disabled = true;
        playBtn.classList.add('search-track-card__play--no-preview');
        playBtn.setAttribute('aria-label', 'No preview available');
        playBtn.innerHTML = PLAY_SVG;
      }

      actions.appendChild(playBtn);
      actions.appendChild(actionRight);

      meta.appendChild(topMeta);
      meta.appendChild(hoverMeta);
      item.appendChild(cover);
      item.appendChild(meta);
      item.appendChild(actions);
      resultsList.appendChild(item);
    }
  }

  global.TrackFlowTrackList = {
    getButtonConfig,
    resolveUserFacingTrackStatus,
    createRequest,
    renderTrackList,
    mergeEnrichedIntoTrackArray,
    syncTrackListRows,
  };
})(typeof window !== 'undefined' ? window : globalThis);
