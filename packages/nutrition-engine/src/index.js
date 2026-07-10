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
    this._searchIndex = Object.entries(db.foods).map(([id, f]) => ({
      id,
      name: f.name,
      tokens: `${f.name} ${f.fdcDesc ?? ''} ${(f.aliases ?? []).join(' ')}`.toLowerCase(),
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
  aggregate(items) {
    const acc = {};
    let name = [];
    for (const it of items) {
      const r = this.forPortion(it.id, it.grams);
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
   * Fuzzy search food names for manual correction UIs.
   * Scores by token-prefix coverage of the query.
   * @param {string} query
   * @param {number} [limit=12]
   * @returns {{id:string, name:string, score:number}[]}
   */
  search(query, limit = 12) {
    const qTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!qTokens.length) return [];
    const scored = [];
    for (const e of this._searchIndex) {
      let score = 0;
      for (const qt of qTokens) {
        if (e.tokens.includes(qt)) score += 2;
        else if (e.tokens.split(/\s+/).some((t) => t.startsWith(qt))) score += 1;
      }
      // All tokens must contribute; prefer names that start with the query.
      if (score >= qTokens.length) {
        if (e.name.toLowerCase().startsWith(qTokens[0])) score += 1.5;
        scored.push({ id: e.id, name: e.name, score });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
