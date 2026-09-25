/**
 * Step 2 of the offline barcode database (step 1 is tools/extract-off.py).
 *
 * Reads tools/data/off-candidates.jsonl, runs every product through the same
 * fromOffProduct the app used for live lookups, keeps the most-scanned ones and
 * writes app/public/data/barcodes-<hash>.bin.gz (the packed table from
 * packages/off-food/src/pack.js, gzipped, opened on the device with
 * DecompressionStream) plus barcodes.json naming it. The hash in the name is
 * what lets the app keep the table in the long-lived model cache.
 *
 * Ranking is by Open Food Facts `unique_scans_n`: how many distinct people
 * scanned the product. That is the closest public proxy for "will a user hold
 * this packet up to the camera", and it is what the coverage figure below is
 * measured against.
 *
 *   node tools/build-barcode-db.mjs [--limit 150000] [--budget-mb 4] [--min-scans 1]
 *
 * Three things keep it light and trustworthy:
 *  - a size budget: products are added in scan order until the gzipped table
 *    would pass --budget-mb, so the least-scanned tail is what gets cut;
 *  - completeness: protein, carbs and fat must all be on the label;
 *  - Atwater agreement: stated kcal must match 4P + 4C + 9F (+2 per g fibre is
 *    allowed for, as is alcohol-free rounding) within 15% or 20 kcal. OFF is
 *    crowdsourced; a kJ figure typed into the kcal box or a per-serving value
 *    in a per-100 g field fails this, and would otherwise be logged confidently.
 *
 * Data is (c) Open Food Facts contributors, licensed ODbL 1.0; the derived
 * table carries the same licence (see app/public/data/BARCODES-LICENSE.txt).
 */
import { createReadStream, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidBarcode } from '@nutrilens/barcode';
import { fromOffProduct, packProducts, BarcodeIndex, PACKED_FIELDS } from '@nutrilens/off-food';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.OFF_CANDIDATES ?? join(root, 'tools/data/off-candidates.jsonl');
const DATA = join(root, 'app/public/data');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const LIMIT = arg('limit', 150_000);
const BUDGET = arg('budget-mb', 4) * 1e6;
const MIN_SCANS = arg('min-scans', 1);

/** GTIN-13 key: UPC-A and EAN-8 left-padded with zeros, as GS1 normalizes them. */
const gtin13 = (code) => code.padStart(13, '0');

/** @returns {string|null} why a record should not ship */
function implausible(n) {
  if (![n.protein, n.carbs, n.fat].every(Number.isFinite)) return 'missing a macro';
  const atwater = 4 * n.protein + 4 * n.carbs + 9 * n.fat;
  // Fibre may or may not be inside "carbohydrates" depending on the label's
  // country, so accept either reading.
  const alt = atwater - 2 * (n.fiber ?? 0);
  const off = Math.min(Math.abs(n.kcal - atwater), Math.abs(n.kcal - alt));
  if (off > Math.max(20, 0.15 * n.kcal)) return 'kcal disagrees with macros';
  if ((n.sugars ?? 0) > n.carbs + 1 || (n.satFat ?? 0) > n.fat + 1) return 'part exceeds its whole';
  return null;
}

const best = new Map(); // gtin13 → { food, scans, popularity, countries }
const rejected = {};
let lines = 0;
let totalScans = 0;
const scansByCountry = {};

