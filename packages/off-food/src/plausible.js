/**
 * Physical checks on a per-100 g record. Open Food Facts is crowdsourced, so a
 * record can map cleanly and still be wrong: a kJ figure typed into the kcal
 * box, a per-serving value in a per-100 g field. The energy on a label is
 * computed from its macros, so disagreement between the two is the tell.
 *
 * Shared by tools/build-barcode-db.mjs (which decides what ships) and the
 * shipped-table test (which checks what did), so the rule exists once.
 */

/**
 * Stated kcal against the macros, under each way a label can count fibre:
 *   - not at all (older labels, or fibre missing),
 *   - inside carbohydrate at 2 kcal/g (US: carbs include fibre),
 *   - separate from carbohydrate at 2 kcal/g (EU: carbs exclude fibre).
 * Alcohol counts 7 kcal/g.
 * @param {object} n per100g
 * @returns {number} smallest kcal gap across the readings
 */
export function atwaterGap(n) {
  const base = 4 * n.protein + 4 * n.carbs + 9 * n.fat + 7 * (n.alcohol ?? 0);
  const f = n.fiber ?? 0;
  return Math.min(...[base, base - 2 * f, base + 2 * f].map((e) => Math.abs(n.kcal - e)));
}

/** Allowed kcal gap: 15%, never below 20 kcal (rounding on low-energy labels). */
export const atwaterTolerance = (kcal) => Math.max(20, 0.15 * kcal);

/**
 * @param {object} n per100g from fromOffProduct
 * @returns {string|null} why the record should not ship, or null if it is fine
 */
export function implausible(n) {
  if (![n.protein, n.carbs, n.fat].every(Number.isFinite)) return 'missing a macro';
  if (atwaterGap(n) > atwaterTolerance(n.kcal)) return 'kcal disagrees with macros';
  if ((n.sugars ?? 0) > n.carbs + 1 || (n.satFat ?? 0) > n.fat + 1) return 'part exceeds its whole';
  return null;
}

/**
 * Fibre is the field most often mistyped (LU Prince: 52 g). If macros plus
 * fibre overflow 100 g, the label must count fibre inside carbs, so sugars and
 * fibre together have to fit inside carbs too. When they cannot, the fibre
 * figure is wrong; drop it rather than the product, whose energy and macros may
 * still check out.
 * @param {object} n per100g, modified in place
 * @returns {boolean} whether fibre was dropped
 */
export function dropImpossibleFibre(n) {
  if (n.fiber == null) return false;
  if (n.protein + n.carbs + n.fat + n.fiber <= 105) return false;
  if ((n.sugars ?? 0) + n.fiber <= n.carbs + 1) return false;
  delete n.fiber;
  return true;
}
