/**
 * The "log food" flow, modelled on how a food tracker actually gets used:
 *
 *   pick a meal → find the food (search, recent, frequent, my foods, my meals,
 *   recipes, barcode, photo, quick add) → choose a serving and how many →
 *   add to the diary.
 *
 * Serving size and serving count are separate fields on purpose. "2 × 1 slice"
 * is how people describe food; grams are derived. Logging the same food again
 * reuses the serving you chose last time, so the second day of tracking is much
 * faster than the first.
 */
import { makeEntry, rankRecent, rankFrequent, normalizeEntry, SLOTS, SLOT_LABEL } from '@nutrilens/diary';
import { $, el, fill, fmt, openSheet, closeSheet, toast, emit, MACRO_COLORS } from './ui.js';
import { food as foodById, search as searchFoods, servingsFor, nutrients, kcalFor, listMyFoods, listMyMeals, listMyRecipes, upsertCustomFood, upsertSavedMeal, per100gFromLabel, nutrientMeta } from './foods.js';
import { saveMeal, listMeals, dateKey, updateMeal } from './db.js';
import { macroRow, macroSummary } from './nutrients-ui.js';
import { openBarcodeScanner } from './barcode-scan.js';

/** Remembered serving choice per food, so repeat logging is one tap. */
const lastServing = new Map();

const LOG_TABS = [
  { id: 'all', label: 'Search' },
  { id: 'recent', label: 'Recent' },
  { id: 'frequent', label: 'Frequent' },
  { id: 'foods', label: 'My foods' },
  { id: 'meals', label: 'My meals' },
  { id: 'recipes', label: 'Recipes' },
];

/**
 * Open the log-food sheet.
 * @param {{date:string, slot:string, onPhoto?:Function}} p
 */
