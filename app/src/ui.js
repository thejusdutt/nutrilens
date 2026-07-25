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

/** @param {string} name @param {{silent?:boolean}} [opts] */
export function show(name, { silent = false } = {}) {
  currentView = name;
  for (const v of VIEWS) {
    const node = $(`view-${v}`);
    if (node) node.hidden = v !== name;
  }
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.view === name);
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

/**
 * Open a bottom sheet. Sheets stack (search → food detail), and closing one
 * returns to the previous, which is how a food tracker's add-flow behaves.
 * @param {{title:string, body:Node, actions?:Node, onClose?:Function}} spec
 */
export function openSheet(spec) {
  sheetStack.push(spec);
  renderSheet();
}

export function closeSheet({ all = false } = {}) {
  const closed = all ? sheetStack.splice(0) : sheetStack.splice(-1);
  for (const s of closed.reverse()) s.onClose?.();
  renderSheet();
}

export const sheetDepth = () => sheetStack.length;

function renderSheet() {
  const host = $('sheet-host');
  const spec = sheetStack.at(-1);
  if (!spec) {
    host.hidden = true;
    fill(host);
    document.body.classList.remove('sheet-open');
    return;
  }
  host.hidden = false;
  document.body.classList.add('sheet-open');
  fill(host,
    el('div.sheet-backdrop', { onclick: () => closeSheet() }),
    el('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': spec.title },
      el('div.sheet-head', null,
        el('button.icon-btn', {
          onclick: () => closeSheet(),
          'aria-label': sheetStack.length > 1 ? 'Back' : 'Close',
        }, sheetStack.length > 1 ? '‹' : el('span.i', { html: CLOSE_MARK })),
        el('h2', null, spec.title),
        spec.actions ?? el('span.sheet-spacer')),
      el('div.sheet-body', null, spec.body)),
  );
  host.querySelector('.sheet-body input, .sheet-body select, .sheet-body button')?.focus?.({ preventScroll: true });
}

addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetStack.length) { e.preventDefault(); closeSheet(); }
});

/** Brief confirmation message. Non-blocking: logging food should never need an OK button. */
export function toast(text, { ms = 2200 } = {}) {
  const host = $('toast-host');
  const node = el('div.toast', null, text);
  host.append(node);
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 300); }, ms);
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
