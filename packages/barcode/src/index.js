/**
 * @nutrilens/barcode
 *
 * EAN-13 / EAN-8 / UPC-A decoding from a camera frame, and encoding back to
 * modules, with no dependencies.
 *
 * Why hand-rolled: the browser's BarcodeDetector is not available everywhere
 * (notably desktop Chrome without the shape-detection flag, and every iOS
 * browser), and a food tracker whose scanner only works on some phones is
 * worse than one that always works. This decoder is the fallback the app uses
 * when BarcodeDetector is missing.
 *
 * Method — the classic scanline approach:
 *   luminance row → global threshold → run lengths → find the start guard →
 *   read digits four runs at a time by matching normalised widths against the
 *   symbol tables → verify the middle/end guards → recover EAN-13's implicit
 *   first digit from the left-half parity pattern → validate the check digit.
 *
 * Only the binary symbol tables are hard-coded; widths and parities are derived
 * from them, so there is one source of truth for the encoding.
 */

/** Set A ("L"), the left-hand odd-parity symbols. */
const SET_A = ['0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011'];
/** Set B ("G"), the left-hand even-parity symbols. */
const SET_B = ['0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111'];
/** Set C ("R"), the right-hand symbols (the complement of set A). */
const SET_C = ['1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100'];

/** Which set encodes each of the six left digits, indexed by the first digit. */
const PARITY = ['AAAAAA', 'AABABB', 'AABBAB', 'AABBBA', 'ABAABB',
  'ABBAAB', 'ABBBAA', 'ABABAB', 'ABABBA', 'ABBABA'];

const START_END = '101';
const MIDDLE = '01010';

/** Run lengths of a 7-module symbol, e.g. "0001101" → [3,2,1,1]. */
const widthsOf = (bits) => {
  const out = [];
  let run = 1;
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] === bits[i - 1]) run++;
    else { out.push(run); run = 1; }
  }
  out.push(run);
  return out;
};

const WIDTHS_A = SET_A.map(widthsOf); // identical to set C by construction
const WIDTHS_B = SET_B.map(widthsOf);

/**
 * GTIN check digit (EAN-8, UPC-A, EAN-13, GTIN-14 all share this rule): from
 * the right of the payload, weights alternate 3, 1, 3, 1…
 * @param {string} payload Digits WITHOUT the check digit.
 * @returns {number}
 */
