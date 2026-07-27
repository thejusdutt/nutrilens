import { parseNutrition, validatePer100g } from './schema.js';

/**
 * The instruction that turns Claude into a disciplined nutrition calculator
 * rather than a chatbot guessing round numbers. Two things matter most:
 *
 *  1. It reasons from a *representative recipe* — real ingredients in grams —
 *     and derives per-100 g of the finished dish from them. A number with a
 *     recipe behind it is checkable and tends to be right; a number pulled from
 *     the air tends to be a memorable-looking lie.
 *  2. It reports the dish *as eaten*: cooked, drained, sauced, the oil it
 *     actually absorbed included. This is the single biggest source of error in
 *     naive food logging — raw vs cooked, dry vs absorbed.
 */
export const SYSTEM_PROMPT = [
  'You are a rigorous nutrition calculator used to build a food database.',
  'For the dish you are given, work out the nutrition of the finished dish AS EATEN',
  '(cooked, drained, sauced, with any oil actually absorbed), per 100 grams.',
  '',
  'Method, every time:',
  '1. Write a standard recipe for the dish as a list of ingredients with gram weights.',
  '2. Use well-established per-ingredient nutrition (USDA-style reference values).',
  '3. Account for cooking: water lost or gained, fat absorbed in frying, fat rendered off.',
  '4. Sum the finished dish, then divide to per-100-gram of the finished, as-eaten food.',
  '5. Check that kcal is within a few percent of 4*protein + 4*carbs + 9*fat - 2*fiber.',
  '   If it is not, your macros are wrong — fix them before answering.',
  '',
  'Then reply with ONLY a single minified JSON object, no prose, no code fence, keys:',
  'kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg,',
  'typical_serving_g (grams in one normal portion of this dish),',
  'confidence (0-1, how well-defined the dish is),',
  'ingredients (one short string, the recipe you used).',
  'All nutrient values are per 100 g of the finished dish. Numbers only, no units in values.',
].join('\n');

/**
 * Ask Claude for one dish's per-100 g nutrition, validate it, and retry once
 * with the failure reason fed back if it does not hold together.
 *
 * `transport` is injected so the same logic runs against Bedrock in a build
 * script, a hosted proxy at runtime, or a canned reply in a test. It is called
 * as `transport({ system, messages, maxTokens, model })` and must resolve to
 * the assistant's text.
 *
 * @param {string} dish  dish name, optionally with a hint ("dosa, plain crepe")
 * @param {{
 *   transport: (req:{system:string,messages:{role:string,content:string}[],maxTokens:number,model?:string})=>Promise<string>,
 *   context?: string, model?: string, retries?: number, maxTokens?: number,
 * }} opts
 * @returns {Promise<{dish:string, per100g:object, servingG:number|null, confidence:number|null,
 *   note:string|null, ingredients:string|null, valid:boolean, reasons:string[], attempts:number, raw:string}>}
 */
export async function estimateNutrition(dish, opts) {
  const { transport, context, model, retries = 1, maxTokens = 700 } = opts;
  if (typeof transport !== 'function') throw new Error('estimateNutrition needs a transport function');
  const ask = context
    ? `Dish: ${dish}\nContext: ${context}\nGive per-100 g nutrition of the finished dish as eaten.`
    : `Dish: ${dish}\nGive per-100 g nutrition of the finished dish as eaten.`;
  const messages = [{ role: 'user', content: ask }];
  let last = { valid: false, reasons: ['no attempt made'], per100g: {}, raw: '' };
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let raw;
    try {
      raw = await transport({ system: SYSTEM_PROMPT, messages, maxTokens, model });
    } catch (e) {
      last = { valid: false, reasons: [`transport error: ${e.message}`], per100g: {}, raw: '' };
      continue;
    }
    let parsed;
    try {
      parsed = parseNutrition(raw);
    } catch (e) {
      last = { valid: false, reasons: [e.message], per100g: {}, raw };
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `That was not usable: ${e.message}. Reply with ONLY the JSON object.` });
      continue;
    }
    const check = validatePer100g(parsed.per100g);
    last = { ...parsed, valid: check.ok, reasons: check.reasons, raw };
    if (check.ok) return { dish, ...last, attempts: attempt };
    // Feed the arithmetic failure back so the retry corrects rather than repeats.
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `The numbers do not hold together: ${check.reasons.join('; ')}. `
        + 'Recompute the recipe so energy matches the macros, then reply with ONLY the JSON object.',
    });
  }
  return { dish, ...last, attempts: retries + 1 };
}