export async function openLogFood({ date, slot, onPhoto }) {
  const state = { date, slot, tab: 'all', query: '' };
  const history = (await listMeals(600)).map(normalizeEntry);

  const results = el('div.food-results');
  const searchInput = el('input', {
    type: 'search', placeholder: 'Search foods, brands, your recipes…',
    autocomplete: 'off', enterkeyhint: 'search',
    oninput: (e) => { state.query = e.target.value; render(); },
  });

  const slotSelect = el('select.slot-select', {
    'aria-label': 'Meal',
    onchange: (e) => { state.slot = e.target.value; },
  }, SLOTS.map((s) => el('option', { value: s, selected: s === state.slot }, SLOT_LABEL[s])));

  const tabs = el('div.tabs', { role: 'tablist' }, LOG_TABS.map((t) => el('button.tab', {
    role: 'tab', dataset: { tab: t.id }, 'aria-selected': t.id === state.tab,
    onclick: () => { state.tab = t.id; render(); },
  }, t.label)));

  function render() {
    for (const btn of tabs.children) {
      const on = btn.dataset.tab === state.tab;
      btn.setAttribute('aria-selected', on);
      btn.classList.toggle('active', on);
    }
    const rows = rowsFor(state, history);
    fill(results, rows.length ? rows : el('p.muted.empty', null, emptyText(state)));
  }

  const log = (id, opts) => openFoodDetail({ ...opts, foodId: id, date: state.date, slot: state.slot });

  /** What to say when a tab has nothing in it — each emptiness has its own cause. */
  function emptyText(s) {
    if (s.tab === 'all') {
      return s.query.trim().length >= 2
        ? `No food matches “${s.query.trim()}”. Try fewer words, scan a barcode, or create the food.`
        : 'Search the food database, or pick something you have logged before.';
    }
    return {
      recent: 'Nothing logged yet — what you eat will show up here for one-tap repeats.',
      frequent: 'No favourites yet. Foods you log often will appear here first.',
      foods: 'No foods of your own yet. “＋ New food” builds one from a nutrition label.',
      meals: 'No saved meals yet. Save one from a day’s ⋯ menu to log it again in a tap.',
      recipes: 'No recipes yet. A recipe splits its ingredients into servings.',
    }[s.tab];
  }

  function rowsFor(s, log0) {
    if (s.tab === 'all') {
      if (s.query.trim().length < 2) {
        return rankRecent(log0, { limit: 12 }).map((r) => historyRow(r.entry, s, 'Recent'));
      }
      return searchFoods(s.query, { limit: 40 }).map((hit) => foodRow(hit, s));
    }
    if (s.tab === 'recent') return rankRecent(log0, { limit: 40 }).map((r) => historyRow(r.entry, s, 'Recent'));
    if (s.tab === 'frequent') {
      return rankFrequent(log0, { limit: 40 }).map((r) => historyRow(r.entry, s, `${r.count}× logged`));
    }
    if (s.tab === 'foods') {
      return listMyFoods().map((f) => foodRow({ id: f.id, name: f.name, brand: f.brand, kind: 'custom' }, s));
    }
    if (s.tab === 'meals') {
      return listMyMeals().map((m) => foodRow({ id: m.id, name: m.name, brand: `${m.items.length} items`, kind: 'meal' }, s));
    }
    return listMyRecipes().map((m) => foodRow({ id: m.id, name: m.name, brand: `${m.servings} servings`, kind: 'recipe' }, s));
  }

  /** A database / custom / product / meal hit. */
  function foodRow(hit, s) {
    const f = foodById(hit.id);
    if (!f) return null;
    const choice = lastServing.get(hit.id) ?? servingsFor(f)[0];
    const kcal = kcalFor(f, choice.grams * (choice.servings ?? 1));
    return el('button.food-row', { onclick: () => log(hit.id, { slot: s.slot }) },
      el('span.fr-main', null,
        el('b', null, f.name),
        el('span.muted', null, [f.brand, `${fmt.servings(choice.servings ?? 1)} × ${choice.label}`].filter(Boolean).join(' · '))),
      el('span.fr-kcal', null, `${fmt.kcal(kcal)} kcal`),
      el('span.fr-add', {
        role: 'button', tabindex: '0', title: 'Log this serving',
        onclick: (e) => { e.stopPropagation(); quickLog(hit.id, choice, s); },
        onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); quickLog(hit.id, choice, s); } },
      }, '＋'));
  }

  /** A row rebuilt from something already logged — one tap repeats it exactly. */
  function historyRow(entry, s, note) {
    const f = entry.foodId ? foodById(entry.foodId) : null;
    return el('button.food-row', {
      onclick: () => (f
        ? log(entry.foodId, { slot: s.slot, servingLabel: entry.servingLabel, servingGrams: entry.servingGrams, servings: entry.servings })
        : repeatOrphan(entry, s)),
    },
    el('span.fr-main', null,
      el('b', null, entry.foodName),
      el('span.muted', null, [note, `${fmt.servings(entry.servings)} × ${entry.servingLabel}`].filter(Boolean).join(' · '))),
    el('span.fr-kcal', null, `${fmt.kcal(entry.kcal)} kcal`),
    el('span.fr-add', {
      role: 'button', tabindex: '0', title: 'Log again',
      onclick: (e) => { e.stopPropagation(); repeatEntry(entry, s); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); repeatEntry(entry, s); } },
    }, '＋'));
  }

  async function quickLog(id, choice, s) {
    const f = foodById(id);
    const grams = choice.grams * (choice.servings ?? 1);
    const r = nutrients(f, grams);
    await addEntry(makeEntry({
      foodId: id, foodName: f.name, brand: f.brand, date: s.date, slot: s.slot,
      servingLabel: choice.label, servingGrams: choice.grams, servings: choice.servings ?? 1,
      nutrients: r.nutrients, source: f.kind === 'product' ? 'barcode' : 'search', ts: Date.now(),
    }));
    lastServing.set(id, choice);
    toast(`${f.name} added to ${s.slot}`);
  }

  const repeatEntry = async (entry, s) => {
    await addEntry({ ...entry, id: undefined, date: s.date, slot: s.slot, ts: Date.now() });
    toast(`${entry.foodName} added to ${s.slot}`);
  };
  const repeatOrphan = (entry, s) => openSheet({
    title: entry.foodName,
    body: el('div.stack', null,
      el('p.muted', null, 'This entry was logged from a food that is no longer stored. You can log it again exactly as it was.'),
      el('p', null, `${fmt.servings(entry.servings)} × ${entry.servingLabel} · ${fmt.kcal(entry.kcal)} kcal`),
      el('button.primary.wide', { onclick: () => { repeatEntry(entry, s); closeSheet(); } }, 'Log again')),
  });

  render();

  openSheet({
    title: 'Add food',
    body: el('div.logfood', null,
      el('div.logfood-head', null,
        slotSelect,
        el('input', { type: 'date', value: state.date, 'aria-label': 'Date', onchange: (e) => { state.date = e.target.value || state.date; } })),
      searchInput,
      el('div.log-actions', null,
        el('button', { onclick: () => { closeSheet({ all: true }); onPhoto?.(state); } }, '📷 Photo'),
        el('button', { onclick: () => openBarcodeScanner({ date: state.date, slot: state.slot }) }, '🔎 Barcode'),
        el('button', { onclick: () => openQuickAdd({ date: state.date, slot: state.slot }) }, '⚡ Quick add'),
        el('button', { onclick: () => openCreateFood({ onSaved: (id) => log(id, { slot: state.slot }) }) }, '＋ New food')),
      tabs,
      results),
  });
}

