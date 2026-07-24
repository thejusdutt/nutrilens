import { describe, it, expect } from 'vitest';
import {
  ACTIVITIES, activity, searchActivities, kcalBurned, kcalBurnedNet,
  makeExerciseEntry, exerciseKcal, exerciseMinutes,
} from '../src/index.js';

describe('activity database', () => {
  it('has unique ids and plausible MET values', () => {
    const ids = ACTIVITIES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACTIVITIES) {
      expect(a.met, a.id).toBeGreaterThanOrEqual(1.5);
      expect(a.met, a.id).toBeLessThanOrEqual(20);
      expect(['cardio', 'strength']).toContain(a.type);
      expect(a.name.length, a.id).toBeGreaterThan(3);
    }
  });

  it('covers both cardio and strength', () => {
    expect(ACTIVITIES.filter((a) => a.type === 'strength').length).toBeGreaterThanOrEqual(5);
    expect(ACTIVITIES.filter((a) => a.type === 'cardio').length).toBeGreaterThanOrEqual(20);
  });

  it('orders MET values sensibly within a family', () => {
    expect(activity('walk').met).toBeLessThan(activity('jog').met);
    expect(activity('jog').met).toBeLessThan(activity('run-14').met);
    expect(activity('cycle-leisure').met).toBeLessThan(activity('cycle-vigorous').met);
    expect(activity('yoga').met).toBeLessThan(activity('yoga-power').met);
  });

  it('searches by words in any order', () => {
    expect(searchActivities('running').map((a) => a.id)).toContain('run-10');
    expect(searchActivities('weight training').map((a) => a.id)).toContain('weights-moderate');
    expect(searchActivities('bike').map((a) => a.id)).toContain('spinning');
    expect(searchActivities('zzz')).toEqual([]);
  });

  it('returns null for an unknown id', () => {
    expect(activity('nope')).toBeNull();
  });
});

describe('energy expenditure', () => {
  it('follows the ACSM formula', () => {
    // 8 MET, 70 kg, 30 min → 8 × 3.5 × 70 / 200 × 30 = 294 kcal
    expect(kcalBurned({ met: 8, minutes: 30, weightKg: 70 })).toBe(294);
  });

  it('scales linearly with time and body mass', () => {
    const a = kcalBurned({ met: 6, minutes: 30, weightKg: 80 });
    expect(kcalBurned({ met: 6, minutes: 60, weightKg: 80 })).toBe(a * 2);
    expect(kcalBurned({ met: 6, minutes: 30, weightKg: 160 })).toBe(a * 2);
  });

  it('credits net calories, not gross, to avoid double-counting rest', () => {
    // The calorie goal already assumes ~1 MET of existing expenditure.
    expect(kcalBurnedNet({ met: 8, minutes: 30, weightKg: 70 }))
      .toBe(kcalBurned({ met: 7, minutes: 30, weightKg: 70 }));
    expect(kcalBurnedNet({ met: 1, minutes: 60, weightKg: 70 })).toBe(0);
  });

  it('returns zero for nonsense input instead of NaN', () => {
    for (const p of [{ met: 0, minutes: 30, weightKg: 70 }, { met: 8, minutes: 0, weightKg: 70 },
      { met: 8, minutes: 30, weightKg: 0 }, { met: NaN, minutes: 30, weightKg: 70 }]) {
      expect(kcalBurned(p)).toBe(0);
    }
  });
});

describe('exercise entries', () => {
  it('builds a cardio entry from a preset', () => {
    const e = makeExerciseEntry({ date: '2026-07-24', activityId: 'run-10', minutes: 45, weightKg: 72, ts: 5 });
    expect(e.name).toBe('Running (10 km/h)');
    expect(e.type).toBe('cardio');
    expect(e.kcalGross).toBe(kcalBurned({ met: 10, minutes: 45, weightKg: 72 }));
    expect(e.kcal).toBe(kcalBurnedNet({ met: 10, minutes: 45, weightKg: 72 }));
    expect(e.kcalSource).toBe('met');
  });

  it('records sets and reps for strength work', () => {
    const e = makeExerciseEntry({
      date: '2026-07-24', activityId: 'weights-moderate', minutes: 40,
      weightKg: 72, sets: 4, reps: 8, weightLiftedKg: 60, ts: 5,
    });
    expect(e.type).toBe('strength');
    expect({ sets: e.sets, reps: e.reps, weightLiftedKg: e.weightLiftedKg }).toEqual({ sets: 4, reps: 8, weightLiftedKg: 60 });
    expect(e.kcal).toBeGreaterThan(0);
  });

  it('lets a watch reading win over the MET estimate', () => {
    const e = makeExerciseEntry({ date: '2026-07-24', activityId: 'cycle-moderate', minutes: 60, weightKg: 70, kcalOverride: 512, ts: 1 });
    expect(e.kcal).toBe(512);
    expect(e.kcalSource).toBe('manual');
  });

  it('accepts a custom activity with an explicit MET', () => {
    const e = makeExerciseEntry({ date: '2026-07-24', name: 'Kabaddi', met: 7.5, minutes: 30, weightKg: 68, ts: 1 });
    expect(e.name).toBe('Kabaddi');
    expect(e.activityId).toBeNull();
    expect(e.kcal).toBe(kcalBurnedNet({ met: 7.5, minutes: 30, weightKg: 68 }));
  });

  it('refuses a custom activity with no name or MET', () => {
    expect(() => makeExerciseEntry({ date: '2026-07-24', minutes: 30, weightKg: 70, ts: 1 })).toThrow(/needs a name/);
  });

  it('totals a day of exercise', () => {
    const day = [
      makeExerciseEntry({ date: '2026-07-24', activityId: 'walk', minutes: 30, weightKg: 70, ts: 1 }),
      makeExerciseEntry({ date: '2026-07-24', activityId: 'weights-light', minutes: 20, weightKg: 70, ts: 2 }),
    ];
    expect(exerciseKcal(day)).toBe(day[0].kcal + day[1].kcal);
    expect(exerciseMinutes(day)).toBe(50);
    expect(exerciseKcal([])).toBe(0);
    expect(exerciseKcal(undefined)).toBe(0);
  });
});
