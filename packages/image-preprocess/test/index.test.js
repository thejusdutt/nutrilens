import { describe, it, expect } from 'vitest';
import {
  resizeBilinear, resizeBicubic, resizeShortestSide, centerCrop, crop, padTo,
  toTensor, toGrayscale, sobel, boxBlur, otsuThreshold,
} from '../src/index.js';

/** Solid-color test image. */
function solid(w, h, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a; }
  return { data, width: w, height: h };
}

describe('resize', () => {
  it('preserves solid colors exactly (bilinear + bicubic)', () => {
    const img = solid(10, 8, [40, 90, 200]);
    for (const fn of [resizeBilinear, resizeBicubic]) {
      const out = fn(img, 5, 4);
      expect(out.width).toBe(5);
      expect(out.height).toBe(4);
      expect(out.data[0]).toBe(40);
      expect(out.data[1]).toBe(90);
      expect(out.data[2]).toBe(200);
    }
  });

  it('bilinear interpolates a two-tone image to the mean at the seam', () => {
    // left half black, right half white, downsample to 1x1 → ~127
    const img = solid(4, 4, [0, 0, 0]);
    for (let y = 0; y < 4; y++) for (let x = 2; x < 4; x++) {
      img.data.set([255, 255, 255, 255], (y * 4 + x) * 4);
    }
    const out = resizeBilinear(img, 1, 1);
    expect(out.data[0]).toBeGreaterThan(100);
    expect(out.data[0]).toBeLessThan(155);
  });

  it('resizeShortestSide keeps aspect ratio', () => {
    const out = resizeShortestSide(solid(200, 100, [1, 2, 3]), 50);
    expect(out.height).toBe(50);
    expect(out.width).toBe(100);
  });
});

describe('crop & pad', () => {
  it('centerCrop extracts the middle', () => {
    const img = solid(6, 6, [0, 0, 0]);
    img.data.set([255, 0, 0, 255], (2 * 6 + 2) * 4); // pixel (2,2) red
    const out = centerCrop(img, 2, 2);
    expect(out.width).toBe(2);
    expect(out.data[0]).toBe(255); // (2,2) is top-left of center 2x2
  });

  it('crop clamps to bounds', () => {
    const out = crop(solid(4, 4, [9, 9, 9]), 2, 2, 10, 10);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });

  it('padTo fills with the given color and keeps alpha opaque', () => {
    const out = padTo(solid(2, 2, [10, 20, 30]), 4, 4, [1, 2, 3]);
    expect(out.data[(3 * 4 + 3) * 4]).toBe(1);
    expect(out.data[(3 * 4 + 3) * 4 + 3]).toBe(255);
    expect(out.data[0]).toBe(10);
  });
});

describe('toTensor', () => {
  it('applies rescale, mean/std in NCHW', () => {
    const img = solid(2, 2, [255, 0, 128]);
    const { data, dims } = toTensor(img, { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] });
    expect(dims).toEqual([1, 3, 2, 2]);
    expect(data[0]).toBeCloseTo(1, 5);          // (1.0-0.5)/0.5
    expect(data[4]).toBeCloseTo(-1, 5);         // G plane
    expect(data[8]).toBeCloseTo((128 / 255 - 0.5) / 0.5, 3);
  });

  it('NHWC layout interleaves channels', () => {
    const { data, dims } = toTensor(solid(1, 1, [255, 0, 0]), { layout: 'nhwc' });
    expect(dims).toEqual([1, 1, 1, 3]);
    expect(data[0]).toBeCloseTo(1, 5);
    expect(data[1]).toBeCloseTo(0, 5);
  });
});

describe('CV primitives', () => {
  it('sobel responds to a vertical edge', () => {
    const img = solid(8, 8, [0, 0, 0]);
    for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) img.data.set([255, 255, 255, 255], (y * 8 + x) * 4);
    const { mag } = sobel(toGrayscale(img));
    expect(mag[3 * 8 + 4]).toBeGreaterThan(100); // at the edge
    expect(mag[3 * 8 + 1]).toBe(0);              // flat region
  });

  it('boxBlur preserves constant planes', () => {
    const plane = { data: new Float32Array(25).fill(77), width: 5, height: 5 };
    const out = boxBlur(plane, 1);
    expect(out.data[12]).toBeCloseTo(77, 4);
  });

  it('otsu separates a bimodal distribution', () => {
    const data = new Float32Array(100);
    data.fill(20, 0, 50);
    data.fill(220, 50);
    const t = otsuThreshold(data);
    expect(t).toBeGreaterThanOrEqual(20); // any t in [20, 219] maximizes between-class variance
    expect(t).toBeLessThan(220);
  });
});
