/**
 * Nutrient rendering shared by every screen that shows food numbers: the photo
 * analysis card, the food detail sheet, the meal card and the nutrition page.
 *
 * The exact display rules live here once — calories rounded to whole numbers,
 * macros to one decimal, micronutrients to whole numbers at 10 or more and two
 * decimals below — because those strings are the app's contract with the user
 * and are asserted digit-for-digit by eval/nutrition-e2e.mjs.
 */
import { el, fill, fmt } from './ui.js';
import { MACRO_COLORS } from './ui.js';

/** Macro bars, in the order people read them. */
export const MACRO_ORDER = ['protein', 'carbs', 'fat', 'fiber', 'sugars'];
const MACRO_SET = new Set(['kcal', ...MACRO_ORDER]);

const pctText = (n, suffix) => (n.pctDV != null ? ` · ${Math.round(n.pctDV)}%${suffix}` : '');

/** One macro row: label, proportional bar, value with %DV. */
export function macroRow(n, color) {
  const pct = n.pctDV != null ? Math.min(100, n.pctDV) : Math.min(100, n.value);
  return el('div.macro-row', null,
    el('span', null, n.name),
    el('span.bar', null, el('span.fill', { style: `width:${pct}%;background:${color}` })),
    el('span.val', null, `${n.value.toFixed(1)} ${n.unit}${pctText(n, '')}`));
}

/** One micronutrient row. */
export function microRow(n) {
  const val = n.value >= 10 ? n.value.toFixed(0) : n.value.toFixed(2);
  return el('div.micro-row', null,
    el('span', null, n.name),
    el('span.dv', null, `${val} ${n.unit}${pctText(n, ' DV')}`));
}

/**
 * Fill a nutrition card: calories hero, macro bars, micronutrient table.
 * @param {Object} nodes  { card, tag, kcal, range, macros, micros }
 * @param {Record<string, {value:number, unit:string, name:string, pctDV:number|null}>} nutrients
 * @param {{kcalRange?:string, confText?:string, confWarn?:boolean}} [opts]
 */
export function fillNutritionCard(nodes, nutrients, { kcalRange = '', confText, confWarn = false } = {}) {
  nodes.card.hidden = false;
  if (nodes.tag) {
    nodes.tag.textContent = confText ?? '';
    nodes.tag.className = confWarn ? 'tag warn' : 'tag';
  }
  const kcal = nutrients.kcal;
  nodes.kcal.textContent = kcal ? Math.round(kcal.value) : '–';
  if (nodes.range) nodes.range.textContent = kcalRange;

  fill(nodes.macros, MACRO_ORDER.filter((k) => nutrients[k]).map((k) => macroRow(nutrients[k], MACRO_COLORS[k])));
  fill(nodes.micros, Object.entries(nutrients).filter(([k]) => !MACRO_SET.has(k)).map(([, n]) => microRow(n)));
}

/** Compact "289 kcal · P 12 · C 33 · F 12 g" line for list rows. */
export function macroSummary(nutrients) {
  const g = (k) => Math.round(nutrients?.[k]?.value ?? nutrients?.[k] ?? 0);
  return `P ${g('protein')} · C ${g('carbs')} · F ${g('fat')} g`;
}

/**
 * Day/week nutrient table with goals — the Nutrients tab.
 * @param {Record<string,number>} totals  absolute amounts
 * @param {Record<string,{name:string,unit:string,rdi:number|null}>} meta
 * @param {(key:string, meta:object)=>number|null} goalFor
 * @param {{days?:number}} [opts] days > 1 multiplies the daily goal
 */
export function nutrientGoalTable(totals, meta, goalFor, { days = 1 } = {}) {
  const rows = [];
  for (const [key, m] of Object.entries(meta)) {
    const total = totals[key] ?? 0;
    const goal = goalFor(key, m);
    const target = goal != null ? goal * days : null;
    const pct = target ? total / target * 100 : null;
    rows.push(el('tr', { class: pct != null && pct >= 100 ? 'hit' : null },
      el('th', { scope: 'row' }, m.name),
      el('td', null, `${fmt.amount(total)} ${m.unit}`),
      el('td', null, target ? `${fmt.amount(target)} ${m.unit}` : '—'),
      el('td.pct', null, pct != null ? `${Math.round(pct)}%` : '—'),
      el('td.meter', null, el('span.meter-track', null,
        el('span.meter-fill', {
          style: `width:${Math.min(100, pct ?? 0)}%;background:${pct >= 100 ? 'var(--good)' : 'var(--accent)'}`,
        })))));
  }
  return el('table.nutrient-table', null,
    el('thead', null, el('tr', null,
      el('th', { scope: 'col' }, 'Nutrient'),
      el('th', { scope: 'col' }, 'Total'),
      el('th', { scope: 'col' }, 'Goal'),
      el('th', { scope: 'col' }, '%'),
      el('th', { scope: 'col' }, ''))),
    el('tbody', null, rows));
}
