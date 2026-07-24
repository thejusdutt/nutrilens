/**
 * Provenance: every number in the shipped nutrition database must be traceable,
 * value-for-value, to the USDA FNDDS release it claims to come from.
 *
 * This is the layer that catches join bugs, unit mix-ups, invented values and
 * silently-empty nutrients — the failure modes that unit tests over the built
 * artifact cannot see, because the artifact is self-consistent either way.
 *
 * Needs the FNDDS CSV release in tools/data/fndds/ (gitignored, fetched by
 * tools/fetch-assets.sh); skipped when it is absent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NUTRIENT_MAP, roundPer100g } from '../nutrient-map.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dbPath = join(root, 'app/public/data/nutrition-db.json');
const fnddsBase = join(root, 'tools/data/fndds');
const release = existsSync(fnddsBase) ? readdirSync(fnddsBase).find((d) => d.startsWith('FoodData')) : null;
const ready = release && existsSync(dbPath);
const d = ready ? describe : describe.skip;

/** Minimal quote-aware CSV → array of row objects (food.csv has commas in descriptions). */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

d('shipped database vs USDA FNDDS source', () => {
  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  const csv = (f) => parseCSV(readFileSync(join(fnddsBase, release, f), 'utf8'));

  const foodDesc = new Map(csv('food.csv').map((f) => [f.fdc_id, f.description]));

  // food_nutrient.nutrient_id holds the legacy nutrient_nbr, not nutrient.id.
  const nbrToKey = new Map();
  const nutrientRows = csv('nutrient.csv');
  for (const [key, [fnddsName]] of Object.entries(NUTRIENT_MAP)) {
    const row = nutrientRows.find((n) => n.name === fnddsName && !(fnddsName === 'Energy' && n.unit_name !== 'KCAL'));
    expect(row, `FNDDS has no nutrient named "${fnddsName}" (key ${key})`).toBeTruthy();
    nbrToKey.set(row.nutrient_nbr, key);
  }

  /** fdc_id → { key: raw amount } straight from the source rows. */
  const srcNutrients = new Map();
  for (const fn of csv('food_nutrient.csv')) {
    const key = nbrToKey.get(fn.nutrient_id);
    if (!key) continue;
    if (!srcNutrients.has(fn.fdc_id)) srcNutrients.set(fn.fdc_id, {});
    srcNutrients.get(fn.fdc_id)[key] = parseFloat(fn.amount);
  }

  /** fdc_id → Set("label@grams") of every portion the source offers. */
  const srcPortions = new Map();
  for (const p of csv('food_portion.csv')) {
    const g = parseFloat(p.gram_weight);
    if (!g || g <= 0) continue;
    const label = (p.portion_description || p.modifier || '').trim();
    if (!label) continue;
    if (!srcPortions.has(p.fdc_id)) srcPortions.set(p.fdc_id, new Set());
    srcPortions.get(p.fdc_id).add(`${label}@${Math.round(g)}`);
  }

  const ids = Object.keys(db.foods);

  it('every food points at a real FNDDS entry with the recorded description', () => {
    for (const id of ids) {
      const f = db.foods[id];
      const desc = foodDesc.get(String(f.fdcId));
      expect(desc, `${id}: fdcId ${f.fdcId} not in food.csv`).toBeTruthy();
      expect(f.fdcDesc, `${id}`).toBe(desc);
    }
  });

  it('every per-100 g value equals its source amount exactly', () => {
    const bad = [];
    for (const id of ids) {
      const src = srcNutrients.get(String(db.foods[id].fdcId)) ?? {};
      for (const [key, value] of Object.entries(db.foods[id].per100g)) {
        if (src[key] == null) { bad.push(`${id}.${key}=${value} has no source row`); continue; }
        const expected = roundPer100g(src[key]);
        if (value !== expected) bad.push(`${id}.${key}: db ${value} vs FNDDS ${expected}`);
      }
    }
    expect(bad, bad.slice(0, 10).join('; ')).toEqual([]);
  });

  it('no source nutrient is silently dropped', () => {
    const missing = [];
    for (const id of ids) {
      const src = srcNutrients.get(String(db.foods[id].fdcId)) ?? {};
      for (const key of Object.keys(src)) {
        if (db.foods[id].per100g[key] == null) missing.push(`${id}.${key} (FNDDS has ${src[key]})`);
      }
    }
    expect(missing, missing.slice(0, 10).join('; ')).toEqual([]);
  });

  it('every advertised nutrient carries data for every food', () => {
    // A nutrient declared in db.nutrients renders a row in the UI, so an empty
    // column is a silent lie. `sugars` shipped this way (mapped to nutrient_nbr
    // 269.3, which no survey-food row uses).
    const empty = Object.keys(db.nutrients)
      .map((key) => [key, ids.filter((id) => db.foods[id].per100g[key] != null).length])
      .filter(([, n]) => n < ids.length);
    expect(empty.map(([k, n]) => `${k}: ${n}/${ids.length}`)).toEqual([]);
  });

  it('nutrient metadata matches the canonical table', () => {
    expect(Object.keys(db.nutrients).sort()).toEqual(Object.keys(NUTRIENT_MAP).sort());
    for (const [key, [, name, unit, rdi]] of Object.entries(NUTRIENT_MAP)) {
      expect(db.nutrients[key], key).toEqual({ name, unit, rdi });
    }
  });

  it('every household portion comes from the source', () => {
    const bad = [];
    for (const id of ids) {
      const src = srcPortions.get(String(db.foods[id].fdcId)) ?? new Set();
      for (const [label, grams] of db.foods[id].portions) {
        if (!src.has(`${label}@${grams}`)) bad.push(`${id}: "${label}" @ ${grams} g not in food_portion.csv`);
      }
    }
    expect(bad, bad.slice(0, 10).join('; ')).toEqual([]);
  });
});
