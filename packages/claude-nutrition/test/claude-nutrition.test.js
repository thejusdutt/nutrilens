import { describe, it, expect } from 'vitest';
import {
  parseNutrition, validatePer100g, atwaterKcal, estimateNutrition, crossVerify, blendPer100g,
} from '../src/index.js';

describe('parseNutrition', () => {
  it('pulls JSON out of a fenced, prose-prefixed reply', () => {
    const reply = 'Here you go:\n```json\n{"kcal": 160, "protein_g": 13, "carbs_g": 6, "fat_g": 9}\n```';
    const r = parseNutrition(reply);
    expect(r.per100g).toEqual({ kcal: 160, protein: 13, carbs: 6, fat: 9 });
  });

  it('coerces stringy numbers and maps every known key', () => {
    const r = parseNutrition('{"kcal":"160","protein_g":"13","carbs_g":"6","fat_g":"9",'
      + '"fiber_g":"1","sugar_g":"3","sat_fat_g":"4","sodium_mg":"380","typical_serving_g":"250","confidence":"0.6"}');
    expect(r.per100g).toEqual({ kcal: 160, protein: 13, carbs: 6, fat: 9, fiber: 1, sugars: 3, satFat: 4, sodium: 380 });
    expect(r.servingG).toBe(250);
    expect(r.confidence).toBe(0.6);
  });

  it('throws when energy or a core macro is missing', () => {
    expect(() => parseNutrition('{"protein_g":13,"carbs_g":6,"fat_g":9}')).toThrow(/no kcal/);
    expect(() => parseNutrition('{"kcal":160,"carbs_g":6,"fat_g":9}')).toThrow(/no protein/);
    expect(() => parseNutrition('not json at all')).toThrow(/no JSON object/);
  });
});

describe('atwaterKcal + validatePer100g', () => {
  it('counts fibre at 2 kcal/g inside the carb total', () => {
    // 4*2 + 4*20 + 9*1 - 2*5 = 8 + 80 + 9 - 10 = 87
    expect(atwaterKcal({ protein: 2, carbs: 20, fat: 1, fiber: 5 })).toBe(87);
  });

  it('passes a self-consistent record', () => {
    const v = validatePer100g({ kcal: 157, protein: 13, carbs: 6, fat: 9 });
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('flags energy that disagrees with the macros', () => {
    const v = validatePer100g({ kcal: 400, protein: 13, carbs: 6, fat: 9 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toMatch(/kcal 400 disagrees/);
  });

  it('flags physically impossible records', () => {
    expect(validatePer100g({ kcal: 100, protein: 5, carbs: 90, fat: 50 }).ok).toBe(false); // P+C+F>105
    expect(validatePer100g({ kcal: 20, protein: 0, carbs: 2, fat: 0, fiber: 8 }).reasons.join())
      .toMatch(/fiber .* exceeds carbs/);
  });
});

describe('estimateNutrition', () => {
  const good = '{"kcal":157,"protein_g":13,"carbs_g":6,"fat_g":9,"fiber_g":0.7,"sugar_g":3,'
    + '"sat_fat_g":4,"sodium_mg":380,"typical_serving_g":250,"confidence":0.6,"ingredients":"chicken, cream, tomato"}';

  it('returns a valid record on a good first reply', async () => {
    const transport = async () => good;
    const r = await estimateNutrition('chicken tikka masala', { transport });
    expect(r.valid).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.per100g.protein).toBe(13);
    expect(r.servingG).toBe(250);
  });

  it('feeds the arithmetic failure back and accepts the corrected retry', async () => {
    const replies = [
      '{"kcal":400,"protein_g":13,"carbs_g":6,"fat_g":9}', // Atwater-inconsistent
      good,
    ];
    const seen = [];
    const transport = async ({ messages }) => { seen.push(messages.length); return replies.shift(); };
    const r = await estimateNutrition('x', { transport, retries: 1 });
    expect(r.valid).toBe(true);
    expect(r.attempts).toBe(2);
    // Second call must carry the correction turns (assistant + user feedback).
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });

  it('gives up as invalid after exhausting retries', async () => {
    const transport = async () => '{"kcal":400,"protein_g":13,"carbs_g":6,"fat_g":9}';
    const r = await estimateNutrition('x', { transport, retries: 1 });
    expect(r.valid).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.reasons.join()).toMatch(/disagrees/);
  });

  it('survives a transport that throws', async () => {
    const transport = async () => { throw new Error('network down'); };
    const r = await estimateNutrition('x', { transport, retries: 0 });
    expect(r.valid).toBe(false);
    expect(r.reasons.join()).toMatch(/transport error/);
  });
});

describe('crossVerify', () => {
  it('agrees when two sources land close', () => {
    const r = crossVerify(
      { kcal: 160, protein: 13, carbs: 6, fat: 9 },
      { kcal: 157, protein: 13, carbs: 6, fat: 9 },
    );
    expect(r.agree).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('disagrees and prefers the Atwater-consistent side', () => {
    // USDA says 52 kcal (aloo gobi mis-mapped to plain cauliflower); Claude 125 and self-consistent.
    const usda = { kcal: 52, protein: 2, carbs: 5, fat: 0.3 };      // atwater ~30 -> inconsistent
    const claude = { kcal: 125, protein: 2.5, carbs: 12, fat: 7 };  // atwater ~121 -> consistent
    const r = crossVerify(usda, claude);
    expect(r.agree).toBe(false);
    expect(r.moreConsistent).toBe('claude');
    expect(r.score).toBeLessThan(0.7);
  });

  it('blend interpolates macros and keeps USDA-only micronutrients', () => {
    const usda = { kcal: 100, protein: 10, iron: 2 };
    const claude = { kcal: 200, protein: 20 };
    const b = blendPer100g(usda, claude, 0.5);
    expect(b.kcal).toBe(150);
    expect(b.protein).toBe(15);
    expect(b.iron).toBe(2); // micronutrient only USDA has survives
  });
});
