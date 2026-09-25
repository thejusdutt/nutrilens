import { describe, it, expect } from 'vitest';
import { implausible, dropImpossibleFibre, fromOffProduct } from '../src/index.js';

describe('plausibility gate', () => {
  it('accepts an EU label that counts fibre outside carbs at 2 kcal/g', () => {
    // Bran flakes, EU style: 4·10 + 4·50 + 9·3 + 2·25 = 317
    expect(implausible({ kcal: 317, protein: 10, carbs: 50, fat: 3, fiber: 25 })).toBeNull();
  });

  it('accepts a US label that counts fibre inside carbs', () => {
    // 4·10 + 4·(75-25) + 9·3 + 2·25 = 317
    expect(implausible({ kcal: 317, protein: 10, carbs: 75, fat: 3, fiber: 25 })).toBeNull();
  });

  it('accepts beer, whose energy is mostly alcohol', () => {
    const beer = fromOffProduct({
      product_name: 'Pils', nutriments: {
        'energy-kcal_100g': 42, proteins_100g: 0.5, carbohydrates_100g: 3.1, fat_100g: 0, alcohol_100g: 4.9,
      },
    }).food;
    expect(beer.per100g.alcohol).toBeCloseTo(3.87, 2);
    expect(implausible(beer.per100g)).toBeNull();
  });

  it('rejects a kJ figure typed into the kcal field', () => {
    expect(implausible({ kcal: 1550, protein: 13, carbs: 60, fat: 8 })).toBe('kcal disagrees with macros');
  });

  it('rejects a record with a macro missing, and parts larger than their whole', () => {
    expect(implausible({ kcal: 100, protein: 1, carbs: 20 })).toBe('missing a macro');
    expect(implausible({ kcal: 100, protein: 1, carbs: 20, fat: 1.5, sugars: 30 })).toBe('part exceeds its whole');
  });

  it('drops fibre that cannot fit on the label, keeping the product', () => {
    const prince = { kcal: 466, protein: 6.3, carbs: 68, fat: 17, fiber: 52, sugars: 32 };
    expect(dropImpossibleFibre(prince)).toBe(true);
    expect(prince.fiber).toBeUndefined();
    expect(implausible(prince)).toBeNull();
    const bran = { kcal: 317, protein: 10, carbs: 50, fat: 3, fiber: 25, sugars: 15 };
    expect(dropImpossibleFibre(bran)).toBe(false);
  });
});
