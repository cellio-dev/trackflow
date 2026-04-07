/**
 * Reusable full-screen PIN entry. Validates via caller-supplied `verify` (e.g. POST /verify-pin).
 * Does not persist the PIN. Import side effect: injects styles once.
 * @module pin-modal
 */
import '../css/pin-modal.css';

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

const PIN_MIN = PIN_MIN_LENGTH;
const PIN_MAX = PIN_MAX_LENGTH;

/**
 * @typedef {object} RequestPinOptions
 * @property {string} title Dialog heading (e.g. "Enter PIN to Skip Track").
 * @property {(pin: string) => Promise<boolean>} verify Return true if PIN is correct (call your API).
 */

/**
 * @param {RequestPinOptions} options
 * @returns {Promise<string | null>} Submitted PIN, or null if cancelled.
 */
export function requestPin(options) {
  const inst = ensureInstance();
  if (inst._busy) {
    return Promise.reject(new Error('PIN modal is already open'));
  }
  return new Promise((resolve) => {
    inst._open(options, resolve);
  });
}

/** @type {ReturnType<typeof createPinModal> | null} */
let modalSingleton = null;

function ensureInstance() {
  if (!modalSingleton) {
    modalSingleton = createPinModal();
  }
  return modalSingleton;
}

function createPinModal() {
  const root = document.createElement('div');
  root.className = 'tf-pin-modal';
  root.setAttribute('hidden', '');
  root.setAttribute('role', 'presentation');

  const backdrop = document.createElement('div');
  backdrop.className = 'tf-pin-modal__backdrop';
  backdrop.setAttribute('aria-hidden', 'true');

  const panel = document.createElement('div');
  panel.className = 'tf-pin-modal__panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const titleId = `tf-pin-title-${Math.random().toString(36).slice(2, 9)}`;
  panel.setAttribute('aria-labelledby', titleId);

  const titleEl = document.createElement('h1');
  titleEl.className = 'tf-pin-modal__title';
  titleEl.id = titleId;

  const dotsWrap = document.createElement('div');
  dotsWrap.className = 'tf-pin-modal__dots';
  const dots = [];
  for (let i = 0; i < PIN_MAX; i += 1) {
    const d = document.createElement('span');
    d.className = 'tf-pin-modal__dot';
    d.setAttribute('aria-hidden', 'true');
    dotsWrap.appendChild(d);
    dots.push(d);
  }

  const errorEl = document.createElement('p');
  errorEl.className = 'tf-pin-modal__error';
  errorEl.setAttribute('role', 'alert');

  const keys = document.createElement('div');
  keys.className = 'tf-pin-modal__keys';

  /** @type {string[]} */
  let digits = [];
  /** @type {RequestPinOptions | null} */
  let opts = null;
  /** @type {((v: string | null) => void) | null} */
  let finish = null;
  let busy = false;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let keyHandler = null;

  function updateDots() {
    for (let i = 0; i < PIN_MAX; i += 1) {
      dots[i].classList.toggle('tf-pin-modal__dot--filled', i < digits.length);
    }
  }

  function setError(msg) {
    errorEl.textContent = msg || '';
  }

  function clearError() {
    errorEl.textContent = '';
  }

  function pinString() {
    return digits.join('');
  }

  function canSubmit() {
    const n = digits.length;
    return n >= PIN_MIN && n <= PIN_MAX;
  }

  function updatePrimary() {
    submitBtn.disabled = !canSubmit() || busy;
  }

  function setDigitKeysDisabled(disabled) {
    for (const b of digitButtons) {
      b.disabled = disabled;
    }
    backBtn.disabled = disabled || digits.length === 0;
  }

  function appendDigit(ch) {
    if (busy || digits.length >= PIN_MAX) {
      return;
    }
    clearError();
    panel.classList.remove('tf-pin-modal__panel--shake');
    digits.push(ch);
    updateDots();
    updatePrimary();
    backBtn.disabled = busy || digits.length === 0;
  }

  function backspace() {
    if (busy || digits.length === 0) {
      return;
    }
    clearError();
    panel.classList.remove('tf-pin-modal__panel--shake');
    digits.pop();
    updateDots();
    updatePrimary();
    backBtn.disabled = busy || digits.length === 0;
  }

  const digitButtons = [];
  const layout = ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', 'back'];
  for (const cell of layout) {
    if (cell === null) {
      const spacer = document.createElement('div');
      spacer.setAttribute('aria-hidden', 'true');
      keys.appendChild(spacer);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tf-pin-modal__key';
    if (cell === 'back') {
      btn.classList.add('tf-pin-modal__key--icon');
      btn.setAttribute('aria-label', 'Delete digit');
      btn.textContent = '⌫';
      btn.addEventListener('click', () => backspace());
    } else {
      btn.textContent = cell;
      btn.setAttribute('aria-label', `Digit ${cell}`);
      btn.addEventListener('click', () => appendDigit(cell));
    }
    keys.appendChild(btn);
    if (cell !== 'back') {
      digitButtons.push(btn);
    }
  }
  const backBtn = /** @type {HTMLButtonElement} */ (keys.querySelector('[aria-label="Delete digit"]'));

  const actions = document.createElement('div');
  actions.className = 'tf-pin-modal__actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'tf-pin-modal__btn tf-pin-modal__btn--secondary';
  cancelBtn.textContent = 'Cancel';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'tf-pin-modal__btn tf-pin-modal__btn--primary';
  submitBtn.textContent = 'Continue';

  cancelBtn.addEventListener('click', () => close(null));
  submitBtn.addEventListener('click', () => void submit());

  actions.append(cancelBtn, submitBtn);

  panel.append(titleEl, dotsWrap, errorEl, keys, actions);
  root.append(backdrop, panel);
  document.body.appendChild(root);

  async function submit() {
    if (!opts || busy) {
      return;
    }
    const pin = pinString();
    if (pin.length < PIN_MIN) {
      setError(`Enter at least ${PIN_MIN} digits`);
      return;
    }
    busy = true;
    submitBtn.classList.add('tf-pin-modal__btn--loading');
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    setDigitKeysDisabled(true);
    try {
      const ok = await opts.verify(pin);
      if (ok) {
        close(pin);
      } else {
        setError('Incorrect PIN');
        panel.classList.remove('tf-pin-modal__panel--shake');
        void panel.offsetWidth;
        panel.classList.add('tf-pin-modal__panel--shake');
      }
    } catch {
      setError('Could not verify PIN. Try again.');
      panel.classList.remove('tf-pin-modal__panel--shake');
      void panel.offsetWidth;
      panel.classList.add('tf-pin-modal__panel--shake');
    } finally {
      busy = false;
      submitBtn.classList.remove('tf-pin-modal__btn--loading');
      cancelBtn.disabled = false;
      setDigitKeysDisabled(false);
      updatePrimary();
    }
  }

  function close(value) {
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler, true);
      keyHandler = null;
    }
    try {
      document.documentElement.classList.remove('tf-pin-modal-open');
    } catch {
      /* ignore */
    }
    root.setAttribute('hidden', '');
    root.setAttribute('aria-hidden', 'true');
    const cb = finish;
    finish = null;
    opts = null;
    digits = [];
    updateDots();
    clearError();
    panel.classList.remove('tf-pin-modal__panel--shake');
    submitBtn.classList.remove('tf-pin-modal__btn--loading');
    cancelBtn.disabled = false;
    busy = false;
    setDigitKeysDisabled(false);
    updatePrimary();
    if (cb) {
      cb(value);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close(null);
      return;
    }
    if (busy) {
      return;
    }
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      e.stopPropagation();
      appendDigit(e.key);
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      backspace();
    }
  }

  return {
    get _busy() {
      return finish != null;
    },
    /**
     * @param {RequestPinOptions} options
     * @param {(v: string | null) => void} resolve
     */
    _open(options, resolve) {
      if (finish != null) {
        resolve(null);
        return;
      }
      opts = options;
      finish = resolve;
      titleEl.textContent = options.title || 'Enter PIN';
      digits = [];
      updateDots();
      clearError();
      panel.classList.remove('tf-pin-modal__panel--shake');
      busy = false;
      submitBtn.classList.remove('tf-pin-modal__btn--loading');
      cancelBtn.disabled = false;
      setDigitKeysDisabled(false);
      updatePrimary();
      root.removeAttribute('hidden');
      root.setAttribute('aria-hidden', 'false');
      try {
        document.documentElement.classList.add('tf-pin-modal-open');
      } catch {
        /* ignore */
      }
      keyHandler = onKeyDown;
      document.addEventListener('keydown', keyHandler, true);
      cancelBtn.focus();
    },
  };
}
