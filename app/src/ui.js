/** Shared DOM helpers, view switching and the bottom-sheet host. */

export const $ = (id) => document.getElementById(id);

/**
 * The sheet's close mark, drawn rather than typed.
 *
 * Inlined here instead of imported from ./icons.js: that module imports `el`
 * from this one, and a module cycle for the sake of one glyph is a worse trade
 * than eight duplicated path characters.
 */
const CLOSE_MARK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"'
  + ' stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * App-wide change notifications. Logging food from a sheet has to refresh
 * whichever screens are behind it, and they should not have to know who logged.
 * Events: 'diary' (entries changed), 'day' (water/notes/weight), 'foods'
 * (my foods, meals, products), 'profile' (goals changed).
 */
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => { bus.addEventListener(name, fn); return () => bus.removeEventListener(name, fn); };

/**
 * Tiny element builder. Text always goes in as text, never as markup: food
 * names, brands and user-typed notes all end up on screen, and this app has no
 * business parsing HTML from any of them.
 *
 * @param {string} tag  'div', or 'div.card.wide' for classes
 * @param {object|null} [props]  attributes; `on*` become listeners, `dataset` merges
 * @param {...(Node|string|number|false|null|undefined|Array)} children
 */
export function el(tag, props = null, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name);
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = [node.className, v].filter(Boolean).join(' ');
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') node.setAttribute('style', v);
    else if (k === 'html') node.innerHTML = v;              // charts only: trusted SVG strings
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Replace a container's children in one go. */
export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

export const VIEWS = ['home', 'camera', 'analyze', 'diary', 'nutrition', 'progress', 'more', 'settings', 'myfoods', 'exercise', 'barcode'];

let currentView = 'home';
const listeners = new Set();

/** @param {string} name @param {{silent?:boolean, history?:'push'|'replace'|'none'}} [opts] */
export function show(name, { silent = false, history: historyMode = 'push' } = {}) {
  if (!VIEWS.includes(name)) return;
  currentView = name;
  for (const v of VIEWS) {
    const node = $(`view-${v}`);
    if (node) node.hidden = v !== name;
  }
  for (const btn of document.querySelectorAll('.tab-btn')) {
    const active = btn.dataset.view === name;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  }
  if (historyMode !== 'none') {
    const method = historyMode === 'replace' ? 'replaceState' : 'pushState';
    history[method]({ ...(history.state ?? {}), view: name, sheetDepth: 0 }, '', location.href);
  }
  document.querySelector('main')?.scrollTo?.({ top: 0 });
  if (!silent) for (const fn of listeners) fn(name);
}

export const view = () => currentView;
export const onViewChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// ---------------------------------------------------------------------------
// Bottom sheet — the surface every "log something" flow lives in
// ---------------------------------------------------------------------------
let sheetStack = [];
let sheetId = 0;
const focusable = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Enter/Space activation for the few controls that cannot be native buttons. */
export const enterKey = (fn) => (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fn(event);
  }
};

/**
 * Open a bottom sheet. Each depth gets a history entry, so Android Back closes
 * one nested sheet at a time before it navigates away from the current view.
 * @param {{title:string, body:Node, actions?:Node, onClose?:Function}} spec
 */
export function openSheet(spec) {
  sheetStack.push({ ...spec, opener: document.activeElement, id: `sheet-title-${++sheetId}` });
  history.pushState({ ...(history.state ?? {}), sheetDepth: sheetStack.length }, '', location.href);
  renderSheet();
}

export function closeSheet({ all = false, historyMode = 'back' } = {}) {
  const count = all ? sheetStack.length : Math.min(1, sheetStack.length);
  if (!count) return;
  const closed = all ? sheetStack.splice(0) : sheetStack.splice(-1);
  for (const s of closed.slice().reverse()) s.onClose?.();
  renderSheet();
  if (historyMode === 'back') history.go(-count);
  else if (historyMode === 'replace') {
    history.replaceState({ ...(history.state ?? {}), sheetDepth: sheetStack.length }, '', location.href);
  }
  const restore = all ? closed[0]?.opener : closed.at(-1)?.opener;
  if (sheetStack.length) focusSheet(sheetStack.at(-1).lastFocus);
  else if (restore?.isConnected) restore.focus({ preventScroll: true });
}

/** Reconcile the visible sheet stack to a history entry without writing history. */
export function restoreSheetDepth(depth = 0) {
  const target = Math.max(0, Number(depth) || 0);
  if (target >= sheetStack.length) return false;
  while (sheetStack.length > target) closeSheet({ historyMode: 'none' });
  return true;
}

