/**
 * Toolbar (grid/list + admin user filter), fetch, and render for followed artists/playlists pages.
 */

const VIEW_STORAGE_PREFIX = 'tf_followed_view_';
const FILTER_STORAGE_PREFIX = 'tf_followed_filter_';

export const UNFOLLOW_ICON_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="24" y2="13"/><line x1="24" y1="8" x2="19" y2="13"/></svg>';

/**
 * @param {object} options
 * @param {object} options.me - /api/auth/me payload
 * @param {'artists'|'playlists'} options.apiSegment
 * @param {string} options.filterSelfLabel - first option label (e.g. "My Artists")
 * @param {string} options.emptyMessageDefault
 * @param {string} options.emptyMessageLoadError
 * @param {(row: object, ctx: object) => HTMLElement} options.buildGridRow
 * @param {(row: object, ctx: object) => HTMLElement} options.buildListRow
 */
export async function mountFollowedPage(options) {
  const {
    me,
    apiSegment,
    filterSelfLabel,
    emptyMessageDefault,
    emptyMessageLoadError,
    buildGridRow,
    buildListRow,
  } = options;

  const followedList = document.getElementById('followedList');
  const emptyState = document.getElementById('emptyState');
  const viewGridBtn = document.getElementById('followedViewGrid');
  const viewListBtn = document.getElementById('followedViewList');
  const userFilterWrap = document.getElementById('followedUserFilterWrap');
  const userFilter = document.getElementById('followedUserFilter');

  if (!followedList || !emptyState) {
    return;
  }

  const isAdmin = me?.role === 'admin';
  const myUserId = me?.id != null ? String(me.id) : '';
  const apiBase = `/api/${apiSegment}`;
  const viewKey = `${VIEW_STORAGE_PREFIX}${apiSegment}`;
  const filterKey = `${FILTER_STORAGE_PREFIX}${apiSegment}`;

  function readViewMode() {
    try {
      const v = localStorage.getItem(viewKey);
      return v === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  }

  function writeViewMode(mode) {
    try {
      localStorage.setItem(viewKey, mode);
    } catch {
      /* ignore */
    }
  }

  function readSavedFilter() {
    if (!isAdmin || !userFilter) {
      return 'self';
    }
    try {
      const v = localStorage.getItem(filterKey);
      return v && v !== '' ? v : 'self';
    } catch {
      return 'self';
    }
  }

  function writeSavedFilter(v) {
    if (!isAdmin) {
      return;
    }
    try {
      localStorage.setItem(filterKey, v);
    } catch {
      /* ignore */
    }
  }

  let viewMode = readViewMode();

  function syncViewToggleButtons() {
    if (viewGridBtn) {
      viewGridBtn.setAttribute('aria-pressed', viewMode === 'grid' ? 'true' : 'false');
      viewGridBtn.classList.toggle('followed-view-btn--active', viewMode === 'grid');
    }
    if (viewListBtn) {
      viewListBtn.setAttribute('aria-pressed', viewMode === 'list' ? 'true' : 'false');
      viewListBtn.classList.toggle('followed-view-btn--active', viewMode === 'list');
    }
  }

  function applyListLayoutClass() {
    followedList.classList.toggle('followed-grid', viewMode === 'grid');
    followedList.classList.toggle('followed-list', viewMode === 'list');
  }

  function setViewMode(mode) {
    viewMode = mode === 'list' ? 'list' : 'grid';
    writeViewMode(viewMode);
    syncViewToggleButtons();
    applyListLayoutClass();
    void loadFollowed();
  }

  viewGridBtn?.addEventListener('click', () => setViewMode('grid'));
  viewListBtn?.addEventListener('click', () => setViewMode('list'));

  if (isAdmin && userFilterWrap && userFilter) {
    const selfOpt = userFilter.querySelector('option[value="self"]');
    if (selfOpt && filterSelfLabel) {
      selfOpt.textContent = filterSelfLabel;
    }

    userFilterWrap.hidden = false;
    userFilterWrap.classList.add('is-admin-visible');

    try {
      const ures = await fetch('/api/users', { credentials: 'same-origin' });
      if (ures.ok) {
        const udata = await ures.json();
        const users = Array.isArray(udata.results) ? udata.results : [];
        const otherUsers = users.filter(
          (u) => u.id != null && String(u.id) !== myUserId,
        );
        for (const u of otherUsers) {
          const opt = document.createElement('option');
          opt.value = String(u.id);
          opt.textContent = String(u.username || '').trim() || 'User';
          userFilter.appendChild(opt);
        }

        let saved = readSavedFilter();
        if (saved === myUserId) {
          saved = 'self';
        }
        const allowed =
          saved === 'all' ||
          saved === 'self' ||
          otherUsers.some((u) => String(u.id) === saved);
        userFilter.value = allowed ? saved : 'self';
        if (!allowed) {
          writeSavedFilter('self');
        }
      }
    } catch {
      /* keep My … + All users only */
    }

    userFilter.addEventListener('change', () => {
      writeSavedFilter(userFilter.value);
      void loadFollowed();
    });
  } else if (userFilterWrap) {
    userFilterWrap.classList.remove('is-admin-visible');
    userFilterWrap.hidden = true;
  }

  function listQueryUserParam() {
    if (!isAdmin || !userFilter) {
      return '';
    }
    const v = userFilter.value;
    if (v === 'self') {
      return '';
    }
    return `&user=${encodeURIComponent(v)}`;
  }

  function showOwnerBadge() {
    return isAdmin && userFilter && userFilter.value === 'all';
  }

  async function deleteFollowedRow(rowId, li, controlEl) {
    if (controlEl) {
      controlEl.disabled = true;
    }
    try {
      const res = await fetch(`${apiBase}/follow/${rowId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        throw new Error('Unfollow failed');
      }
      li.remove();
      if (followedList.children.length === 0) {
        emptyState.textContent = emptyMessageDefault;
        emptyState.hidden = false;
      }
    } catch {
      if (controlEl) {
        controlEl.disabled = false;
      }
    }
  }

  const ctxBase = {
    deleteFollowedRow,
    showOwnerBadge,
  };

  async function loadFollowed() {
    followedList.innerHTML = '';
    applyListLayoutClass();
    syncViewToggleButtons();

    const q = listQueryUserParam();
    try {
      const res = await fetch(`${apiBase}/followed?include_pending=1${q}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Load failed');
      }
      const data = await res.json();
      const rows = Array.isArray(data.results) ? data.results : [];
      if (rows.length === 0) {
        emptyState.textContent = emptyMessageDefault;
      }
      emptyState.hidden = rows.length > 0;

      const ctx = { ...ctxBase, viewMode };
      for (const row of rows) {
        const li =
          viewMode === 'list' ? buildListRow(row, ctx) : buildGridRow(row, ctx);
        followedList.appendChild(li);
      }
    } catch (e) {
      console.error(e);
      emptyState.hidden = false;
      emptyState.textContent = e?.message || emptyMessageLoadError;
    }
  }

  applyListLayoutClass();
  syncViewToggleButtons();
  await loadFollowed();
}

const TYPE_STORAGE_KEY = 'tf_following_type';

/**
 * Unified Following page: artists + playlists with type filter (all / artists / playlists).
 * @param {object} options
 * @param {object} options.me - /api/auth/me payload
 * @param {(row: object, ctx: object) => HTMLElement} options.buildGridRow — row includes `_kind`: `artist` | `playlist`
 * @param {(row: object, ctx: object) => HTMLElement} options.buildListRow
 */
export async function mountFollowingPage(options) {
  const { me, buildGridRow, buildListRow } = options;

  const followedList = document.getElementById('followedList');
  const emptyState = document.getElementById('emptyState');
  const viewGridBtn = document.getElementById('followedViewGrid');
  const viewListBtn = document.getElementById('followedViewList');
  const typeAllBtn = document.getElementById('followingFilterAll');
  const typeArtistsBtn = document.getElementById('followingFilterArtists');
  const typePlaylistsBtn = document.getElementById('followingFilterPlaylists');
  const userFilterWrap = document.getElementById('followedUserFilterWrap');
  const userFilter = document.getElementById('followedUserFilter');

  if (!followedList || !emptyState) {
    return;
  }

  const isAdmin = me?.role === 'admin';
  const myUserId = me?.id != null ? String(me.id) : '';
  const viewKey = `${VIEW_STORAGE_PREFIX}following`;
  const filterKey = `${FILTER_STORAGE_PREFIX}following`;

  if (isAdmin) {
    window.addEventListener('pagehide', () => {
      try {
        localStorage.removeItem(filterKey);
      } catch {
        /* ignore */
      }
    });
    window.addEventListener('pageshow', (ev) => {
      if (!ev.persisted || !userFilter) {
        return;
      }
      userFilter.value = 'self';
      try {
        localStorage.setItem(filterKey, 'self');
      } catch {
        /* ignore */
      }
      void loadFollowed();
    });
  }

  function consumeUrlTypeParam() {
    try {
      const u = new URL(window.location.href);
      const t = (u.searchParams.get('type') || '').toLowerCase();
      if (t === 'artists' || t === 'playlists' || t === 'all') {
        u.searchParams.delete('type');
        const next = `${u.pathname}${u.search}${u.hash}`;
        history.replaceState(null, '', next || u.pathname);
        return t;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function readTypeFilter() {
    const fromUrl = consumeUrlTypeParam();
    if (fromUrl) {
      try {
        localStorage.setItem(TYPE_STORAGE_KEY, fromUrl);
      } catch {
        /* ignore */
      }
      return fromUrl;
    }
    try {
      const v = localStorage.getItem(TYPE_STORAGE_KEY);
      if (v === 'artists' || v === 'playlists' || v === 'all') {
        return v;
      }
    } catch {
      /* ignore */
    }
    return 'all';
  }

  function writeTypeFilter(v) {
    const t = v === 'artists' || v === 'playlists' ? v : 'all';
    try {
      localStorage.setItem(TYPE_STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  }

  let typeFilter = readTypeFilter();

  function readViewMode() {
    try {
      const v = localStorage.getItem(viewKey);
      return v === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  }

  function writeViewMode(mode) {
    try {
      localStorage.setItem(viewKey, mode);
    } catch {
      /* ignore */
    }
  }

  function readSavedFilter() {
    if (!isAdmin || !userFilter) {
      return 'self';
    }
    try {
      const v = localStorage.getItem(filterKey);
      return v && v !== '' ? v : 'self';
    } catch {
      return 'self';
    }
  }

  function writeSavedFilter(v) {
    if (!isAdmin) {
      return;
    }
    try {
      localStorage.setItem(filterKey, v);
    } catch {
      /* ignore */
    }
  }

  let viewMode = readViewMode();

  function syncViewToggleButtons() {
    if (viewGridBtn) {
      viewGridBtn.setAttribute('aria-pressed', viewMode === 'grid' ? 'true' : 'false');
      viewGridBtn.classList.toggle('followed-view-btn--active', viewMode === 'grid');
    }
    if (viewListBtn) {
      viewListBtn.setAttribute('aria-pressed', viewMode === 'list' ? 'true' : 'false');
      viewListBtn.classList.toggle('followed-view-btn--active', viewMode === 'list');
    }
  }

  function syncTypeFilterButtons() {
    const map = [
      [typeAllBtn, typeFilter === 'all'],
      [typeArtistsBtn, typeFilter === 'artists'],
      [typePlaylistsBtn, typeFilter === 'playlists'],
    ];
    for (const [btn, active] of map) {
      if (!btn) continue;
      btn.classList.toggle('followed-view-btn--active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function applyListLayoutClass() {
    followedList.classList.toggle('followed-grid', viewMode === 'grid');
    followedList.classList.toggle('followed-list', viewMode === 'list');
  }

  function setViewMode(mode) {
    viewMode = mode === 'list' ? 'list' : 'grid';
    writeViewMode(viewMode);
    syncViewToggleButtons();
    applyListLayoutClass();
    void loadFollowed();
  }

  function setTypeFilter(next) {
    const t = next === 'artists' || next === 'playlists' ? next : 'all';
    typeFilter = t;
    writeTypeFilter(t);
    syncTypeFilterButtons();
    void loadFollowed();
  }

  viewGridBtn?.addEventListener('click', () => setViewMode('grid'));
  viewListBtn?.addEventListener('click', () => setViewMode('list'));
  typeAllBtn?.addEventListener('click', () => setTypeFilter('all'));
  typeArtistsBtn?.addEventListener('click', () => setTypeFilter('artists'));
  typePlaylistsBtn?.addEventListener('click', () => setTypeFilter('playlists'));

  if (isAdmin && userFilterWrap && userFilter) {
    const selfOpt = userFilter.querySelector('option[value="self"]');
    if (selfOpt) {
      selfOpt.textContent = 'My follows';
    }

    userFilterWrap.hidden = false;
    userFilterWrap.classList.add('is-admin-visible');

    try {
      const ures = await fetch('/api/users', { credentials: 'same-origin' });
      if (ures.ok) {
        const udata = await ures.json();
        const users = Array.isArray(udata.results) ? udata.results : [];
        const otherUsers = users.filter((u) => u.id != null && String(u.id) !== myUserId);
        for (const u of otherUsers) {
          const opt = document.createElement('option');
          opt.value = String(u.id);
          opt.textContent = String(u.username || '').trim() || 'User';
          userFilter.appendChild(opt);
        }

        let saved = readSavedFilter();
        if (saved === myUserId) {
          saved = 'self';
        }
        const allowed =
          saved === 'all' ||
          saved === 'self' ||
          otherUsers.some((u) => String(u.id) === saved);
        userFilter.value = allowed ? saved : 'self';
        if (!allowed) {
          writeSavedFilter('self');
        }
      }
    } catch {
      /* keep defaults */
    }

    userFilter.addEventListener('change', () => {
      writeSavedFilter(userFilter.value);
      void loadFollowed();
    });
  } else if (userFilterWrap) {
    userFilterWrap.classList.remove('is-admin-visible');
    userFilterWrap.hidden = true;
  }

  function listQueryUserParam() {
    if (!isAdmin || !userFilter) {
      return '';
    }
    const v = userFilter.value;
    if (v === 'self') {
      return '';
    }
    return `&user=${encodeURIComponent(v)}`;
  }

  function showOwnerBadge() {
    return isAdmin && userFilter && userFilter.value === 'all';
  }

  function emptyMessageForFilter() {
    if (typeFilter === 'artists') {
      return 'Nothing here yet. Discover some artists and hit follow.';
    }
    if (typeFilter === 'playlists') {
      return 'Nothing here yet. Discover some playlists and hit follow.';
    }
    return 'Nothing here yet. Follow artists or playlists from Discover.';
  }

  async function deleteFollowedRow(row, li, controlEl) {
    if (String(row?.follow_status || '') === 'denied') {
      return;
    }
    if (controlEl) {
      controlEl.disabled = true;
    }
    const rowId = Number(row?.id);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      if (controlEl) controlEl.disabled = false;
      return;
    }
    const base = row._kind === 'artist' ? '/api/artists' : '/api/playlists';
    try {
      const res = await fetch(`${base}/follow/${rowId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        throw new Error('Unfollow failed');
      }
      li.remove();
      if (followedList.children.length === 0) {
        emptyState.textContent = emptyMessageForFilter();
        emptyState.hidden = false;
      }
    } catch {
      if (controlEl) {
        controlEl.disabled = false;
      }
    }
  }

  const ctxBase = {
    deleteFollowedRow,
    showOwnerBadge,
  };

  async function loadFollowed() {
    followedList.innerHTML = '';
    applyListLayoutClass();
    syncViewToggleButtons();
    syncTypeFilterButtons();

    const q = listQueryUserParam();
    const needArtists = typeFilter === 'all' || typeFilter === 'artists';
    const needPlaylists = typeFilter === 'all' || typeFilter === 'playlists';

    try {
      const jobs = [];
      if (needArtists) {
        jobs.push(
          fetch(`/api/artists/followed?include_pending=1${q}`, { credentials: 'same-origin' }).then(async (res) => {
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || 'Failed to load followed artists');
            }
            const data = await res.json();
            const results = Array.isArray(data.results) ? data.results : [];
            return results.map((r) => ({ ...r, _kind: 'artist' }));
          }),
        );
      }
      if (needPlaylists) {
        jobs.push(
          fetch(`/api/playlists/followed?include_pending=1${q}`, { credentials: 'same-origin' }).then(async (res) => {
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || 'Failed to load followed playlists');
            }
            const data = await res.json();
            const results = Array.isArray(data.results) ? data.results : [];
            return results.map((r) => ({ ...r, _kind: 'playlist' }));
          }),
        );
      }

      const parts = await Promise.all(jobs);
      let rows = parts.flat();
      if (typeFilter === 'all') {
        rows = rows.sort((a, b) => {
          const ta = a._kind === 'artist' ? String(a.name || '') : String(a.title || '');
          const tb = b._kind === 'artist' ? String(b.name || '') : String(b.title || '');
          return ta.localeCompare(tb, undefined, { sensitivity: 'base' });
        });
      }

      if (rows.length === 0) {
        emptyState.textContent = emptyMessageForFilter();
      }
      emptyState.hidden = rows.length > 0;

      const ctx = { ...ctxBase, viewMode };
      for (const row of rows) {
        const li = viewMode === 'list' ? buildListRow(row, ctx) : buildGridRow(row, ctx);
        followedList.appendChild(li);
      }
    } catch (e) {
      console.error(e);
      emptyState.hidden = false;
      emptyState.textContent = e?.message || 'Could not load follows.';
    }
  }

  applyListLayoutClass();
  syncViewToggleButtons();
  syncTypeFilterButtons();
  await loadFollowed();
}