/** Persist an entry and tell the app. */
export async function addEntry(entry) {
  await saveMeal(entry);
  emit('diary', { date: entry.date });
  return entry;
}

/**
 * Food detail: choose serving, count, meal and date, see the numbers, add it.
 * Also used to edit an existing entry (`entryId`), which is the same screen with
 * a different verb — as it should be.
 */
export function openFoodDetail({ foodId, date, slot, servingLabel, servingGrams, servings = 1, entryId, entry }) {
  const f = foodById(foodId) ?? (entry ? orphanFood(entry) : null);
  if (!f) { toast('That food is no longer available'); return; }
  const options = servingsFor(f);
  const state = {
    date, slot,
    servings: Number(servings) || 1,
    choice: options.find((o) => o.label === servingLabel) ?? { label: servingLabel ?? options[0].label, grams: servingGrams ?? options[0].grams },
  };
  if (!options.some((o) => o.label === state.choice.label)) options.unshift(state.choice);

  const summary = el('div.detail-summary');
  const macros = el('div.macro-bars');

  const servingSelect = el('select', {
    'aria-label': 'Serving size', id: 'detail-serving',
    onchange: (e) => {
      const opt = options[Number(e.target.value)];
      if (opt) state.choice = opt;
      update();
    },
  }, options.map((o, i) => el('option', { value: String(i), selected: o.label === state.choice.label }, `${o.label} (${fmt.amount(o.grams)} g)`)));

  const servingsInput = el('input', {
    type: 'number', min: '0.1', step: '0.5', value: String(state.servings),
    id: 'detail-servings', 'aria-label': 'Number of servings',
    oninput: (e) => { state.servings = Math.max(0.01, Number(e.target.value) || 0); update(); },
  });

  function update() {
    const grams = state.choice.grams * state.servings;
    const r = nutrients(f, grams);
    fill(summary,
      el('div.ds-kcal', null, el('b', null, fmt.kcal(r.nutrients.kcal?.value ?? 0)), ' kcal'),
      el('div.muted', null, `${fmt.amount(grams)} g · ${macroSummary(r.nutrients)}`));
    fill(macros, ['protein', 'carbs', 'fat'].filter((k) => r.nutrients[k]).map((k) => macroRow(r.nutrients[k], MACRO_COLORS[k])));
  }
  update();

  const save = async () => {
    const grams = state.choice.grams * state.servings;
    const r = nutrients(f, grams);
    const built = makeEntry({
      foodId: f.id, foodName: f.name, brand: f.brand, date: state.date, slot: state.slot,
      servingLabel: state.choice.label, servingGrams: state.choice.grams, servings: state.servings,
      nutrients: r.nutrients, source: entry?.source ?? (f.kind === 'product' ? 'barcode' : 'search'),
      thumb: entry?.thumb ?? null, ts: entry?.ts ?? Date.now(),
    });
    if (entryId) {
      await updateMeal(entryId, built);
      emit('diary', { date: state.date });
      toast('Entry updated');
    } else {
      await addEntry(built);
      lastServing.set(f.id, { label: state.choice.label, grams: state.choice.grams, servings: state.servings });
      toast(`${f.name} added to ${state.slot}`);
    }
    closeSheet({ all: true });
  };

  openSheet({
    title: entryId ? 'Edit entry' : f.name,
    actions: el('button.sheet-save', { onclick: save }, entryId ? 'Save' : 'Add'),
    body: el('div.stack.detail', null,
      el('div.detail-title', null,
        el('b', null, f.name),
        f.brand && el('span.muted', null, f.brand),
        f.source && el('span.muted.tiny', null, f.source)),
      el('label', { for: 'detail-serving' }, 'Serving size'), servingSelect,
      el('label', { for: 'detail-servings' }, 'Number of servings'), servingsInput,
      el('div.row2', null,
        el('label', null, 'Meal', el('select', {
          onchange: (e) => { state.slot = e.target.value; },
        }, SLOTS.map((s) => el('option', { value: s, selected: s === state.slot }, SLOT_LABEL[s])))),
        el('label', null, 'Date', el('input', {
          type: 'date', value: state.date, onchange: (e) => { state.date = e.target.value || state.date; },
        }))),
      summary,
      macros,
      f.items && el('button.wide', {
        onclick: async () => {
          // A saved meal can go in as separate lines, which is what you want when
          // you ate most of it but not all — each part stays editable.
          for (const it of f.items) {
            const itemFood = foodById(it.id) ?? { name: it.name, per100g: it.per100g ?? {}, id: it.id };
            const r = nutrients(itemFood, it.grams * state.servings);
            if (!r) continue;
            await addEntry(makeEntry({
              foodId: it.id, foodName: it.name ?? itemFood.name, date: state.date, slot: state.slot,
              servingLabel: `${fmt.amount(it.grams)} g`, servingGrams: it.grams, servings: state.servings,
              nutrients: r.nutrients, source: f.kind === 'recipe' ? 'recipe' : 'meal', ts: Date.now(),
            }));
          }
          toast(`${f.items.length} items added`);
          closeSheet({ all: true });
        },
      }, 'Add items separately'),
      el('button.primary.wide', { onclick: save }, entryId ? 'Save changes' : `Add to ${state.slot}`)),
  });
}

