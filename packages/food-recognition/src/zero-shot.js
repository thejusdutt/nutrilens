import { resizeShortestSide, centerCrop, toTensor } from '@nutrilens/image-preprocess';
import { softmax } from './swin-classifier.js';

/**
 * Open-vocabulary zero-shot classifier: CLIP-style vision tower + a matrix of
 * precomputed, L2-normalized text embeddings (one row per label, built with
 * prompt ensembling at build time — the text tower never ships to the client).
 *
 * Default checkpoint: Apple MobileCLIP-S0 vision tower (11.8 MB int8).
 */
export class ZeroShotFoodClassifier {
  /** @private */
  constructor(ort, session, embeddings, opts) {
    this.ort = ort;
    this.session = session;
    /** @type {string[]} */
    this.labels = embeddings.labels;
    /** @type {Float32Array} row-major [labels x dim], rows L2-normalized */
    this.matrix = embeddings.matrix;
    this.dim = embeddings.dim;
    this.inputSize = opts.inputSize ?? 256;
    /** CLIP logit scale (exp of learned temperature). MobileCLIP uses 100. */
    this.logitScale = opts.logitScale ?? embeddings.logitScale ?? 100;
    /**
     * Optional linear probe over the same embedding: {classes, weights, bias}
     * plus `alpha`, its weight in the blend. Trained on photographs of each
     * dish rather than on a sentence describing it, which is the one thing
     * text embeddings cannot be — a bowl of pale coarse paste sits about as
     * close to "coconut chutney" as it does to "clam chowder".
     *
     * Blended, not substituted: the probe only knows the classes it has photos
     * of, and it is worse than zero-shot on the ones it has few of. Labels it
     * was never trained on keep their zero-shot score untouched.
     *
     * `trusted` narrows it further, and has to. Most of the probe's classes are
     * trained on whole photographs, because that is what a labelled food
     * dataset is; this pipeline classifies tight *region crops*, which is a
     * different distribution, and the probe is confidently wrong across it —
     * blending all of its classes takes a dosa plate from 3/3 dishes to 1/3,
     * naming the dosa as garlic bread and the coconut chutney as clam chowder.
     * Only classes trained on hand-labelled region crops are mixed in; the
     * rest keep their zero-shot score.
     */
    this.probe = opts.probe ?? null;
    this.probeAlpha = opts.probeAlpha ?? 0.5;
  }

  /**
   * @param {object} ort onnxruntime module
   * @param {string|Uint8Array} model vision tower ONNX
   * @param {{labels:string[], matrix:Float32Array, dim:number, logitScale?:number}} embeddings
   * @param {{inputSize?:number, logitScale?:number, sessionOptions?:object}} [opts]
   */
  static async load(ort, model, embeddings, opts = {}) {
    if (embeddings.matrix.length !== embeddings.labels.length * embeddings.dim) {
      throw new Error('embeddings matrix size does not match labels x dim');
    }
    const session = await ort.InferenceSession.create(model, opts.sessionOptions);
    return new ZeroShotFoodClassifier(ort, session, embeddings, opts);
  }

