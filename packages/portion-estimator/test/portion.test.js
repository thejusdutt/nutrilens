import { describe, it, expect } from 'vitest';
import { PortionEstimator, detectPlateEllipse, leastSquaresEllipse, maskAreaInsideEllipse } from '../src/index.js';

describe('leastSquaresEllipse', () => {
  it('recovers a known axis-aligned ellipse from samples', () => {
    const pts = [];
    for (let a = 0; a < Math.PI * 2; a += 0.1) {
      pts.push(100 + 60 * Math.cos(a), 80 + 35 * Math.sin(a));
    }
    const e = leastSquaresEllipse(pts);
    expect(e.cx).toBeCloseTo(100, 1);
    expect(e.cy).toBeCloseTo(80, 1);
    expect(e.rx).toBeCloseTo(60, 1);
    expect(e.ry).toBeCloseTo(35, 1);
  });
});

describe('detectPlateEllipse', () => {
  it('finds a synthetic plate rim', () => {
    // white background, dark ellipse rim (plate edge) at known geometry
    const w = 320, h = 240;
    const data = new Uint8ClampedArray(w * h * 4).fill(235);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const cx = 160, cy = 120, rx = 110, ry = 70;
    for (let a = 0; a < Math.PI * 2; a += 0.002) {
      for (let t = -1.5; t <= 1.5; t += 0.5) {
        const x = Math.round(cx + (rx + t) * Math.cos(a));
        const y = Math.round(cy + (ry + t) * Math.sin(a));
        if (x >= 0 && x < w && y >= 0 && y < h) {
          const o = (y * w + x) * 4;
          data[o] = 30; data[o + 1] = 30; data[o + 2] = 30;
        }
      }
    }
    const e = detectPlateEllipse({ data, width: w, height: h }, { iterations: 2500 });
    expect(e).not.toBeNull();
    expect(e.cx).toBeCloseTo(cx, -1);
    expect(e.cy).toBeCloseTo(cy, -1);
    expect(Math.abs(e.rx - rx)).toBeLessThan(8);
    expect(Math.abs(e.ry - ry)).toBeLessThan(8);
  });

  it('returns null on a blank image', () => {
    const img = { data: new Uint8ClampedArray(320 * 240 * 4).fill(128), width: 320, height: 240 };
    expect(detectPlateEllipse(img)).toBeNull();
  });
});

describe('PortionEstimator', () => {
  const estimator = new PortionEstimator({ plateDiameterCm: 26 });

  it('plate-scale: shrinks the geometric estimate toward the serving prior', () => {
    // Plate radius 200 px → 26cm/400px = 0.065 cm/px on both axes (top-down).
    const plate = { cx: 0, cy: 0, rx: 200, ry: 200, confidence: 0.9 };
    // Geometric estimate: 40,000 px² → 169 cm²; h=2, rho=1 → 338 g. Serving 250 g.
    // Log-domain blend (w=0.65) must land strictly between the two, nearer the geometry.
    const est = estimator.estimate({
      areaPx: 40000, imageWidth: 800, imageHeight: 600, plate,
      prior: { heightCm: 2, densityGml: 1, servingG: 250 },
    });
    expect(est.method).toBe('plate-scale');
    expect(est.grams).toBeGreaterThan(250);
    expect(est.grams).toBeLessThan(338);
    expect(est.grams - 250).toBeGreaterThan(338 - est.grams); // closer to the geometric side
    expect(est.low).toBeLessThan(est.grams);
    expect(est.high).toBeGreaterThan(est.grams);
  });

  it('is monotonic in mask area', () => {
    const plate = { cx: 0, cy: 0, rx: 200, ry: 200, confidence: 0.9 };
    const prior = { heightCm: 2, densityGml: 1, servingG: 250 };
    const small = estimator.estimate({ areaPx: 15000, imageWidth: 800, imageHeight: 600, plate, prior });
    const big = estimator.estimate({ areaPx: 45000, imageWidth: 800, imageHeight: 600, plate, prior });
    expect(big.grams).toBeGreaterThan(small.grams);
  });

  it('caps food area at the plate surface (segmentation bleed cannot outgrow the plate)', () => {
    const plate = { cx: 0, cy: 0, rx: 200, ry: 200, confidence: 0.9 };
    const plateAreaCm2 = Math.PI * 13 * 13;
    // Absurd mask: 10× the plate in pixels.
    const est = estimator.estimate({
      areaPx: 4e6, imageWidth: 4000, imageHeight: 3000, plate,
      prior: { heightCm: 2, densityGml: 1, servingG: 250 },
    });
    expect(est.areaCm2).toBeLessThanOrEqual(Math.ceil(0.9 * plateAreaCm2));
  });

  it('foreshortened plate increases per-pixel area scale', () => {
    const flat = estimator.estimate({
      areaPx: 10000, imageWidth: 800, imageHeight: 600,
      plate: { rx: 200, ry: 200, confidence: 0.9 }, prior: { heightCm: 2, densityGml: 1 },
    });
    const tilted = estimator.estimate({
      areaPx: 10000, imageWidth: 800, imageHeight: 600,
      plate: { rx: 200, ry: 100, confidence: 0.9 }, prior: { heightCm: 2, densityGml: 1 },
    });
    expect(tilted.grams).toBeGreaterThan(flat.grams);
  });

  it('falls back to serving prior without a plate', () => {
    const est = estimator.estimate({
      areaPx: 40000, imageWidth: 800, imageHeight: 600, plate: null,
      prior: { servingG: 250 },
    });
    expect(est.method).toBe('serving-prior');
    expect(est.grams).toBe(250);
    expect(est.high / est.low).toBeCloseTo(4, 0); // ×/÷2 band
  });

  it('clamps absurd masses', () => {
    const plate = { rx: 20, ry: 20, confidence: 0.9 }; // tiny plate → huge cm/px
    const est = estimator.estimate({
      areaPx: 500000, imageWidth: 800, imageHeight: 600, plate,
      prior: { heightCm: 10, densityGml: 1.2 },
    });
    expect(est.grams).toBeLessThanOrEqual(1500);
  });
});

describe('maskAreaInsideEllipse', () => {
  it('counts only mask pixels inside the rim', () => {
    const w = 100, h = 100;
    const mask = new Uint8Array(w * h).fill(1); // mask covers everything
    const plate = { cx: 50, cy: 50, rx: 25, ry: 25 };
    const inside = maskAreaInsideEllipse(mask, w, h, plate, 1.0);
    const expected = Math.PI * 25 * 25; // ellipse area in px
    expect(Math.abs(inside - expected) / expected).toBeLessThan(0.05);
  });

  it('returns full mask area when the mask is entirely inside', () => {
    const w = 100, h = 100;
    const mask = new Uint8Array(w * h);
    for (let y = 45; y < 55; y++) for (let x = 45; x < 55; x++) mask[y * w + x] = 1;
    const plate = { cx: 50, cy: 50, rx: 40, ry: 40 };
    expect(maskAreaInsideEllipse(mask, w, h, plate)).toBe(100);
  });

  it('excludes mask pixels outside the rim entirely', () => {
    const w = 100, h = 100;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) mask[y * w + x] = 1; // far corner
    const plate = { cx: 70, cy: 70, rx: 20, ry: 20 };
    expect(maskAreaInsideEllipse(mask, w, h, plate)).toBe(0);
  });
});