export function checkDigit(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const digit = payload.charCodeAt(payload.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** @param {string} code Full code including its check digit. */
export function isValidBarcode(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  return checkDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** UPC-A is EAN-13 with a leading zero; normalise so lookups have one key shape. */
export function toEan13(code) {
  if (code.length === 12) return `0${code}`;
  return code;
}

/**
 * Encode a code to a module string ('1' = bar). Useful for rendering a barcode
 * and for testing the decoder against exact, known input.
 * @param {string} code EAN-13 (13 digits), UPC-A (12) or EAN-8 (8), check digit included.
 * @returns {string} modules, 95 for EAN-13 / 67 for EAN-8
 */
export function encode(code) {
  if (!isValidBarcode(code)) throw new Error(`invalid barcode: ${code}`);
  if (code.length === 12) return encode(toEan13(code));
  const d = [...code].map(Number);
  if (code.length === 8) {
    return START_END
      + d.slice(0, 4).map((x) => SET_A[x]).join('')
      + MIDDLE
      + d.slice(4).map((x) => SET_C[x]).join('')
      + START_END;
  }
  if (code.length !== 13) throw new Error(`unsupported length: ${code.length}`);
  const parity = PARITY[d[0]];
  return START_END
    + d.slice(1, 7).map((x, i) => (parity[i] === 'A' ? SET_A[x] : SET_B[x])).join('')
    + MIDDLE
    + d.slice(7).map((x) => SET_C[x]).join('')
    + START_END;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Mean squared difference between measured run widths and a symbol pattern,
 * both normalised to modules. Returns Infinity when any single run is wildly
 * off, which rejects noise faster than a summed score alone.
 * @private
 */
function variance(counters, pattern) {
  const total = counters.reduce((s, c) => s + c, 0);
  const patternTotal = pattern.reduce((s, c) => s + c, 0);
  if (total < patternTotal) return Infinity; // fewer pixels than modules
  const unit = total / patternTotal;
  const maxPerUnit = unit * 0.75;
  let sum = 0;
  for (let i = 0; i < counters.length; i++) {
    const diff = Math.abs(counters[i] - pattern[i] * unit);
    if (diff > maxPerUnit) return Infinity;
    sum += diff * diff;
  }
  return sum / counters.length / (unit * unit);
}

const MAX_VARIANCE = 0.42;

/** @private Best-matching digit for four run widths, or null. */
function matchDigit(counters, widths) {
  let best = null, bestVar = MAX_VARIANCE;
  for (let d = 0; d < 10; d++) {
    const v = variance(counters, widths[d]);
    if (v < bestVar) { bestVar = v; best = d; }
  }
  return best;
}

/** @private Are these runs a guard of equal-width modules? */
function isGuard(counters, expected) {
  return variance(counters, expected) < MAX_VARIANCE;
}

/**
 * Run-length encode one row of luminance. Threshold is the midpoint between the
 * row's darkest and lightest pixel: barcodes are high-contrast by design, and a
 * per-row midpoint tolerates uneven lighting across the frame better than one
 * global threshold for the whole image.
 * @private
 * @returns {{runs:number[], firstDark:boolean}|null}
 */
function rowRuns(luma, width) {
  let min = 255, max = 0;
  for (let i = 0; i < width; i++) {
    const v = luma[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 40) return null; // flat row: no barcode here
  const threshold = (min + max) / 2;
  const runs = [];
  const firstDark = luma[0] < threshold;
  let dark = firstDark;
  let len = 0;
  for (let i = 0; i < width; i++) {
    const isDark = luma[i] < threshold;
    if (isDark === dark) len++;
    else { runs.push(len); dark = isDark; len = 1; }
  }
  runs.push(len);
  return { runs, firstDark };
}

/**
 * Decode a single row of luminance values.
 * @param {ArrayLike<number>} luma  One row, 0-255.
 * @param {number} width
 * @returns {{code:string, format:'EAN-13'|'EAN-8'|'UPC-A'}|null}
 */
export function decodeRow(luma, width) {
  const rle = rowRuns(luma, width);
  if (!rle) return null;
  const { runs, firstDark } = rle;
  // Try every dark run as a possible start guard, forwards then backwards
  // (a barcode held upside down reads as the reversed row).
  for (const reversed of [false, true]) {
    const seq = reversed ? [...runs].reverse() : runs;
    const startsDark = reversed
      ? (runs.length % 2 === 1 ? firstDark : !firstDark)
      : firstDark;
    for (let i = startsDark ? 0 : 1; i + 3 < seq.length; i += 2) {
      const found = tryDecodeAt(seq, i);
      if (found) return found;
    }
  }
  return null;
}

/** @private Attempt a full symbol read with the start guard at run index `i`. */
function tryDecodeAt(runs, i) {
  if (!isGuard(runs.slice(i, i + 3), [1, 1, 1])) return null;
  let p = i + 3;

  // EAN-13: 6 left digits (A/B mix), middle guard, 6 right digits (C).
  const left = [];
  const parity = [];
  for (let k = 0; k < 6; k++, p += 4) {
    const counters = runs.slice(p, p + 4);
    if (counters.length < 4) return null;
    const a = matchDigit(counters, WIDTHS_A);
    const b = matchDigit(counters, WIDTHS_B);
    const va = a == null ? Infinity : variance(counters, WIDTHS_A[a]);
    const vb = b == null ? Infinity : variance(counters, WIDTHS_B[b]);
    if (va === Infinity && vb === Infinity) break;
    if (va <= vb) { left.push(a); parity.push('A'); } else { left.push(b); parity.push('B'); }
  }

  if (left.length === 6 && isGuard(runs.slice(p, p + 5), [1, 1, 1, 1, 1])) {
    const q = p + 5;
    const right = [];
    for (let k = 0; k < 6; k++) {
      const counters = runs.slice(q + k * 4, q + k * 4 + 4);
      if (counters.length < 4) return null;
      const d = matchDigit(counters, WIDTHS_A); // set C shares set A's widths
      if (d == null) return null;
      right.push(d);
    }
    const firstDigit = PARITY.indexOf(parity.join(''));
    if (firstDigit < 0) return null;
    const code = `${firstDigit}${left.join('')}${right.join('')}`;
    if (!isValidBarcode(code)) return null;
    return { code, format: code.startsWith('0') ? 'UPC-A' : 'EAN-13' };
  }

  // EAN-8: 4 left digits (all set A), middle guard, 4 right digits.
  if (left.length >= 4 && parity.slice(0, 4).every((x) => x === 'A')) {
    const mid = i + 3 + 16;
    if (!isGuard(runs.slice(mid, mid + 5), [1, 1, 1, 1, 1])) return null;
    const q = mid + 5;
    const right = [];
    for (let k = 0; k < 4; k++) {
      const counters = runs.slice(q + k * 4, q + k * 4 + 4);
      if (counters.length < 4) return null;
      const d = matchDigit(counters, WIDTHS_A);
      if (d == null) return null;
      right.push(d);
    }
    const code = `${left.slice(0, 4).join('')}${right.join('')}`;
    if (!isValidBarcode(code)) return null;
    return { code, format: 'EAN-8' };
  }
  return null;
}

/**
 * Decode a barcode from an RGBA image by sampling horizontal scanlines.
 *
 * Rows are tried from the vertical centre outwards, because that is where a
 * user aims the guide box and where a partially-shadowed label is most likely
 * to be readable.
 *
 * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} img
 * @param {{rows?:number, band?:number}} [opts] rows = scanlines to try,
 *   band = fraction of image height to sample around the centre.
 * @returns {{code:string, format:string, row:number}|null}
 */
export function decodeImage(img, { rows = 21, band = 0.7 } = {}) {
  const { data, width, height } = img;
  const luma = new Uint8Array(width);
  const half = Math.floor(rows / 2);
  const spacing = Math.max(1, Math.floor(height * band / rows));
  const centre = Math.floor(height / 2);
  for (let step = 0; step <= half; step++) {
    for (const dir of step === 0 ? [0] : [-1, 1]) {
      const y = centre + dir * step * spacing;
      if (y < 0 || y >= height) continue;
      const off = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = off + x * 4;
        luma[x] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      }
      const hit = decodeRow(luma, width);
      if (hit) return { ...hit, row: y };
    }
  }
  return null;
}

/**
 * Render a code as an RGBA image — used by the tests, and handy for showing a
 * scannable code in the UI.
 * @param {string} code
 * @param {{moduleWidth?:number, height?:number, quiet?:number}} [opts]
 */
export function toImage(code, { moduleWidth = 3, height = 40, quiet = 10 } = {}) {
  const modules = encode(code);
  const width = (modules.length + quiet * 2) * moduleWidth;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let x = 0; x < width; x++) {
    const m = Math.floor(x / moduleWidth) - quiet;
    const dark = m >= 0 && m < modules.length && modules[m] === '1';
    if (!dark) continue;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}