  /**
   * Embed an image (L2-normalized).
   * @param {{data:Uint8ClampedArray,width:number,height:number}} img
   * @returns {Promise<Float32Array>}
   */
  async embed(img) {
    const resized = resizeShortestSide(img, this.inputSize);
    const cropped = centerCrop(resized, this.inputSize, this.inputSize);
    // MobileCLIP: rescale to 0-1 only, no mean/std normalization.
    const t = toTensor(cropped, { mean: [0, 0, 0], std: [1, 1, 1] });
    const input = new this.ort.Tensor('float32', t.data, t.dims);
    const out = await this.session.run({ pixel_values: input });
    const e = Float32Array.from(out.image_embeds.data);
    let norm = 0;
    for (const v of e) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < e.length; i++) e[i] /= norm;
    return e;
  }

  /**
   * Zero-shot classify: cosine similarity against every label embedding.
   * @param {{data:Uint8ClampedArray,width:number,height:number}} img
   * @returns {Promise<{sims: Float32Array, probs: Float32Array, top: {label:string, index:number, prob:number, sim:number}[]}>}
   */
  /**
   * @param {{data:Uint8ClampedArray,width:number,height:number}} img
   * @param {{whole?:boolean}} [opts] `whole: true` when `img` is an entire
   *   photograph rather than a region cut out of one — see #blendProbe.
   */
  async classify(img, opts = {}) {
    const e = await this.embed(img);
    const n = this.labels.length;
    const sims = new Float32Array(n);
    for (let r = 0; r < n; r++) {
      let dot = 0;
      const off = r * this.dim;
      for (let c = 0; c < this.dim; c++) dot += e[c] * this.matrix[off + c];
      sims[r] = dot;
    }
    const scaled = new Float32Array(n);
    for (let i = 0; i < n; i++) scaled[i] = sims[i] * this.logitScale;
    const probs = this.probe ? this.#blendProbe(e, scaled, opts.whole === true) : softmax(scaled);
    const top = [...probs.keys()]
      .sort((a, b) => probs[b] - probs[a])
      .slice(0, 10)
      .map((i) => ({ label: this.labels[i], index: i, prob: probs[i], sim: sims[i] }));
    return { sims, probs, top };
  }

  /**
   * Mix probe and zero-shot in the log domain, then renormalize.
   *
   * Both sides are turned into log-probabilities over their own label set
   * first, so the blend is over comparable quantities rather than a cosine and
   * a logit on different scales. A label the probe does not cover keeps its
   * zero-shot log-probability: no opinion is not evidence against.
   *
   * @private
   */
  #blendProbe(e, zeroShotLogits, whole = false) {
    const {
      classes, weights, bias, index, trusted, trustedWhole,
    } = this.probe;
    // Which classes may speak depends on what is being looked at.
    //
    // The probe learned from whole photographs, because that is what a labelled
    // food dataset is. On whole photographs it is worth a lot — 77.6% → 82.7%
    // held-out top-1 across the classes where it beats zero-shot outright. On
    // tight region crops it is a different distribution and it is confidently
    // wrong: measured, letting the same classes vote on crops took plate recall
    // from 76.3% to 71.7% and added five phantom dishes.
    //
    // So the safe set is context-dependent. `trusted` are the classes trained
    // on hand-labelled region crops, sound wherever they are asked; those plus
    // `trustedWhole` apply only when the input is an entire photograph.
    const allow = whole && trustedWhole ? trustedWhole : trusted;
    const a = this.probeAlpha;
    const k = classes.length;
    const pLogits = new Float32Array(k);
    for (let r = 0; r < k; r++) {
      let s = bias[r];
      const off = r * this.dim;
      for (let c = 0; c < this.dim; c++) s += weights[off + c] * e[c];
      pLogits[r] = s;
    }
    const logSoftmax = (xs) => {
      let max = -Infinity;
      for (const v of xs) if (v > max) max = v;
      let sum = 0;
      for (const v of xs) sum += Math.exp(v - max);
      const lse = max + Math.log(sum);
      const out = new Float32Array(xs.length);
      for (let i = 0; i < xs.length; i++) out[i] = xs[i] - lse;
      return out;
    };
    const zLog = logSoftmax(zeroShotLogits);
    const pLog = logSoftmax(pLogits);
    const mixed = new Float32Array(zLog.length);
    for (let i = 0; i < zLog.length; i++) {
      const label = this.labels[i];
      const pi = index.get(label);
      const use = pi !== undefined && (!allow || allow.has(label));
      mixed[i] = use ? (1 - a) * zLog[i] + a * pLog[pi] : zLog[i];
    }
    return softmax(mixed);
  }

  async dispose() { await this.session.release?.(); }
}
