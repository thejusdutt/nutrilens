import { describe, it, expect } from 'vitest';
import { fromOffProduct, packProducts, BarcodeIndex } from '../src/index.js';

const product = (code, extra = {}) => ({
  code,
  product_name: `Product ${code}`,
  brands: 'Acme, Other',
  serving_size: '1 bar (32.5 g)',
  nutriments: {
    'energy-kcal_100g': 471.3, proteins_100g: 6.25, carbohydrates_100g: 64.05, fat_100g: 20.2,
    sugars_100g: 48.1, 'saturated-fat_100g': 11.9, fiber_100g: 1.5, salt_100g: 0.4,
  },
  ...extra,
});
const mapped = (p) => fromOffProduct(p, { barcode: p.code }).food;

describe('packed barcode table', () => {
  const foods = ['4000417025005', '0049000006346', '8901058851298'].map((c) => mapped(product(c)));
  const index = new BarcodeIndex(packProducts(foods, { source: 'test' }));

  it('finds every packed code and nothing else', () => {
    expect(index.count).toBe(3);
    for (const f of foods) expect(index.lookup(f.barcode)?.barcode).toBe(f.barcode);
    expect(index.lookup('4000417025012')).toBeNull();
    expect(index.lookup('0000000000000')).toBeNull();
    expect(index.lookup('9999999999999')).toBeNull();
  });

  it('round-trips to the record fromOffProduct builds, for the packed fields', () => {
    const want = foods[0];
    const got = index.lookup(want.barcode);
    expect(got.name).toBe(want.name);
    expect(got.brand).toBe('Acme');
    expect(got.portions).toEqual(want.portions);
    expect(got.prior).toEqual(want.prior);
    for (const k of ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'satFat']) {
      expect(got.per100g[k]).toBeCloseTo(want.per100g[k], 1);
    }
    expect(got.per100g.sodium).toBe(Math.round(want.per100g.sodium));
    expect(got.id).toBe(`off:${want.barcode}`);
    expect(index.meta.source).toBe('test');
  });

  it('keeps a missing nutrient missing, not zero', () => {
    const sparse = mapped(product('5000112637922', { serving_size: null, nutriments: { 'energy-kcal_100g': 42 } }));
    const got = new BarcodeIndex(packProducts([sparse])).lookup('5000112637922');
    expect(got.per100g).toEqual({ kcal: 42 });
    expect(got.portions).toEqual([['100 g', 100]]);
    expect(got.prior.servingG).toBe(100);
  });

  it('keeps non-ASCII names intact', () => {
    const f = mapped(product('3017620422003', { product_name: 'Crème brûlée à la vanille — 巧克力' }));
    expect(new BarcodeIndex(packProducts([f])).lookup('3017620422003').name).toBe('Crème brûlée à la vanille — 巧克力');
  });

  it('refuses duplicates and non-EAN-13 codes at build time', () => {
    expect(() => packProducts([foods[0], foods[0]])).toThrow(/duplicate/);
    expect(() => packProducts([{ ...foods[0], barcode: '12345678' }])).toThrow(/EAN-13/);
  });

  it('opens a table that starts at an unaligned offset', () => {
    const packed = packProducts(foods);
    const shifted = new Uint8Array(packed.length + 3);
    shifted.set(packed, 3);
    expect(new BarcodeIndex(shifted.subarray(3)).lookup(foods[1].barcode)?.barcode).toBe(foods[1].barcode);
  });
});
