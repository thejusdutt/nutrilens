/**
 * @nutrilens/image-preprocess
 *
 * Dependency-free image preprocessing and classic computer-vision primitives.
 * All functions operate on a plain `RawImage` record so results are
 * bit-identical in the browser (Canvas/ImageBitmap sources) and in Node
 * (raw RGBA buffers, e.g. decoded with sharp).
 *
 * @typedef {Object} RawImage
 * @property {Uint8ClampedArray|Uint8Array} data  RGBA interleaved, length = width*height*4
 * @property {number} width
 * @property {number} height
 */

// ---------------------------------------------------------------------------
// Decoding (browser only) — Node callers construct RawImage themselves.
// ---------------------------------------------------------------------------

/**
 * Decode any browser image source into a RawImage.
 * Applies EXIF orientation (via createImageBitmap) so phone photos are upright.
 *
 * @param {Blob|File|HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData} source
 * @param {{maxSide?: number}} [opts] Downscale so max(width,height) <= maxSide (saves memory before ML resize).
 * @returns {Promise<RawImage>}
 */
export async function toRawImage(source, opts = {}) {
  if (source && source.data && source.width && source.height) {
    return { data: source.data, width: source.width, height: source.height };
  }
  const bitmapOpts = { imageOrientation: 'from-image' };
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source, bitmapOpts);
  let { width, height } = bitmap;
  if (opts.maxSide && Math.max(width, height) > opts.maxSide) {
    const s = opts.maxSide / Math.max(width, height);
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (bitmap !== source) bitmap.close?.();
  const { data } = ctx.getImageData(0, 0, width, height);
  return { data, width, height };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Bilinear resize. Matches the conventional align_corners=false sampling used
 * by PIL/torchvision "bilinear", which the shipped models were trained with.
 *
 * @param {RawImage} img
 * @param {number} dstW
 * @param {number} dstH
 * @returns {RawImage}
 */
export function resizeBilinear(img, dstW, dstH) {
  const { data: src, width: sw, height: sh } = img;
  if (sw === dstW && sh === dstH) return { data: new Uint8ClampedArray(src), width: sw, height: sh };
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = sw / dstW, yRatio = sh / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(Math.max((y + 0.5) * yRatio - 0.5, 0), sh - 1);
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1);
    const fy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(Math.max((x + 0.5) * xRatio - 0.5, 0), sw - 1);
      const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1);
      const fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx;
        const bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx;
        dst[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { data: dst, width: dstW, height: dstH };
}

/**
 * Bicubic resize (Catmull-Rom a=-0.5, matching PIL's BICUBIC kernel shape).
 * Swin-Food101 was trained with bicubic resampling; using it at inference
 * time measurably improves parity with the training pipeline vs bilinear.
 *
 * @param {RawImage} img
 * @param {number} dstW
 * @param {number} dstH
 * @returns {RawImage}
 */
export function resizeBicubic(img, dstW, dstH) {
  const { data: src, width: sw, height: sh } = img;
  if (sw === dstW && sh === dstH) return { data: new Uint8ClampedArray(src), width: sw, height: sh };
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = sw / dstW, yRatio = sh / dstH;
  const cubic = (t) => {
    const a = -0.5, at = Math.abs(t);
    if (at <= 1) return (a + 2) * at * at * at - (a + 3) * at * at + 1;
    if (at < 2) return a * at * at * at - 5 * a * at * at + 8 * a * at - 4 * a;
    return 0;
  };
  const wx = new Float32Array(4), wy = new Float32Array(4);
  for (let y = 0; y < dstH; y++) {
    const sy = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.floor(sy), fy = sy - y0;
    for (let k = 0; k < 4; k++) wy[k] = cubic(fy - (k - 1));
    for (let x = 0; x < dstW; x++) {
      const sx = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.floor(sx), fx = sx - x0;
      for (let k = 0; k < 4; k++) wx[k] = cubic(fx - (k - 1));
      const o = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        let acc = 0, wsum = 0;
        for (let j = 0; j < 4; j++) {
          const yy = Math.min(Math.max(y0 + j - 1, 0), sh - 1);
          for (let i = 0; i < 4; i++) {
            const xx = Math.min(Math.max(x0 + i - 1, 0), sw - 1);
            const w = wy[j] * wx[i];
            acc += src[(yy * sw + xx) * 4 + c] * w;
            wsum += w;
          }
        }
        dst[o + c] = acc / wsum;
      }
    }
  }
  return { data: dst, width: dstW, height: dstH };
}

/**
 * Resize so the shorter side equals `size`, preserving aspect ratio.
 * @param {RawImage} img
 * @param {number} size
 * @returns {RawImage}
 */
export function resizeShortestSide(img, size) {
  const s = size / Math.min(img.width, img.height);
  return resizeBilinear(img, Math.round(img.width * s), Math.round(img.height * s));
}

/**
 * Center crop to (w, h). Image must be at least that large.
 * @param {RawImage} img
 * @param {number} w
 * @param {number} h
 * @returns {RawImage}
 */
export function centerCrop(img, w, h) {
  const x0 = Math.floor((img.width - w) / 2);
  const y0 = Math.floor((img.height - h) / 2);
  return crop(img, x0, y0, w, h);
}

/**
 * Crop a rectangle (clamped to bounds).
 * @param {RawImage} img
 * @param {number} x0 @param {number} y0 @param {number} w @param {number} h
 * @returns {RawImage}
 */
