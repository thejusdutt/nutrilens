/**
 * @nutrilens/portion-estimator
 *
 * Best-practical portion (mass) estimation from a single uncalibrated RGB
 * photo. Exact single-image portion estimation is an open research problem;
 * this library implements the strongest browser-only approximation and is
 * honest about uncertainty — every estimate carries a low/high range and a
 * `method` tag so UIs can communicate provenance.
 *
 * Methods, in order of preference:
 *  1. `plate-scale` — a detected plate rim (assumed circular, default ⌀ 26 cm)
 *     gives cm/px on the food plane, including foreshortening from the
 *     ellipse axis ratio; mask area (cm²) × per-food height prior (cm) ×
 *     density prior (g/cm³) → grams.
 *  2. `serving-prior` — no plate found: the food's typical serving mass
 *     (from FNDDS portion statistics) with a wide uncertainty band.
 *
 * @example
 * const plate = detectPlateEllipse(rawImage);
 * const est = new PortionEstimator().estimate({
 *   areaPx: seg.areaPx, imageWidth: img.width, imageHeight: img.height,
 *   plate, prior: { heightCm: 2.5, densityGml: 0.9, servingG: 300 },
 * });
 * // → { grams: 342, low: 214, high: 547, method: 'plate-scale', areaCm2: 152 }
 */
export { detectPlateEllipse, leastSquaresEllipse } from './plate-detector.js';

/** Default plate diameter prior (cm). Dinner plates cluster at 26–27 cm. */
export const DEFAULT_PLATE_DIAMETER_CM = 26;

/**
 * Minimum plate-rim angular coverage before the ellipse is trusted as a scale
 * reference. Below this the "plate" is usually a bowl rim, a pan edge or an
 * accident of food texture.
 */
export const MIN_PLATE_CONFIDENCE = 0.7;

/**
 * How much of the frame a single dish occupies in a typical food photo —
 * the reference point when there is no plate to measure against. People
 * frame food to fill the shot, so this is high.
 */
export const TYPICAL_FRAME_OCCUPANCY = 0.38;

/** Furthest the geometry may move a portion from the food's typical serving. */
export const MAX_SERVING_FACTOR = 2.5;

/**
 * Food covering at least this share of the detected ellipse means the ellipse
 * is the food's own bowl, not a plate underneath it.
 */
export const BOWL_FILL_RATIO = 0.62;

/**
 * @typedef {Object} FoodPrior
 * @property {number} [heightCm=2.2]   Typical pile height of this food on a plate.
 * @property {number} [densityGml=0.8] Bulk density in g/cm³ (FAO/INFOODS-informed).
 * @property {number} [servingG=300]   Typical serving mass (FNDDS median portion).
 * @property {number} [spread=1.6]     Multiplicative 1-sigma uncertainty of the area method.
 */

