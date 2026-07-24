/**
 * My foods, meals, recipes and scanned products — everything the user owns.
 *
 * Each tab lists what you created, with the two actions that matter: log it
 * again, or fix it. Deleting a food leaves diary history intact: past entries
 * carry their own nutrients precisely so that removing a food never rewrites
 * what you ate last Tuesday.
 */
import { el, fill, fmt, show, toast, openSheet, closeSheet, emit, on, $ } from './ui.js';
import {
  listMyFoods, listMyMeals, listMyRecipes, listMyProducts, food as foodById,
  removeCustomFood, removeSavedMeal, servingsFor, kcalFor,
} from './foods.js';
import { openFoodDetail, openCreateFood, openMealBuilder } from './logfood.js';
import { suggestSlot } from './goals.js';
import { diaryDate } from './today.js';

const TABS = [
  ['foods', 'My foods'],
  ['meals', 'Meals'],
  ['recipes', 'Recipes'],
  ['products', 'Scanned'],
];
const state = { tab: 'foods' };

export function renderMyFoods() {
  const rows = {
    foods: () => listMyFoods().map((f) => itemRow(f, {
      subtitle: [f.brand, `${fmt.amount(f.portions?.[0]?.[1] ?? 100)} g serving`].filter(Boolean).join(' · '),
      onEdit: () => openCreateFood({ existing: f }),
      onDelete: async () => { await removeCustomFood(f.storageId); emit('foods'); toast('Food deleted'); },
    })),
    meals: () => listMyMeals().map((m) => itemRow(foodById(m.id), {
      subtitle: `${m.items.length} items`,
      onEdit: () => openMealBuilder({ kind: 'meal', existing: m }),
      onDelete: async () => { await removeSavedMeal(m.storageId); emit('foods'); toast('Meal deleted'); },
    })),
    recipes: () => listMyRecipes().map((m) => itemRow(foodById(m.id), {
      subtitle: `${m.items.length} ingredients · makes ${m.servings}`,
      onEdit: () => openMealBuilder({ kind: 'recipe', existing: m }),
      onDelete: async () => { await removeSavedMeal(m.storageId); emit('foods'); toast('Recipe deleted'); },
    })),
    products: () => listMyProducts().map((p) => itemRow(p, {
      subtitle: [p.brand, p.barcode].filter(Boolean).join(' · '),
    })),
  }[state.tab]();

  fill($('myfoods-root'),
    el('h2', null, 'My food'),
    el('div.tabs', { role: 'tablist' }, TABS.map(([id, label]) => el('button.tab', {
      role: 'tab', class: id === state.tab ? 'tab active' : 'tab', 'aria-selected': id === state.tab,
      dataset: { tab: id },
      onclick: () => { state.tab = id; renderMyFoods(); },
    }, label))),
    el('div.log-actions', null,
      el('button', { onclick: () => openCreateFood({}) }, '＋ New food'),
      el('button', { onclick: () => openMealBuilder({ kind: 'meal' }) }, '＋ New meal'),
      el('button', { onclick: () => openMealBuilder({ kind: 'recipe' }) }, '＋ New recipe')),
    el('div.food-results', null, rows.length ? rows : el('p.muted.empty', null, emptyText())));
}

function emptyText() {
  return {
    foods: 'No foods of your own yet. Create one from any nutrition label.',
    meals: 'No saved meals yet. Save a meal from the diary’s ⋯ menu to reuse it.',
    recipes: 'No recipes yet. A recipe divides its ingredients into servings.',
    products: 'Nothing scanned yet. Scanned products are cached here and work offline.',
  }[state.tab];
}

function itemRow(f, { subtitle, onEdit, onDelete }) {
  if (!f) return null;
  const serving = servingsFor(f)[0];
  return el('div.food-row.static', null,
    el('button.fr-main', {
      onclick: () => openFoodDetail({ foodId: f.id, date: diaryDate(), slot: suggestSlot() }),
    },
    el('b', null, f.name),
    el('span.muted', null, [subtitle, `${fmt.kcal(kcalFor(f, serving.grams))} kcal / ${serving.label}`].filter(Boolean).join(' · '))),
    onEdit && el('button.icon-btn.small', { title: 'Edit', 'aria-label': `Edit ${f.name}`, onclick: onEdit }, '✎'),
    onDelete && el('button.icon-btn.small', {
      title: 'Delete', 'aria-label': `Delete ${f.name}`,
      onclick: () => confirmDelete(f.name, onDelete),
    }, '🗑'));
}

function confirmDelete(name, onDelete) {
  openSheet({
    title: 'Delete?',
    body: el('div.stack', null,
      el('p', null, `Delete “${name}”?`),
      el('p.muted.tiny', null, 'Diary entries you already logged keep their own numbers and stay unchanged.'),
      el('button.wide.danger', { onclick: async () => { await onDelete(); closeSheet(); renderMyFoods(); } }, 'Delete'),
      el('button.wide', { onclick: () => closeSheet() }, 'Keep it')),
  });
}

on('foods', () => { if (!$('view-myfoods').hidden) renderMyFoods(); });
