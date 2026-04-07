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

    if (!me.jukebox_enabled) {
      for (const a of [...sidebar.querySelectorAll('a.app-nav-item[href="/jukebox.html"]')]) {
        a.remove();
      }
    }

    for (const a of [...sidebar.querySelectorAll('a.app-nav-item[href="/settings.html"]')]) {
      if (me.role === 'admin') {
        a.removeAttribute('hidden');
      } else {
        a.remove();
      }
    }

    initAppUserMenu(me);
  } finally {
    initAppTopSearch();
  }
}