export const sheetDepth = () => sheetStack.length;

function setBackgroundInert(value) {
  for (const node of [$('view-root'), document.querySelector('.topbar'), document.querySelector('.tabbar')]) {
    if (node) node.inert = value;
  }
}

function focusSheet(preferred) {
  const sheet = $('sheet-host')?.querySelector('.sheet');
  const target = preferred?.isConnected ? preferred : sheet?.querySelector(focusable) ?? sheet;
  target?.focus?.({ preventScroll: true });
}

function renderSheet() {
  const host = $('sheet-host');
  const spec = sheetStack.at(-1);
  if (!spec) {
    host.hidden = true;
    fill(host);
    document.body.classList.remove('sheet-open');
    setBackgroundInert(false);
    return;
  }
  const active = document.activeElement;
  const previous = sheetStack.at(-2);
  if (previous && host.contains(active)) previous.lastFocus = active;
  host.hidden = false;
  document.body.classList.add('sheet-open');
  setBackgroundInert(true);
  fill(host,
    el('div.sheet-backdrop', { onclick: () => closeSheet() }),
    el('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': spec.id, tabindex: '-1' },
      el('div.sheet-head', null,
        el('button.icon-btn', {
          onclick: () => closeSheet(),
          'aria-label': sheetStack.length > 1 ? 'Back' : 'Close',
        }, sheetStack.length > 1 ? '‹' : el('span.i', { html: CLOSE_MARK })),
        el('h2', { id: spec.id }, spec.title),
        spec.actions ?? el('span.sheet-spacer')),
      el('div.sheet-body', null, spec.body)),
  );
  queueMicrotask(() => focusSheet(spec.lastFocus));
}

addEventListener('keydown', (event) => {
  if (!sheetStack.length) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSheet(); return; }
  if (event.key !== 'Tab') return;
  const sheet = $('sheet-host')?.querySelector('.sheet');
  const items = [...(sheet?.querySelectorAll(focusable) ?? [])].filter((node) => node.offsetParent !== null);
  if (!items.length) { event.preventDefault(); sheet?.focus(); return; }
  const first = items[0], last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

/** Brief message, optionally with one reversible action. */
export function toast(text, { ms = 2200, action, onAction } = {}) {
  const host = $('toast-host');
  let finished = false;
  let acting = false;
  const dismiss = () => {
    if (finished) return;
    finished = true;
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  };
  const node = el('div.toast', null, el('span', null, text), action && el('button.toast-action', {
    onclick: async (event) => {
      if (finished || acting) return;
      acting = true;
      event.currentTarget.disabled = true;
      try { await onAction?.(); } finally { dismiss(); }
    },
  }, action));
  host.append(node);
  setTimeout(dismiss, ms);
}

/** Formatters used across every screen. */
export const fmt = {
  kcal: (v) => Math.round(v || 0).toLocaleString(),
  g: (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10),
  amount: (v) => (v >= 10 ? Math.round(v) : Math.round(v * 100) / 100),
  servings: (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)),
  date: (key) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
  dayShort: (key) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' }),
};

/** Colours shared by cards and charts, resolved from the stylesheet. */
/**
 * Macro colours, from food pigments rather than a UI palette: beetroot,
 * turmeric, olive, spinach, blackcurrant. These are the literal values of the
 * --m-* tokens in styles.css — charts are drawn into SVG strings that cannot
 * read custom properties, so the two have to be kept in step by hand, and a
 * mismatch shows up as a legend swatch that disagrees with its own bar.
 */
export const MACRO_COLORS = {
  protein: '#8c2c58', carbs: '#a85b0c', fat: '#5e7233', fiber: '#2c6b5c', sugars: '#6b4a9e',
};
/** Meal slots, in the order they are eaten: dawn through night. */
export const SLOT_COLORS = ['#c98a2b', '#a85b0c', '#6b4a9e', '#2c6b5c'];
/**
 * Read a design token as a literal colour.
 *
 * Charts are built as SVG strings and handed to the DOM, so they cannot inherit
 * a custom property for a fill — the value has to be resolved before the string
 * is built. Doing that here means a chart follows the theme instead of carrying
 * a hex that only suits one of them.
 */
export const cssVar = (name, fallback = '') => (
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
);
/** Ink for chart furniture, matched to the theme at call time. */
export const chartInk = () => cssVar('--ink-2', '#5c6874');
