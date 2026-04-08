/**
 * Discover-style track cards: Seerr-like bottom hover panel.
 * Primary controls + icons updated in place (no innerHTML churn) to avoid hover flicker.
 */
import './track-preview-shared.js';

const IMAGE_PLACEHOLDER =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="%23d0d0d0"/></svg>';

const PLAY_SVG =
  '<svg class="search-track-card__play-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG =
  '<svg class="search-track-card__play-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

const STATUS_ICON_SVG = {
  Requested: `<svg class="search-track-card__status-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  Processing: `<svg class="search-track-card__status-svg search-track-card__status-svg--spin" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z" opacity="0.9"/></svg>`,
  Available: `<svg class="search-track-card__status-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
  'Needs Attention': `<svg class="search-track-card__status-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  Denied: `<svg class="search-track-card__status-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`,
  Canceled: `<svg class="search-track-card__status-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5 19L19 5"/></svg>`,
};

function statusIconHtml(userFacingStatus) {
  if (userFacingStatus == null || userFacingStatus === '') {
    return '';
  }
  return STATUS_ICON_SVG[userFacingStatus] || '';
}

function statusIconHtmlForList(userFacingStatus) {
  const inner = statusIconHtml(userFacingStatus);
  if (!inner) {
    return '';
  }
  return inner.replace(/search-track-card__status-svg/g, 'track-row__status-svg');
}

function fillLinkedLine(rowEl, text, id, kind) {
  rowEl.replaceChildren();
  const label = text || (kind === 'artist' ? 'Unknown Artist' : 'Unknown Album');
  if (id != null && id !== '') {
    const a = document.createElement('a');
    a.className = 'search-card-meta-link';
    a.href =
      kind === 'artist'
        ? `/artist.html?id=${encodeURIComponent(String(id))}`
        : `/album.html?id=${encodeURIComponent(String(id))}`;
    a.textContent = label;
    rowEl.appendChild(a);
  } else {
    rowEl.textContent = label;
  }
}

function syncTopArtistLine(artistLineEl, track) {
  const artistName = track.artist || 'Unknown Artist';
  const artistId = track.artistId;
  const sig = `${artistName}\0${artistId ?? ''}`;
  if (artistLineEl.dataset.tfArtistSig === sig) {
    return;
  }
  artistLineEl.dataset.tfArtistSig = sig;
  artistLineEl.replaceChildren();
  if (artistId != null && artistId !== '') {
    const artistLink = document.createElement('a');
    artistLink.className = 'search-card-meta-link';
    artistLink.href = `/artist.html?id=${encodeURIComponent(String(artistId))}`;
    artistLink.textContent = artistName;
    artistLineEl.appendChild(artistLink);
  } else {
    artistLineEl.textContent = artistName;
  }
}

function buildHoverDetailsShell() {
  const wrap = document.createElement('div');
  wrap.className = 'search-track-card__hover-details-inner';
  const artistRow = document.createElement('div');
  artistRow.className = 'search-track-card__hover-line search-track-card__hover-line--artist';
  const titleRow = document.createElement('div');
  titleRow.className = 'search-track-card__hover-line search-track-card__hover-line--title';
  const albumRow = document.createElement('div');
  albumRow.className = 'search-track-card__hover-line search-track-card__hover-line--album';
  wrap.appendChild(artistRow);
  wrap.appendChild(titleRow);
  wrap.appendChild(albumRow);
  return { wrap, artistRow, titleRow, albumRow };
}

/**
 * Persist title/artist/duration on the card for POST /api/discover/track-status polling
 * (id-only stubs cannot match library rows without trackflow_id tags).
 */
function syncTrackStatusPollHints(li, track) {
  if (!li || !track || typeof track !== 'object') {
    return;
  }
  const artist = typeof track.artist === 'string' ? track.artist : '';
  const title = typeof track.title === 'string' ? track.title : '';
  const d =
    track.duration != null && Number.isFinite(Number(track.duration))
      ? String(Math.round(Number(track.duration)))
      : '';
  li.setAttribute('data-tf-enrich-artist', artist);
  li.setAttribute('data-tf-enrich-title', title);
  li.setAttribute('data-tf-enrich-duration', d);
}

function syncHoverDetailRows(artistRow, titleRow, albumRow, track) {
  const sig = [
    track.artist ?? '',
    track.artistId ?? '',
    track.title ?? '',
    track.album ?? '',
    track.albumId ?? '',
  ].join('\0');
  if (artistRow.dataset.tfHoverSig === sig) {
    return;
  }
  artistRow.dataset.tfHoverSig = sig;
  titleRow.dataset.tfHoverSig = sig;
  albumRow.dataset.tfHoverSig = sig;
  fillLinkedLine(artistRow, track.artist, track.artistId, 'artist');
  titleRow.textContent = track.title || 'Unknown Title';
  fillLinkedLine(albumRow, track.album, track.albumId, 'album');
}

/**
 * @param {object} track
 * @param {{
 *   optimisticMap: Map<string, string>,
 *   onAfterRequest: () => void | Promise<void>,
 *   listItemClass?: string,
 * }} options
 * @returns {HTMLLIElement}
 */
function createTrackListItem(track, options) {
  const TrackFlowTrackList = window.TrackFlowTrackList;
  const TrackFlowTrackPreview = window.TrackFlowTrackPreview;

  if (!TrackFlowTrackList || !TrackFlowTrackPreview) {
    throw new Error('TrackFlowTrackList / TrackFlowTrackPreview required');
  }

  let current = { ...track };
  const optimisticMap = options.optimisticMap;
  const onAfterRequest = options.onAfterRequest;
  const listItemClass = options.listItemClass ?? 'track-grid__item';

  const deezerId = String(current.id);
  if (current.requestStatus != null) {
    optimisticMap.delete(deezerId);
  }

  let previewUrl = null;

  const li = document.createElement('li');
  li.className = listItemClass;
  li.dataset.trackflowId = deezerId;

  const card = document.createElement('div');
  card.className = 'search-track-card';

  const img = document.createElement('img');
  img.className = 'search-track-card__cover';
  img.src = current.albumCover || IMAGE_PLACEHOLDER;
  img.alt = '';
  img.decoding = 'async';

  const imageShade = document.createElement('div');
  imageShade.className = 'search-track-card__image-shade';
  imageShade.setAttribute('aria-hidden', 'true');

  const textGradient = document.createElement('div');
  textGradient.className = 'search-track-card__text-gradient';
  textGradient.setAttribute('aria-hidden', 'true');

  const textBand = document.createElement('div');
  textBand.className = 'search-track-card__text-band search-track-card__text-band--top';
  const titleEl = document.createElement('div');
  titleEl.className = 'search-track-card__title';
  const artistLine = document.createElement('div');
  artistLine.className = 'search-track-card__artist';
  titleEl.textContent = current.title || 'Unknown Title';
  syncTopArtistLine(artistLine, current);
  textBand.appendChild(titleEl);
  textBand.appendChild(artistLine);

  const hoverPanel = document.createElement('div');
  hoverPanel.className = 'search-track-card__hover-panel';

  const hoverDetails = document.createElement('div');
  hoverDetails.className = 'search-track-card__hover-details';
  const { wrap: hoverInner, artistRow: hArtist, titleRow: hTitle, albumRow: hAlbum } =
    buildHoverDetailsShell();
  hoverDetails.appendChild(hoverInner);
  syncHoverDetailRows(hArtist, hTitle, hAlbum, current);

  const hoverActions = document.createElement('div');
  hoverActions.className = 'search-track-card__hover-actions';

  const iconSlot = document.createElement('div');
  iconSlot.className = 'search-track-card__status-icon-slot';
  iconSlot.setAttribute('aria-hidden', 'true');

  const primarySlot = document.createElement('div');
  primarySlot.className = 'search-track-card__hover-primary-slot';

  const requestBtn = document.createElement('button');
  requestBtn.type = 'button';
  requestBtn.className = 'search-track-card__hover-request tf-action-pill';
  requestBtn.textContent = 'Request';

  const statusPill = document.createElement('div');
  statusPill.className = 'search-track-card__hover-status-text tf-action-pill';
  statusPill.setAttribute('role', 'status');

  primarySlot.appendChild(requestBtn);
  primarySlot.appendChild(statusPill);

  const actionRight = document.createElement('div');
  actionRight.className = 'search-track-card__hover-action-right';
  actionRight.appendChild(iconSlot);
  actionRight.appendChild(primarySlot);

  let requestInFlight = false;
  let lastStatusKey = null;

  function isRequestable() {
    const userFacingStatus = TrackFlowTrackList.resolveUserFacingTrackStatus(
      current,
      deezerId,
      optimisticMap,
    );
    const cfg = TrackFlowTrackList.getButtonConfig(userFacingStatus);
    return cfg.action === 'request';
  }

  function userFacingStatus() {
    return TrackFlowTrackList.resolveUserFacingTrackStatus(current, deezerId, optimisticMap);
  }

  function mountPrimaryControls() {
    const uf = userFacingStatus();
    const cfg = TrackFlowTrackList.getButtonConfig(uf);
    const key = uf == null || uf === '' ? '' : String(uf);
    if (key !== lastStatusKey) {
      iconSlot.innerHTML = statusIconHtml(uf);
      lastStatusKey = key;
    }

    const showRequest = cfg.action === 'request';
    const showStatus = !showRequest && Boolean(cfg.label);
    requestBtn.classList.toggle('is-off', !showRequest);
    requestBtn.setAttribute('aria-hidden', showRequest ? 'false' : 'true');
    statusPill.classList.toggle('is-off', !showStatus);
    statusPill.setAttribute('aria-hidden', showStatus ? 'false' : 'true');
    if (showStatus) {
      statusPill.textContent = cfg.label;
    }

    if (showRequest) {
      requestBtn.setAttribute(
        'aria-label',
        `Request ${current.title || 'track'} by ${current.artist || 'artist'}`,
      );
    } else {
      requestBtn.removeAttribute('aria-label');
    }

    updateCardA11y();
  }

  function updateCardA11y() {
    card.removeAttribute('role');
    card.removeAttribute('tabindex');
    card.removeAttribute('aria-label');
  }

  async function runCardRequest() {
    if (!isRequestable() || requestInFlight) {
      return;
    }
    requestInFlight = true;
    optimisticMap.set(deezerId, 'Requested');
    mountPrimaryControls();
    try {
      await TrackFlowTrackList.createRequest(current);
      await Promise.resolve(onAfterRequest());
    } catch (error) {
      console.error('Request error:', error);
      optimisticMap.delete(deezerId);
      mountPrimaryControls();
    } finally {
      requestInFlight = false;
      mountPrimaryControls();
    }
  }

  requestBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void runCardRequest();
  });

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'search-track-card__play';

  function syncPlayVisual() {
    const on = TrackFlowTrackPreview.isPlaying(deezerId);
    playBtn.classList.toggle('is-playing', on);
    playBtn.setAttribute('aria-label', on ? 'Stop preview' : 'Play preview');
    playBtn.innerHTML = on ? PAUSE_SVG : PLAY_SVG;
  }

  function applyPreviewUrl(url) {
    const next = url && String(url).trim() ? String(url).trim() : null;
    if (next === previewUrl) {
      return;
    }
    previewUrl = next;
    if (previewUrl) {
      playBtn.disabled = false;
      playBtn.classList.remove('search-track-card__play--no-preview');
    } else {
      playBtn.disabled = true;
      playBtn.classList.add('search-track-card__play--no-preview');
      playBtn.setAttribute('aria-label', 'No preview available');
      playBtn.innerHTML = PLAY_SVG;
    }
    syncPlayVisual();
  }

  playBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!previewUrl) {
      return;
    }
    TrackFlowTrackPreview.toggle(
      previewUrl,
      deezerId,
      () => syncPlayVisual(),
      () => syncPlayVisual(),
    );
  });

  applyPreviewUrl(
    typeof current.preview === 'string' && current.preview.trim() ? current.preview.trim() : null,
  );

  mountPrimaryControls();
  syncTrackStatusPollHints(li, current);

  hoverActions.appendChild(playBtn);
  hoverActions.appendChild(actionRight);

  hoverPanel.appendChild(hoverDetails);
  hoverPanel.appendChild(hoverActions);

  card.appendChild(img);
  card.appendChild(imageShade);
  card.appendChild(textGradient);
  card.appendChild(textBand);
  card.appendChild(hoverPanel);

  li.appendChild(card);

  function patchTrack(nextTrack) {
    if (!nextTrack || typeof nextTrack !== 'object') {
      return;
    }
    current = { ...current, ...nextTrack };
    if (current.requestStatus != null) {
      optimisticMap.delete(deezerId);
    }
    const nextTitle = current.title || 'Unknown Title';
    if (titleEl.textContent !== nextTitle) {
      titleEl.textContent = nextTitle;
    }
    syncTopArtistLine(artistLine, current);
    syncHoverDetailRows(hArtist, hTitle, hAlbum, current);
    const nextCover = current.albumCover || IMAGE_PLACEHOLDER;
    try {
      const resolved = new URL(nextCover, location.href).href;
      if (img.currentSrc !== resolved) {
        img.src = nextCover;
        void img.decode?.().catch(() => {});
      }
    } catch {
      if (img.getAttribute('src') !== nextCover) {
        img.src = nextCover;
        void img.decode?.().catch(() => {});
      }
    }
    const nextPreview =
      typeof current.preview === 'string' && current.preview.trim() ? current.preview.trim() : null;
    applyPreviewUrl(nextPreview);
    mountPrimaryControls();
    syncTrackStatusPollHints(li, current);
  }

  li._trackflowPatch = patchTrack;

  return li;
}

/**
 * Update an existing track card in place (stable DOM for hover / focus).
 * @param {HTMLLIElement} li
 * @param {object} track
 */
function patchTrackListItem(li, track) {
  if (li && typeof li._trackflowPatch === 'function') {
    li._trackflowPatch(track);
  }
}

(function (global) {
  global.TrackFlowTrackCard = {
    createTrackListItem,
    patchTrackListItem,
    IMAGE_PLACEHOLDER,
    statusIconHtml,
    statusIconHtmlForList,
  };
})(typeof window !== 'undefined' ? window : globalThis);
