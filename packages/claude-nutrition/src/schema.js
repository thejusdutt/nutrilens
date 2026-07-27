/**
 * Shape and sanity rules for a Claude-computed nutrition record.
 *
 * A language model will happily return numbers that do not add up. The whole
 * point of this layer is that nothing it says is trusted until it survives the
 * same arithmetic a nutrition label has to: energy has to match the macros
 * that carry it, and no per-100 g figure may exceed what 100 g can physically
 * hold. A record that fails is thrown away, not shipped.
 */

/**
 * Claude output key → NutriLens database key + unit. The database keys are the
 * ones in tools/nutrient-map.mjs, so a verified record drops straight into a
 * food's `per100g` with no renaming.
 */
export const FIELD_MAP = {
  kcal: { db: 'kcal', unit: 'kcal' },
  protein_g: { db: 'protein', unit: 'g' },
  carbs_g: { db: 'carbs', unit: 'g' },
  fat_g: { db: 'fat', unit: 'g' },
  fiber_g: { db: 'fiber', unit: 'g' },
  sugar_g: { db: 'sugars', unit: 'g' },
  sat_fat_g: { db: 'satFat', unit: 'g' },
  sodium_mg: { db: 'sodium', unit: 'mg' },
};

/** The macros energy is computed from, with their Atwater factors (kcal/g). */
export const ATWATER = { protein: 4, carbs: 4, fat: 9, fiber: 2 };

/** Energy implied by the macros. Fibre is counted at 2 kcal/g, as FDA does. */
export function atwaterKcal({ protein = 0, carbs = 0, fat = 0, fiber = 0 }) {
  // Net-carb view: fibre is part of `carbs` by USDA "by difference", so it is
  // already counted at 4; subtract the 2 it does not actually yield.
  return 4 * protein + 4 * carbs + 9 * fat - 2 * fiber;
}

/**
 * Pull the first JSON object out of a model reply and coerce its known fields
 * to numbers. Tolerant of a stray ```json fence or a sentence before the
 * brace, strict about everything after: unknown text is ignored, missing
 * required keys throw.
 * @param {string} text
 * @returns {{per100g:object, servingG:number|null, confidence:number|null, note:string|null, ingredients:string|null}}
 */
export function parseNutrition(text) {
  if (typeof text !== 'string') throw new Error('nutrition reply is not text');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 80)}`);
  let raw;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`nutrition reply is not valid JSON: ${e.message}`);
  }
  const num = (v) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : undefined;
  };
  const per100g = {};
  for (const [key, { db }] of Object.entries(FIELD_MAP)) {
    const v = num(raw[key]);
    if (v !== undefined) per100g[db] = v;
  }
  if (per100g.kcal === undefined) throw new Error('nutrition reply has no kcal');
  for (const k of ['protein', 'carbs', 'fat']) {
    if (per100g[k] === undefined) throw new Error(`nutrition reply has no ${k}`);
  }
  return {
    per100g,
    servingG: num(raw.typical_serving_g) ?? null,
    confidence: num(raw.confidence) ?? null,
    note: typeof raw.note === 'string' ? raw.note : null,
    ingredients: typeof raw.ingredients === 'string' ? raw.ingredients
      : Array.isArray(raw.ingredients) ? raw.ingredients.join(', ') : null,
  };
}

/**
 * Is a per-100 g record physically possible and internally consistent?
 * @param {object} per100g
 * @param {{atwaterTolPct?:number, atwaterTolAbs?:number}} [opts]
 * @returns {{ok:boolean, reasons:string[], atwater:number}}
 */
export function validatePer100g(per100g, opts = {}) {
  const reasons = [];
  const { kcal = 0, protein = 0, carbs = 0, fat = 0, fiber = 0, sugars = 0, sodium = 0 } = per100g;
  const atwater = atwaterKcal({ protein, carbs, fat, fiber });
  const tolPct = opts.atwaterTolPct ?? 0.25;
  const tolAbs = opts.atwaterTolAbs ?? 20;
  if (Math.abs(kcal - atwater) > Math.max(tolAbs, atwater * tolPct)) {
    reasons.push(`kcal ${kcal} disagrees with 4P+4C+9F-2Fib=${atwater.toFixed(0)}`);
  }
  if (kcal < 0 || kcal > 900) reasons.push(`kcal ${kcal} out of range 0-900`);
  if (protein < 0 || protein > 92) reasons.push(`protein ${protein} out of range`);
  if (fat < 0 || fat > 100) reasons.push(`fat ${fat} out of range`);
  if (carbs < 0 || carbs > 100) reasons.push(`carbs ${carbs} out of range`);
  if (protein + carbs + fat > 105) reasons.push(`P+C+F ${(protein + carbs + fat).toFixed(0)} > 105 g/100 g`);
  if (fiber > carbs + 1) reasons.push(`fiber ${fiber} exceeds carbs ${carbs}`);
  if (sugars > carbs + 1) reasons.push(`sugar ${sugars} exceeds carbs ${carbs}`);
  if (sodium < 0 || sodium > 40000) reasons.push(`sodium ${sodium} mg out of range`);
  return { ok: reasons.length === 0, reasons, atwater };
}