export function crop(img, x0, y0, w, h) {
  x0 = Math.max(0, Math.min(img.width - 1, x0 | 0));
  y0 = Math.max(0, Math.min(img.height - 1, y0 | 0));
  w = Math.min(w | 0, img.width - x0);
  h = Math.min(h | 0, img.height - y0);
  const dst = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcOff = ((y0 + y) * img.width + x0) * 4;
    dst.set(img.data.subarray(srcOff, srcOff + w * 4), y * w * 4);
  }
  return { data: dst, width: w, height: h };
}

/**
 * Pad an image on the right/bottom to (w, h) with a constant RGB fill.
 * Used by SAM-style models that expect square padded inputs.
 * @param {RawImage} img
 * @param {number} w @param {number} h
 * @param {[number,number,number]} [fill=[0,0,0]]
 * @returns {RawImage}
 */
export function padTo(img, w, h, fill = [0, 0, 0]) {
  const dst = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    dst[i * 4] = fill[0]; dst[i * 4 + 1] = fill[1]; dst[i * 4 + 2] = fill[2]; dst[i * 4 + 3] = 255;
  }
  for (let y = 0; y < img.height; y++) {
    dst.set(img.data.subarray(y * img.width * 4, (y * img.width + img.width) * 4), y * w * 4);
  }
  return { data: dst, width: w, height: h };
}

// ---------------------------------------------------------------------------
// Tensor conversion
// ---------------------------------------------------------------------------

/**
 * Convert a RawImage to a normalized Float32 tensor.
 *
 * @param {RawImage} img
 * @param {Object} [opts]
 * @param {number[]} [opts.mean=[0,0,0]]   Per-channel mean, applied after rescale.
 * @param {number[]} [opts.std=[1,1,1]]    Per-channel std.
 * @param {number}   [opts.rescale=1/255]  Multiplier applied to raw 0-255 values.
 * @param {'nchw'|'nhwc'} [opts.layout='nchw']
 * @returns {{data: Float32Array, dims: number[]}}
 */
export function toTensor(img, opts = {}) {
  const { mean = [0, 0, 0], std = [1, 1, 1], rescale = 1 / 255, layout = 'nchw' } = opts;
  const { data, width, height } = img;
  const n = width * height;
  const out = new Float32Array(n * 3);
  if (layout === 'nchw') {
    for (let i = 0; i < n; i++) {
      out[i]         = (data[i * 4]     * rescale - mean[0]) / std[0];
      out[n + i]     = (data[i * 4 + 1] * rescale - mean[1]) / std[1];
      out[2 * n + i] = (data[i * 4 + 2] * rescale - mean[2]) / std[2];
    }
    return { data: out, dims: [1, 3, height, width] };
  }
  for (let i = 0; i < n; i++) {
    out[i * 3]     = (data[i * 4]     * rescale - mean[0]) / std[0];
    out[i * 3 + 1] = (data[i * 4 + 1] * rescale - mean[1]) / std[1];
    out[i * 3 + 2] = (data[i * 4 + 2] * rescale - mean[2]) / std[2];
  }
  return { data: out, dims: [1, height, width, 3] };
}

// ---------------------------------------------------------------------------
// Classic CV primitives (grayscale float planes)
// ---------------------------------------------------------------------------

/**
 * RGBA → single-channel luma plane (Float32, 0-255).
 * @param {RawImage} img
 * @returns {{data: Float32Array, width: number, height: number}}
 */
export function toGrayscale(img) {
  const n = img.width * img.height;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    g[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  }
  return { data: g, width: img.width, height: img.height };
}

/**
 * 3x3 Sobel operator. Returns gradient magnitude and per-axis gradients.
 * @param {{data: Float32Array, width: number, height: number}} gray
 * @returns {{mag: Float32Array, gx: Float32Array, gy: Float32Array, width: number, height: number}}
 */
export function sobel(gray) {
  const { data, width: w, height: h } = gray;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = data[i - w - 1], b = data[i - w], c = data[i - w + 1];
      const d = data[i - 1],                    f = data[i + 1];
      const g2 = data[i + w - 1], hh = data[i + w], k = data[i + w + 1];
      const sx = (c + 2 * f + k) - (a + 2 * d + g2);
      const sy = (g2 + 2 * hh + k) - (a + 2 * b + c);
      gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy);
    }
  }
  return { mag, gx, gy, width: w, height: h };
}

/**
 * Separable box blur on a float plane.
 * @param {{data: Float32Array, width: number, height: number}} plane
 * @param {number} radius
 */
export function boxBlur(plane, radius) {
  const { data, width: w, height: h } = plane;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const win = 2 * radius + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += data[y * w + Math.min(Math.max(x, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / win;
      const add = Math.min(x + radius + 1, w - 1), del = Math.max(x - radius, 0);
      acc += data[y * w + add] - data[y * w + del];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      const add = Math.min(y + radius + 1, h - 1), del = Math.max(y - radius, 0);
      acc += tmp[add * w + x] - tmp[del * w + x];
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Otsu threshold over a float plane (values expected 0-255).
 * @param {Float32Array} data
 * @returns {number} threshold
 */
export function otsuThreshold(data) {
  const hist = new Float64Array(256);
  for (let i = 0; i < data.length; i++) hist[Math.min(255, Math.max(0, data[i] | 0))]++;
  const total = data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thresh = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thresh = t; }
  }
  return thresh;
}

/**
 * Draw a RawImage into an existing 2D canvas context (browser helper).
 * @param {RawImage} img
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 */
export function putToCanvas(img, ctx) {
  const id = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.canvas.width = img.width; ctx.canvas.height = img.height;
  ctx.putImageData(id, 0, 0);
}
