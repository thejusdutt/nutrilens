/**
 * The readout — this app's signature component.
 *
 * NutriLens measures food; it does not know it. Every figure it prints is an
 * estimate with a tolerance, and the engine already computes those tolerances
 * (portion low/high, per-nutrient ranges) — the interface used to discard them
 * and print a bare number, which reads as certainty the app does not have.
 *
 * A readout is a figure over a graduated scale: the ruler shows where the
 * value sits against what it is measured toward (the day's goal), and, where
 * the value is an estimate rather than a count, marks the band it could
 * plausibly fall in. Same component at three sizes — the day, the plate, one
 * dish — so the whole app reads in one voice.
 *
 * Returns SVG strings, so it is testable without a DOM.
 */

/** Graduation spacing, in fractions of the track. Fifths, with a taller mark at half. */
const TICKS = [0.2, 0.4, 0.5, 0.6, 0.8];

/**
 * A graduated bar.
 *
 * @param {Object} p
 * @param {number} p.value     what was measured
 * @param {number} p.max       full scale (the goal, or the largest sibling)
 * @param {number} [p.low]     lower end of the plausible band
 * @param {number} [p.high]    upper end of the plausible band
 * @param {string} [p.color]   fill colour (defaults to the accent token)
 * @param {number} [p.height]
 * @param {boolean} [p.over]   value has passed the goal — draw it as an overrun
 * @returns {string} SVG
 */
export function tickScale({
  value, max, low = null, high = null, color = 'var(--accent)', height = 10, over = false,
}) {
  const span = Math.max(1, max);
  const pct = (v) => Math.max(0, Math.min(100, (v / span) * 100));
  const w = pct(value);
  const mid = height / 2;

  const marks = TICKS.map((t) => {
    const tall = t === 0.5;
    const y = tall ? 0 : mid - 2;
    const h = tall ? height : 4;
    return `<rect x="${(t * 100).toFixed(2)}%" y="${y}" width="1" height="${h}" class="tick" />`;
  }).join('');

  // The band is drawn *behind* the fill: it is context for the figure, not a
  // second value competing with it.
  const band = low != null && high != null && high > low
    ? `<rect x="${pct(low)}%" y="${mid - 3}" width="${(pct(high) - pct(low)).toFixed(2)}%" height="6" rx="3" class="band" />`
    : '';

  return `<svg class="readout-scale" viewBox="0 0 100 ${height}" preserveAspectRatio="none" width="100%" height="${height}" aria-hidden="true">`
    + `<rect x="0" y="${mid - 1}" width="100%" height="2" rx="1" class="track" />`
    + band
    + `<rect x="0" y="${mid - 3}" width="${w.toFixed(2)}%" height="6" rx="3" fill="${color}"${over ? ' class="over"' : ''} />`
    + marks
    + '</svg>';
}

/**
 * Split a single track between several contributions — the day's calories are
 * one measurement made of parts, not four unrelated numbers.
 *
 * @param {{value:number, color:string}[]} parts
 * @param {number} max
 * @param {number} [height]
 */
export function stackedScale(parts, max, height = 10) {
  const span = Math.max(1, max);
  const mid = height / 2;
  let x = 0;
  const segs = parts.filter((p) => p.value > 0).map((p) => {
    const w = Math.max(0, Math.min(100 - x, (p.value / span) * 100));
    const seg = `<rect x="${x.toFixed(2)}%" y="${mid - 3}" width="${w.toFixed(2)}%" height="6" fill="${p.color}" />`;
    x += w;
    return seg;
  }).join('');
  const marks = TICKS.map((t) => {
    const tall = t === 0.5;
    return `<rect x="${(t * 100).toFixed(2)}%" y="${tall ? 0 : mid - 2}" width="1" height="${tall ? height : 4}" class="tick" />`;
  }).join('');
  return `<svg class="readout-scale" viewBox="0 0 100 ${height}" preserveAspectRatio="none" width="100%" height="${height}" aria-hidden="true">`
    + `<rect x="0" y="${mid - 1}" width="100%" height="2" rx="1" class="track" />${segs}${marks}</svg>`;
}

/**
 * Format an estimate's band for print: "310–520" — or nothing, when the
 * number is a count rather than a measurement.
 */
export function bandLabel(low, high) {
  if (low == null || high == null) return '';
  const lo = Math.round(low);
  const hi = Math.round(high);
  return hi > lo ? `${lo.toLocaleString()}–${hi.toLocaleString()}` : '';
}
