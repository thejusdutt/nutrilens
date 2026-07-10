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
  }

  /**
   * Estimate the mass of a segmented food region.
   *
   * @param {Object} p
   * @param {number} p.areaPx        Foreground pixel count of the food mask.
   * @param {number} p.imageWidth
   * @param {number} p.imageHeight
   * @param {import('./plate-detector.js').PlateEllipse|null} [p.plate]
   * @param {FoodPrior} [p.prior]
   * @returns {{grams:number, low:number, high:number, method:'plate-scale'|'serving-prior', areaCm2:number|null, plateConfidence:number|null}}
   */
  estimate({ areaPx, imageWidth, imageHeight, plate = null, prior = {} }) {
    const heightCm = prior.heightCm ?? 2.2;
    const densityGml = prior.densityGml ?? 0.8;
    const servingG = prior.servingG ?? 300;
    const spread = prior.spread ?? 1.6;

    if (plate && plate.confidence > 0.3 && areaPx > 0) {
      // Areas on the plate plane scale by the product of the two axis scales.
      const cmPerPxMajor = this.plateDiameterCm / (2 * plate.rx);
      const cmPerPxMinor = this.plateDiameterCm / (2 * plate.ry);
      const areaCm2 = areaPx * cmPerPxMajor * cmPerPxMinor;
      let grams = areaCm2 * heightCm * densityGml;
      grams = this._clamp(grams);
      // Widen the band when the plate fit itself is shaky.
      const s = spread * (plate.confidence > 0.6 ? 1 : 1.25);
      return {
        grams: Math.round(grams),
        low: Math.round(this._clamp(grams / s)),
        high: Math.round(this._clamp(grams * s)),
        method: 'plate-scale',
        areaCm2: Math.round(areaCm2),
        plateConfidence: plate.confidence,
      };
    }

    // Fallback: population prior for a typical serving of this food.
    const s = 2.0; // wide band — nothing in the image anchors the scale
    return {
      grams: Math.round(this._clamp(servingG)),
      low: Math.round(this._clamp(servingG / s)),
      high: Math.round(this._clamp(servingG * s)),
      method: 'serving-prior',
      areaCm2: null,
      plateConfidence: plate?.confidence ?? null,
    };
  }

  /** @private */
  _clamp(g) { return Math.min(this.maxGrams, Math.max(this.minGrams, g)); }
}
