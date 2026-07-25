/**
 * Turning a weight into words.
 *
 * Grams are what the app computes and what the diary stores, but "154 g" is
 * not how anyone describes a dosa. FNDDS ships household measures per food
 * ("1 cup", "1 medium chappatti or roti (7\")", "1 item, any size"), and this
 * module picks the one that fits and phrases it the way a person would.
 *
 * Deliberately free of DOM and of the food database: it takes a list of
 * measures and a number, so it can be unit-tested directly.
 */

/** Fractions worth saying out loud. */
const FRACTIONS = { 0.25: '¼', 0.5: '½', 0.75: '¾' };

/**
 * FNDDS measures already carry their own quantity, so pairing one with a count
 * gives "1.25 1 small". Strip the leading one; and when what remains says
 * nothing about the food ("item", "each"), name the food instead — "3¾ idli"
 * is the phrase someone would actually use.
 *
 * @param {string} label  e.g. "1 cup", "1 item, any size"
 * @param {string} [foodName]
 */
export function unitNoun(label, foodName = 'serving') {
  const stripped = String(label).replace(/^1\s+/i, '').replace(/,\s*any size$/i, '').trim();
  if (!stripped || /^(item|each|serving|portion|piece)$/i.test(stripped)) return foodName.toLowerCase();
  return stripped;
}

/** "1½", not "1.47". Quarters, because that is the resolution of a guess. */
export function niceCount(n) {
  // Round the original, not the quarter-rounded value: 11.4 → 11.5 → 12 is a
  // whole serving conjured out of two roundings.
  if (n >= 9.875) return String(Math.round(n));
  const q = Math.round(n * 4) / 4;
  const whole = Math.floor(q);
  const frac = FRACTIONS[Math.round((q - whole) * 100) / 100];
  if (!frac) return String(whole || q);
  return whole ? `${whole}${frac}` : frac;
}

/** Step size that keeps the count on values worth showing. */
export function stepFor(count) {
  if (count < 2) return 0.25;
  if (count < 6) return 0.5;
  return 1;
}

/**
 * The measure that best describes this weight of this food.
 *
 * Prefers a unit landing near a whole small number of servings — "2 idli"
 * reads better than "0.37 cup" even when the two weigh the same — and avoids
 * units so small or large that the count stops being meaningful.
 *
 * @param {[string, number][]|{label:string,grams:number}[]} measures
 * @param {number} grams
 * @param {string} [foodName]
 * @returns {{label:string, grams:number, count:number}}
 */
export function bestServing(measures, grams, foodName = 'serving') {
  const options = (measures ?? [])
    .map((m) => (Array.isArray(m) ? { label: m[0], grams: m[1] } : m))
    .filter((m) => m && m.grams >= 5 && m.label !== '100 g');
  if (!options.length) return { label: 'g', grams: 1, count: grams };

  let best = null;
  let bestCost = Infinity;
  for (const o of options) {
    const n = grams / o.grams;
    if (n < 0.25 || n > 12) continue;
    // Two costs: distance from a whole number, and distance from "about one
    // and a half servings", which is where household measures read best.
    const cost = Math.abs(n - Math.round(n)) + Math.abs(Math.log(n / 1.5)) * 0.35;
    if (cost < bestCost) { bestCost = cost; best = o; }
  }
  // Nothing in range: fall back to the measure closest to the weight itself,
  // rather than inventing a count of 40.
  if (!best) {
    best = options.reduce((a, b) => (Math.abs(b.grams - grams) < Math.abs(a.grams - grams) ? b : a));
  }
  return { label: unitNoun(best.label, foodName), grams: best.grams, count: grams / best.grams };
}

/** Ready-to-render phrase for a weight, e.g. "1½ cup". */
export const servingPhrase = (measures, grams, foodName) => {
  const u = bestServing(measures, grams, foodName);
  return `${niceCount(u.count)} ${u.label}`;
};
