/**
 * Shared discover-style horizontal rows: scroll chrome, track cards, entity cards, follow UI.
 */
import { recordNavFrom } from './app-back-nav.js';
import { PLEX_SYNC_SVG_HTML } from './plex-sync-icon.js';

/** Match track card Requested / Available icons (clock, checkmark). */
const ENTITY_FOLLOW_SVG_PENDING = `<svg class="search-entity-card__follow-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

const ENTITY_FOLLOW_SVG_FOLLOWING = `<svg class="search-entity-card__follow-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

const ENTITY_FOLLOW_SVG_DENIED = `<svg class="search-entity-card__follow-svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`;

/**
 * @param {Map<string, string>} optimisticRequestStatusById
 */
export function createDiscoverFeedCore(optimisticRequestStatusById) {
  const MAX_ITEMS_PER_SECTION = 20;

  function scrollStepPx(viewport) {
    return Math.max(220, Math.floor(viewport.clientWidth * 0.85));
  }

  function syncHorizontalScrollBlock(block) {
    const viewport = block.querySelector('.tracks-scroll-viewport');
    const prev = block.querySelector('.tracks-scroll-nav--prev');
    const next = block.querySelector('.tracks-scroll-nav--next');
    if (!viewport || !prev || !next) {
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = viewport;
    const maxScroll = scrollWidth - clientWidth;
    const canScroll = maxScroll > 2;
    prev.disabled = !canScroll || scrollLeft <= 2;
    next.disabled = !canScroll || scrollLeft >= maxScroll - 2;
  }

  function scheduleSyncAllScrollBlocks() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const block of document.querySelectorAll('.tracks-scroll-block')) {
          syncHorizontalScrollBlock(block);
        }
      });
    });
  }

  function initHorizontalScrollBlocks() {
    const blocks = document.querySelectorAll('.tracks-scroll-block');
    for (const block of blocks) {
      const viewport = block.querySelector('.tracks-scroll-viewport');
      const prev = block.querySelector('.tracks-scroll-nav--prev');
      const next = block.querySelector('.tracks-scroll-nav--next');
      if (!viewport || !prev || !next) {
        continue;
      }
      prev.addEventListener('click', () => {
        viewport.scrollBy({ left: -scrollStepPx(viewport), behavior: 'smooth' });
      });
      next.addEventListener('click', () => {
        viewport.scrollBy({ left: scrollStepPx(viewport), behavior: 'smooth' });
      });
      viewport.addEventListener('scroll', () => syncHorizontalScrollBlock(block), { passive: true });
      const ro = new ResizeObserver(() => syncHorizontalScrollBlock(block));
      ro.observe(viewport);
    }
    window.addEventListener('resize', () => {
      for (const block of document.querySelectorAll('.tracks-scroll-block')) {
        syncHorizontalScrollBlock(block);
      }
    });
  }

  function trackCardOptions() {
    return {
      optimisticMap: optimisticRequestStatusById,
      onAfterRequest: () => Promise.resolve(),
      listItemClass: 'tracks-scroll-row__item',
    };
  }

  function renderTrackIntoList(track, listEl) {
    const li = window.TrackFlowTrackCard.createTrackListItem(track, trackCardOptions());
    listEl.appendChild(li);
  }

  function fillDiscoverTrackSection(sectionEl, listEl, tracks) {
    if (!sectionEl || !listEl) {
      return;
    }
    listEl.innerHTML = '';
    const slice = Array.isArray(tracks) ? tracks.slice(0, MAX_ITEMS_PER_SECTION) : [];
    for (const t of slice) {
      renderTrackIntoList(t, listEl);
    }
    sectionEl.hidden = slice.length === 0;
    scheduleSyncAllScrollBlocks();
  }

  function fillDiscoverEntitySection(sectionEl, listEl, items) {
    if (!sectionEl || !listEl) {
      return;
    }
    listEl.innerHTML = '';
    const slice = Array.isArray(items) ? items.slice(0, MAX_ITEMS_PER_SECTION) : [];
    for (const item of slice) {
      renderEntityCard(item, listEl);
    }
    sectionEl.hidden = slice.length === 0;
    scheduleSyncAllScrollBlocks();
  }

  function getEntityHref(item) {
    if (item.type === 'artist') {
      return `/artist.html?id=${encodeURIComponent(String(item.id))}`;
    }
    if (item.type === 'album') {
      return `/album.html?id=${encodeURIComponent(String(item.id))}`;
    }
    if (item.type === 'playlist') {
      return `/playlist.html?id=${encodeURIComponent(String(item.id))}`;
    }
    return '#';
  }

  function getDiscoverFollowLabelEl(btn) {
    return btn.querySelector('.search-entity-card__follow-label');
  }

  function getDiscoverFollowIconSlot(btn) {
    return btn.querySelector('.search-entity-card__follow-icon-slot');
  }

  function syncDiscoverEntityFollowIcon(btn) {
    const slot = getDiscoverFollowIconSlot(btn);
    if (!slot) {
      return;
    }
    const rowId = btn.dataset.followRowId || '';
    const st = btn.dataset.followStatus || '';
    if (!rowId) {
      slot.innerHTML = '';
      return;
    }
    if (st === 'pending') {
      slot.innerHTML = ENTITY_FOLLOW_SVG_PENDING;
      return;
    }
    if (st === 'active') {
      slot.innerHTML = ENTITY_FOLLOW_SVG_FOLLOWING;
      return;
    }
    if (st === 'denied') {
      slot.innerHTML = ENTITY_FOLLOW_SVG_DENIED;
      return;
    }
    slot.innerHTML = '';
  }

  function setDiscoverFollowAria(btn) {
    const label = getDiscoverFollowLabelEl(btn);
    const visible = label?.textContent?.trim() || 'Follow';
    btn.setAttribute('aria-label', visible);
  }

  function restoreDiscoverFollowButtonLabel(btn) {
    const labelEl = getDiscoverFollowLabelEl(btn);
    if (!labelEl) {
      return;
    }
    const rowId = btn.dataset.followRowId || '';
    const st = btn.dataset.followStatus || '';
    if (!rowId) {
      labelEl.textContent = 'Follow';
      setDiscoverFollowAria(btn);
      syncDiscoverEntityFollowIcon(btn);
      return;
    }
    if (st === 'pending') {
      labelEl.textContent = 'Pending…';
      setDiscoverFollowAria(btn);
      syncDiscoverEntityFollowIcon(btn);
      return;
    }
    if (st === 'denied') {
      labelEl.textContent = 'Denied';
      setDiscoverFollowAria(btn);
      syncDiscoverEntityFollowIcon(btn);
      return;
    }
    labelEl.textContent = 'Following';
    setDiscoverFollowAria(btn);
    syncDiscoverEntityFollowIcon(btn);
  }

  function patchDiscoverFollowButton(btn, row) {
    btn.dataset.followRowId = row ? String(row.id) : '';
    btn.dataset.followStatus = row ? String(row.follow_status || '') : '';
    if (!row) {
      btn.classList.remove('is-pending', 'is-following', 'is-denied');
      btn.disabled = false;
      restoreDiscoverFollowButtonLabel(btn);
      return;
    }
    if (row.follow_status === 'pending') {
      btn.classList.add('is-pending');
      btn.classList.remove('is-following', 'is-denied');
      btn.disabled = false;
      restoreDiscoverFollowButtonLabel(btn);
      return;
    }
    if (row.follow_status === 'denied') {
      btn.classList.add('is-denied');
      btn.classList.remove('is-pending', 'is-following');
      btn.disabled = true;
      restoreDiscoverFollowButtonLabel(btn);
      return;
    }
    btn.classList.add('is-following');
    btn.classList.remove('is-pending', 'is-denied');
    btn.disabled = false;
    restoreDiscoverFollowButtonLabel(btn);
  }

  async function refreshEntityFollowUi() {
    const selectors = '.search-entity-card__follow-btn[data-entity-type]';
    if (!document.querySelector(selectors)) {
      return;
    }
    try {
      const [plRes, arRes] = await Promise.all([
        fetch('/api/playlists/followed?include_pending=1', { credentials: 'same-origin' }),
        fetch('/api/artists/followed?include_pending=1', { credentials: 'same-origin' }),
      ]);
      const plData = plRes.ok ? await plRes.json() : { results: [] };
      const arData = arRes.ok ? await arRes.json() : { results: [] };
      const plBy = new Map((plData.results || []).map((r) => [String(r.playlist_id), r]));
      const arBy = new Map((arData.results || []).map((r) => [String(r.artist_id), r]));

      for (const btn of document.querySelectorAll(selectors)) {
        const t = btn.dataset.entityType;
        const id = btn.dataset.entityId;
        const strip = btn.closest('.search-entity-card__follow-strip');
        const plexSlot = strip?.querySelector('.search-entity-card__plex-sync-slot');
        if (t === 'playlist') {
          const row = plBy.get(id);
          patchDiscoverFollowButton(btn, row);
          if (plexSlot) {
            const show =
              row && row.follow_status === 'active' && Boolean(row.plex_sync_enabled);
            plexSlot.hidden = !show;
            if (show) {
              if (!plexSlot.querySelector('.search-entity-card__plex-sync-svg')) {
                plexSlot.innerHTML = PLEX_SYNC_SVG_HTML;
              }
              plexSlot.setAttribute('aria-label', 'Synced to Plex');
              plexSlot.removeAttribute('aria-hidden');
            } else {
              plexSlot.replaceChildren();
              plexSlot.setAttribute('aria-hidden', 'true');
            }
            strip.classList.toggle('search-entity-card__follow-strip--has-plex-sync', Boolean(show));
          }
        } else if (t === 'artist') {
          patchDiscoverFollowButton(btn, arBy.get(id));
          if (plexSlot) {
            plexSlot.hidden = true;
            plexSlot.replaceChildren();
            plexSlot.setAttribute('aria-hidden', 'true');
            strip?.classList.remove('search-entity-card__follow-strip--has-plex-sync');
          }
        }
      }
    } catch (e) {
      console.warn('Follow state refresh failed:', e);
    }
  }

  async function toggleDiscoverEntityFollow(btn) {
    const kind = btn.dataset.entityType;
    const id = btn.dataset.entityId;
    const title = btn.dataset.entityTitle || '';
    const picture = btn.dataset.picture || '';
    if (!kind || !id) {
      return;
    }

    const rowId = btn.dataset.followRowId ? Number(btn.dataset.followRowId) : 0;
    const status = btn.dataset.followStatus || '';
    if (status === 'denied') {
      return;
    }
    btn.disabled = true;

    try {
      if (rowId > 0 && (status === 'active' || status === 'pending')) {
        const path =
          kind === 'playlist' ? `/api/playlists/follow/${rowId}` : `/api/artists/follow/${rowId}`;
        const res = await fetch(path, { method: 'DELETE', credentials: 'same-origin' });
        if (!res.ok) {
          throw new Error('Unfollow failed');
        }
      } else {
        const url = kind === 'playlist' ? '/api/playlists/follow' : '/api/artists/follow';
        const body =
          kind === 'playlist'
            ? { playlist_id: id, title, picture: picture || null }
            : { artist_id: id, name: title, picture: picture || null };
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          if (res.status === 403) {
            await refreshEntityFollowUi();
            return;
          }
          throw new Error('Follow failed');
        }
      }
      await refreshEntityFollowUi();
    } catch (err) {
      console.error(err);
    } finally {
      btn.disabled = btn.dataset.followStatus === 'denied';
    }
  }

  function renderEntityCard(item, targetList) {
    const li = document.createElement('li');
    li.className = 'tracks-scroll-row__item';
    li.dataset.entityType = item.type;
    li.dataset.entityId = String(item.id);

    const card = document.createElement('div');
    card.className = 'search-entity-card';
    if (item.type === 'playlist') {
      card.classList.add('search-entity-card--playlist');
    }

    const img = document.createElement('img');
    img.className = 'search-entity-card__cover';
    const placeholder = window.TrackFlowTrackCard.IMAGE_PLACEHOLDER;
    const coverSrc =
      item.type === 'playlist'
        ? item.picture || placeholder
        : item.picture || item.cover || placeholder;
    img.src = coverSrc;
    img.alt = '';

    const href = getEntityHref(item);
    const titleText = item.name || item.title || 'Untitled';

    const imageShade = document.createElement('div');
    imageShade.className = 'search-entity-card__image-shade';
    imageShade.setAttribute('aria-hidden', 'true');

    const textGradient = document.createElement('div');
    textGradient.className = 'search-entity-card__text-gradient';
    textGradient.setAttribute('aria-hidden', 'true');

    const textBand = document.createElement('div');
    textBand.className = 'search-entity-card__text-band';
    const titleEl = document.createElement('div');
    titleEl.className = 'search-entity-card__title';
    titleEl.textContent = titleText;
    const metaEl = document.createElement('div');
    metaEl.className = 'search-entity-card__subtitle';
    if (item.type === 'album' && item.artist) {
      const aid = item.artistId;
      if (aid != null && aid !== '') {
        const artistA = document.createElement('a');
        artistA.className = 'search-card-meta-link';
        artistA.href = `/artist.html?id=${encodeURIComponent(String(aid))}`;
        artistA.textContent = item.artist;
        metaEl.appendChild(artistA);
      } else {
        metaEl.textContent = item.artist;
      }
    }

    textBand.appendChild(titleEl);
    textBand.appendChild(metaEl);

    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Open ${item.type} ${titleText}`);

    function goEntity() {
      recordNavFrom();
      window.location.href = href;
    }

    card.addEventListener('click', (e) => {
      if (e.target.closest('a.search-card-meta-link')) {
        return;
      }
      goEntity();
    });

    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') {
        return;
      }
      e.preventDefault();
      goEntity();
    });

    card.appendChild(img);
    card.appendChild(imageShade);
    card.appendChild(textGradient);
    card.appendChild(textBand);

    if (item.type === 'playlist' || item.type === 'artist') {
      const followStrip = document.createElement('div');
      followStrip.className = 'search-entity-card__follow-strip';
      if (item.type === 'playlist') {
        const plexSlot = document.createElement('span');
        plexSlot.className = 'search-entity-card__plex-sync-slot';
        plexSlot.hidden = true;
        plexSlot.setAttribute('aria-hidden', 'true');
        followStrip.appendChild(plexSlot);
      }
      const followBtn = document.createElement('button');
      followBtn.type = 'button';
      followBtn.className = 'search-entity-card__follow-btn';
      followBtn.dataset.entityType = item.type;
      followBtn.dataset.entityId = String(item.id);
      followBtn.dataset.entityTitle = titleText;
      followBtn.dataset.picture =
        item.type === 'playlist' ? item.picture || '' : item.picture || item.cover || '';
      const iconSlot = document.createElement('span');
      iconSlot.className = 'search-entity-card__follow-icon-slot';
      iconSlot.setAttribute('aria-hidden', 'true');
      const labelEl = document.createElement('span');
      labelEl.className = 'search-entity-card__follow-label';
      labelEl.setAttribute('aria-hidden', 'true');
      labelEl.textContent = 'Follow';
      followBtn.appendChild(iconSlot);
      followBtn.appendChild(labelEl);
      setDiscoverFollowAria(followBtn);
      followBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void toggleDiscoverEntityFollow(followBtn);
      });
      followBtn.addEventListener('mouseenter', () => {
        const rid = followBtn.dataset.followRowId || '';
        const st = followBtn.dataset.followStatus || '';
        const le = getDiscoverFollowLabelEl(followBtn);
        if (!le || !rid || (st !== 'active' && st !== 'pending')) {
          return;
        }
        le.textContent = 'Unfollow';
        followBtn.setAttribute('aria-label', 'Unfollow');
      });
      followBtn.addEventListener('mouseleave', () => {
        restoreDiscoverFollowButtonLabel(followBtn);
      });
      followStrip.appendChild(followBtn);
      card.appendChild(followStrip);
    }

    li.appendChild(card);
    targetList.appendChild(li);
  }

  return {
    MAX_ITEMS_PER_SECTION,
    initHorizontalScrollBlocks,
    scheduleSyncAllScrollBlocks,
    trackCardOptions,
    renderTrackIntoList,
    fillDiscoverTrackSection,
    fillDiscoverEntitySection,
    refreshEntityFollowUi,
    renderEntityCard,
  };
}
