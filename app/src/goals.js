/**
 * Daily calorie & macro goals, MyFitnessPal-style, computed fully offline:
 *   BMR (Mifflin-St Jeor, 1990) × activity factor = TDEE (maintenance)
 *   goal = TDEE + 7700·(kg/week)/7   (≈500 kcal/day per 0.5 kg/week)
 *   macro targets from % split (default 50% carbs / 20% protein / 30% fat).
 * Profile persists in localStorage; a manual calorie override always wins.
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
  activity: 1.55, rateKgWeek: 0, customKcal: null,
  macroPct: { carbs: 50, protein: 20, fat: 30 }, // MFP default split
};

export function getProfile() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('profile') ?? '{}') };
  } catch { return { ...DEFAULTS }; }
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
 * @returns {{ kcal:number, tdee:number, macros:{protein:number,carbs:number,fat:number} (grams), source:'computed'|'custom' }}
 */
export function dailyGoal(profile = getProfile()) {
  const tdee = Math.round(bmr(profile) * profile.activity);
  // 7700 kcal ≈ 1 kg of body weight change.
  let kcal = profile.customKcal ?? Math.round(tdee + (profile.rateKgWeek * 7700) / 7);
  kcal = Math.max(1200, kcal); // MFP floors goals for safety; never suggest a crash diet
  const pct = profile.macroPct;
  return {
    kcal,
    tdee,
    source: profile.customKcal != null ? 'custom' : 'computed',
    macros: {
      carbs: Math.round((kcal * pct.carbs / 100) / 4),   // 4 kcal/g
      protein: Math.round((kcal * pct.protein / 100) / 4),
      fat: Math.round((kcal * pct.fat / 100) / 9),       // 9 kcal/g
    },
  };
}

/** Meal slot suggestion by local time, like MFP's quick-add default. */
export function suggestSlot(d = new Date()) {
  const h = d.getHours();
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 17 && h < 22) return 'dinner';
  return 'snacks';
}

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks'];
export const SLOT_LABEL = { breakfast: '🌅 Breakfast', lunch: '☀️ Lunch', dinner: '🌙 Dinner', snacks: '🍿 Snacks' };
