/**
 * The bundled barcode table: a quarter of a million of the most-scanned Open
 * Food Facts products, resolved on the device.
 *
 * /data/barcodes.json (precached with the shell, tiny) names the current table
 * file, which carries a content hash in its name. The table itself goes into the
 * model cache rather than the shell cache, so a UI release does not re-download
 * it, and a rebuilt table can never be confused with a cached old one.
 *
 * Opened once per session: a gunzip and a few typed-array views, no parsing.
 */
import { BarcodeIndex } from '@nutrilens/off-food';
import { loadModelBytes, MODEL_CACHE } from './model-cache.js';

let opening = null;

/** GTIN-13 key: UPC-A and EAN-8 left-padded with zeros, as GS1 normalizes them. */
export const gtin13 = (code) => code.padStart(13, '0');

async function gunzip(bytes) {
  // Some hosts send the file with Content-Encoding: gzip and fetch has already
  // inflated it; only inflate what still starts with the gzip magic.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Drop tables from earlier builds so they do not sit in storage forever. */
async function pruneOld(current) {
  try {
    const cache = await caches.open(MODEL_CACHE);
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (path.startsWith('/data/barcodes-') && path !== current) await cache.delete(req);
    }
  } catch { /* storage cleanup is best effort */ }
}

/**
 * Put the table bytes in the cache without opening it, so startup costs no
 * memory or CPU. Safe to call repeatedly: a cache hit returns straight away.
 */
export async function warmBarcodeDb() {
  const meta = await fetch('/data/barcodes.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!meta?.file) return;
  const url = `/data/${meta.file}`;
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  // A hit is the common case on every launch: check it without reading 4 MB.
  if (!(cache && await cache.match(url))) await loadModelBytes(url);
  pruneOld(url);
}

/**
 * @param {(loaded:number,total:number)=>void} [onProgress]
 * @returns {Promise<BarcodeIndex|null>} null when no table ships with this build
 */
export function openBarcodeDb(onProgress) {
  opening ??= (async () => {
    const meta = await fetch('/data/barcodes.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!meta?.file) return null;
    const url = `/data/${meta.file}`;
    let index;
    try {
      index = new BarcodeIndex(await gunzip(await loadModelBytes(url, onProgress)));
    } catch (err) {
      // SPA hosts answer a missing file with index.html and HTTP 200, which
      // would otherwise sit in the cache and fail every open until a release.
      await caches.open(MODEL_CACHE).then((c) => c.delete(url)).catch(() => {});
      throw err;
    }
    pruneOld(url);
    return index;
  })().catch((err) => { opening = null; throw err; });
  return opening;
}

/**
 * @param {string} barcode as scanned or typed
 * @returns {Promise<object|null>} a food record shaped like fromOffProduct's
 */
export async function bundledProduct(barcode) {
  const index = await openBarcodeDb();
  const food = index?.lookup(gtin13(barcode));
  // Keep the id keyed on the code as scanned, like every other product path.
  return food ? { ...food, id: `off:${barcode}`, barcode } : null;
}
