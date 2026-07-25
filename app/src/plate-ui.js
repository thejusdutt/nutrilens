/**
 * The plate editor: the list of dishes found in a photo, and the controls for
 * putting them right.
 *
 * This screen is read as a *result*, not filled in as a form, so it is built
 * around one idea: every number on it is a guess, and correcting a guess must
 * be faster than typing the answer. That means the dish name is a button, not
 * a dropdown; portions move in servings people recognise ("1 dosa") with grams
 * shown alongside; and a guess the model is unsure of says so, in place, with
 * the fix one tap away.
 */
import { el, fill, fmt, openSheet, closeSheet } from './ui.js';
import { food as foodById, servingsFor, search } from './foods.js';
import { bestServing, niceCount, stepFor } from './servings.js';

/** Below this fused probability a dish is flagged for the user to confirm. */
const UNSURE_BELOW = 0.5;

/** Per-dish colours, matching the numbered badges drawn on the photo. */
export const REGION_COLORS = [
  [46, 204, 113], [79, 142, 247], [232, 161, 60], [224, 93, 123], [176, 111, 216], [52, 199, 190],
];
export const rgbOf = (i) => `rgb(${REGION_COLORS[i % REGION_COLORS.length].join(',')})`;

const kcalOf = (id, grams) => Math.round(((foodById(id)?.per100g?.kcal ?? 0) * grams) / 100);

/**
 * Render the dish list.
 *
 * @param {HTMLElement} host
 * @param {{items:object[]}} plate
 * @param {Object} hooks
 * @param {() => void} hooks.onChanged        totals/overlay need redrawing
 * @param {(item:object) => number} hooks.reestimate  grams for a newly-named dish
 */
export function renderPlate(host, plate, hooks) {
  fill(host, plate.items.map((it, i) => dishRow(it, i, plate, hooks)));
}

function dishRow(it, i, plate, hooks) {
  const foodRecord = foodById(it.id);
  const name = foodRecord?.name ?? it.id;
  const unsure = it.prob < UNSURE_BELOW;

  const kcalEl = el('span.dish-kcal', null, `${fmt.kcal(kcalOf(it.id, it.grams))} kcal`);
  let row;
  const refresh = () => {
    kcalEl.textContent = `${fmt.kcal(kcalOf(it.id, it.grams))} kcal`;
    // Mirror the weight onto the row so the DOM never disagrees with the
    // state behind it — the plate is the one screen where a stale number is
    // the whole failure mode.
    if (row) row.dataset.grams = String(Math.round(it.grams));
    hooks.onChanged();
  };

  const rename = () => openFixSheet(it, {
    onPick: (id) => {
      it.id = id;
      it.prob = 1;
      it.grams = hooks.reestimate(it);
      hooks.onChanged({ rerender: true });
    },
  });

  row = el('div.dish', { style: `--dish: ${rgbOf(i)}`, dataset: { id: it.id, grams: Math.round(it.grams) } },
    el('span.dish-pin', { 'aria-hidden': 'true' }, i + 1),
    el('div.dish-main', null,
      el('button.dish-name', {
        onclick: rename,
        title: 'Change this dish',
      }, el('span', null, name), el('span.dish-swap', { 'aria-hidden': 'true' }, '⇄')),
      portionControl(it, foodRecord, refresh),
      unsure && el('button.dish-flag', {
        onclick: rename,
        title: `${Math.round(it.prob * 100)}% sure`,
      }, 'Not sure — check this'),
    ),
    el('div.dish-right', null,
      kcalEl,
      el('button.dish-del', {
        'aria-label': `Remove ${name}`,
        onclick: () => {
          plate.items.splice(i, 1);
          hooks.onChanged({ rerender: true });
        },
      }, '✕')),
  );
  return row;
}

/**
 * Servings stepper with the gram weight alongside, and a direct-entry mode for
 * anyone who weighed it. Stepping by serving is what makes a wrong portion a
 * one-tap fix instead of arithmetic.
 */
