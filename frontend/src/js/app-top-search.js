/**
 * On non-Discover pages, wires the top search row to open Discover with ?q=.
 * Runs after initAppNavAuth so the top bar layout is stable before listeners attach.
 */
import { recordNavFrom } from './app-back-nav.js';

let topSearchWired = false;

export function initAppTopSearch() {
  if (topSearchWired) {
    return;
  }
  const row = document.querySelector('[data-app-top-search]');
  if (!row || document.getElementById('searchInput')) {
    return;
  }
  topSearchWired = true;

  const input = row.querySelector('input[type="text"], input[type="search"], input:not([type])');
  function goDiscover() {
    recordNavFrom();
    const q = (input?.value ?? '').trim();
    window.location.href = q ? `/index.html?q=${encodeURIComponent(q)}` : '/index.html';
  }
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goDiscover();
    }
  });
}
