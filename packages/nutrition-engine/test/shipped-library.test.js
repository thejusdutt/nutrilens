/**
 * Integrity of the shipped offline dish library (nutrition-library.json).
 *
 * The library is what makes "log any dish" work without a network: ~1700 dishes
 * computed at build time and shipped as static JSON. Its numbers are Claude
 * estimates rather than laboratory measurements, which is exactly why they need a
 * gate — an estimate is allowed to be approximate, not allowed to be impossible.
 *
 * Every row must survive the same arithmetic a nutrition label does, and the
 * library must not quietly shadow a measured USDA food.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NutritionEngine } from '../src/index.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app/public/data');
const libPath = join(dataDir, 'nutrition-library.json');
const dbPath = join(dataDir, 'nutrition-db.json');
const ready = existsSync(libPath) && existsSync(dbPath);
const d = ready ? describe : describe.skip;

d('shipped dish library', () => {
  const lib = JSON.parse(readFileSync(libPath, 'utf8'));
  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  const engine = new NutritionEngine(db);
  const entries = Object.entries(lib.foods);

  it('ships a substantial library with a stated provenance', () => {
    expect(entries.length).toBeGreaterThan(1000);
    expect(lib.count).toBe(entries.length);
    // The source string must be honest about what these numbers are.
    expect(lib.source).toMatch(/Claude/);
    expect(lib.source).toMatch(/[Ee]stimate/);
  });

  it('every row has a name, a group and the macros a log needs', () => {
    for (const [id, f] of entries) {
      expect(typeof f.name, id).toBe('string');
      expect(f.name.length, id).toBeGreaterThan(1);
      expect(typeof f.group, `${id} group`).toBe('string');
      for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
        expect(typeof f.per100g[k], `${id}.${k}`).toBe('number');
        expect(f.per100g[k], `${id}.${k} negative`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('energy agrees with the macros carrying it (Atwater)', () => {
    const bad = [];
    for (const [id, f] of entries) {
      const { kcal, protein = 0, carbs = 0, fat = 0, fiber = 0 } = f.per100g;
      const atwater = 4 * protein + 4 * carbs + 9 * fat - 2 * fiber;
      if (Math.abs(kcal - atwater) > Math.max(20, atwater * 0.25)) {
        bad.push(`${id}: ${kcal} vs ${atwater.toFixed(0)}`);
      }
    }
    expect(bad, `${bad.length} rows fail Atwater: ${bad.slice(0, 8).join('; ')}`).toEqual([]);
  });

  it('no row is physically impossible per 100 g', () => {
    const bad = [];
    for (const [id, f] of entries) {
      const { kcal, protein = 0, carbs = 0, fat = 0, fiber = 0, sugars = 0, satFat = 0, sodium = 0 } = f.per100g;
      if (kcal > 900) bad.push(`${id}: ${kcal} kcal`);
      if (protein + carbs + fat > 105) bad.push(`${id}: P+C+F ${(protein + carbs + fat).toFixed(0)} g`);
      if (fiber > carbs + 1) bad.push(`${id}: fiber ${fiber} > carbs ${carbs}`);
      if (sugars > carbs + 1) bad.push(`${id}: sugar ${sugars} > carbs ${carbs}`);
      if (satFat > fat + 0.5) bad.push(`${id}: satFat ${satFat} > fat ${fat}`);
      if (sodium > 40000) bad.push(`${id}: sodium ${sodium} mg`);
    }
    expect(bad, bad.slice(0, 8).join('; ')).toEqual([]);
  });

  it('reports no micronutrients it cannot measure', () => {
    // Fabricating a selenium value would be worse than omitting it; the library
    // is deliberately limited to what a recipe determines.
    const allowed = new Set(['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'satFat', 'sodium']);
    const extra = new Set();
    for (const [, f] of entries) for (const k of Object.keys(f.per100g)) if (!allowed.has(k)) extra.add(k);
    expect([...extra]).toEqual([]);
  });

  it('serving weights are usable when present', () => {
    for (const [id, f] of entries) {
      for (const [label, grams] of f.portions ?? []) {
        expect(typeof label, `${id} portion label`).toBe('string');
        expect(grams, `${id} "${label}"`).toBeGreaterThanOrEqual(5);
        expect(grams, `${id} "${label}"`).toBeLessThanOrEqual(1500);
      }
    }
  });

  it('does not shadow a measured USDA food by name', () => {
    // USDA rows carry 31 measured nutrients; a library row carries 8 estimates.
    // If both claim the same name the user could be shown the weaker record.
    const usda = new Set(engine.foodIds.map((id) => engine.food(id).name.toLowerCase()));
    const clash = entries.filter(([, f]) => usda.has(f.name.toLowerCase())).map(([id]) => id);
    expect(clash, `library duplicates USDA foods: ${clash.slice(0, 8).join(', ')}`).toEqual([]);
  });

  it('ids are unique, url-safe slugs', () => {
    for (const [id] of entries) expect(id, id).toMatch(/^[a-z0-9-]+$/);
    expect(new Set(entries.map(([id]) => id)).size).toBe(entries.length);
  });

  it('the engine can price any library food through the shared path', () => {
    // forFood is what the app calls; a library record must work in it unchanged.
    for (const [id, f] of entries.slice(0, 50)) {
      const r = engine.forFood(f, 250, id);
      expect(r, id).toBeTruthy();
      expect(r.nutrients.kcal.value).toBeCloseTo(f.per100g.kcal * 2.5, 6);
    }
  });
});
