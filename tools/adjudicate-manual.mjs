/**
 * Adjudicate the foods the cross-check waved through, by hand.
 *
 * `crossVerify`'s absolute escape used to be 2 g of protein and 2.5 g of fat.
 * On dishes carrying 3–8 g per 100 g that is a quarter to two thirds of the
 * whole figure, so the relative tolerance could never fire and 29 foods were
 * stamped "two-source confirmed" without their macros ever being compared.
 * Tightening the floor to 0.5 g re-opens them, and each one needs a decision.
 *
 * The rule applied here, and the reason each verdict is recorded:
 *
 *   CORRECT — the USDA row describes a *different preparation* from the dish
 *             its name promises (an undressed salad, a soup that is really
 *             juice, a rice ball with no filling), or the value is outside what
 *             the dish's own ingredients can produce.
 *   KEEP    — the two sources describe the same dish made differently. A thick
 *             rajma and a thin one are both rajma, and USDA is a survey of what
 *             people actually ate; a model's recipe is not better evidence.
 *
 * Corrections take the Sonnet macro set, which is Atwater-consistent by
 * construction (schema.js validates it), and keep USDA's micronutrients, which
 * come from measurement rather than reasoning. Fat sub-fractions are rescaled
 * to the corrected total so the parts still sum to the whole.
 *
 * Not a model call: this is a recorded human-reviewed judgement, committed like
 * the rest of the overlay so the build stays offline and reproducible.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** id -> [verdict, reason]. Every food the tightened floor re-opened. */
const VERDICTS = {
  // --- corrected: USDA describes another dish -------------------------------
  bibimbap: ['correct', '76 kcal/100 g is below plain cooked rice (130); a rice bowl with beef and egg cannot be lighter than its own base'],
  'seaweed-salad': ['correct', '41 kcal and 3.5 g protein is plain wakame; the salad as served is dressed with sesame oil and sugar'],
  'green-chutney': ['correct', '11.5 kcal/100 g is herbs in water — a coriander-mint chutney carries oil, nuts or coconut'],
  'tomato-soup': ['correct', '19 kcal/100 g is tomato juice; prepared soup is 35–80 depending on cream'],
  'fruit-salad': ['correct', '6.3 g of fat is impossible for mixed fruit, which is under 0.5 g'],
  soba: ['correct', '2.1 g of fat cannot come from buckwheat noodles, which are near fat-free'],
  udon: ['correct', '3.0 g of fat cannot come from wheat flour, salt and water'],
  onigiri: ['correct', '0.3 g fat and 2.7 g protein is the plain rice, with none of the filling the dish is named for'],
  dosa: ['correct', '5.7 g protein exceeds what a 3:1 rice-to-urad-dal batter yields once cooked and hydrated'],
  'masala-dosa': ['correct', 'same batter ceiling as dosa, and the potato filling dilutes protein further rather than raising it'],
  idli: ['correct', '6.4 g protein is too high for a steamed cake of the same batter at higher moisture'],
  'tomato-chutney': ['correct', '0.51 g protein is below plain tomato (0.9 g), before any dal or coconut'],
  lassi: ['correct', '3.65 g protein is undiluted yogurt; lassi is yogurt let down with water and sugar'],
  'curry-rice-jp': ['correct', '2.0 g protein implies a meat curry with no meat in it'],
  pudding: ['correct', '2.1 g protein is below the milk it is made from (3.4 g)'],

  // --- kept: a different version of the same dish ---------------------------
  'hot-and-sour-soup': ['keep', '39 kcal is a plausible thin broth; the models differ on how many solids are in the bowl'],
  'red-velvet-cake': ['keep', 'frosted-cake protein spans this range; neither side is outside it'],
  sushi: ['keep', 'generic sushi covers lean maki through nigiri, and USDA sits inside that span'],
  rajma: ['keep', 'a thick rajma really does reach 177 kcal; the model priced a thinner gravy'],
  poha: ['keep', 'flattened rice with a light tempering is plausible at 151 kcal and 2.6 g protein'],
  upma: ['keep', 'both sides are defensible for semolina at different water ratios; USDA is the wetter one'],
  chutney: ['keep', '0.33 g protein is right for a sugar-and-fruit preserve'],
  sambar: ['keep', 'sambar thickness varies more than the two estimates differ'],
  'spring-roll-fresh': ['keep', 'USDA is high for an unfried roll, but 0.17 g fat is lower than the filling allows — neither is better'],
  'roasted-vegetables': ['keep', 'calories agree exactly; the split depends on how much oil, which the name does not fix'],
  'corn-on-cob': ['keep', 'buttered corn at 119 kcal is reasonable; 16 g of fat is more butter than corn'],
  trifle: ['keep', 'sponge, custard and cream together support 3.5 g protein'],
  'mexican-rice': ['keep', 'within the range of how much oil and tomato the rice is cooked in'],
  'wonton-soup': ['keep', 'broth-to-wonton ratio, not a disagreement about the food'],
};