export class PortionEstimator {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.plateDiameterCm=26] User-configurable plate size prior.
   * @param {number} [opts.minGrams=10]
   * @param {number} [opts.maxGrams=1500]
   */
  constructor(opts = {}) {
    this.plateDiameterCm = opts.plateDiameterCm ?? DEFAULT_PLATE_DIAMETER_CM;
    this.minGrams = opts.minGrams ?? 10;
    this.maxGrams = opts.maxGrams ?? 1500;
    this.minPlateConfidence = opts.minPlateConfidence ?? MIN_PLATE_CONFIDENCE;
    this.maxFactor = opts.maxFactor ?? MAX_SERVING_FACTOR;
  }

  /**
   * Estimate the mass of a segmented food region.
   *
   * @param {Object} p
   * @param {number} p.areaPx        Foreground pixel count of the food mask
   *                                 (use {@link maskAreaInsideEllipse} so pixels
   *                                 outside the plate rim don't get priced as food).
   * @param {number} p.imageWidth
   * @param {number} p.imageHeight
   * @param {import('./plate-detector.js').PlateEllipse|null} [p.plate]
   * @param {FoodPrior} [p.prior]
   * @param {number} [p.dishCount=1] How many dishes share this photo — see
   *   the frame-scale branch; ignored when a plate anchors the scale.
   * @returns {{grams:number, low:number, high:number, method:'plate-scale'|'bowl-scale'|'frame-scale'|'serving-prior', areaCm2:number|null, plateConfidence:number|null, sizeFactor:number}}
   */
  estimate({ areaPx, imageWidth, imageHeight, plate = null, prior = {}, dishCount = 1 }) {
    const heightCm = prior.heightCm ?? 2.2;
    const densityGml = prior.densityGml ?? 0.8;
    const servingG = prior.servingG ?? 300;
    const spread = prior.spread ?? 1.55;
    const usePlate = !!plate && plate.confidence >= this.minPlateConfidence && areaPx > 0;

    // One model, two reference frames. In both, the answer is the food's own
    // typical serving scaled by how large this helping looks *relative to what
    // a typical helping looks like* — which is how a person reads a photo
    // ("that's a big dosa, call it one and a half"). Geometry sets the factor;
    // it never sets the mass outright.
    let ratio = null;   // observed share of the reference area
    let expected = null; // share a typical serving of this food would occupy
    let w; let method;

    if (usePlate) {
      // Share of the plate's surface the food covers. Note the metric scale
      // cancels out of ratio/expected — the plate diameter prior only ever
      // affects `areaCm2`, which is reported, not used.
      const plateAreaPx = Math.PI * plate.rx * plate.ry;
      const plateAreaCm2 = Math.PI * (this.plateDiameterCm / 2) ** 2;
      ratio = Math.min(areaPx / plateAreaPx, 0.95);
      expected = Math.min(0.95, servingG / (heightCm * densityGml * plateAreaCm2));
      // Trust geometry more when the rim is fully evidenced.
      w = plate.confidence >= 0.75 ? 0.6 : 0.45;
      method = 'plate-scale';
      // Food covering nearly the whole ellipse means the ellipse is the food's
      // own container, not a plate it is sitting on — a bowl rim traced round a
      // bowl of dal. That outline says nothing about depth, which is where all
      // the mass is, so the area reading carries almost no information and a
      // 200 g serving was being read as 500 g. Fall back toward the statistic.
      if (ratio >= BOWL_FILL_RATIO) { w = 0.2; method = 'bowl-scale'; }
    } else if (areaPx > 0 && imageWidth && imageHeight) {
      // No usable plate: the frame itself is the only reference. It says
      // nothing about absolute size, but a dish filling 70% of the shot really
      // is a bigger helping than one filling 15%, so it still carries signal —
      // just weakly, hence the low weight.
      ratio = Math.min(areaPx / (imageWidth * imageHeight), 0.95);
      // Split the frame between the dishes sharing it. A thali of four fills
      // more of the shot than a single bowl does, but not four times as much —
      // people step back. Sub-linear growth (√n) keeps a single dish at the
      // full reference while stopping every dish on a crowded plate from being
      // judged small and logged at half its weight.
      expected = TYPICAL_FRAME_OCCUPANCY / Math.sqrt(Math.max(1, dishCount));
      w = 0.35;
      method = 'frame-scale';
    } else {
      const s = 2.0; // wide band — nothing in the image anchors the scale
      return {
        grams: Math.round(this._clamp(servingG)),
        low: Math.round(this._clamp(servingG / s)),
        high: Math.round(this._clamp(servingG * s)),
        method: 'serving-prior',
        areaCm2: null,
        plateConfidence: plate?.confidence ?? null,
        sizeFactor: 1,
      };
    }

    // Bounded because the inputs are unreliable in ways the maths cannot see:
    // a bowl rim and a dinner plate both fit an ellipse, but one is 16 cm and
    // the other 26 cm — a 2.6× area error. Letting the factor run free is how
    // a naan became 22 g and half an omelette became 605 g. Real helpings of a
    // known dish live within about 2.5× of its typical serving; outside that
    // the photo is telling us something the model cannot represent, and the
    // honest answer is the serving statistic with a wide band.
    const raw = (ratio / expected) ** w;
    const sizeFactor = Math.min(this.maxFactor, Math.max(1 / this.maxFactor, raw));
    const grams = this._clamp(servingG * sizeFactor);
    const clamped = Math.abs(Math.log(raw / sizeFactor)) > 1e-6;
    const s = spread * (method === 'plate-scale' && !clamped ? 1 : 1.25);

    return {
      grams: Math.round(grams),
      low: Math.round(this._clamp(grams / s)),
      high: Math.round(this._clamp(grams * s)),
      method,
      areaCm2: usePlate
        ? Math.round(ratio * Math.PI * (this.plateDiameterCm / 2) ** 2)
        : null,
      plateConfidence: plate?.confidence ?? null,
      sizeFactor: Number(sizeFactor.toFixed(2)),
    };
  }

  /** @private */
  _clamp(g) { return Math.min(this.maxGrams, Math.max(this.minGrams, g)); }
}

/**
 * Count mask pixels that lie inside the plate ellipse (with a small margin).
 * Food sits on the plate; mask area outside the rim is background bleed
 * (table, shadows, napkins) and must not be priced as food.
 *
 * @param {Uint8Array} mask 0/1, length = width*height
 * @param {number} width
 * @param {number} height
 * @param {import('./plate-detector.js').PlateEllipse} plate
 * @param {number} [margin=1.05] Allowed normalized radius (1 = exactly the rim).
 * @returns {number} pixel count
 */
export function maskAreaInsideEllipse(mask, width, height, plate, margin = 1.05) {
  const m2 = margin * margin;
  let count = 0;
  for (let y = 0; y < height; y++) {
    const dy = (y - plate.cy) / plate.ry;
    const dy2 = dy * dy;
    if (dy2 > m2) continue;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      const dx = (x - plate.cx) / plate.rx;
      if (dx * dx + dy2 <= m2) count++;
    }
  }
  return count;
}
