import { initAppTopSearch } from './app-top-search.js';
import { initAppUserMenu } from './app-user-menu.js';

/**
 * @param {{ username?: string, role?: string, jukebox_enabled?: boolean } | null | undefined} me
 */
export async function initAppNavAuth(me) {
  try {
    if (!me?.username) {
      return;
    }

    const sidebar = document.querySelector('.app-sidebar');
    if (!sidebar) {
      return;
    }

    // Sidebar HTML defaults to jukebox hidden so first paint matches jukebox-disabled users (no flash on navigation).
    for (const a of [...sidebar.querySelectorAll('a.app-nav-item[href="/jukebox.html"]')]) {
      if (me.jukebox_enabled) {
        a.removeAttribute('hidden');
      } else {
        a.setAttribute('hidden', '');
      }
    }

    for (const a of [...sidebar.querySelectorAll('a.app-nav-item[href="/settings.html"]')]) {
      if (me.role === 'admin') {
        a.removeAttribute('hidden');
      } else {
        a.setAttribute('hidden', '');
      }
    }

    initAppUserMenu(me);
  } finally {
    initAppTopSearch();
  }
}
