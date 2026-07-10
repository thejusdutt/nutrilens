import { softmax } from './swin-classifier.js';

/**
 * @typedef {Object} VocabEntry
 * @property {string} id        Canonical food id (kebab-case), e.g. "biryani"
 * @property {string} name      Display name, e.g. "Biryani"
 * @property {number|null} f101 Index into the Food-101 classifier's label space, or null if out-of-set
 * @property {boolean} [nonFood] True for non-food probe labels ("a person", "an empty plate", ...)
 */

/**
 * Fuses the closed-set (Swin/Food-101) and open-vocabulary (CLIP zero-shot)
 * heads into a single calibrated distribution over the canonical vocabulary,
 * with non-food rejection.
 *
 * Fusion rule (log-linear, standard late fusion):
 *   in-set labels:  score = wSwin·log p_swin + (1−wSwin)·log p_zs
 *   OOV labels:     score = log p_zs + oovBias
 * followed by a softmax over the union. `wSwin` adapts to the closed-set
 * head's own confidence: when Swin is unsure (its max prob is low, typical
 * for foods outside Food-101) the zero-shot head dominates.
 */
export class FusionScorer {
  /**
   * @param {VocabEntry[]} vocab  Canonical vocabulary; **must be index-aligned
   *   with the zero-shot embedding matrix rows** (probes included).
   * @param {Object} [opts]
   * @param {number} [opts.wSwin=0.72]        Base weight of the closed-set head for in-set labels.
   * @param {number} [opts.oovBias=-0.35]     Additive log-score bias for OOV labels (compensates the
   *                                          closed-set head never voting for them).
   * @param {number} [opts.probeMass=0.42]    If total zero-shot probability on non-food probes exceeds
   *                                          this, the image is declared non-food.
   * @param {number} [opts.minConfidence=0.10] Below this fused top-1 prob the result is flagged uncertain.
   */
  constructor(vocab, opts = {}) {
    this.vocab = vocab;
    this.wSwin = opts.wSwin ?? 0.72;
    this.oovBias = opts.oovBias ?? -0.35;
    this.probeMass = opts.probeMass ?? 0.42;
    this.minConfidence = opts.minConfidence ?? 0.10;
    this.foodIdx = [];
    this.probeIdx = [];
    vocab.forEach((v, i) => (v.nonFood ? this.probeIdx : this.foodIdx).push(i));
  }

  /**
   * @param {Float32Array} swinProbs  Probabilities over the 101 Food-101 classes.
   * @param {Float32Array} zsProbs    Probabilities over the full vocabulary (index-aligned with vocab).
   * @returns {{
   *   top: {id:string, name:string, prob:number, sources:{swin:number|null, zeroShot:number}}[],
   *   isFood: boolean, uncertain: boolean, nonFoodMass: number
   * }}
   */
  fuse(swinProbs, zsProbs) {
    const EPS = 1e-9;
    let nonFoodMass = 0;
    for (const i of this.probeIdx) nonFoodMass += zsProbs[i];

    // Confidence-adaptive closed-set weight: full weight when Swin is sure,
    // sliding toward the open-vocab head as Swin's own max prob drops.
    let swinMax = 0;
    for (const p of swinProbs) swinMax = Math.max(swinMax, p);
    const wS = this.wSwin * Math.min(1, swinMax / 0.5);

    const scores = new Float32Array(this.foodIdx.length);
    this.foodIdx.forEach((vi, k) => {
      const v = this.vocab[vi];
      const zLog = Math.log(zsProbs[vi] + EPS);
      if (v.f101 != null) {
        const sLog = Math.log(swinProbs[v.f101] + EPS);
        scores[k] = wS * sLog + (1 - wS) * zLog;
      } else {
        scores[k] = zLog + this.oovBias;
      }
    });

    const fused = softmax(scores);
    const order = [...fused.keys()].sort((a, b) => fused[b] - fused[a]).slice(0, 8);
    const top = order.map((k) => {
      const v = this.vocab[this.foodIdx[k]];
      return {
        id: v.id,
        name: v.name,
        prob: fused[k],
        sources: {
          swin: v.f101 != null ? swinProbs[v.f101] : null,
          zeroShot: zsProbs[this.foodIdx[k]],
        },
      };
    });

    const isFood = nonFoodMass < this.probeMass;
    const uncertain = !isFood || top[0].prob < this.minConfidence;
    return { top, isFood, uncertain, nonFoodMass };
  }
}

/**
 * High-level recognizer that owns both heads and the fusion scorer.
 */
export class FoodRecognizer {
  /**
   * @param {import('./swin-classifier.js').SwinFoodClassifier} swin
   * @param {import('./zero-shot.js').ZeroShotFoodClassifier} zeroShot
   * @param {FusionScorer} scorer
   */
  constructor(swin, zeroShot, scorer) {
    this.swin = swin;
    this.zeroShot = zeroShot;
    this.scorer = scorer;
  }

  /**
   * Recognize the food in an image (or image region).
   * @param {{data:Uint8ClampedArray,width:number,height:number}} img
   * @returns {Promise<ReturnType<FusionScorer['fuse']> & {timings:{swinMs:number, zeroShotMs:number}}>}
   */
  async recognize(img) {
    const t0 = performance.now();
    const [s, z] = await Promise.all([this.swin.classify(img), this.zeroShot.classify(img)]);
    const t1 = performance.now();
    const result = this.scorer.fuse(s.probs, z.probs);
    return { ...result, timings: { swinMs: t1 - t0, zeroShotMs: t1 - t0, totalMs: performance.now() - t0 } };
  }
}
