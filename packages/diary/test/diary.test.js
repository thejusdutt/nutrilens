import { describe, it, expect } from 'vitest';
import {
  makeEntry, normalizeEntry, rescaleEntry, dayTotals, remaining, macroEnergy,
  streak, shiftDate, dateRange, weightProjection, rankFrequent, rankRecent,
  perServing, toCSV, totalGrams, SLOTS,
} from '../src/index.js';

const NUT = { kcal: { name: 'Calories', unit: 'kcal' }, protein: { name: 'Protein', unit: 'g' } };
const entry = (over = {}) => makeEntry({
  foodId: 'pizza', foodName: 'Pizza', date: '2026-07-24', slot: 'lunch',
  servingLabel: '1 slice', servingGrams: 107, servings: 2,
  nutrients: { kcal: 288.6, protein: 11.77, carbs: 33.2 }, ts: 1000, ...over,
});

describe('serving arithmetic', () => {
  it('derives grams from serving size × count', () => {
    expect(totalGrams(107, 2)).toBe(214);
    expect(totalGrams(33.3, 3)).toBe(99.9);
    expect(entry().grams).toBe(214);
  });

  it('rounds calories for display but keeps nutrients at two decimals', () => {
    const e = entry();
    expect(e.kcal).toBe(289);
    expect(e.nutrients.kcal).toBe(288.6);
    expect(e.nutrients.protein).toBe(11.77);
  });

  it('accepts engine-shaped nutrients ({value}) as well as plain numbers', () => {
    const e = entry({ nutrients: { kcal: { value: 100.456 }, protein: { value: 2.5 } } });
    expect(e.nutrients).toEqual({ kcal: 100.46, protein: 2.5 });
  });

  it('rescales an entry to a new count and serving size', () => {
    const doubled = rescaleEntry(entry(), { servings: 4 });
    expect(doubled.grams).toBe(428);
    expect(doubled.nutrients.kcal).toBeCloseTo(577.2, 2);
    expect(doubled.kcal).toBe(577);
    const perGram = rescaleEntry(entry(), { servingLabel: '1 g', servingGrams: 1, servings: 150 });
    expect(perGram.grams).toBe(150);
    expect(perGram.nutrients.kcal).toBeCloseTo(288.6 * 150 / 214, 1);
  });

  it('rescales entries whose food is no longer in any database', () => {
    const orphan = rescaleEntry({
      date: '2026-07-24', slot: 'snacks', foodName: 'Gone', servingLabel: '1 bar',
      servingGrams: 40, servings: 1, grams: 40, kcal: 200, nutrients: { kcal: 200 }, ts: 1,
    }, { servings: 3 });
    expect(orphan.kcal).toBe(600);
  });

  it('treats legacy grams-only entries as one serving', () => {
    const legacy = normalizeEntry({ date: '2026-07-01', slot: 'lunch', foodName: 'Old', grams: 250, kcal: 300, nutrients: { kcal: 300 } });
    expect(legacy.servings).toBe(1);
    expect(legacy.servingGrams).toBe(250);
    expect(legacy.servingLabel).toBe('250 g');
    expect(rescaleEntry(legacy, { servings: 2 }).kcal).toBe(600);
  });
});

