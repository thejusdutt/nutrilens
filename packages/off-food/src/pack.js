/**
 * A packed, read-only barcode → product table, so a scan resolves on the
 * device instead of asking Open Food Facts.
 *
 * JSON would be the obvious format and is the wrong one: a quarter of a
 * million objects take seconds to parse on a phone and triple the memory.
 * This is column-major typed arrays, so opening the table is a few views over
 * one buffer and a lookup is a binary search.
 *
 * Layout (little-endian), every section 8-byte aligned:
 *   u32 magic 'NLBC' · u32 version · u32 count · u32 metaBytes
 *   meta     UTF-8 JSON { fields, scales, ...provenance }
 *   codes    f64[count]            EAN-13 as a number, ascending (exact below 2^53)
 *   values   u16[count × fields]   value × scale, MISSING = 0xFFFF
 *   serving  u16[count]            label serving grams × 10, MISSING = none
 *   offsets  u32[count + 1]        into text
 *   text     UTF-8 "name\x1fbrand\x1fserving label" per product
 */

export const MAGIC = 0x4342_4c4e; // 'NLBC'
export const VERSION = 1;
const MISSING = 0xffff;
const SEP = '\u001f';

/** Packed nutrients and their fixed-point scale. Grams keep round2 precision. */
export const PACKED_FIELDS = [
  ['kcal', 10], ['protein', 100], ['carbs', 100], ['fat', 100],
  ['fiber', 100], ['sugars', 100], ['satFat', 100], ['sodium', 1], ['alcohol', 100],
];

const align8 = (n) => (n + 7) & ~7;

/**
 * @param {Array<{barcode:string, name:string, brand:string|null, per100g:object, portions:Array}>} foods
 *   records from fromOffProduct, barcodes already EAN-13
 * @param {object} [provenance] stored in the header (source, licence, build date)
 * @returns {Uint8Array}
 */
export function packProducts(foods, provenance = {}) {
  const rows = [...foods].sort((a, b) => Number(a.barcode) - Number(b.barcode));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].barcode === rows[i - 1].barcode) throw new Error(`duplicate barcode ${rows[i].barcode}`);
  }
  const count = rows.length;
  const F = PACKED_FIELDS.length;
  const enc = new TextEncoder();
  const meta = enc.encode(JSON.stringify({
    fields: PACKED_FIELDS.map(([k]) => k), scales: PACKED_FIELDS.map(([, s]) => s), ...provenance,
  }));
  const texts = rows.map((f) => {
    const serving = f.portions.find(([label]) => label !== '100 g');
    // "30 g" is rebuilt from the grams on read; only a label with words in it
    // ("1 bar (32.5 g)") is worth its bytes.
    const label = serving && serving[0] !== `${serving[1]} g` ? serving[0] : '';
    return enc.encode([f.name, f.brand ?? '', label].join(SEP));
  });
  const textBytes = texts.reduce((n, t) => n + t.length, 0);

  const oMeta = 16;
  const oCodes = align8(oMeta + meta.length);
  const oValues = align8(oCodes + count * 8);
  const oServing = align8(oValues + count * F * 2);
  const oOffsets = align8(oServing + count * 2);
  const oText = align8(oOffsets + (count + 1) * 4);
  const buf = new ArrayBuffer(oText + textBytes);
  const u8 = new Uint8Array(buf);

  new Uint32Array(buf, 0, 4).set([MAGIC, VERSION, count, meta.length]);
  u8.set(meta, oMeta);
  const codes = new Float64Array(buf, oCodes, count);
  const values = new Uint16Array(buf, oValues, count * F);
  const serving = new Uint16Array(buf, oServing, count);
  const offsets = new Uint32Array(buf, oOffsets, count + 1);

  let at = 0;
  rows.forEach((f, i) => {
    if (!/^\d{13}$/.test(f.barcode)) throw new Error(`not EAN-13: ${f.barcode}`);
    codes[i] = Number(f.barcode);
    PACKED_FIELDS.forEach(([key, scale], j) => {
      const v = f.per100g[key];
      const q = Number.isFinite(v) ? Math.round(v * scale) : MISSING;
      values[i * F + j] = q >= 0 && q < MISSING ? q : MISSING;
    });
    const g = f.portions.find(([label]) => label !== '100 g')?.[1];
    const qg = Number.isFinite(g) ? Math.round(g * 10) : MISSING;
    serving[i] = qg > 0 && qg < MISSING ? qg : MISSING;
    offsets[i] = at;
    u8.set(texts[i], oText + at);
    at += texts[i].length;
  });
  offsets[count] = at;
  return u8;
}

/** Opens a packed table without copying it. */
export class BarcodeIndex {
  /** @param {ArrayBuffer|Uint8Array} bytes */
  constructor(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Typed-array views need an aligned base; copy only if the caller's isn't.
    const buf = u8.byteOffset % 8 === 0 ? u8.buffer : u8.slice().buffer;
    const base = u8.byteOffset % 8 === 0 ? u8.byteOffset : 0;
    const [magic, version, count, metaLen] = new Uint32Array(buf, base, 4);
    if (magic !== MAGIC) throw new Error('not a NutriLens barcode table');
    if (version !== VERSION) throw new Error(`barcode table version ${version}, expected ${VERSION}`);
    this.meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, base + 16, metaLen)));
    this.count = count;
    const F = this.meta.fields.length;
    const oCodes = align8(16 + metaLen);
    const oValues = align8(oCodes + count * 8);
    const oServing = align8(oValues + count * F * 2);
    const oOffsets = align8(oServing + count * 2);
    const oText = align8(oOffsets + (count + 1) * 4);
    this.codes = new Float64Array(buf, base + oCodes, count);
    this.values = new Uint16Array(buf, base + oValues, count * F);
    this.serving = new Uint16Array(buf, base + oServing, count);
    this.offsets = new Uint32Array(buf, base + oOffsets, count + 1);
    this.text = new Uint8Array(buf, base + oText);
    this.decoder = new TextDecoder();
  }

  /** @param {string} ean13 */
  indexOf(ean13) {
    const target = Number(ean13);
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.codes[mid];
      if (v === target) return mid;
      if (v < target) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /**
   * The same food record fromOffProduct builds, so the rest of the app cannot
   * tell a bundled product from a scanned one.
   * @param {string} ean13
   */
  lookup(ean13) {
    const i = this.indexOf(ean13);
    if (i < 0) return null;
    const { fields, scales } = this.meta;
    const F = fields.length;
    const per100g = {};
    fields.forEach((key, j) => {
      const q = this.values[i * F + j];
      if (q !== MISSING) per100g[key] = Math.round((q / scales[j]) * 100) / 100;
    });
    const [name, brand, servingLabel] = this.decoder
      .decode(this.text.subarray(this.offsets[i], this.offsets[i + 1])).split(SEP);
    const sq = this.serving[i];
    const servingG = sq === MISSING ? null : sq / 10;
    const portions = [];
    if (servingG) portions.push([servingLabel || `${servingG} g`, servingG]);
    portions.push(['100 g', 100]);
    return {
      id: `off:${ean13}`,
      name,
      brand: brand || null,
      barcode: ean13,
      source: 'Open Food Facts (ODbL)',
      per100g,
      portions,
      prior: { servingG: servingG ?? 100, heightCm: 2, densityGml: 1 },
      quality: { nutrientCount: Object.keys(per100g).length, hasServing: !!servingG, completeness: null },
    };
  }
}
