import { describe, it, expect } from 'vitest';
import { fromOffProduct, parseServing, productUrl } from '../src/index.js';

const nutella = {
  code: '3017624010701',
  product_name: 'Nutella',
  brands: 'Ferrero, Nutella',
  serving_size: '15 g',
  completeness: 0.875,
  nutriments: {
    'energy-kcal_100g': 539,
    energy_100g: 2255,
    proteins_100g: 6.3,
    carbohydrates_100g: 57.5,
    sugars_100g: 56.3,
    fat_100g: 30.9,
    'saturated-fat_100g': 10.6,
    fiber_100g: 0,
    sodium_100g: 0.0428,        // g → 42.8 mg
    calcium_100g: 0.108,        // g → 108 mg
    iron_100g: 0.0035,          // g → 3.5 mg
    'vitamin-e_100g': 0.0069,   // g → 6.9 mg
    'vitamin-b9_100g': 0.00004, // g → 40 µg
    'vitamin-d_100g': 0.0000012, // g → 1.2 µg
  },
};

describe('unit conversion', () => {
  const { food } = fromOffProduct(nutella, { barcode: nutella.code });

  it('keeps grams as grams', () => {
    expect(food.per100g.kcal).toBe(539);
    expect(food.per100g.protein).toBe(6.3);
    expect(food.per100g.carbs).toBe(57.5);
    expect(food.per100g.fat).toBe(30.9);
    expect(food.per100g.sugars).toBe(56.3);
    expect(food.per100g.satFat).toBe(10.6);
  });

  it('converts minerals from grams to milligrams', () => {
    expect(food.per100g.sodium).toBe(42.8);
    expect(food.per100g.calcium).toBe(108);
    expect(food.per100g.iron).toBe(3.5);
    expect(food.per100g.vitE).toBe(6.9);
  });

  it('converts trace vitamins to micrograms', () => {
    expect(food.per100g.folate).toBe(40);
    expect(food.per100g.vitD).toBe(1.2);
  });

  it('never leaves a nutrient in Open Food Facts units', () => {
    // A missed conversion shows up as an absurdly small mineral figure.
    for (const key of ['sodium', 'calcium', 'iron']) {
      expect(food.per100g[key], key).toBeGreaterThan(0.5);
    }
  });
});

describe('product mapping', () => {
  it('records name, brand, barcode and attribution', () => {
    const { food } = fromOffProduct(nutella, { barcode: nutella.code });
    expect(food.name).toBe('Nutella');
    expect(food.brand).toBe('Ferrero');       // first brand only
    expect(food.barcode).toBe('3017624010701');
    expect(food.id).toBe('off:3017624010701');
    expect(food.source).toMatch(/Open Food Facts/);
  });

  it('offers the label serving and 100 g', () => {
    const { food } = fromOffProduct(nutella, { barcode: nutella.code });
    expect(food.portions).toEqual([['15 g', 15], ['100 g', 100]]);
    expect(food.prior.servingG).toBe(15);
  });

  it('falls back to kJ when kcal is missing', () => {
    const kjOnly = { ...nutella, nutriments: { energy_100g: 2255, proteins_100g: 6.3 } };
    const { food } = fromOffProduct(kjOnly);
    expect(food.per100g.kcal).toBeCloseTo(2255 / 4.184, 1);
  });

  it('derives sodium from salt when sodium is absent', () => {
    const salty = { ...nutella, nutriments: { 'energy-kcal_100g': 200, salt_100g: 1.25 } };
    const { food } = fromOffProduct(salty);
    expect(food.per100g.sodium).toBe(500); // 1.25 g salt / 2.5 × 1000
  });

  it('parses numeric strings', () => {
    const strings = { ...nutella, nutriments: { 'energy-kcal_100g': '250', proteins_100g: '12.5' } };
    const { food } = fromOffProduct(strings);
    expect(food.per100g.kcal).toBe(250);
    expect(food.per100g.protein).toBe(12.5);
  });

  it('reports quality so the UI can warn about thin records', () => {
    const { food } = fromOffProduct(nutella, { barcode: nutella.code });
    expect(food.quality.nutrientCount).toBeGreaterThan(10);
    expect(food.quality.hasServing).toBe(true);
    expect(food.quality.completeness).toBe(0.875);
  });
});

describe('rejecting untrustworthy records', () => {
  const cases = [
    ['no product data', null],
    ['product has no energy value', { product_name: 'Mystery', nutriments: {} }],
    ['product has no name', { nutriments: { 'energy-kcal_100g': 100 } }],
    ['implausible nutrition data (macros exceed 100 g)', {
      product_name: 'Broken', nutriments: { 'energy-kcal_100g': 300, proteins_100g: 50, carbohydrates_100g: 50, fat_100g: 40 },
    }],
    ['implausible nutrition data (energy too high)', {
      product_name: 'Broken', nutriments: { 'energy-kcal_100g': 4000 },
    }],
  ];
  for (const [reason, product] of cases) {
    it(`rejects: ${reason}`, () => {
      const r = fromOffProduct(product);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    });
  }

  it('ignores negative amounts rather than logging them', () => {
    const { food } = fromOffProduct({ product_name: 'X', nutriments: { 'energy-kcal_100g': 100, proteins_100g: -5 } });
    expect(food.per100g.protein).toBeUndefined();
  });
});

describe('serving-size parsing', () => {
  it('reads a plain weight', () => {
    expect(parseServing('30 g')).toEqual({ grams: 30, label: '30 g' });
    expect(parseServing('250ml')).toEqual({ grams: 250, label: '250ml' });
  });
  it('prefers the weight inside brackets', () => {
    expect(parseServing('1 biscuit (12.5 g)').grams).toBe(12.5);
    expect(parseServing('2 tranches (60 g)').grams).toBe(60);
  });
  it('handles comma decimals', () => {
    expect(parseServing('12,5 g').grams).toBe(12.5);
  });
  it('returns null for text with no usable weight', () => {
    for (const s of ['1 portion', '', null, undefined, 'about a handful', '0 g', '99999 g']) {
      expect(parseServing(s), String(s)).toBeNull();
    }
  });
});

describe('API url', () => {
  it('asks only for the fields we map and identifies the app', () => {
    const url = productUrl('3017624010701');
    expect(url).toContain('/api/v2/product/3017624010701.json');
    expect(url).toContain('nutriments');
    expect(url).toContain('app_name=NutriLens');
  });
  it('escapes the barcode', () => {
    expect(productUrl('../etc')).toContain('%2F');
  });
});