/** An entry whose food is gone: rebuild a food record from the entry itself. */
function orphanFood(entry) {
  const e = normalizeEntry(entry);
  const per100g = {};
  if (e.grams > 0) for (const [k, v] of Object.entries(e.nutrients ?? {})) per100g[k] = v / e.grams * 100;
  return { id: e.foodId ?? `orphan:${e.foodName}`, name: e.foodName, brand: e.brand, per100g, portions: [[e.servingLabel, e.servingGrams]] };
}

/**
 * Quick add: calories now, details never. The escape hatch for restaurant food,
 * someone else's cooking, and everything a database will never contain.
 */
export function openQuickAdd({ date, slot }) {
  const fields = {
    kcal: el('input', { type: 'number', min: '0', step: '5', id: 'qa-kcal', placeholder: '0', inputmode: 'numeric' }),
    protein: el('input', { type: 'number', min: '0', step: '1', placeholder: '0', inputmode: 'decimal' }),
    carbs: el('input', { type: 'number', min: '0', step: '1', placeholder: '0', inputmode: 'decimal' }),
    fat: el('input', { type: 'number', min: '0', step: '1', placeholder: '0', inputmode: 'decimal' }),
  };
  const name = el('input', { type: 'text', placeholder: 'Quick add', maxlength: '60' });
  const slotSel = el('select', null, SLOTS.map((s) => el('option', { value: s, selected: s === slot }, SLOT_LABEL[s])));

  const save = async () => {
    const kcal = Number(fields.kcal.value) || 0;
    if (kcal <= 0) { toast('Enter some calories first'); fields.kcal.focus(); return; }
    const nutrientAmounts = { kcal };
    for (const k of ['protein', 'carbs', 'fat']) {
      const v = Number(fields[k].value);
      if (v > 0) nutrientAmounts[k] = v;
    }
    await addEntry(makeEntry({
      foodName: name.value.trim() || 'Quick add', date, slot: slotSel.value,
      servingLabel: 'quick add', servingGrams: 0, servings: 1,
      nutrients: nutrientAmounts, source: 'quick', ts: Date.now(),
    }));
    toast(`${fmt.kcal(kcal)} kcal added`);
    closeSheet({ all: true });
  };

  openSheet({
    title: 'Quick add',
    body: el('div.stack', null,
      el('label', { for: 'qa-kcal' }, 'Calories'), fields.kcal,
      el('div.row3', null,
        el('label', null, 'Protein (g)', fields.protein),
        el('label', null, 'Carbs (g)', fields.carbs),
        el('label', null, 'Fat (g)', fields.fat)),
      el('label', null, 'Description', name),
      el('label', null, 'Meal', slotSel),
      el('p.muted.tiny', null, 'Macros are optional — calories alone still count toward your day.'),
      el('button.primary.wide', { onclick: save }, 'Add to diary')),
  });
}

