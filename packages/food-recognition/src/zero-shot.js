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
  async classify(img) {
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
    const probs = softmax(scaled);
    const top = [...probs.keys()]
      .sort((a, b) => probs[b] - probs[a])
      .slice(0, 10)
      .map((i) => ({ label: this.labels[i], index: i, prob: probs[i], sim: sims[i] }));
    return { sims, probs, top };
  }

  async dispose() { await this.session.release?.(); }
}