describe('day totals', () => {
  const entries = [
    entry(),
    entry({ slot: 'breakfast', foodId: 'banana', foodName: 'Banana', servingLabel: '1 medium', servingGrams: 118, servings: 1, nutrients: { kcal: 105, protein: 1.3 } }),
    entry({ slot: 'snacks', foodId: 'coffee', foodName: 'Coffee', servingLabel: '1 cup', servingGrams: 240, servings: 1, nutrients: { kcal: 5 } }),
  ];

  it('sums calories and every nutrient', () => {
    const t = dayTotals(entries);
    expect(t.kcal).toBe(289 + 105 + 5);
    expect(t.nutrients.kcal).toBeCloseTo(398.6, 2);
    expect(t.nutrients.protein).toBeCloseTo(13.07, 2);
    expect(t.nutrients.carbs).toBeCloseTo(33.2, 2);
  });

  it('breaks calories down by meal, defaulting unknown slots to snacks', () => {
    const t = dayTotals([...entries, entry({ slot: 'brunch', nutrients: { kcal: 100 } })]);
    expect(t.bySlot.lunch).toEqual({ kcal: 289, count: 1 });
    expect(t.bySlot.breakfast.kcal).toBe(105);
    expect(t.bySlot.snacks.kcal).toBe(105);
    expect(t.bySlot.snacks.count).toBe(2);
    expect(Object.keys(t.bySlot)).toEqual(SLOTS);
  });

  it('is empty-safe', () => {
    expect(dayTotals([])).toEqual({ kcal: 0, nutrients: {}, bySlot: Object.fromEntries(SLOTS.map((s) => [s, { kcal: 0, count: 0 }])) });
  });
});

describe('remaining calories', () => {
  it('computes Goal − Food + Exercise', () => {
    expect(remaining({ goalKcal: 2000, foodKcal: 1650, exerciseKcal: 320 }))
      .toEqual({ goalKcal: 2000, foodKcal: 1650, exerciseKcal: 320, left: 670, over: false });
  });
  it('flags going over', () => {
    expect(remaining({ goalKcal: 1800, foodKcal: 2100 }).over).toBe(true);
    expect(remaining({ goalKcal: 1800, foodKcal: 2100 }).left).toBe(-300);
  });
});

describe('macro energy split', () => {
  it('splits by calories, not grams, and sums to 100%', () => {
    const { pct, total } = macroEnergy({ protein: 50, carbs: 100, fat: 50 });
    expect(total).toBe(50 * 4 + 100 * 4 + 50 * 9);
    expect(pct.protein + pct.carbs + pct.fat).toBeCloseTo(100, 6);
    expect(pct.fat).toBeCloseTo(450 / 1050 * 100, 6);
  });
  it('reports zeroes for an empty day instead of NaN', () => {
    const { pct } = macroEnergy({});
    expect(pct).toEqual({ protein: 0, carbs: 0, fat: 0 });
  });
});

