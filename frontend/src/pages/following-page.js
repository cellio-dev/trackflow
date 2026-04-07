import { ensureLoggedIn } from '../js/auth-guard.js';
import { initAppNavAuth } from '../js/app-nav-auth.js';
import { mountFollowingPage, UNFOLLOW_ICON_SVG } from '../js/followed-pages-shared.js';
import { PLEX_SYNC_SVG_HTML } from '../js/plex-sync-icon.js';
import '../js/track-card-shared.js';

const __tfMe = await ensureLoggedIn();
if (!__tfMe) {
  await new Promise(() => {});
}
await initAppNavAuth(__tfMe);

const PLACEHOLDER = window.TrackFlowTrackCard?.IMAGE_PLACEHOLDER || '';

function playlistRowShowsPlexSyncBadge(row) {
  return (
    row._kind === 'playlist' &&
    row.follow_status === 'active' &&
    Boolean(row.plex_sync_enabled)
  );
}

function wireFollowedGridUnfollowHover(btn, pending) {
  btn.addEventListener('mouseenter', () => {
    btn.textContent = 'Unfollow';
  });
  btn.addEventListener('mouseleave', () => {
    btn.textContent = pending ? 'Pending…' : 'Following';
  });
}

function buildArtistGridRow(row, ctx) {
  const li = document.createElement('li');
  li.className = 'followed-item';

  const href = `/artist.html?id=${encodeURIComponent(String(row.artist_id))}`;
  const isPending = row.follow_status === 'pending';

  const card = document.createElement('div');
  card.className = 'search-entity-card';
  card.setAttribute('role', 'link');
  card.setAttribute('tabindex', '0');
  card.setAttribute(
    'aria-label',
    `Open artist ${String(row.name || 'Artist').replace(/"/g, '')}`,
  );

  function goArtist() {
    window.location.href = href;
  }
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) {
      return;
    }
    goArtist();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') {
      return;
    }
    e.preventDefault();
    goArtist();
  });

  const img = document.createElement('img');
  img.className = 'search-entity-card__cover';
  img.src = row.picture || PLACEHOLDER;
  img.alt = '';

  const shade = document.createElement('div');
  shade.className = 'search-entity-card__image-shade';
  shade.setAttribute('aria-hidden', 'true');
  const grad = document.createElement('div');
  grad.className = 'search-entity-card__text-gradient';
  grad.setAttribute('aria-hidden', 'true');

  const band = document.createElement('div');
  band.className = 'search-entity-card__text-band';
  const titleEl = document.createElement('div');
  titleEl.className = 'search-entity-card__title';
  titleEl.textContent = row.name || 'Artist';
  const sub = document.createElement('div');
  sub.className = 'search-entity-card__subtitle';
  if (ctx.showOwnerBadge() && row.owner_username) {
    sub.textContent = row.owner_username;
  }
  band.appendChild(titleEl);
  band.appendChild(sub);

  card.appendChild(img);
  card.appendChild(shade);
  card.appendChild(grad);
  card.appendChild(band);

  const followStrip = document.createElement('div');
  followStrip.className = 'search-entity-card__follow-strip';
  if (!isPending) {
    followStrip.classList.add('followed-card__follow-strip--reveal');
  }

  const followBtn = document.createElement('button');
  followBtn.type = 'button';
  followBtn.className = `search-entity-card__follow-btn${isPending ? ' is-pending' : ' is-following'}`;
  followBtn.textContent = isPending ? 'Pending…' : 'Following';
  wireFollowedGridUnfollowHover(followBtn, isPending);
  followBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    await ctx.deleteFollowedRow(row, li, followBtn);
  });
  followStrip.appendChild(followBtn);
  card.appendChild(followStrip);

  li.appendChild(card);
  return li;
}

function buildPlaylistGridRow(row, ctx) {
  const li = document.createElement('li');
  li.className = 'followed-item';

  const href = `/playlist.html?id=${encodeURIComponent(String(row.playlist_id))}`;
  const isPending = row.follow_status === 'pending';

  const card = document.createElement('div');
  card.className = 'search-entity-card search-entity-card--playlist';
  card.setAttribute('role', 'link');
  card.setAttribute('tabindex', '0');
  card.setAttribute(
    'aria-label',
    `Open playlist ${String(row.title || 'Playlist').replace(/"/g, '')}`,
  );

  function goPlaylist() {
    window.location.href = href;
  }
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) {
      return;
    }
    goPlaylist();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') {
      return;
    }
    e.preventDefault();
    goPlaylist();
  });

  const img = document.createElement('img');
  img.className = 'search-entity-card__cover';
  img.src = row.picture || PLACEHOLDER;
  img.alt = '';

  const shade = document.createElement('div');
  shade.className = 'search-entity-card__image-shade';
  shade.setAttribute('aria-hidden', 'true');
  const grad = document.createElement('div');
  grad.className = 'search-entity-card__text-gradient';
  grad.setAttribute('aria-hidden', 'true');

  const band = document.createElement('div');
  band.className = 'search-entity-card__text-band';
  const titleEl = document.createElement('div');
  titleEl.className = 'search-entity-card__title';
  titleEl.textContent = row.title || 'Playlist';
  const sub = document.createElement('div');
  sub.className = 'search-entity-card__subtitle';
  if (ctx.showOwnerBadge() && row.owner_username) {
    sub.textContent = row.owner_username;
  }
  band.appendChild(titleEl);
  band.appendChild(sub);

  card.appendChild(img);
  card.appendChild(shade);
  card.appendChild(grad);
  card.appendChild(band);

  const followStrip = document.createElement('div');
  followStrip.className = 'search-entity-card__follow-strip';
  if (!isPending) {
    followStrip.classList.add('followed-card__follow-strip--reveal');
  }

  const followBtn = document.createElement('button');
  followBtn.type = 'button';
  followBtn.className = `search-entity-card__follow-btn${isPending ? ' is-pending' : ' is-following'}`;
  followBtn.textContent = isPending ? 'Pending…' : 'Following';
  wireFollowedGridUnfollowHover(followBtn, isPending);
  followBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    await ctx.deleteFollowedRow(row, li, followBtn);
  });
  if (playlistRowShowsPlexSyncBadge(row)) {
    const plexSlot = document.createElement('span');
    plexSlot.className = 'search-entity-card__plex-sync-slot';
    plexSlot.setAttribute('aria-label', 'Synced to Plex');
    plexSlot.innerHTML = PLEX_SYNC_SVG_HTML;
    followStrip.appendChild(plexSlot);
    followStrip.classList.add('search-entity-card__follow-strip--has-plex-sync');
    followStrip.classList.add('followed-card__follow-strip--plex-always-visible');
  }
  followStrip.appendChild(followBtn);
  card.appendChild(followStrip);

  li.appendChild(card);
  return li;
}