const MACROS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'sodium'];
const FAT_PARTS = ['satFat', 'monoFat', 'polyFat'];

const base = JSON.parse(readFileSync(join(root, 'tools/data/nutrition-db.base.json'), 'utf8')).foods;
const cache = JSON.parse(readFileSync(join(root, 'tools/data/claude-nutrition-cache.json'), 'utf8'));
const overlayPath = join(root, 'tools/data/claude-overlay.json');
const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));

const sonnet = {};
for (const [k, v] of Object.entries(cache)) sonnet[k.split('::')[0]] ??= v;

let corrected = 0; let kept = 0; let alreadyFixed = 0;
for (const [id, [verdict, reason]] of Object.entries(VERDICTS)) {
  const usda = base[id]?.per100g;
  const est = sonnet[id]?.per100g;
  if (!usda || !est) { console.warn(`skip ${id}: missing data`); continue; }

  if (verdict === 'keep') {
    overlay[id] = { ...(overlay[id] ?? {}), source: 'usda-kept-on-review', reviewedAt: '2026-08-08', note: reason };
    kept++;
    continue;
  }

  // Never overwrite a two-model consensus with one model plus one reviewer.
  //
  // Some of these foods were already corrected — the sweep that found them
  // compared the *pristine USDA base* against Sonnet, and for anything the
  // earlier pass had already fixed, that disagreement was stale. Bibimbap's
  // shipped value was 122.8, not the 76 the comparison showed, and "correcting"
  // it to Sonnet's 121 would trade a blended two-model figure for a single
  // estimate. Fewer sources is not a correction.
  if (overlay[id]?.per100g) {
    overlay[id].reviewNote = `already corrected by ${overlay[id].source}; manual review agreed and left it alone`;
    alreadyFixed++;
    continue;
  }

  // Corrected: model macros over measured micronutrients.
  const per100g = { ...usda };
  for (const k of MACROS) if (est[k] != null) per100g[k] = est[k];

  // Keep the fat sub-fractions summing to the corrected total.
  const oldFat = usda.fat ?? 0;
  const newFat = per100g.fat ?? 0;
  if (oldFat > 0 && newFat > 0) {
    const s = newFat / oldFat;
    for (const p of FAT_PARTS) if (usda[p] != null) per100g[p] = usda[p] * s;
  }

  overlay[id] = {
    source: 'manual-review',
    reviewedAt: '2026-08-08',
    note: reason,
    usdaPer100g: { kcal: usda.kcal, protein: usda.protein, carbs: usda.carbs, fat: usda.fat },
    per100g,
    ...(sonnet[id].servingG ? { servingG: sonnet[id].servingG } : {}),
  };
  corrected++;
}

writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 1)}\n`);
console.log(`overlay updated: ${corrected} corrected, ${kept} kept on review, ${alreadyFixed} left to an existing two-model correction`);
