/**
 * Calorie, macro, water and weight goals — computed on the device, no account.
 *
 *   BMR (Mifflin-St Jeor, 1990) × activity factor = TDEE (maintenance)
 *   goal = TDEE + 7700 × (kg/week) / 7      (≈500 kcal/day per 0.5 kg/week)
 *
 * Macro targets can be driven either by percentage split (the usual way, always
 * summing to 100) or by explicit gram targets, because people following a
 * programme are given grams, not percentages. A manual calorie override wins
 * over the computation.
 *
 * Profile lives in localStorage: it is a handful of numbers, it is needed
 * synchronously on first paint, and it must survive the diary being cleared.
 */

export const ACTIVITY = [
  ['1.2', 'Sedentary (desk job, little exercise)'],
  ['1.375', 'Lightly active (1–3 workouts/week)'],
  ['1.55', 'Moderately active (3–5 workouts/week)'],
  ['1.725', 'Very active (6–7 workouts/week)'],
  ['1.9', 'Extra active (physical job + training)'],
];

export const RATE = [
  ['-1', 'Lose 1 kg / week'],
  ['-0.5', 'Lose 0.5 kg / week'],
  ['-0.25', 'Lose 0.25 kg / week'],
  ['0', 'Maintain weight'],
  ['0.25', 'Gain 0.25 kg / week'],
  ['0.5', 'Gain 0.5 kg / week'],
];

const DEFAULTS = {
  sex: 'male', age: 30, heightCm: 170, weightKg: 70,
  startWeightKg: null, goalWeightKg: null,
  activity: 1.55, rateKgWeek: 0, customKcal: null,
  macroMode: 'percent',                            // 'percent' | 'grams'
  macroPct: { carbs: 50, protein: 20, fat: 30 },
  macroG: { carbs: null, protein: null, fat: null },
  waterGoal: 8,                                    // glasses (250 ml)
  stepGoal: 10000,
  creditExercise: true,                            // add exercise calories back
  nutrientGoals: {},                               // key → target, overrides %DV
};

/** Lowest calorie goal we will suggest; below this, get a professional involved. */
export const MIN_KCAL = 1200;

export function getProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem('profile') ?? '{}');
    return {
      ...DEFAULTS, ...saved,
      macroPct: { ...DEFAULTS.macroPct, ...(saved.macroPct ?? {}) },
      macroG: { ...DEFAULTS.macroG, ...(saved.macroG ?? {}) },
      nutrientGoals: { ...(saved.nutrientGoals ?? {}) },
    };
  } catch { return structuredClone(DEFAULTS); }
}

export function setProfile(patch) {
  const p = { ...getProfile(), ...patch };
  localStorage.setItem('profile', JSON.stringify(p));
  return p;
}

/** Mifflin-St Jeor basal metabolic rate (kcal/day). */
export function bmr({ sex, age, heightCm, weightKg }) {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
}

/**
 * @returns {{kcal:number, tdee:number, macros:{protein:number,carbs:number,fat:number},
 *   source:'computed'|'custom', floored:boolean, macroMode:string}}
 */
export function dailyGoal(profile = getProfile()) {
  const tdee = Math.round(bmr(profile) * profile.activity);
  const computed = Math.round(tdee + (profile.rateKgWeek * 7700) / 7);
  const requested = profile.customKcal ?? computed;
  // The floor is a safety rail on the *suggestion*. When someone types their own
  // number we report that we clamped it rather than silently showing a goal they
  // did not ask for.
  const kcal = Math.max(MIN_KCAL, requested);

  let macros;
  if (profile.macroMode === 'grams' && ['carbs', 'protein', 'fat'].every((k) => profile.macroG[k] > 0)) {
    macros = { carbs: Math.round(profile.macroG.carbs), protein: Math.round(profile.macroG.protein), fat: Math.round(profile.macroG.fat) };
  } else {
    const pct = profile.macroPct;
    macros = {
      carbs: Math.round((kcal * pct.carbs / 100) / 4),
      protein: Math.round((kcal * pct.protein / 100) / 4),
      fat: Math.round((kcal * pct.fat / 100) / 9),
    };
  }
  return {
    kcal, tdee, macros,
    source: profile.customKcal != null ? 'custom' : 'computed',
    floored: kcal !== requested,
    macroMode: profile.macroMode,
  };
}

/** Calories implied by gram targets — shown so a grams-mode split can be sanity-checked. */
export const macroKcal = ({ protein, carbs, fat }) => Math.round(protein * 4 + carbs * 4 + fat * 9);

/** Do the percentages add up? Surfaced in settings rather than silently rescaled. */
export function macroPctSum(profile = getProfile()) {
  const p = profile.macroPct;
  return p.carbs + p.protein + p.fat;
}

/**
 * Daily target for any nutrient: an explicit user goal, else the FDA Daily Value
 * from the database, else null (tracked but untargeted).
 * @param {string} key
 * @param {{rdi:number|null}} meta
 * @param {object} [profile]
 */
export function nutrientGoal(key, meta, profile = getProfile()) {
  const custom = profile.nutrientGoals?.[key];
  if (Number.isFinite(custom) && custom > 0) return custom;
  return meta?.rdi ?? null;
}

/** Meal slot suggestion by local time. */
export function suggestSlot(d = new Date()) {
  const h = d.getHours();
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 17 && h < 22) return 'dinner';
  return 'snacks';
}

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks'];
export const SLOT_LABEL = { breakfast: '🌅 Breakfast', lunch: '☀️ Lunch', dinner: '🌙 Dinner', snacks: '🍿 Snacks' };

/** Weight goal progress, for the Progress screen. */
export function weightProgress(profile = getProfile()) {
  const { startWeightKg, goalWeightKg, weightKg } = profile;
  if (!(startWeightKg > 0) || !(goalWeightKg > 0)) return null;
  const total = startWeightKg - goalWeightKg;
  const done = startWeightKg - weightKg;
  return {
    startWeightKg, goalWeightKg, weightKg,
    totalKg: Math.round(total * 10) / 10,
    doneKg: Math.round(done * 10) / 10,
    remainingKg: Math.round((weightKg - goalWeightKg) * 10) / 10,
    pct: total === 0 ? 100 : Math.max(0, Math.min(100, done / total * 100)),
  };
}