function buildGridRow(row, ctx) {
  return row._kind === 'playlist' ? buildPlaylistGridRow(row, ctx) : buildArtistGridRow(row, ctx);
}

function buildArtistListRow(row, ctx) {
  const li = document.createElement('li');
  li.className = 'followed-list-item';

  const href = `/artist.html?id=${encodeURIComponent(String(row.artist_id))}`;
  const isPending = row.follow_status === 'pending';

  const thumb = document.createElement('img');
  thumb.className = 'followed-list-item__thumb';
  thumb.src = row.picture || PLACEHOLDER;
  thumb.alt = '';

  const main = document.createElement('div');
  main.className = 'followed-list-item__main';

  const titleLink = document.createElement('a');
  titleLink.className = 'followed-list-item__title';
  titleLink.href = href;
  titleLink.textContent = row.name || 'Artist';

  const meta = document.createElement('div');
  meta.className = 'followed-list-item__meta';
  const parts = [];
  if (isPending) {
    parts.push('Pending approval');
  }
  if (ctx.showOwnerBadge() && row.owner_username) {
    parts.push(`User: ${row.owner_username}`);
  }
  meta.textContent = parts.join(' · ');

  main.appendChild(titleLink);
  main.appendChild(meta);

  const unfollowBtn = document.createElement('button');
  unfollowBtn.type = 'button';
  unfollowBtn.className = 'followed-list-unfollow';
  unfollowBtn.setAttribute('aria-label', `Unfollow ${row.name || 'artist'}`);
  unfollowBtn.innerHTML = UNFOLLOW_ICON_SVG;
  unfollowBtn.addEventListener('click', async () => {
    await ctx.deleteFollowedRow(row, li, unfollowBtn);
  });

  li.appendChild(thumb);
  li.appendChild(main);
  li.appendChild(unfollowBtn);
  return li;
}

function buildPlaylistListRow(row, ctx) {
  const li = document.createElement('li');
  li.className = 'followed-list-item';

  const href = `/playlist.html?id=${encodeURIComponent(String(row.playlist_id))}`;
  const isPending = row.follow_status === 'pending';

  const thumb = document.createElement('img');
  thumb.className = 'followed-list-item__thumb';
  thumb.src = row.picture || PLACEHOLDER;
  thumb.alt = '';

  const main = document.createElement('div');
  main.className = 'followed-list-item__main';

  const titleLink = document.createElement('a');
  titleLink.className = 'followed-list-item__title';
  titleLink.href = href;
  titleLink.textContent = row.title || 'Playlist';

  const meta = document.createElement('div');
  meta.className = 'followed-list-item__meta';
  const parts = [];
  if (isPending) {
    parts.push('Pending approval');
  }
  if (ctx.showOwnerBadge() && row.owner_username) {
    parts.push(`User: ${row.owner_username}`);
  }
  meta.textContent = parts.join(' · ');

  main.appendChild(titleLink);
  main.appendChild(meta);

  const unfollowBtn = document.createElement('button');
  unfollowBtn.type = 'button';
  unfollowBtn.className = 'followed-list-unfollow';
  unfollowBtn.setAttribute('aria-label', `Unfollow ${row.title || 'playlist'}`);
  unfollowBtn.innerHTML = UNFOLLOW_ICON_SVG;
  unfollowBtn.addEventListener('click', async () => {
    await ctx.deleteFollowedRow(row, li, unfollowBtn);
  });

  const actions = document.createElement('div');
  actions.className = 'followed-list-item__actions';
  if (playlistRowShowsPlexSyncBadge(row)) {
    const plexSlot = document.createElement('span');
    plexSlot.className = 'followed-list-item__plex-sync-slot';
    plexSlot.setAttribute('aria-label', 'Synced to Plex');
    plexSlot.innerHTML = PLEX_SYNC_SVG_HTML;
    actions.appendChild(plexSlot);
  }
  actions.appendChild(unfollowBtn);

  li.appendChild(thumb);
  li.appendChild(main);
  li.appendChild(actions);
  return li;
}

function buildListRow(row, ctx) {
  return row._kind === 'playlist' ? buildPlaylistListRow(row, ctx) : buildArtistListRow(row, ctx);
}

await mountFollowingPage({
  me: __tfMe,
  buildGridRow,
  buildListRow,
});
