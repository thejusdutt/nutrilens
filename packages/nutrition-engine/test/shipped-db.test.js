/**
 * Regression tests against the REAL shipped database + search ranking.
 * These encode the exact failures users hit: "white rice" surfacing Risotto
 * (USDA description pollution) and 'Roti' substring-matching "ROTIsserie
 * chicken" (18 g protein "rice"). If the DB or ranking regresses, this fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NutritionEngine } from '../src/index.js';

const dbPath = join(dirname(fileURLToPath(import.meta.url)), '../../../app/public/data/nutrition-db.json');
const hasDb = existsSync(dbPath);
const d = hasDb ? describe : describe.skip;

d('shipped nutrition database', () => {
  const engine = new NutritionEngine(JSON.parse(readFileSync(dbPath, 'utf8')));

  it('golden nutrition values (per 100 g)', () => {
    // [id, kcal, ±, protein, ±] — published USDA reference values
    const golden = [
      ['plain-rice', 130, 20, 2.7, 1],
      ['banana', 93, 15, 1, 0.6],
      ['pizza', 270, 45, 11, 3],
      ['boiled-egg', 150, 25, 12.5, 2],
      ['oatmeal', 70, 25, 2.5, 1.5],
      ['chapati', 300, 70, 8, 3.5],
      ['bacon', 470, 90, 34, 8],
      ['coffee', 2, 3, 0.2, 0.3],
    ];
    for (const [id, kcal, kTol, protein, pTol] of golden) {
      const f = engine.food(id);
      expect(f, id).toBeTruthy();
      expect(Math.abs(f.per100g.kcal - kcal), `${id} kcal=${f.per100g.kcal}`).toBeLessThanOrEqual(kTol);
      expect(Math.abs(f.per100g.protein - protein), `${id} protein=${f.per100g.protein}`).toBeLessThanOrEqual(pTol);
    }
  });

  it('Atwater consistency across every food', () => {
    for (const id of engine.foodIds) {
      const { kcal = 0, protein = 0, carbs = 0, fat = 0 } = engine.food(id).per100g;
      const atwater = 4 * protein + 4 * carbs + 9 * fat;
      expect(Math.abs(kcal - atwater), `${id}: kcal=${kcal} vs ${atwater.toFixed(0)}`)
        .toBeLessThanOrEqual(Math.max(20, atwater * 0.25));
    }
  });

  it('no mapping points at a semantically absurd source', () => {
    // The exact bug class that shipped: flatbread mapped to rotisserie chicken.
    expect(engine.food('chapati').fdcDesc.toLowerCase()).not.toContain('chicken');
    expect(engine.food('lassi').fdcDesc.toLowerCase()).not.toContain('vegetable');
    expect(engine.food('oatmeal').fdcDesc.toLowerCase()).not.toContain('cookie');
    expect(engine.food('plain-rice').fdcDesc.toLowerCase()).toMatch(/^rice/);
  });

  it('search: the obvious food ranks first', () => {
    expect(engine.search('white rice')[0].id).toBe('plain-rice');
    expect(engine.search('steamed rice')[0].id).toBe('plain-rice');
    expect(engine.search('rice').slice(0, 3).map((h) => h.id)).toContain('plain-rice');
    expect(engine.search('chapati')[0].id).toBe('chapati');
    expect(engine.search('pizza')[0].id).toBe('pizza');
    expect(engine.search('biryani')[0].id).toBe('biryani');
    expect(engine.search('dal')[0].id).toBe('dal');
  });

  it('search: name matches outrank source-description mentions', () => {
    // Risotto's USDA desc contains "Rice, white" — it must not beat Steamed rice.
    const white = engine.search('white rice').map((h) => h.id);
    expect(white.indexOf('plain-rice')).toBeLessThan(Math.max(0, white.indexOf('risotto')) + (white.includes('risotto') ? 0 : 99));
    // "rice" queries must not put non-rice-named dishes (bibimbap) first.
    expect(engine.search('rice')[0].id).not.toBe('bibimbap');
  });
});
