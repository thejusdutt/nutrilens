/**
 * @nutrilens/off-food
 *
 * Turns an Open Food Facts product record into the same food shape the offline
 * USDA database uses, so a scanned packet behaves exactly like any other food
 * once it is in the diary.
 *
 * Two things make this more than a rename:
 *  1. **Units.** Open Food Facts stores nearly everything in grams per 100 g,
 *     including minerals and vitamins. Our database (and every nutrition label)
 *     uses mg for sodium and calcium, µg for folate and vitamin D. Getting this
 *     wrong is a 1000× error, so each field carries an explicit scale factor.
 *  2. **Trust.** The data is crowdsourced and often half-filled. A record with
 *     no energy, or with macros that cannot physically fit in 100 g, is rejected
 *     rather than logged as a confident number.
 *
 * Data is ODbL-licensed and requires attribution, which the UI shows next to any
 * scanned product.
 */

/** our key → [Open Food Facts nutriment key, multiplier to our unit] */
const FIELDS = {
  kcal: ['energy-kcal', 1],
  protein: ['proteins', 1],
  fat: ['fat', 1],
  carbs: ['carbohydrates', 1],
  fiber: ['fiber', 1],
  sugars: ['sugars', 1],
  satFat: ['saturated-fat', 1],
  monoFat: ['monounsaturated-fat', 1],
  polyFat: ['polyunsaturated-fat', 1],
  cholesterol: ['cholesterol', 1000],   // g → mg
  sodium: ['sodium', 1000],             // g → mg
  potassium: ['potassium', 1000],
  calcium: ['calcium', 1000],
  iron: ['iron', 1000],
  magnesium: ['magnesium', 1000],
  phosphorus: ['phosphorus', 1000],
  zinc: ['zinc', 1000],
  copper: ['copper', 1000],
  selenium: ['selenium', 1e6],          // g → µg
  vitA: ['vitamin-a', 1e6],
  vitC: ['vitamin-c', 1000],
  vitD: ['vitamin-d', 1e6],
  vitE: ['vitamin-e', 1000],
  vitK: ['vitamin-k', 1e6],
  thiamin: ['vitamin-b1', 1000],
  riboflavin: ['vitamin-b2', 1000],
  niacin: ['vitamin-pp', 1000],
  vitB6: ['vitamin-b6', 1000],
  folate: ['vitamin-b9', 1e6],
  vitB12: ['vitamin-b12', 1e6],
  choline: ['choline', 1000],
};

const KJ_PER_KCAL = 4.184;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Parse a serving size string into grams. Open Food Facts writes these by hand,
 * so the field is a free-text minefield: "30 g", "1 biscuit (12.5g)",
 * "250ml", "2 tranches (60 g)".
 * @param {string} text
 * @returns {{grams:number, label:string}|null}
 */
export function parseServing(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.trim();
  // Prefer a weight inside brackets — that is the gram figure for "1 cup (240 g)".
  const bracket = s.match(/\(([^)]*?)([\d.,]+)\s*(g|gram|grams|ml)\)/i);
  const plain = s.match(/([\d.,]+)\s*(g\b|gram|grams|ml\b)/i);
  const m = bracket ? { value: bracket[2], unit: bracket[3] } : plain ? { value: plain[1], unit: plain[2] } : null;
  if (!m) return null;
  const grams = parseFloat(m.value.replace(',', '.'));
  if (!(grams > 0) || grams > 5000) return null;
  // ml is treated as g: for the drinks people scan, density is ~1 g/ml, and the
  // alternative is refusing to log the product at all.
  return { grams: round2(grams), label: s.length <= 32 ? s : `${round2(grams)} g` };
}

/**
 * @param {object} product  Open Food Facts `product` object.
 * @param {{barcode?:string}} [opts]
 * @returns {{ok:true, food:object}|{ok:false, reason:string}}
 */
export function fromOffProduct(product, { barcode } = {}) {
  if (!product || typeof product !== 'object') return { ok: false, reason: 'no product data' };
  const nutriments = product.nutriments ?? {};
  const per100g = {};

  for (const [key, [offKey, scale]] of Object.entries(FIELDS)) {
    const raw = nutriments[`${offKey}_100g`] ?? nutriments[offKey];
    const value = typeof raw === 'string' ? parseFloat(raw) : raw;
    if (!Number.isFinite(value) || value < 0) continue;
    per100g[key] = round2(value * scale);
  }

  // Energy: prefer kcal, fall back to the kJ field every European label carries.
  if (per100g.kcal == null) {
    const kj = nutriments['energy-kj_100g'] ?? nutriments.energy_100g ?? nutriments.energy;
    if (Number.isFinite(kj) && kj > 0) per100g.kcal = round2(kj / KJ_PER_KCAL);
  }
  // Sodium is often absent while salt is present (salt = sodium × 2.5).
  if (per100g.sodium == null && Number.isFinite(nutriments.salt_100g)) {
    per100g.sodium = round2(nutriments.salt_100g / 2.5 * 1000);
  }

  if (!(per100g.kcal > 0)) return { ok: false, reason: 'product has no energy value' };
  const macroMass = (per100g.protein ?? 0) + (per100g.carbs ?? 0) + (per100g.fat ?? 0);
  if (macroMass > 105) return { ok: false, reason: 'implausible nutrition data (macros exceed 100 g)' };
  if (per100g.kcal > 950) return { ok: false, reason: 'implausible nutrition data (energy too high)' };

  const name = (product.product_name || product.generic_name || '').trim();
  if (!name) return { ok: false, reason: 'product has no name' };
  const brand = (product.brands || '').split(',')[0].trim() || null;

  const serving = parseServing(product.serving_size);
  const portions = [];
  if (serving) portions.push([serving.label, serving.grams]);
  portions.push(['100 g', 100]);

  return {
    ok: true,
    food: {
      id: `off:${barcode ?? product.code ?? name}`,
      name,
      brand,
      barcode: barcode ?? product.code ?? null,
      source: 'Open Food Facts (ODbL)',
      per100g,
      portions,
      // Packaged food comes in a packet, not a pile on a plate: portion
      // estimation from a photo does not apply, so the serving prior is the
      // label's own serving (or 100 g).
      prior: { servingG: serving?.grams ?? 100, heightCm: 2, densityGml: 1 },
      quality: {
        nutrientCount: Object.keys(per100g).length,
        hasServing: !!serving,
        completeness: Number(product.completeness) || null,
      },
    },
  };
}

/**
 * The v2 product endpoint, asking only for the fields we map. Open Food Facts
 * requests a descriptive User-Agent; browsers forbid setting that header, so the
 * app identifies itself with the `app_name`/`app_version` query parameters the
 * API also accepts.
 * @param {string} barcode
 * @param {{appName?:string, appVersion?:string}} [opts]
 */
export function productUrl(barcode, { appName = 'NutriLens', appVersion = '1.0' } = {}) {
  const fields = [
    'code', 'product_name', 'generic_name', 'brands', 'serving_size', 'completeness', 'nutriments',
  ].join(',');
  const q = new URLSearchParams({ fields, app_name: appName, app_version: appVersion });
  return `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?${q}`;
}
