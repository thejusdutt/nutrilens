import { describe, it, expect } from 'vitest';
import { NutritionEngine, MACRO_KEYS } from '../src/index.js';

const db = {
  version: 'test',
  nutrients: {
    kcal: { name: 'Calories', unit: 'kcal', rdi: 2000 },
    protein: { name: 'Protein', unit: 'g', rdi: 50 },
    vitC: { name: 'Vitamin C', unit: 'mg', rdi: 90 },
  },
  foods: {
    pizza: {
      name: 'Pizza', fdcDesc: 'Pizza, cheese', aliases: ['cheese pizza'],
      per100g: { kcal: 266, protein: 11.4, vitC: 1.4 },
      portions: [['1 slice', 107]],
      prior: { heightCm: 1.2, densityGml: 0.85, servingG: 240 },
    },
    banana: {
      name: 'Banana', fdcDesc: 'Banana, raw', aliases: [],
      per100g: { kcal: 97, protein: 0.74, vitC: 12 },
      portions: [],
      prior: { heightCm: 5, densityGml: 0.9, servingG: 120 },
    },
  },
};

describe('NutritionEngine', () => {
  const engine = new NutritionEngine(db);

  it('rejects malformed databases', () => {
    expect(() => new NutritionEngine({})).toThrow();
  });

  it('scales nutrients linearly by grams', () => {
    const r = engine.forPortion('pizza', 200);
    expect(r.nutrients.kcal.value).toBeCloseTo(532, 0);
    expect(r.nutrients.protein.value).toBeCloseTo(22.8, 1);
    expect(r.nutrients.kcal.pctDV).toBeCloseTo(26.6, 1);
  });

  it('returns null for unknown foods', () => {
    expect(engine.forPortion('nope', 100)).toBeNull();
  });

  it('propagates portion uncertainty to every nutrient', () => {
    const r = engine.forPortionRange('banana', { grams: 120, low: 60, high: 240 });
    expect(r.nutrients.kcal.value).toBeCloseTo(116.4, 1);
    expect(r.nutrients.kcal.low).toBeCloseTo(58.2, 1);
    expect(r.nutrients.kcal.high).toBeCloseTo(232.8, 1);
  });

  it('aggregates multi-item meals', () => {
    const r = engine.aggregate([{ id: 'pizza', grams: 100 }, { id: 'banana', grams: 100 }]);
    expect(r.nutrients.kcal.value).toBeCloseTo(363, 0);
    expect(r.name).toBe('Pizza + Banana');
  });

  it('always offers a 100 g portion', () => {
    expect(engine.portions('banana')).toContainEqual(['100 g', 100]);
    expect(engine.portions('pizza')[0]).toEqual(['1 slice', 107]);
  });

  it('search matches names, descriptions and aliases', () => {
    expect(engine.search('pizza')[0].id).toBe('pizza');
    expect(engine.search('cheese')[0].id).toBe('pizza');   // alias hit
    expect(engine.search('ban')[0].id).toBe('banana');     // prefix hit
    expect(engine.search('zzz')).toHaveLength(0);
  });

  it('exports macro key list', () => {
    expect(MACRO_KEYS).toContain('kcal');
  });
});
