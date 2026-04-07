/**
 * Reusable user-facing status pill (Requested, Processing, Available, …).
 */
(function (global) {
  /**
   * @param {string} text
   * @param {{ asButton?: boolean, onClick?: (e: Event) => void, className?: string }} [options]
   */
  function create(text, options) {
    const asButton = Boolean(options?.asButton);
    const el = document.createElement(asButton ? 'button' : 'span');
    el.className = ['tf-status-badge', options?.className || ''].filter(Boolean).join(' ');
    el.textContent = text;
    if (asButton) {
      el.type = 'button';
    }
    if (typeof options?.onClick === 'function') {
      el.addEventListener('click', options.onClick);
    }
    return el;
  }

  global.TrackFlowStatusBadge = { create };
})(typeof window !== 'undefined' ? window : globalThis);
