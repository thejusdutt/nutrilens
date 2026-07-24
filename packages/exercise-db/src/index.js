/**
 * @nutrilens/exercise-db
 *
 * Energy expenditure for logged exercise, computed offline from MET values.
 *
 * MET (metabolic equivalent of task) values follow the 2011 Compendium of
 * Physical Activities (Ainsworth et al.), the same reference table consumer
 * trackers use. Calories come from the ACSM relationship
 *
 *     kcal/min = MET × 3.5 × bodyMassKg / 200
 *
 * which is exact for the compendium's definition of a MET (3.5 ml O₂/kg/min)
 * and 5 kcal per litre of oxygen. Nothing here needs a network, a wearable, or
 * a heart-rate strap: duration, body mass and activity choice are enough.
 *
 * Strength training is billed by time under the same formula — sets and reps
 * are recorded because people want them logged, not because a rep count tells
 * you anything reliable about energy cost.
 */

/** @typedef {{id:string, name:string, met:number, type:'cardio'|'strength', per?:'distance'}} Activity */

/** @type {Activity[]} */
export const ACTIVITIES = [
  // --- walking / running (compendium 17xxx) ---
  { id: 'walk-slow', name: 'Walking, slow (3 km/h)', met: 2.8, type: 'cardio' },
  { id: 'walk', name: 'Walking, moderate (5 km/h)', met: 3.5, type: 'cardio' },
  { id: 'walk-brisk', name: 'Walking, brisk (6.5 km/h)', met: 5.0, type: 'cardio' },
  { id: 'walk-uphill', name: 'Walking uphill', met: 6.0, type: 'cardio' },
  { id: 'hiking', name: 'Hiking, cross-country', met: 6.0, type: 'cardio' },
  { id: 'stairs', name: 'Stair climbing', met: 8.8, type: 'cardio' },
  { id: 'jog', name: 'Jogging (8 km/h)', met: 8.0, type: 'cardio' },
  { id: 'run-10', name: 'Running (10 km/h)', met: 10.0, type: 'cardio' },
  { id: 'run-12', name: 'Running (12 km/h)', met: 11.8, type: 'cardio' },
  { id: 'run-14', name: 'Running (14 km/h)', met: 14.0, type: 'cardio' },
  { id: 'treadmill', name: 'Treadmill, moderate', met: 7.0, type: 'cardio' },
  // --- cycling ---
  { id: 'cycle-leisure', name: 'Cycling, leisure (16 km/h)', met: 4.0, type: 'cardio' },
  { id: 'cycle-moderate', name: 'Cycling, moderate (20 km/h)', met: 8.0, type: 'cardio' },
  { id: 'cycle-vigorous', name: 'Cycling, vigorous (25 km/h)', met: 10.0, type: 'cardio' },
  { id: 'spinning', name: 'Stationary bike / spinning', met: 8.5, type: 'cardio' },
  // --- water ---
  { id: 'swim-leisure', name: 'Swimming, leisurely', met: 6.0, type: 'cardio' },
  { id: 'swim-laps', name: 'Swimming laps, moderate', met: 8.3, type: 'cardio' },
  { id: 'aqua-aerobics', name: 'Water aerobics', met: 5.5, type: 'cardio' },
  // --- gym classes ---
  { id: 'elliptical', name: 'Elliptical trainer', met: 5.0, type: 'cardio' },
  { id: 'rowing', name: 'Rowing machine, moderate', met: 7.0, type: 'cardio' },
  { id: 'aerobics', name: 'Aerobics class', met: 7.3, type: 'cardio' },
  { id: 'zumba', name: 'Zumba / dance fitness', met: 6.5, type: 'cardio' },
  { id: 'hiit', name: 'HIIT / circuit training', met: 8.0, type: 'cardio' },
  { id: 'jump-rope', name: 'Jump rope', met: 11.0, type: 'cardio' },
  { id: 'rowing-vigorous', name: 'Rowing machine, vigorous', met: 8.5, type: 'cardio' },
  // --- mind & body ---
  { id: 'yoga', name: 'Yoga, hatha', met: 2.5, type: 'cardio' },
  { id: 'yoga-power', name: 'Yoga, power / vinyasa', met: 4.0, type: 'cardio' },
  { id: 'pilates', name: 'Pilates', met: 3.0, type: 'cardio' },
  { id: 'stretching', name: 'Stretching / mobility', met: 2.3, type: 'cardio' },
  // --- sport ---
  { id: 'football', name: 'Football (soccer), casual', met: 7.0, type: 'cardio' },
  { id: 'cricket', name: 'Cricket', met: 4.8, type: 'cardio' },
  { id: 'badminton', name: 'Badminton, social', met: 5.5, type: 'cardio' },
  { id: 'tennis', name: 'Tennis, singles', met: 8.0, type: 'cardio' },
  { id: 'basketball', name: 'Basketball, game', met: 8.0, type: 'cardio' },
  { id: 'table-tennis', name: 'Table tennis', met: 4.0, type: 'cardio' },
  { id: 'squash', name: 'Squash', met: 7.3, type: 'cardio' },
  { id: 'boxing-bag', name: 'Boxing, punching bag', met: 5.5, type: 'cardio' },
  { id: 'martial-arts', name: 'Martial arts', met: 10.3, type: 'cardio' },
  // --- daily life ---
  { id: 'housework', name: 'Housework, general', met: 3.3, type: 'cardio' },
  { id: 'gardening', name: 'Gardening', met: 3.8, type: 'cardio' },
  { id: 'childcare', name: 'Playing with children, active', met: 4.0, type: 'cardio' },
  { id: 'shopping', name: 'Grocery shopping, walking', met: 2.3, type: 'cardio' },
  // --- strength ---
  { id: 'weights-light', name: 'Weight training, light', met: 3.5, type: 'strength' },
  { id: 'weights-moderate', name: 'Weight training, moderate', met: 5.0, type: 'strength' },
  { id: 'weights-vigorous', name: 'Weight training, vigorous', met: 6.0, type: 'strength' },
  { id: 'bodyweight', name: 'Bodyweight circuit (push-ups, squats)', met: 8.0, type: 'strength' },
  { id: 'powerlifting', name: 'Powerlifting, heavy singles', met: 6.0, type: 'strength' },
  { id: 'kettlebell', name: 'Kettlebell training', met: 8.0, type: 'strength' },
  { id: 'core', name: 'Core / abdominal work', met: 3.8, type: 'strength' },
];

