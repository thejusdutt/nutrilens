/**
 * @nutrilens/food-segmentation
 *
 * Promptable segmentation via SlimSAM (a 1.4%-size distillation of SAM)
 * running on ONNX Runtime, plus dependency-free mask post-processing.
 *
 * Typical use: segment the dish under the image center (or a user tap) to
 * measure how much of the frame the food occupies — the input to portion
 * estimation.
 *
 * @example
 * const seg = await SlimSamSegmenter.load(ort, '/models/slimsam/onnx/vision_encoder_quantized.onnx',
 *                                              '/models/slimsam/onnx/prompt_encoder_mask_decoder_quantized.onnx');
 * await seg.setImage(rawImage);
 * const { mask, areaFraction } = await seg.segment([{ x: img.width/2, y: img.height/2, label: 1 }]);
 */
import { resizeBilinear, padTo, toTensor } from '@nutrilens/image-preprocess';

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const SAM_SIZE = 1024;
const MASK_SIZE = 256;

export class SlimSamSegmenter {
  /** @private */
  constructor(ort, encoder, decoder) {
    this.ort = ort;
    this.encoder = encoder;
    this.decoder = decoder;
    this._state = null; // per-image embeddings + geometry
  }

  /**
   * @param {object} ort onnxruntime module (web or node)
   * @param {string|Uint8Array} encoderModel
   * @param {string|Uint8Array} decoderModel
   * @param {{sessionOptions?: object}} [opts]
   */
  static async load(ort, encoderModel, decoderModel, opts = {}) {
    const [enc, dec] = await Promise.all([
      ort.InferenceSession.create(encoderModel, opts.sessionOptions),
      ort.InferenceSession.create(decoderModel, opts.sessionOptions),
    ]);
    return new SlimSamSegmenter(ort, enc, dec);
  }

  /**
   * Encode an image once; subsequent {@link segment} calls reuse the embedding
   * (the expensive step), so interactive re-prompting is cheap.
   * @param {{data:Uint8ClampedArray,width:number,height:number}} img
   */
  async setImage(img) {
    const scale = SAM_SIZE / Math.max(img.width, img.height);
    const rw = Math.round(img.width * scale), rh = Math.round(img.height * scale);
    const resized = resizeBilinear(img, rw, rh);
    const padded = padTo(resized, SAM_SIZE, SAM_SIZE);
    const t = toTensor(padded, { mean: IMAGENET_MEAN, std: IMAGENET_STD });
    const out = await this.encoder.run({
      pixel_values: new this.ort.Tensor('float32', t.data, t.dims),
    });
    this._state = {
      embeddings: out.image_embeddings,
      posEmbeddings: out.image_positional_embeddings,
      width: img.width, height: img.height, scale, rw, rh,
    };
  }

  /**
   * Segment with point prompts (original-image pixel coordinates).
   * @param {{x:number, y:number, label?:1|0}[]} points  label 1 = foreground (default), 0 = background
   * @returns {Promise<{mask: Uint8Array, width:number, height:number, areaFraction:number, areaPx:number, iou:number, bbox:{x0:number,y0:number,x1:number,y1:number}|null}>}
   */
  async segment(points) {
    if (!this._state) throw new Error('call setImage() first');
    const s = this._state;
    const coords = new Float32Array(points.length * 2);
    const labels = new BigInt64Array(points.length);
    points.forEach((p, i) => {
      coords[i * 2] = p.x * s.scale;
      coords[i * 2 + 1] = p.y * s.scale;
      labels[i] = BigInt(p.label ?? 1);
    });
    const out = await this.decoder.run({
      input_points: new this.ort.Tensor('float32', coords, [1, 1, points.length, 2]),
      input_labels: new this.ort.Tensor('int64', labels, [1, 1, points.length]),
      image_embeddings: s.embeddings,
      image_positional_embeddings: s.posEmbeddings,
    });
    // pred_masks: [1,1,3,256,256] logits over the padded 1024 frame; pick best by IoU score.
    const iou = out.iou_scores.data;
    let best = 0;
    for (let i = 1; i < iou.length; i++) if (iou[i] > iou[best]) best = i;
    const logits = out.pred_masks.data.subarray(best * MASK_SIZE * MASK_SIZE, (best + 1) * MASK_SIZE * MASK_SIZE);

    const mask = this._upscaleMask(logits, s);
    cleanMask(mask, s.width, s.height);
    let areaPx = 0;
    for (let i = 0; i < mask.length; i++) areaPx += mask[i];
    return {
      mask, width: s.width, height: s.height,
      areaPx, areaFraction: areaPx / (s.width * s.height),
      iou: iou[best],
      bbox: maskBBox(mask, s.width, s.height),
    };
  }