function portionControl(it, foodRecord, refresh) {
  const wrap = el('div.portion-ctl');

  const draw = () => {
    const unit = bestServing(servingsFor(foodRecord), it.grams, foodRecord?.name);
    const inc = stepFor(unit.count);
    // Step from the *displayed* count, not the raw one, so the number on screen
    // moves by exactly the amount the button promised.
    const shown = Math.round(unit.count * 4) / 4;
    const step = (delta) => {
      it.grams = Math.min(2000, Math.max(1, Math.round((shown + delta) * unit.grams)));
      draw();
      refresh();
    };

    fill(wrap,
      el('button.step', { onclick: () => step(-inc), 'aria-label': 'Smaller portion' }, '−'),
      el('button.portion-read', {
        onclick: () => openGramEntry(it, () => { draw(); refresh(); }),
        title: 'Enter an exact weight',
      },
      el('b', null, `${niceCount(unit.count)} ${unit.label}`),
      el('span.portion-g', null, `${Math.round(it.grams)} g`)),
      el('button.step', { onclick: () => step(inc), 'aria-label': 'Bigger portion' }, '+'),
    );
  };
  draw();
  return wrap;
}

function openGramEntry(it, done) {
  const input = el('input.grams-input', {
    type: 'number', min: 1, max: 2000, step: 1, value: Math.round(it.grams),
    inputmode: 'numeric', 'aria-label': 'Weight in grams',
  });
  const apply = () => {
    const v = Number(input.value);
    if (v > 0) it.grams = Math.min(2000, v);
    closeSheet();
    done();
  };
  openSheet({
    title: `How much ${foodById(it.id)?.name ?? 'food'}?`,
    body: el('div.gram-sheet', null,
      el('label.field', null, el('span', null, 'Weight'), el('div.gram-row', null, input, el('span', null, 'g'))),
      el('p.muted', null, 'Weighing beats guessing. If you did not weigh it, the serving stepper is close enough.'),
      el('button.primary.wide', { onclick: apply }, 'Use this weight')),
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
}

/**
 * "What is this?" — the alternatives the model actually considered, each
 * priced at the current portion so the consequence of the choice is visible,
 * plus a search over every food the app knows.
 *
 * The same sheet adds a dish the scan missed: pass an item with no candidates
 * and a title of "Add a dish".
 */
export function openFixSheet(it, { onPick, title = 'What is this?', intro }) {
  const results = el('div.fix-list');
  const pick = (id) => { closeSheet(); onPick(id); };

  const row = (id, label, sub) => el('button.fix-row', { onclick: () => pick(id) },
    el('div.fix-text', null, el('b', null, label), sub && el('span.muted', null, sub)),
    el('span.fix-kcal', null, `${fmt.kcal(kcalOf(id, it.grams))} kcal`));

  const alternatives = [];
  const seen = new Set();
  for (const c of it.candidates ?? []) {
    if (seen.has(c.id) || c.id === it.id) continue;
    const f = foodById(c.id);
    if (!f) continue;
    seen.add(c.id);
    alternatives.push(row(c.id, f.name, `${Math.round(c.prob * 100)}% match`));
    if (alternatives.length >= 5) break;
  }

  const input = el('input', {
    type: 'search', placeholder: 'Search every food…', autocomplete: 'off',
    oninput: (e) => {
      const q = e.target.value.trim();
      if (q.length < 2) { fill(results, alternatives); return; }
      const hits = search(q, { limit: 20 }).filter((h) => foodById(h.id));
      fill(results, hits.length
        ? hits.map((h) => row(h.id, h.name, h.brand))
        : el('p.muted.empty', null, `Nothing matches “${q}”. Try a simpler word.`));
    },
  });

  fill(results, alternatives.length ? alternatives : el('p.muted.empty', null, 'Search for the food below.'));
  openSheet({
    title,
    body: el('div.fix-sheet', null,
      el('p.muted', null, intro ?? `Currently logged as ${foodById(it.id)?.name ?? it.id}, ${Math.round(it.grams)} g.`),
      input,
      results),
  });
}

/**
 * Add a dish the scan missed. It gets that food's typical serving, which the
 * stepper then adjusts — there is no mask to measure, and pretending otherwise
 * would be inventing precision.
 */
export function openAddDish(onAdd) {
  openFixSheet({ id: null, grams: 100, candidates: [] }, {
    title: 'Add a dish',
    intro: 'Anything the scan missed — it starts at a typical serving, then step it to size.',
    onPick: onAdd,
  });
}
