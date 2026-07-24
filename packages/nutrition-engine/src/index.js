/**
 * @nutrilens/nutrition-engine
 *
 * Offline nutrition computation over a compact database derived from
 * USDA FNDDS 2021-2023 (Survey Foods) — see tools/build-nutrition-db.mjs in
 * the NutriLens monorepo for how the database file is produced.
 *
 * Database shape (nutrition-db.json):
 * {
 *   version, source,
 *   nutrients: { key: { name, unit, rdi } },       // rdi = FDA adult Daily Value, same unit
 *   foods: {
 *     [id]: { name, fdcId, fdcDesc, per100g: { key: value }, portions: [[label, grams]], prior: { h, rho, serve } }
 *   }
 * }
 *
 * All `per100g` values are per 100 g of the as-consumed food.
 */

/** Macro keys displayed as first-class citizens; everything else is a micro. */
export const MACRO_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars'];

export class NutritionEngine {
  /** @param {object} db Parsed nutrition-db.json. */
  constructor(db) {
    if (!db?.foods || !db?.nutrients) throw new Error('invalid nutrition database');
    this.db = db;
    const words = (s) => (s ?? '').toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean);
    this._searchIndex = Object.entries(db.foods).map(([id, f]) => ({
      id,
      name: f.name,
      nameLower: f.name.toLowerCase(),
      nameWords: words(f.name),
      aliasWords: words((f.aliases ?? []).join(' ')),
      descWords: words(f.fdcDesc),
    }));
  }

  /** @returns {string[]} all food ids */
  get foodIds() { return Object.keys(this.db.foods); }

  /** @param {string} id @returns {object|null} raw food record */
  food(id) { return this.db.foods[id] ?? null; }

  /**
   * Nutrients for `grams` of food `id`.
   * @param {string} id
   * @param {number} grams
   * @returns {{
   *   id:string, name:string, grams:number,
   *   nutrients: Record<string, {value:number, unit:string, name:string, pctDV:number|null}>
   * }|null}
   */
  forPortion(id, grams) {
    const f = this.db.foods[id];
    if (!f) return null;
    return this.forFood(f, grams, id);
  }

  /**
   * Same computation for a food record that is not in the database — a
   * user-created food, or a packaged product from a barcode scan. Sharing this
   * path is what keeps a scanned yoghurt and a USDA yoghurt identical
   * downstream: one scaling rule, one set of units, one %DV basis.
   *
   * @param {{name:string, per100g:Record<string,number>}} food
   * @param {number} grams
   * @param {string} [id]
   */
  forFood(food, grams, id = food?.id) {
    if (!food?.per100g) return null;
    const f = food;
    const factor = grams / 100;
    const nutrients = {};
    for (const [key, per100] of Object.entries(f.per100g)) {
      const meta = this.db.nutrients[key];
      if (!meta) continue;
      const value = per100 * factor;
      nutrients[key] = {
        value,
        unit: meta.unit,
        name: meta.name,
        pctDV: meta.rdi ? (value / meta.rdi) * 100 : null,
      };
    }
    return { id, name: f.name, grams, nutrients };
  }

  /**
   * Nutrients for a portion **range** — carries portion uncertainty through to
   * every nutrient as {low, high} alongside the point value.
   * @param {string} id
   * @param {{grams:number, low:number, high:number}} portion
   */
  forPortionRange(id, portion) {
    const mid = this.forPortion(id, portion.grams);
    if (!mid) return null;
    const lo = portion.low / portion.grams, hi = portion.high / portion.grams;
    for (const n of Object.values(mid.nutrients)) {
      n.low = n.value * lo;
      n.high = n.value * hi;
    }
    mid.portion = portion;
    return mid;
  }

  /**
   * Sum several portions (a multi-item meal) into one nutrient table.
   * @param {Array<{id:string, grams:number}>} items
   */
  aggregate(items, resolve) {
    const acc = {};
    const name = [];
    for (const it of items) {
      // `resolve` lets a caller mix in foods the database has never heard of
      // (custom foods, scanned products) without copying the scaling maths.
      const food = resolve ? resolve(it.id) : this.food(it.id);
      const r = food ? this.forFood(food, it.grams, it.id) : null;
      if (!r) continue;
      name.push(r.name);
      for (const [k, n] of Object.entries(r.nutrients)) {
        if (!acc[k]) acc[k] = { ...n, value: 0 };
        acc[k].value += n.value;
      }
    }
    for (const [k, n] of Object.entries(acc)) {
      const meta = this.db.nutrients[k];
      n.pctDV = meta?.rdi ? (n.value / meta.rdi) * 100 : null;
    }
    return { name: name.join(' + '), nutrients: acc };
  }

  /**
   * Household portions for a food (from FNDDS portion weights), e.g.
   * [["1 slice", 107], ["1 piece", 32]]. Always includes a 100 g row.
   * @param {string} id
   * @returns {[string, number][]}
   */
  portions(id) {
    const f = this.db.foods[id];
    const list = f?.portions ? [...f.portions] : [];
    if (!list.some(([, g]) => g === 100)) list.push(['100 g', 100]);
    return list;
  }

  /**
   * Fuzzy search food names for manual correction and quick-add UIs.
   *
   * Ranking philosophy: what the food is CALLED beats what its source
   * database happens to mention. Display-name word matches score far above
   * alias matches, which score above source-description matches — otherwise
   * "white rice" surfaces Risotto first (its USDA description reads
   * "Rice, white, cooked with fat…"). Every query token must match
   * somewhere; ties break toward shorter names, then alphabetically, so
   * results are stable.
   *
   * @param {string} query
   * @param {number} [limit=12]
   * @returns {{id:string, name:string, score:number}[]}
   */
  search(query, limit = 12) {
    const q = query.toLowerCase().trim();
    const qTokens = q.split(/[^a-z0-9%]+/).filter(Boolean);
    if (!qTokens.length) return [];
    const scored = [];
    for (const e of this._searchIndex) {
      let score = 0;
      let allMatched = true;
      for (const qt of qTokens) {
        if (e.nameWords.includes(qt)) score += 6;
        else if (e.nameWords.some((w) => w.startsWith(qt))) score += 4;
        else if (e.aliasWords.includes(qt)) score += 3;
        else if (e.aliasWords.some((w) => w.startsWith(qt))) score += 2;
        else if (e.descWords.includes(qt)) score += 1;
        else if (e.descWords.some((w) => w.startsWith(qt))) score += 0.5;
        else { allMatched = false; break; }
      }
      if (!allMatched) continue;
      if (e.nameLower === q) score += 30;
      else if (e.nameLower.startsWith(q)) score += 12;
      scored.push({ id: e.id, name: e.name, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
}
