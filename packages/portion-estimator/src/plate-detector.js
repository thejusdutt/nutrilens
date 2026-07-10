/**
 * Plate detection: finds the dominant axis-aligned ellipse (a circular plate
 * seen at a camera tilt) from image edges, giving a metric scale reference.
 *
 * Method: downscale → grayscale → blur → Sobel → keep strong edge points →
 * RANSAC over 4-point samples solving the axis-aligned conic
 * A·x² + B·y² + C·x + D·y = 1, with plausibility gating (size, aspect,
 * center) and inlier maximization, then a least-squares refit on inliers.
 *
 * Axis-aligned is a deliberate simplification: photos of plates are taken
 * with roll ≈ 0 (people hold phones level), so the ellipse axes align with
 * the image axes; dropping rotation makes the fit 4-DOF and far more robust
 * on cluttered food edges than a general 5-DOF conic.
 */
import { toGrayscale, resizeBilinear, boxBlur, sobel } from '@nutrilens/image-preprocess';

/**
 * @typedef {Object} PlateEllipse
 * @property {number} cx  Center x (original-image pixels)
 * @property {number} cy  Center y
 * @property {number} rx  Semi-axis along x (≈ plate radius in px)
 * @property {number} ry  Semi-axis along y (foreshortened)
 * @property {number} inlierRatio  Fraction of sampled edge points on the ellipse
 * @property {number} confidence   0..1 heuristic confidence
 */

/**
 * Detect the plate ellipse.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img
 * @param {Object} [opts]
 * @param {number} [opts.workSize=360]     Long-side working resolution.
 * @param {number} [opts.iterations=1400]  RANSAC iterations.
 * @param {number} [opts.edgePercentile=0.92] Keep the top (1-p) strongest edges.
 * @param {number} [opts.tolerance=0.035]  Inlier tolerance on normalized radial residual.
 * @returns {PlateEllipse|null}
 */
export function detectPlateEllipse(img, opts = {}) {
  const workSize = opts.workSize ?? 360;
  const iterations = opts.iterations ?? 1400;
  const edgePercentile = opts.edgePercentile ?? 0.92;
  const tolerance = opts.tolerance ?? 0.035;

  const scale = workSize / Math.max(img.width, img.height);
  const w = Math.max(2, Math.round(img.width * scale));
  const h = Math.max(2, Math.round(img.height * scale));
  const gray = toGrayscale(resizeBilinear(img, w, h));
  const { mag } = sobel(boxBlur(gray, 1));

  // Edge points above percentile threshold.
  const sorted = Float32Array.from(mag).sort();
  const thresh = Math.max(sorted[Math.floor(sorted.length * edgePercentile)], 20);
  const pts = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      if (mag[y * w + x] >= thresh) pts.push(x, y);
    }
  }
  const nPts = pts.length / 2;
  if (nPts < 40) return null;

  // Plausibility bounds for a plate in frame.
  const minR = 0.18 * Math.min(w, h), maxRx = 0.62 * w, maxRy = 0.62 * h;

  let best = null, bestScore = 0;
  const idx = new Uint32Array(4);
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < 4; k++) idx[k] = (Math.random() * nPts) | 0;
    const M = [], rhs = [1, 1, 1, 1];
    for (let k = 0; k < 4; k++) {
      const x = pts[idx[k] * 2], y = pts[idx[k] * 2 + 1];
      M.push([x * x, y * y, x, y]);
    }
    const sol = solve4(M, rhs);
    if (!sol) continue;
    const e = conicToEllipse(sol);
    if (!e) continue;
    if (e.rx < minR || e.ry < minR || e.rx > maxRx || e.ry > maxRy) continue;
    const aspect = e.ry / e.rx;
    if (aspect < 0.30 || aspect > 1 / 0.30) continue;
    if (e.cx < w * 0.15 || e.cx > w * 0.85 || e.cy < h * 0.10 || e.cy > h * 0.95) continue;

    let inliers = 0;
    for (let i = 0; i < nPts; i++) {
      const dx = (pts[i * 2] - e.cx) / e.rx, dy = (pts[i * 2 + 1] - e.cy) / e.ry;
      if (Math.abs(Math.hypot(dx, dy) - 1) < tolerance) inliers++;
    }
    // Normalize by circumference (larger ellipses trivially collect more points).
    const circ = Math.PI * (e.rx + e.ry);
    const score = inliers / circ;
    if (score > bestScore) { bestScore = score; best = { ...e, inliers }; }
  }
  if (!best) return null;

  // Refit on inliers (linear least squares on the conic).
  const inlierPts = [];
  for (let i = 0; i < nPts; i++) {
    const dx = (pts[i * 2] - best.cx) / best.rx, dy = (pts[i * 2 + 1] - best.cy) / best.ry;
    if (Math.abs(Math.hypot(dx, dy) - 1) < tolerance) inlierPts.push(pts[i * 2], pts[i * 2 + 1]);
  }
  const refined = leastSquaresEllipse(inlierPts) ?? best;

  const inlierRatio = best.inliers / nPts;
  // Confidence: how completely the rim is supported (inliers vs circumference in px).
  const support = Math.min(1, best.inliers / (Math.PI * (refined.rx + refined.ry) * 0.5));
  const confidence = Math.max(0, Math.min(1, 0.25 + 0.75 * support));

  return {
    cx: refined.cx / scale, cy: refined.cy / scale,
    rx: refined.rx / scale, ry: refined.ry / scale,
    inlierRatio, confidence,
  };
}

/** @private Solve a 4x4 linear system via Gaussian elimination with partial pivoting. */
function solve4(M, rhs) {
  const a = M.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-9) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 5; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[4] / a[i][i]);
}

/** @private Convert conic A·x²+B·y²+C·x+D·y=1 to ellipse params (or null if not an ellipse).
 * Note: A and B are both negative when the coordinate origin lies outside the
 * ellipse (the normalization constant flips sign), so require same sign and
 * positive squared radii rather than A,B > 0. */
function conicToEllipse([A, B, C, D]) {
  if (!(A * B > 0)) return null; // opposite signs (or 0/NaN) → not an ellipse
  const cx = -C / (2 * A), cy = -D / (2 * B);
  const k = 1 + A * cx * cx + B * cy * cy;
  const rx2 = k / A, ry2 = k / B;
  if (rx2 <= 0 || ry2 <= 0) return null;
  return { cx, cy, rx: Math.sqrt(rx2), ry: Math.sqrt(ry2) };
}

/** @private Least-squares fit of the axis-aligned conic over ≥4 points. */
export function leastSquaresEllipse(flatPts) {
  const n = flatPts.length / 2;
  if (n < 4) return null;
  // Normal equations for [x², y², x, y]·p = 1.
  const AtA = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const Atb = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = flatPts[i * 2], y = flatPts[i * 2 + 1];
    const row = [x * x, y * y, x, y];
    for (let r = 0; r < 4; r++) {
      Atb[r] += row[r];
      for (let c = 0; c < 4; c++) AtA[r][c] += row[r] * row[c];
    }
  }
  const sol = solve4(AtA, Atb);
  return sol ? conicToEllipse(sol) : null;
}
