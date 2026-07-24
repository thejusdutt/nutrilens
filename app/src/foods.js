/**
 * One food lookup for the whole app, over four sources:
 *
 *   USDA database   plain ids, e.g. "pizza"      — the offline reference set
 *   My Foods        "my:<n>"                     — user-created, from a label
 *   Products        "off:<barcode>"              — scanned, cached forever
 *   Saved meals     "meal:<n>" / "recipe:<n>"    — groups of the above
 *
 * Callers never branch on source: `food(id)`, `search(q)`, `servingsFor(food)`
 * and `nutrients(food, grams)` behave the same whatever produced the record.
 * Nutrient scaling always goes through the nutrition engine so a scanned yoghurt
 * and a USDA yoghurt are computed by identical code.
 */
import { perServing } from '@nutrilens/diary';
import {
  listCustomFoods, listProducts, listSavedMeals, saveCustomFood, deleteCustomFood,
  saveSavedMeal, deleteSavedMeal, putProduct, getProduct,
} from './db.js';

let engine = null;
const custom = new Map();   // "my:<n>"      → food
const products = new Map(); // "off:<code>"  → food
const saved = new Map();     // "meal:<n>" | "recipe:<n>" → saved meal

export const customId = (id) => `my:${id}`;
export const productId = (barcode) => `off:${barcode}`;
export const savedId = (kind, id) => `${kind}:${id}`;

/** @param {import('@nutrilens/nutrition-engine').NutritionEngine} nutritionEngine */
export async function initFoods(nutritionEngine) {
  engine = nutritionEngine;
  await reloadAll();
}

export async function reloadAll() {
  const [foods, prods, meals] = await Promise.all([listCustomFoods(), listProducts(), listSavedMeals()]);
  custom.clear();
  for (const f of foods) custom.set(customId(f.id), { ...f, id: customId(f.id), storageId: f.id, kind: 'custom' });
  products.clear();
  for (const p of prods) products.set(productId(p.barcode), { ...p.food, id: productId(p.barcode), kind: 'product' });
  saved.clear();
  for (const m of meals) saved.set(savedId(m.kind, m.id), { ...m, id: savedId(m.kind, m.id), storageId: m.id });
}

export const nutrientMeta = () => engine?.db?.nutrients ?? {};
export const macroKeys = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars'];

/**
 * Resolve any id to a food record. Saved meals resolve to a synthetic food whose
 * per-100 g values come from the meal's own items, which is what lets a recipe be
 * logged, rescaled and edited exactly like a single food.
 * @param {string} id
 */
export function food(id) {
  if (id == null) return null;
  if (custom.has(id)) return custom.get(id);
  if (products.has(id)) return products.get(id);
  if (saved.has(id)) return mealAsFood(saved.get(id));
  return engine?.food(id) ? { ...engine.food(id), id, kind: 'usda' } : null;
}

/** Saved meals and recipes presented as a food, so one code path logs everything. */
function mealAsFood(meal) {
  const per = perServing({ items: meal.items, servings: meal.servings ?? 1 });
  const per100g = {};
  if (per.grams > 0) {
    for (const [k, v] of Object.entries(per.nutrients)) per100g[k] = v / per.grams * 100;
  }
  return {
    id: meal.id,
    kind: meal.kind,                      // 'meal' | 'recipe'
    name: meal.name,
    brand: meal.kind === 'recipe' ? 'Recipe' : 'Saved meal',
    per100g,
    perServingNutrients: per.nutrients,
    servingGrams: per.grams,
    servingsMade: per.servings,
    items: meal.items,
    portions: [[meal.kind === 'recipe' ? '1 serving' : '1 meal', Math.max(1, Math.round(per.grams))]],
    prior: { servingG: Math.max(1, Math.round(per.grams)) },
    storageId: meal.storageId,
  };
}

/**
 * Serving choices for a food: its own household measures first, then the two
 * universal fallbacks. "1 g" matters more than it looks — it is how people log
 * "237 g of rice" by typing the grams as a serving count.
 * @returns {{label:string, grams:number}[]}
 */