const byId = new Map(ACTIVITIES.map((a) => [a.id, a]));

/** @param {string} id @returns {Activity|null} */
export const activity = (id) => byId.get(id) ?? null;

/** Substring search over activity names, cardio first, then by intensity. */
export function searchActivities(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return ACTIVITIES.slice(0, limit);
  const tokens = q.split(/\s+/);
  return ACTIVITIES
    .filter((a) => tokens.every((t) => a.name.toLowerCase().includes(t) || a.id.includes(t)))
    .slice(0, limit);
}

/**
 * Calories burned, ACSM: kcal/min = MET × 3.5 × kg / 200.
 * @param {{met:number, minutes:number, weightKg:number}} p
 * @returns {number} kcal, rounded
 */
export function kcalBurned({ met, minutes, weightKg }) {
  if (!(met > 0) || !(minutes > 0) || !(weightKg > 0)) return 0;
  return Math.round(met * 3.5 * weightKg / 200 * minutes);
}

/**
 * Net calories — what a diary should credit back. Sitting still for that hour
 * would already have burned ~1 MET, and the calorie goal is built from a TDEE
 * that assumes those resting calories, so awarding the gross figure
 * double-counts them.
 * @param {{met:number, minutes:number, weightKg:number}} p
 */
export function kcalBurnedNet({ met, minutes, weightKg }) {
  return Math.max(0, kcalBurned({ met: Math.max(0, met - 1), minutes, weightKg }));
}

/**
 * Build an exercise diary entry.
 * @param {Object} p
 * @param {string} p.date
 * @param {string} [p.activityId]  Omitted for a custom activity.
 * @param {string} [p.name]        Required when there is no activityId.
 * @param {number} [p.met]         Required when there is no activityId.
 * @param {number} p.minutes
 * @param {number} p.weightKg
 * @param {number} [p.sets] @param {number} [p.reps] @param {number} [p.weightLiftedKg]
 * @param {number} [p.kcalOverride] User typed the burn from a watch — that wins.
 * @param {number} p.ts
 */
export function makeExerciseEntry({
  date, activityId, name, met, minutes, weightKg,
  sets, reps, weightLiftedKg, kcalOverride, ts,
}) {
  const preset = activityId ? activity(activityId) : null;
  const useMet = met ?? preset?.met;
  if (!preset && !(name && useMet > 0)) throw new Error('custom exercise needs a name and a MET value');
  const gross = kcalBurned({ met: useMet, minutes, weightKg });
  const net = kcalBurnedNet({ met: useMet, minutes, weightKg });
  return {
    date,
    activityId: activityId ?? null,
    name: name ?? preset.name,
    type: preset?.type ?? (sets || reps ? 'strength' : 'cardio'),
    met: useMet,
    minutes,
    sets: sets ?? null,
    reps: reps ?? null,
    weightLiftedKg: weightLiftedKg ?? null,
    kcalGross: gross,
    kcal: Math.round(kcalOverride ?? net),
    kcalSource: kcalOverride != null ? 'manual' : 'met',
    ts,
  };
}

/** Total credited calories for a day's exercise entries. */
export const exerciseKcal = (entries) => Math.round((entries ?? []).reduce((s, e) => s + (e.kcal ?? 0), 0));

/** Total minutes moved, for the activity summary. */
export const exerciseMinutes = (entries) => (entries ?? []).reduce((s, e) => s + (e.minutes ?? 0), 0);
