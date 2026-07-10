import { resizeBicubic, toTensor } from '@nutrilens/image-preprocess';

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/** Numerically stable softmax. */
export function softmax(logits, temperature = 1) {
  const out = new Float32Array(logits.length);
  let max = -Infinity;
  for (const v of logits) max = Math.max(max, v);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) { out[i] = Math.exp((logits[i] - max) / temperature); sum += out[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/**
 * Closed-set food classifier wrapping a fine-tuned image-classification ONNX
 * model (Swin-Base fine-tuned on Food-101 by default, 92.1% top-1).
 *
 * Isomorphic: pass the `onnxruntime-web` or `onnxruntime-node` module as `ort`.
 */
export class SwinFoodClassifier {
  /** @private */
  constructor(ort, session, labels, opts) {
    this.ort = ort;
    this.session = session;
    /** @type {string[]} raw model labels, index-aligned with logits */
    this.labels = labels;
    this.inputSize = opts.inputSize ?? 224;
    /** Calibration temperature (fitted on held-out data; 1 = uncalibrated). */
    this.temperature = opts.temperature ?? 1;
  }

  /**
   * @param {object} ort  onnxruntime module (web or node)
   * @param {string|Uint8Array} model  URL/path or bytes of the ONNX model
   * @param {string[]} labels  index-aligned class labels
   * @param {{inputSize?: number, temperature?: number, sessionOptions?: object}} [opts]
   */
  static async load(ort, model, labels, opts = {}) {
    const session = await ort.InferenceSession.create(model, opts.sessionOptions);
    return new SwinFoodClassifier(ort, session, labels, opts);
  }

  /**
   * Classify a RawImage.
   * @param {{data:Uint8ClampedArray,width:number,height:number}} img
   * @returns {Promise<{probs: Float32Array, top: {label:string, index:number, prob:number}[]}>}
   */
  async classify(img) {
    const resized = resizeBicubic(img, this.inputSize, this.inputSize);
    const t = toTensor(resized, { mean: IMAGENET_MEAN, std: IMAGENET_STD });
    const input = new this.ort.Tensor('float32', t.data, t.dims);
    const out = await this.session.run({ pixel_values: input });
    const logits = out.logits.data;
    const probs = softmax(logits, this.temperature);
    const top = [...probs.keys()]
      .sort((a, b) => probs[b] - probs[a])
      .slice(0, 10)
      .map((i) => ({ label: this.labels[i], index: i, prob: probs[i] }));
    return { probs, top };
  }

  async dispose() { await this.session.release?.(); }
}