export function servingsFor(foodRecord) {
  const out = [];
  const seen = new Set();
  const add = (label, grams) => {
    const g = Math.round(grams * 100) / 100;
    if (!(g > 0) || seen.has(label)) return;
    seen.add(label);
    out.push({ label, grams: g });
  };
  for (const [label, grams] of foodRecord?.portions ?? []) add(label, grams);
  add('100 g', 100);
  add('1 g', 1);
  return out;
}

/** Nutrients for `grams` of a food — always the engine's arithmetic. */
export function nutrients(foodRecord, grams) {
  if (!foodRecord || !engine) return null;
  return engine.forFood(foodRecord, grams, foodRecord.id);
}

/** Calories for `grams`, for list rows where a full table would be noise. */
export const kcalFor = (foodRecord, grams) => Math.round((foodRecord?.per100g?.kcal ?? 0) * grams / 100);

/**
 * Search every source at once. USDA results are ranked by the engine; local
 * items (your own foods, your scans, your meals) are boosted, because a food you
 * created is almost always the one you meant.
 * @param {string} query
 * @param {{limit?:number}} [opts]
 * @returns {{id:string, name:string, brand?:string, kind:string, score:number}[]}
 */
export function search(query, { limit = 40 } = {}) {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const local = [];
  for (const rec of [...custom.values(), ...products.values(), ...saved.values()]) {
    const hay = `${rec.name} ${rec.brand ?? ''}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    const f = rec.kind === 'meal' || rec.kind === 'recipe' ? mealAsFood(rec) : rec;
    local.push({
      id: f.id, name: f.name, brand: f.brand, kind: f.kind,
      score: 100 + (hay.startsWith(q) ? 10 : 0),
    });
  }
  const usda = (engine?.search(query, limit) ?? []).map((h) => ({
    id: h.id, name: h.name, kind: 'usda', score: h.score,
  }));
  return [...local, ...usda].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Mutations — every one refreshes the in-memory view so the UI stays truthful
// ---------------------------------------------------------------------------

/** @param {{id?:number, name:string, brand?:string, per100g:object, portions:Array}} f */
export async function upsertCustomFood(f) {
  const id = await saveCustomFood({ ...f, kind: 'custom', updated: Date.now() });
  await reloadAll();
  return customId(f.id ?? id);
}

export async function removeCustomFood(storageId) {
  await deleteCustomFood(storageId);
  await reloadAll();
}

/** @param {{id?:number, kind:'meal'|'recipe', name:string, servings?:number, items:Array}} m */
export async function upsertSavedMeal(m) {
  const id = await saveSavedMeal({ ...m, updated: Date.now() });
  await reloadAll();
  return savedId(m.kind, m.id ?? id);
}

export async function removeSavedMeal(storageId) {
  await deleteSavedMeal(storageId);
  await reloadAll();
}

/** Cache a scanned product and return its food id. */
export async function rememberProduct(barcode, foodRecord) {
  await putProduct({ barcode, food: foodRecord, ts: Date.now() });
  await reloadAll();
  return productId(barcode);
}

/** A previously scanned product, straight from the cache (works offline). */
export async function cachedProduct(barcode) {
  const hit = products.get(productId(barcode));
  if (hit) return hit;
  const rec = await getProduct(barcode);
  return rec ? { ...rec.food, id: productId(barcode), kind: 'product' } : null;
}

export const listMyFoods = () => [...custom.values()];
export const listMyMeals = () => [...saved.values()].filter((m) => m.kind === 'meal');
export const listMyRecipes = () => [...saved.values()].filter((m) => m.kind === 'recipe');
export const listMyProducts = () => [...products.values()];

/**
 * Build the per-100 g table for a food someone types off a nutrition label.
 * Labels state amounts per serving, so this converts once, at creation time —
 * everything downstream then works in per-100 g like the rest of the app.
 * @param {Record<string, number>} perServingAmounts
 * @param {number} servingGrams
 */
export function per100gFromLabel(perServingAmounts, servingGrams) {
  const per100g = {};
  if (!(servingGrams > 0)) return per100g;
  for (const [k, v] of Object.entries(perServingAmounts)) {
    if (Number.isFinite(v) && v >= 0) per100g[k] = Math.round(v / servingGrams * 100 * 100) / 100;
  }
  return per100g;
}