describe('dates and streaks', () => {
  it('shifts dates across month and year boundaries', () => {
    expect(shiftDate('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });
  it('builds an inclusive range ending today', () => {
    expect(dateRange('2026-07-24', 3)).toEqual(['2026-07-22', '2026-07-23', '2026-07-24']);
  });
  it('counts consecutive logged days', () => {
    const logged = ['2026-07-24', '2026-07-23', '2026-07-22', '2026-07-20'];
    expect(streak(logged, '2026-07-24')).toEqual({ days: 3, atRisk: false });
  });
  it('keeps a streak alive before today is logged, and marks it at risk', () => {
    expect(streak(['2026-07-23', '2026-07-22'], '2026-07-24')).toEqual({ days: 2, atRisk: true });
  });
  it('reports zero when nothing recent was logged', () => {
    expect(streak(['2026-07-01'], '2026-07-24')).toEqual({ days: 0, atRisk: false });
    expect(streak([], '2026-07-24')).toEqual({ days: 0, atRisk: false });
  });
});

describe('weight projection', () => {
  it('projects five weeks from today’s deficit', () => {
    // 500 kcal/day under maintenance for 35 days = 17500 kcal ≈ 2.3 kg
    const p = weightProjection({ tdee: 2400, foodKcal: 1900, exerciseKcal: 0, weightKg: 80 });
    expect(p.dailyDelta).toBe(-500);
    expect(p.changeKg).toBeCloseTo(-2.3, 1);
    expect(p.weightKg).toBeCloseTo(77.7, 1);
    expect(p.direction).toBe('lose');
  });
  it('credits exercise to the net intake', () => {
    const p = weightProjection({ tdee: 2400, foodKcal: 2400, exerciseKcal: 500, weightKg: 80 });
    expect(p.dailyDelta).toBe(-500);
  });
  it('reports maintenance when intake matches expenditure', () => {
    expect(weightProjection({ tdee: 2200, foodKcal: 2200, weightKg: 70 }).direction).toBe('maintain');
  });
  it('projects gains too', () => {
    const p = weightProjection({ tdee: 2000, foodKcal: 2500, weightKg: 60, weeks: 10 });
    expect(p.direction).toBe('gain');
    expect(p.changeKg).toBeCloseTo(500 * 70 / 7700, 1);
  });
});

describe('recent and frequent', () => {
  const log = [
    entry({ foodId: 'pizza', ts: 10 }),
    entry({ foodId: 'banana', foodName: 'Banana', ts: 20 }),
    entry({ foodId: 'pizza', ts: 30 }),
    entry({ foodId: 'coffee', foodName: 'Coffee', ts: 40, slot: 'breakfast' }),
    entry({ foodId: 'pizza', ts: 50 }),
  ];
  it('ranks frequent foods by count', () => {
    const top = rankFrequent(log);
    expect(top[0].key).toBe('pizza');
    expect(top[0].count).toBe(3);
    expect(top).toHaveLength(3);
  });
  it('ranks recent foods by last logged, one row per food', () => {
    const recent = rankRecent(log);
    expect(recent.map((r) => r.key)).toEqual(['pizza', 'coffee', 'banana']);
  });
  it('filters by meal slot', () => {
    expect(rankRecent(log, { slot: 'breakfast' }).map((r) => r.key)).toEqual(['coffee']);
  });
  it('groups quick-adds without a food id by name', () => {
    const quick = [entry({ foodId: undefined, foodName: 'Quick add', ts: 1 }), entry({ foodId: undefined, foodName: 'Quick add', ts: 2 })];
    expect(rankFrequent(quick)[0].count).toBe(2);
  });
});

describe('recipes and saved meals', () => {
  const items = [
    { grams: 200, nutrients: { kcal: 260, protein: 5.4 } },
    { grams: 150, nutrients: { kcal: 180, protein: 9 } },
  ];
  it('divides a recipe by its serving count', () => {
    const per = perServing({ items, servings: 4 });
    expect(per.nutrients.kcal).toBe(110);
    expect(per.nutrients.protein).toBe(3.6);
    expect(per.grams).toBe(87.5);
    expect(per.totalGrams).toBe(350);
  });
  it('treats a saved meal as a single serving', () => {
    expect(perServing({ items }).nutrients.kcal).toBe(440);
  });
  it('never divides by zero', () => {
    expect(perServing({ items, servings: 0 }).nutrients.kcal).toBe(440);
  });
});

describe('CSV export', () => {
  it('writes one row per entry plus a daily total row', () => {
    const csv = toCSV([entry(), entry({ slot: 'dinner', nutrients: { kcal: 100, protein: 1 } })], NUT, ['kcal', 'protein']);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Meal,Food,Brand,Serving,Servings,Grams,Calories (kcal),Protein (g)');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('TOTAL');
    expect(lines[3].endsWith('389,12.8')).toBe(true);
  });
  it('quotes fields containing commas or quotes', () => {
    const csv = toCSV([entry({ foodName: 'Pizza, "large"' })], NUT, ['kcal']);
    expect(csv).toContain('"Pizza, ""large"""');
  });
  it('groups by date in calendar order', () => {
    const csv = toCSV([entry({ date: '2026-07-25' }), entry({ date: '2026-07-24' })], NUT, ['kcal']);
    const dates = csv.split('\n').slice(1).map((l) => l.split(',')[0]);
    expect(dates).toEqual(['2026-07-24', '2026-07-24', '2026-07-25', '2026-07-25']);
  });
});