const NUTRIENT_FIELDS = [
  ['kcal', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'],
  ['fat', 'Fat', 'g'], ['satFat', 'Saturated fat', 'g'], ['fiber', 'Fibre', 'g'],
  ['sugars', 'Sugars', 'g'], ['sodium', 'Sodium', 'mg'], ['potassium', 'Potassium', 'mg'],
  ['cholesterol', 'Cholesterol', 'mg'], ['calcium', 'Calcium', 'mg'], ['iron', 'Iron', 'mg'],
];

/**
 * Create (or edit) a food from a nutrition label. Values are entered per serving,
 * exactly as the packet states them, and converted to per-100 g once here.
 */
export function openCreateFood({ onSaved, existing, prefill } = {}) {
  const src = existing ?? prefill ?? {};
  const name = el('input', { type: 'text', required: true, id: 'cf-name', value: src.name ?? '', placeholder: 'e.g. Amul masala chaas' });
  const brand = el('input', { type: 'text', value: src.brand ?? '', placeholder: 'Brand (optional)' });
  const servingLabel = el('input', { type: 'text', value: src.portions?.[0]?.[0] ?? '1 serving', id: 'cf-serving' });
  const servingGrams = el('input', { type: 'number', min: '0.1', step: '0.1', id: 'cf-grams', value: String(src.portions?.[0]?.[1] ?? 100) });
  const inputs = {};
  const perServing = existing ? servingAmounts(existing) : {};
  for (const [key] of NUTRIENT_FIELDS) {
    inputs[key] = el('input', {
      type: 'number', min: '0', step: '0.1', inputmode: 'decimal',
      value: perServing[key] != null ? String(perServing[key]) : (key === 'kcal' && prefill?.kcal ? String(prefill.kcal) : ''),
      placeholder: '0',
    });
  }

  const save = async () => {
    const grams = Number(servingGrams.value);
    if (!name.value.trim()) { toast('Give the food a name'); name.focus(); return; }
    if (!(grams > 0)) { toast('Serving weight must be more than 0 g'); servingGrams.focus(); return; }
    const amounts = {};
    for (const [key] of NUTRIENT_FIELDS) {
      const v = Number(inputs[key].value);
      if (Number.isFinite(v) && v > 0) amounts[key] = v;
    }
    if (!(amounts.kcal > 0)) { toast('Calories per serving are required'); inputs.kcal.focus(); return; }
    const id = await upsertCustomFood({
      id: existing?.storageId,
      name: name.value.trim(),
      brand: brand.value.trim() || null,
      per100g: per100gFromLabel(amounts, grams),
      portions: [[servingLabel.value.trim() || '1 serving', grams]],
      prior: { servingG: grams },
    });
    emit('foods');
    toast(existing ? 'Food updated' : 'Food created');
    closeSheet();
    onSaved?.(id);
  };

  openSheet({
    title: existing ? 'Edit food' : 'Create a food',
    body: el('div.stack', null,
      el('label', { for: 'cf-name' }, 'Name'), name,
      brand,
      el('div.row2', null,
        el('label', { for: 'cf-serving' }, 'Serving', servingLabel),
        el('label', { for: 'cf-grams' }, 'Weight (g)', servingGrams)),
      el('p.muted.tiny', null, 'Enter the numbers per serving, straight off the label.'),
      el('div.label-grid', null, NUTRIENT_FIELDS.map(([key, label, unit]) => el('label', null, `${label} (${unit})`, inputs[key]))),
      el('button.primary.wide', { onclick: save }, existing ? 'Save food' : 'Create food')),
  });
}

/** Per-serving amounts of a stored custom food, for the edit form. */
function servingAmounts(f) {
  const grams = f.portions?.[0]?.[1] ?? 100;
  const out = {};
  for (const [k, v] of Object.entries(f.per100g ?? {})) out[k] = Math.round(v * grams / 100 * 100) / 100;
  return out;
}

/**
 * Build a saved meal or a recipe from parts. The only difference is division:
 * a meal is eaten whole, a recipe splits into the servings it made.
 */
export function openMealBuilder({ kind = 'meal', existing, seedItems = [], onSaved } = {}) {
  const state = {
    name: existing?.name ?? '',
    servings: existing?.servings ?? (kind === 'recipe' ? 4 : 1),
    items: existing?.items ? [...existing.items] : [...seedItems],
  };
  const list = el('div.builder-items');
  const totals = el('div.detail-summary');

  const searchBox = el('input', { type: 'search', placeholder: 'Add an ingredient…', autocomplete: 'off' });
  const searchOut = el('div.food-results.compact');
  searchBox.oninput = () => {
    const q = searchBox.value.trim();
    if (q.length < 2) { fill(searchOut); return; }
    fill(searchOut, searchFoods(q, { limit: 8 }).map((hit) => {
      const f = foodById(hit.id);
      if (!f || f.items) return null; // no meals inside meals
      const choice = servingsFor(f)[0];
      return el('button.food-row', {
        onclick: () => {
          const r = nutrients(f, choice.grams);
          state.items.push({ id: f.id, name: f.name, grams: choice.grams, nutrients: flatten(r.nutrients) });
          searchBox.value = ''; fill(searchOut); renderItems();
        },
      }, el('span.fr-main', null, el('b', null, f.name), el('span.muted', null, `${choice.label} · ${kcalFor(f, choice.grams)} kcal`)),
      el('span.fr-add', null, '＋'));
    }));
  };

  function renderItems() {
    fill(list, state.items.length
      ? state.items.map((it, i) => el('div.builder-item', null,
        el('span.bi-name', null, it.name),
        el('input.bi-grams', {
          type: 'number', min: '1', step: '5', value: String(it.grams), 'aria-label': `${it.name} grams`,
          oninput: (e) => {
            const grams = Math.max(1, Number(e.target.value) || 0);
            const f = foodById(it.id);
            const r = f ? nutrients(f, grams) : null;
            state.items[i] = { ...it, grams, nutrients: r ? flatten(r.nutrients) : scaleFlat(it, grams) };
            renderTotals();
          },
        }),
        el('span.muted', null, 'g'),
        el('button.mi-del', { title: 'Remove', onclick: () => { state.items.splice(i, 1); renderItems(); } }, '✕')))
      : el('p.muted.empty', null, 'No ingredients yet — search above to add some.'));
    renderTotals();
  }

  function renderTotals() {
    const n = Math.max(1, state.servings);
    const sum = {};
    let grams = 0;
    for (const it of state.items) {
      grams += it.grams;
      for (const [k, v] of Object.entries(it.nutrients ?? {})) sum[k] = (sum[k] ?? 0) + v;
    }
    fill(totals,
      el('div.ds-kcal', null, el('b', null, fmt.kcal((sum.kcal ?? 0) / n)), ' kcal per serving'),
      el('div.muted', null, `${fmt.amount(grams / n)} g per serving · ${fmt.kcal(sum.kcal ?? 0)} kcal total`));
  }
  renderItems();

  const nameInput = el('input', { type: 'text', id: 'mb-name', value: state.name, placeholder: kind === 'recipe' ? 'e.g. Sunday dal' : 'e.g. My usual breakfast', oninput: (e) => { state.name = e.target.value; } });
  const servingsInput = el('input', {
    type: 'number', min: '1', step: '1', value: String(state.servings), id: 'mb-servings',
    oninput: (e) => { state.servings = Math.max(1, Number(e.target.value) || 1); renderTotals(); },
  });

  const save = async () => {
    if (!state.name.trim()) { toast('Give it a name'); nameInput.focus(); return; }
    if (!state.items.length) { toast('Add at least one ingredient'); return; }
    const id = await upsertSavedMeal({
      id: existing?.storageId, kind, name: state.name.trim(),
      servings: kind === 'recipe' ? state.servings : 1, items: state.items,
    });
    emit('foods');
    toast(kind === 'recipe' ? 'Recipe saved' : 'Meal saved');
    closeSheet();
    onSaved?.(id);
  };

  openSheet({
    title: existing ? `Edit ${kind}` : (kind === 'recipe' ? 'Create a recipe' : 'Create a meal'),
    body: el('div.stack', null,
      el('label', { for: 'mb-name' }, 'Name'), nameInput,
      kind === 'recipe' && el('label', { for: 'mb-servings' }, 'Servings this makes'),
      kind === 'recipe' && servingsInput,
      searchBox, searchOut,
      list, totals,
      el('button.primary.wide', { onclick: save }, existing ? 'Save changes' : `Save ${kind}`)),
  });
}

const flatten = (nutrientTable) => Object.fromEntries(Object.entries(nutrientTable).map(([k, n]) => [k, Math.round(n.value * 100) / 100]));
const scaleFlat = (item, grams) => Object.fromEntries(Object.entries(item.nutrients ?? {})
  .map(([k, v]) => [k, Math.round(v / (item.grams || 1) * grams * 100) / 100]));

/** Log a food straight to the diary — used by the photo flow and the scanner. */
export async function logFoodDirect({ foodRecord, foodId, date, slot, servingLabel, servingGrams, servings = 1, source, thumb }) {
  const f = foodRecord ?? foodById(foodId);
  const r = nutrients(f, servingGrams * servings);
  return addEntry(makeEntry({
    foodId: foodId ?? f.id, foodName: f.name, brand: f.brand, date: date ?? dateKey(), slot,
    servingLabel, servingGrams, servings, nutrients: r.nutrients, source, thumb, ts: Date.now(),
  }));
}

export { lastServing, nutrientMeta };