  /** @private Bilinearly sample 256×256 logits back to original size, threshold at 0. */
  _upscaleMask(logits, s) {
    const { width: w, height: h, rw, rh } = s;
    const mask = new Uint8Array(w * h);
    // Valid (non-padding) region of the 256 mask corresponds to rw×rh of 1024.
    const mx = (rw / SAM_SIZE) * MASK_SIZE, my = (rh / SAM_SIZE) * MASK_SIZE;
    for (let y = 0; y < h; y++) {
      const sy = Math.min((y + 0.5) / h * my - 0.5, MASK_SIZE - 1);
      const y0 = Math.max(Math.floor(sy), 0), y1 = Math.min(y0 + 1, MASK_SIZE - 1);
      const fy = Math.max(sy - y0, 0);
      for (let x = 0; x < w; x++) {
        const sx = Math.min((x + 0.5) / w * mx - 0.5, MASK_SIZE - 1);
        const x0 = Math.max(Math.floor(sx), 0), x1 = Math.min(x0 + 1, MASK_SIZE - 1);
        const fx = Math.max(sx - x0, 0);
        const v = logits[y0 * MASK_SIZE + x0] * (1 - fx) * (1 - fy)
                + logits[y0 * MASK_SIZE + x1] * fx * (1 - fy)
                + logits[y1 * MASK_SIZE + x0] * (1 - fx) * fy
                + logits[y1 * MASK_SIZE + x1] * fx * fy;
        mask[y * w + x] = v > 0 ? 1 : 0;
      }
    }
    return mask;
  }

  reset() { this._state = null; }
  async dispose() {
    await this.encoder.release?.();
    await this.decoder.release?.();
  }
}

// ---------------------------------------------------------------------------
// Pure-JS mask utilities
// ---------------------------------------------------------------------------

/**
 * Keep only the largest 4-connected component, then fill enclosed holes.
 * Mutates `mask` in place.
 * @param {Uint8Array} mask 0/1
 * @param {number} w @param {number} h
 */
export function cleanMask(mask, w, h) {
  largestComponent(mask, w, h);
  fillHoles(mask, w, h);
}

/**
 * Zero out all but the largest 4-connected foreground component (BFS labeling).
 * @param {Uint8Array} mask @param {number} w @param {number} h
 */
export function largestComponent(mask, w, h) {
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let nextLabel = 0, bestLabel = -1, bestSize = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    nextLabel++;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = start; labels[start] = nextLabel;
    while (head < tail) {
      const i = queue[head++]; size++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = nextLabel; queue[tail++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = nextLabel; queue[tail++] = i + 1; }
      if (y > 0 && mask[i - w] && !labels[i - w]) { labels[i - w] = nextLabel; queue[tail++] = i - w; }
      if (y < h - 1 && mask[i + w] && !labels[i + w]) { labels[i + w] = nextLabel; queue[tail++] = i + w; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = nextLabel; }
  }
  if (bestLabel < 0) return;
  for (let i = 0; i < mask.length; i++) mask[i] = labels[i] === bestLabel ? 1 : 0;
}

/**
 * Fill holes: any background region not reachable from the image border
 * becomes foreground. BFS flood fill from all border background pixels.
 * @param {Uint8Array} mask @param {number} w @param {number} h
 */
export function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  const push = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < mask.length; i++) if (!mask[i] && !outside[i]) mask[i] = 1;
}

/**
 * Bounding box of foreground pixels, or null for an empty mask.
 * @param {Uint8Array} mask @param {number} w @param {number} h
 */
export function maskBBox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Render a translucent colored overlay of the mask onto an RGBA buffer
 * (browser UI helper).
 * @param {Uint8Array} mask
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img mutated in place
 * @param {[number,number,number]} [rgb=[46,204,113]]
 * @param {number} [alpha=0.45]
 */
export function overlayMask(mask, img, rgb = [46, 204, 113], alpha = 0.45) {
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    img.data[i * 4] = img.data[i * 4] * (1 - alpha) + rgb[0] * alpha;
    img.data[i * 4 + 1] = img.data[i * 4 + 1] * (1 - alpha) + rgb[1] * alpha;
    img.data[i * 4 + 2] = img.data[i * 4 + 2] * (1 - alpha) + rgb[2] * alpha;
  }
}
