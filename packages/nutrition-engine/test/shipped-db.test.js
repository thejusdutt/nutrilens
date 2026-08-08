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
    // Scallion pancake resolved to *Pancake syrup*: the plural in "Pancakes,
    // NFS" meant the singular query only matched the condiment.
    expect(engine.food('spring-onion-pancake').fdcDesc.toLowerCase()).not.toContain('syrup');
    // Fresh summer rolls priced as fried egg rolls, at 2.4× the energy.
    expect(engine.food('spring-roll-fresh').fdcDesc.toLowerCase()).not.toContain('egg roll');
  });

  it('composed dishes carry every component they are made of', () => {
    // Each of these lost a defining ingredient to a fallback query: the bread
    // under the avocado, the bun round the lobster, the potato in aloo gobi.
    // A calorie total can look sane while the macros behind it are another
    // food's, so assert the shape, not just the energy.
    const shape = [
      // id, minCarbs, minFat, minProtein — the component that went missing
      ['avocado-toast', 18, 5, 3],          // was pure avocado: 8.5 g carbs
      ['lobster-roll-sandwich', 15, 5, 8],  // was lobster salad: 1.2 g carbs
      ['aloo-gobi', 9, 4, 1.5],             // was bare cauliflower: 0.29 g fat
      ['butter-chicken', 2, 9, 8],          // was plain curry: 6.5 g fat
      ['spring-onion-pancake', 25, 8, 4],   // was syrup: 0 g protein, 0.1 g fat
      ['panna-cotta', 10, 10, 1.5],         // was custard: 3.6 g fat
      ['poha', 20, 2, 2],                   // was plain rice: 0.28 g fat
      ['chocolate-bar', 40, 20, 5],         // was generic candy: 8.3 g fat
    ];
    for (const [id, minC, minF, minP] of shape) {
      const p = engine.food(id)?.per100g;
      expect(p, id).toBeTruthy();
      expect(p.carbs, `${id} carbs=${p.carbs}`).toBeGreaterThanOrEqual(minC);
      expect(p.fat, `${id} fat=${p.fat}`).toBeGreaterThanOrEqual(minF);
      expect(p.protein, `${id} protein=${p.protein}`).toBeGreaterThanOrEqual(minP);
    }
  });

  it('no two foods share one row by accident', () => {
    // A query falling through to a generic parent leaves the child with the
    // parent's exact numbers — how Butter chicken became plain chicken curry.
    // These pairs genuinely are one FNDDS food; everything else is a bug.
    const allowed = new Set([
      'beef-carpaccio|beef-tartare', 'beignets|donuts', 'filet-mignon|steak',
      'fried-rice|nasi-goreng', 'omelette|scrambled-eggs', 'sashimi|tuna-tartare',
      'onigiri|plain-rice',
    ]);
    const seen = new Map();
    for (const id of engine.foodIds) {
      const fp = JSON.stringify(engine.food(id).per100g);
      if (!seen.has(fp)) seen.set(fp, []);
      seen.get(fp).push(id);
    }
    const clashes = [];
    for (const ids of seen.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const pair = [ids[i], ids[j]].sort().join('|');
          if (!allowed.has(pair)) clashes.push(pair);
        }
      }
    }
    expect(clashes, `foods sharing identical nutrition: ${clashes.join(', ')}`).toEqual([]);
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

  it('Claude cross-verification provenance is present and coherent', () => {
    // The verification overlay must have been folded in at build time: a large
    // share of foods carry a provenance tag, and every tag is one we emit.
    const foods = Object.entries(engine.db.foods);
    const tagged = foods.filter(([, f]) => f.src);
    expect(tagged.length, 'foods with a verification src tag').toBeGreaterThan(80);
    // `manual-review` and `usda-kept-on-review` come from tools/adjudicate-manual.mjs:
    // foods the automated cross-check waved through because its absolute
    // tolerance was wider than the whole nutrient, reviewed one at a time and
    // either corrected or explicitly left alone with a recorded reason.
    const okSrc = new Set([
      'usda-verified', 'claude-corrected', 'two-model-consensus', 'two-model-outlier',
      'manual-review', 'usda-kept-on-review',
    ]);
    for (const [id, f] of foods) {
      if (!f.src) continue;
      expect(okSrc.has(f.src), `${id} has unknown src "${f.src}"`).toBe(true);
      expect(f.verified, `${id} tagged ${f.src} but not verified`).toBe(true);
      // A corrected food must carry a complete, self-consistent macro set.
      if (f.src !== 'usda-verified') {
        for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
          expect(typeof f.per100g[k], `${id}.${k} missing after correction`).toBe('number');
        }
      }
    }
  });
});