const rl = createInterface({ input: createReadStream(SRC, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  lines++;
  // Python's json writes Infinity/NaN for garbage cells; read them as missing.
  const p = JSON.parse(line.replace(/:(-?Infinity|NaN)(?=[,}])/g, ':null'));
  if (!isValidBarcode(p.code)) { rejected['bad check digit'] = (rejected['bad check digit'] ?? 0) + 1; continue; }
  const key = gtin13(p.code);
  const mapped = fromOffProduct(p, { barcode: key });
  if (!mapped.ok) { rejected[mapped.reason] = (rejected[mapped.reason] ?? 0) + 1; continue; }
  // Fibre is the field most often mistyped (LU Prince: 52 g). If macros plus
  // fibre overflow 100 g, the label must count fibre inside carbs, so sugars
  // and fibre together have to fit inside carbs too. When they cannot, drop
  // fibre rather than the product: the energy and macros still check out.
  const n = mapped.food.per100g;
  if (n.fiber != null && n.protein + n.carbs + n.fat + n.fiber > 105
      && (n.sugars ?? 0) + n.fiber > n.carbs + 1) {
    delete n.fiber;
    rejected['fibre dropped (kept product)'] = (rejected['fibre dropped (kept product)'] ?? 0) + 1;
  }
  const why = implausible(n);
  if (why) { rejected[why] = (rejected[why] ?? 0) + 1; continue; }
  totalScans += p.scans;
  for (const c of p.countries) scansByCountry[c] = (scansByCountry[c] ?? 0) + p.scans;
  const prev = best.get(key);
  if (!prev || p.scans > prev.scans) {
    // Names are free text; a 300-character "name" is an ingredients list pasted
    // into the wrong field and would only bloat the table.
    mapped.food.name = mapped.food.name.replace(/\s+/g, ' ').slice(0, 80);
    if (mapped.food.brand) mapped.food.brand = mapped.food.brand.slice(0, 40);
    best.set(key, { food: mapped.food, scans: p.scans, popularity: p.popularity, countries: p.countries });
  }
  if (lines % 500_000 === 0) console.error(`${lines} lines, ${best.size} valid`);
}

const ranked = [...best.values()]
  .filter((r) => r.scans >= MIN_SCANS)
  .sort((a, b) => b.scans - a.scans || b.popularity - a.popularity);
// Fill the size budget in scan order. gzip ratio is steady across the table, so
// measure it on a prefix and cut once, rather than recompressing per product.
let kept = ranked.slice(0, LIMIT);
for (;;) {
  const trial = gzipSync(packProducts(kept.map((r) => r.food)), { level: 9 }).length;
  if (trial <= BUDGET) break;
  kept = kept.slice(0, Math.floor(kept.length * (BUDGET / trial) * 0.98));
}

const keptScans = kept.reduce((n, r) => n + r.scans, 0);
const keptByCountry = {};
for (const r of kept) for (const c of r.countries) keptByCountry[c] = (keptByCountry[c] ?? 0) + r.scans;

const packed = packProducts(kept.map((r) => r.food), {
  source: 'Open Food Facts product-database (Hugging Face export)',
  license: 'ODbL-1.0',
  attribution: '© Open Food Facts contributors — openfoodfacts.org',
  built: new Date().toISOString().slice(0, 10),
});
const gz = gzipSync(packed, { level: 9 });
const file = `barcodes-${createHash('sha256').update(gz).digest('hex').slice(0, 10)}.bin.gz`;
for (const f of readdirSync(DATA)) if (/^barcodes-.*\.bin\.gz$/.test(f)) rmSync(join(DATA, f));
writeFileSync(join(DATA, file), gz);
writeFileSync(join(DATA, 'barcodes.json'), `${JSON.stringify({
  file, count: kept.length, bytes: gz.length, built: new Date().toISOString().slice(0, 10),
  license: 'ODbL-1.0', attribution: '© Open Food Facts contributors — openfoodfacts.org',
}, null, 2)}
`);

// Read back what was written, the way the app will.
const check = new BarcodeIndex(packed);
for (const r of kept.slice(0, 2000)) {
  const got = check.lookup(r.food.barcode);
  if (!got || got.name !== r.food.name) throw new Error(`round-trip failed for ${r.food.barcode}`);
  // kcal is stored to 0.1; anything past half a step is a packing bug.
  if (Math.abs(got.per100g.kcal - r.food.per100g.kcal) > 0.0501) throw new Error(`kcal drift on ${r.food.barcode}`);
}

const pct = (a, b) => `${((100 * a) / (b || 1)).toFixed(1)}%`;
console.log(`candidates read      ${lines}`);
console.log(`valid products       ${best.size}`);
console.log(`rejected             ${JSON.stringify(rejected)}`);
console.log(`kept                 ${kept.length} (min scans ${kept.at(-1)?.scans ?? 0})`);
console.log(`scan coverage        ${pct(keptScans, totalScans)} of all unique scans of valid products`);
for (const c of ['india', 'germany', 'united-states', 'united-kingdom', 'france']) {
  console.log(`  ${c.padEnd(18)} ${pct(keptByCountry[c] ?? 0, scansByCountry[c])}`);
}
console.log(`fields               ${PACKED_FIELDS.map(([k]) => k).join(', ')}`);
console.log(`packed               ${(packed.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(1)} MB gzip -> app/public/data/${file}`);
