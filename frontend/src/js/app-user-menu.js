/**
 * @param {{ username?: string } | null | undefined} me
 */
export function initAppUserMenu(me) {
  if (!me?.username) {
    return;
  }
  if (document.querySelector('.app-user-menu')) {
    return;
  }

  const searchRow =
    document.querySelector('[data-app-top-search]') || document.querySelector('.app-main .search-row');
  if (!searchRow?.parentNode) {
    return;
  }

  if (searchRow.closest('.app-top-bar')) {
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'app-top-bar';
  searchRow.parentNode.insertBefore(wrap, searchRow);
  wrap.appendChild(searchRow);

  const root = document.createElement('div');
  root.className = 'app-user-menu';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'app-user-menu__trigger';
  const letter = me.username.trim().charAt(0).toUpperCase() || '?';
  trigger.textContent = letter;
  trigger.setAttribute('aria-label', 'Account menu');
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');

  const dropdown = document.createElement('div');
  dropdown.className = 'app-user-menu__dropdown';
  dropdown.hidden = true;
  dropdown.setAttribute('role', 'menu');

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'app-user-menu__item';
  logoutBtn.setAttribute('role', 'menuitem');
  logoutBtn.textContent = 'Log out';
  logoutBtn.addEventListener('click', async () => {
    setOpen(false);
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login.html';
  });
  dropdown.appendChild(logoutBtn);

  function setOpen(open) {
    dropdown.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(dropdown.hidden);
  });

  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) {
      setOpen(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setOpen(false);
    }
  });

  root.appendChild(trigger);
  root.appendChild(dropdown);
  wrap.appendChild(root);
}
