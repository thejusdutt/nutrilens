/**
 * Gate on the barcode table that actually ships, not on fixtures: every row
 * must satisfy the same physical checks the build applies, so a regression in
 * tools/build-barcode-db.mjs cannot publish a bad table quietly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BarcodeIndex } from '../src/index.js';

const data = join(dirname(fileURLToPath(import.meta.url)), '../../../app/public/data');
const metaPath = join(data, 'barcodes.json');

describe.skipIf(!existsSync(metaPath))('shipped barcode table', () => {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const gz = readFileSync(join(data, meta.file));
  const index = new BarcodeIndex(gunzipSync(gz));

  it('stays light and matches its manifest', () => {
    expect(gz.length).toBe(meta.bytes);
    expect(gz.length).toBeLessThan(5e6);
    expect(index.count).toBe(meta.count);
    expect(index.count).toBeGreaterThan(100_000);
    expect(index.meta.license).toBe('ODbL-1.0');
  });

  it('is sorted with no duplicate codes, so binary search is exact', () => {
    for (let i = 1; i < index.count; i++) expect(index.codes[i] > index.codes[i - 1]).toBe(true);
  });

  it('every product is physically plausible', () => {
    const bad = [];
    for (let i = 0; i < index.count; i++) {
      const code = String(index.codes[i]).padStart(13, '0');
      const f = index.lookup(code);
      const n = f.per100g;
      const atwater = 4 * n.protein + 4 * n.carbs + 9 * n.fat;
      const off = Math.min(Math.abs(n.kcal - atwater), Math.abs(n.kcal - (atwater - 2 * (n.fiber ?? 0))));
      if (!f.name || !(n.kcal >= 0) || n.kcal > 950
        || off > Math.max(20, 0.15 * n.kcal) + 0.5
        || n.protein + n.carbs + n.fat > 105
        || (n.sugars ?? 0) > n.carbs + 1.01 || (n.satFat ?? 0) > n.fat + 1.01) bad.push(code);
      if (bad.length > 5) break;
    }
    expect(bad).toEqual([]);
  });

  it('knows the products everyone scans', () => {
    const cola = index.lookup('5449000000996');
    expect(cola?.name).toMatch(/coca-cola/i);
    expect(cola.per100g.kcal).toBeGreaterThan(35);
    expect(cola.per100g.kcal).toBeLessThan(48);
    expect(index.lookup('3017620422003')?.name).toMatch(/nutella/i);
  });
});
