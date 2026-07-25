/**
 * Icons.
 *
 * The app used emoji, which meant its chrome was rendered by the operating
 * system in whatever style and colour that system felt like: a full-colour
 * cartoon plate next to a grey hairline label, differing between a Pixel and
 * an iPhone, and untouchable by the theme. An instrument's markings are drawn
 * to spec, in one stroke weight, in the current text colour.
 *
 * One geometry: 24-unit box, 1.6 stroke, round caps, no fill. `currentColor`
 * throughout, so an icon inherits whatever it sits next to and both themes
 * come free.
 */

import { el } from './ui.js';

const svg = (body, { size = 18, stroke = 1.6 } = {}) => '<svg viewBox="0 0 24 24" '
  + `width="${size}" height="${size}" fill="none" stroke="currentColor" `
  + `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/**
 * One sole — ball of the foot, waist, heel — placed twice by `steps`. Drawn at
 * a comfortable size and scaled into position, so the two feet stay identical.
 */
const SOLE = 'M6.9 3.5c1.7 0 2.7 1.2 2.7 3 0 1.3-.5 2.2-.9 3-.4.8-.6 1.2-.6 1.9 0 .6.3 1.1.3 1.8'
  + ' 0 1.1-.7 1.8-1.5 1.8s-1.5-.7-1.5-1.8c0-.7.3-1.2.3-1.8 0-.7-.2-1.1-.6-1.9-.4-.8-.9-1.7-.9-3'
  + ' 0-1.8 1-3 2.7-3z';

/** Icon bodies, keyed by what the icon *means* here, not by what it depicts. */
const PATHS = {
  // Navigation
  diary: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M9 4v16"/><path d="M12 9h4M12 13h4"/>',
  // Columns, not hairlines. Drawn as single strokes these were three thin lines
  // over a rule, which is what `barcode` also is.
  nutrition: '<rect x="3.4" y="12.5" width="4.6" height="7" rx="1"/>'
    + '<rect x="9.7" y="6" width="4.6" height="13.5" rx="1"/>'
    + '<rect x="16" y="9.5" width="4.6" height="10" rx="1"/>',
  progress: '<path d="M3 17l5-6 4 3 5-8"/><path d="M17 6h4v4"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',

  // Instruments
  camera: '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="12.5" r="3.2"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.4"/><path d="M21 16l-5-4.5L8 19"/>',
  barcode: '<path d="M4 6v12M7.5 6v12M11 6v9M14.5 6v12M18 6v12M20.5 6v9"/>',
  // A bathroom scale seen from above: platform, dial, needle. The balance beam
  // that was here read as scales of justice — the right instrument for weighing
  // an ingredient, the wrong one for the row that asks what you weigh.
  scale: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/>'
    + '<path d="M8.2 14.6a4 4 0 0 1 7.6 0"/><path d="M12 14.6l2.7-2.5"/>',
  // A dumbbell: plates as blocks rather than thin bars, which at 18px read as
  // the letters "IHI" instead of a weight.
  exercise: '<rect x="2.5" y="8.5" width="4" height="7" rx="1.2"/><rect x="17.5" y="8.5" width="4" height="7" rx="1.2"/>'
    + '<path d="M6.5 12h11"/><path d="M21.5 12h1"/><path d="M1.5 12h1"/>',
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>',
  // Faders, not a cog: a small circle ringed by six tick marks dissolves into
  // scattered dots at 18px. Three sliders also say what this screen actually
  // is — values you set, including the calorie and macro goals.
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/>'
    + '<circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
  library: '<path d="M4 5h16v5H4z"/><path d="M4 14h7v5H4z"/><path d="M13 14h7v5h-7z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/>',
  quick: '<path d="M13 3l-8 11h6l-1 7 8-11h-6z"/>',
  water: '<path d="M12 3.5s6 6.2 6 10.2a6 6 0 0 1-12 0C6 9.7 12 3.5 12 3.5z"/>',
  // Two footprints, as a stride. Filled, unlike the rest of the set: outlined at
  // 18px a sole is a hollow ring and the toe bar under it is an underscore, so
  // the pair read as the ordinal marks in "1º 2º" rather than as feet.
  steps: '<g fill="currentColor" stroke="none">'
    + `<g transform="translate(-2.5 -2.8) scale(1.4)"><path d="${SOLE}"/></g>`
    + `<g transform="translate(7.1 .8) scale(1.4)"><path d="${SOLE}"/></g>`
    + '</g>',
  note: '<path d="M5 4h14v11l-4 5H5z"/><path d="M9 9h6M9 13h4"/>',
  flip: '<path d="M20 11a8 8 0 0 0-13.6-4.6L4 9"/><path d="M4 5v4h4"/><path d="M4 13a8 8 0 0 0 13.6 4.6L20 15"/><path d="M20 19v-4h-4"/>',
  keyboard: '<rect x="2.5" y="7" width="19" height="10" rx="2"/><path d="M6 10.5h.01M9.5 10.5h.01M13 10.5h.01M16.5 10.5h.01M7.5 13.5h9"/>',
  save: '<path d="M5 5h11l3 3v11H5z"/><path d="M9 5v5h6V5"/><path d="M9 19v-5h6v5"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  alert: '<path d="M12 4.5l8.5 15H3.5z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  swap: '<path d="M4 8h13"/><path d="M14 5l3 3-3 3"/><path d="M20 16H7"/><path d="M10 13l-3 3 3 3"/>',

  // Meals — the sun climbing, overhead, then gone. Snacks sit outside that
  // sequence because they sit outside the day's shape, so they get a bag.
  breakfast: '<circle cx="12" cy="14" r="3.2"/><path d="M4 19h16"/><path d="M12 7.5v2M6.5 9.5l1.4 1.4M17.5 9.5l-1.4 1.4"/>',
  lunch: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M18 6l-1.6 1.6M7.6 16.4L6 18"/>',
  // A deep crescent. The shallow one — a disc with a nick out of its side —
  // read as a bitten biscuit, which in a food app is a real misreading.
  dinner: '<path d="M20.4 13.4A8.6 8.6 0 1 1 11.2 4.2a6.7 6.7 0 0 0 9.2 9.2z"/>',
  snacks: '<path d="M6 9h12l-1.5 11h-9z"/><path d="M9 9V5.5a3 3 0 0 1 6 0V9"/>',
};

/** @param {keyof PATHS} name @param {{size?:number, stroke?:number}} [opts] */
export const icon = (name, opts) => svg(PATHS[name] ?? '', opts);

/** True when a name exists — used by tests and by the audit script. */
export const hasIcon = (name) => Object.hasOwn(PATHS, name);

export const ICON_NAMES = Object.keys(PATHS);

/**
 * Draw every `<span class="i" data-icon="…">` in the static markup.
 *
 * index.html declares icons by name rather than carrying its own copy of the
 * path data. It used to inline the SVGs, and the two copies promptly drifted:
 * three icons were redrawn here and the markup kept rendering the old shapes.
 *
 * @param {ParentNode} [root=document]
 */
export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    const name = node.dataset.icon;
    if (!hasIcon(name)) { console.warn(`[icons] no icon named "${name}"`); continue; }
    const size = Number(node.dataset.iconSize) || undefined;
    node.innerHTML = icon(name, size ? { size } : undefined);
  }
}

/**
 * The same icon as a node, for the `el()` builder. `html` is safe here and
 * only here: these strings are authored above, never derived from user text.
 */
export const iconEl = (name, opts) => el('span.i', { html: icon(name, opts) });

/** Meal-slot icons, so the diary and the add sheet cannot drift apart. */
export const SLOT_ICON = {
  breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snacks: 'snacks',
};
