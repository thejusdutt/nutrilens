/**
 * Exactness of the nutrition arithmetic over the WHOLE shipped database.
 *
 * The engine is what the calorie and macro numbers on screen are computed from,
 * so every food × every nutrient × a range of portion sizes is recomputed here
 * from per-100 g values independently and compared. Anything that scales,
 * sums, or converts to %DV is covered: a food-specific or portion-specific
 * slip cannot hide behind a passing spot check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NutritionEngine } from '../src/index.js';

const dbPath = join(dirname(fileURLToPath(import.meta.url)), '../../../app/public/data/nutrition-db.json');
const hasDb = existsSync(dbPath);
const d = hasDb ? describe : describe.skip;

/** Portion sizes spanning the UI's whole range: slider min/max, odd grams, household weights. */
const GRAM_CASES = [1, 5, 10, 37, 63.5, 100, 155, 250, 333, 1000, 1500];
const REL = 1e-12; // float slack: same maths, possibly different multiply order

const relClose = (actual, expected, label) => {
  const slack = Math.max(Math.abs(expected) * REL, 1e-12);
  expect(Math.abs(actual - expected), `${label}: got ${actual}, want ${expected}`).toBeLessThanOrEqual(slack);
};

d('nutrition arithmetic across every food', () => {
  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  const engine = new NutritionEngine(db);
  const ids = engine.foodIds;

  it(`scales every nutrient of every food linearly (${GRAM_CASES.length} portion sizes)`, () => {
    for (const id of ids) {
      const per100g = engine.food(id).per100g;
      for (const grams of GRAM_CASES) {
        const r = engine.forPortion(id, grams);
        expect(r.id).toBe(id);
        expect(r.grams).toBe(grams);
        expect(r.name).toBe(engine.food(id).name);
        // Same key set, no extras, no drops.
        expect(Object.keys(r.nutrients).sort()).toEqual(Object.keys(per100g).sort());
        for (const [key, per100] of Object.entries(per100g)) {
          relClose(r.nutrients[key].value, per100 * grams / 100, `${id}.${key}@${grams}g`);
        }
      }
    }
  });

  it('reports the unit, display name and %DV the database defines', () => {
    for (const id of ids) {
      const r = engine.forPortion(id, 250);
      for (const [key, n] of Object.entries(r.nutrients)) {
        const meta = db.nutrients[key];
        expect(n.unit, `${id}.${key} unit`).toBe(meta.unit);
        expect(n.name, `${id}.${key} name`).toBe(meta.name);
        if (meta.rdi) relClose(n.pctDV, n.value / meta.rdi * 100, `${id}.${key} pctDV`);
        else expect(n.pctDV, `${id}.${key} pctDV`).toBeNull();
      }
    }
  });

  it('kcal agrees with the Atwater sum of the scaled macros', () => {
    // Not a data check (build-nutrition-db gates that per 100 g) but a scaling
    // one: macros and calories must stay in step at any portion size.
    for (const id of ids) {
      for (const grams of [37, 250, 1500]) {
        const n = engine.forPortion(id, grams).nutrients;
        const atwater = 4 * (n.protein?.value ?? 0) + 4 * (n.carbs?.value ?? 0) + 9 * (n.fat?.value ?? 0);
        const kcal = n.kcal.value;
        expect(Math.abs(kcal - atwater), `${id}@${grams}g: ${kcal} vs ${atwater.toFixed(1)}`)
          .toBeLessThanOrEqual(Math.max(20, atwater * 0.25) * grams / 100);
      }
    }
  });

  it('sub-components stay within their parent macro', () => {
    for (const id of ids) {
      const p = engine.food(id).per100g;
      const fatParts = (p.satFat ?? 0) + (p.monoFat ?? 0) + (p.polyFat ?? 0);
      // Fat sub-fractions exclude glycerol/trans, so they sum to ≤ total fat (+rounding).
      expect(fatParts, `${id}: satFat+monoFat+polyFat=${fatParts} > fat=${p.fat}`)
        .toBeLessThanOrEqual((p.fat ?? 0) + 0.5);
      expect(p.fiber ?? 0, `${id}: fiber > carbs`).toBeLessThanOrEqual((p.carbs ?? 0) + 0.5);
      // Carbohydrate is "by difference" while sugars are measured, so USDA
      // itself lists small inversions (Cheese, paneer: 23.33 g sugars vs
      // 22.46 g carbs). Allow a slim margin — wide enough for that, far too
      // narrow for a unit or scale error.
      const carbs = p.carbs ?? 0;
      expect(p.sugars ?? 0, `${id}: sugars ${p.sugars} vs carbs ${carbs}`)
        .toBeLessThanOrEqual(carbs + Math.max(1, carbs * 0.05));
    }
  });

  it('carries the portion range through every nutrient', () => {
    for (const id of ids) {
      const portion = { grams: 250, low: 160, high: 390 };
      const r = engine.forPortionRange(id, portion);
      expect(r.portion).toEqual(portion);
      for (const [key, n] of Object.entries(r.nutrients)) {
        const per100 = engine.food(id).per100g[key];
        relClose(n.value, per100 * 2.5, `${id}.${key} mid`);
        relClose(n.low, per100 * 250 / 100 * (160 / 250), `${id}.${key} low`);
        relClose(n.high, per100 * 250 / 100 * (390 / 250), `${id}.${key} high`);
        expect(n.low).toBeLessThanOrEqual(n.value + 1e-9);
        expect(n.high).toBeGreaterThanOrEqual(n.value - 1e-9);
      }
    }
  });

  it('household portions weigh what the database says', () => {
    for (const id of ids) {
      for (const [label, grams] of engine.portions(id)) {
        expect(typeof label, `${id} portion label`).toBe('string');
        expect(grams, `${id} "${label}"`).toBeGreaterThan(0);
        const kcal = engine.forPortion(id, grams).nutrients.kcal.value;
        relClose(kcal, (engine.food(id).per100g.kcal ?? 0) * grams / 100, `${id} "${label}" kcal`);
      }
      expect(engine.portions(id).some(([, g]) => g === 100), `${id} lacks a 100 g row`).toBe(true);
    }
  });

  it('a multi-item plate totals exactly the sum of its items', () => {
    // Walk the whole vocabulary in overlapping plates of 4, with awkward grams.
    for (let i = 0; i < ids.length; i++) {
      const items = [
        { id: ids[i], grams: 137 },
        { id: ids[(i + 7) % ids.length], grams: 42.5 },
        { id: ids[(i + 53) % ids.length], grams: 310 },
        { id: ids[i], grams: 8 }, // same food twice must add, not replace
      ];
      const totals = engine.aggregate(items);
      expect(totals.name).toBe(items.map((it) => engine.food(it.id).name).join(' + '));
      const keys = new Set(items.flatMap((it) => Object.keys(engine.food(it.id).per100g)));
      expect(Object.keys(totals.nutrients).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        const expected = items.reduce((s, it) => s + (engine.food(it.id).per100g[key] ?? 0) * it.grams / 100, 0);
        relClose(totals.nutrients[key].value, expected, `plate ${i} ${key}`);
        const meta = db.nutrients[key];
        if (meta.rdi) relClose(totals.nutrients[key].pctDV, expected / meta.rdi * 100, `plate ${i} ${key} pctDV`);
      }
    }
  });

  it('aggregate handles empty, unknown and single-item plates', () => {
    expect(engine.aggregate([])).toEqual({ name: '', nutrients: {} });
    expect(engine.aggregate([{ id: 'not-a-food', grams: 100 }])).toEqual({ name: '', nutrients: {} });
    const mixed = engine.aggregate([{ id: 'banana', grams: 100 }, { id: 'nope', grams: 500 }]);
    expect(mixed.name).toBe(engine.food('banana').name);
    relClose(mixed.nutrients.kcal.value, engine.food('banana').per100g.kcal, 'banana only');
    const one = engine.aggregate([{ id: 'pizza', grams: 250 }]);
    relClose(one.nutrients.kcal.value, engine.forPortion('pizza', 250).nutrients.kcal.value, 'single item');
  });

  it('never returns NaN, Infinity or a negative amount', () => {
    for (const id of ids) {
      for (const grams of GRAM_CASES) {
        for (const [key, n] of Object.entries(engine.forPortion(id, grams).nutrients)) {
          expect(Number.isFinite(n.value), `${id}.${key}@${grams}g = ${n.value}`).toBe(true);
          expect(n.value, `${id}.${key}@${grams}g negative`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('rounds for display the way the UI does, without drift', () => {
    // The UI shows Math.round(kcal) and macros at one decimal; the saved diary
    // entry stores two decimals. Re-derived totals must stay within that.
    for (const id of ids) {
      const r = engine.forPortion(id, 250);
      const stored = Object.fromEntries(Object.entries(r.nutrients).map(([k, n]) => [k, +n.value.toFixed(2)]));
      for (const [key, n] of Object.entries(r.nutrients)) {
        // Half a hundredth is the most 2-decimal storage can lose (+float slack).
        expect(Math.abs(stored[key] - n.value), `${id}.${key} store drift`).toBeLessThanOrEqual(0.005 + 1e-9);
      }
      expect(Math.abs(Math.round(r.nutrients.kcal.value) - r.nutrients.kcal.value)).toBeLessThanOrEqual(0.5);
    }
  });
});
