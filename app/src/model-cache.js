/**
 * Model byte loading, shared by the page and the inference worker.
 *
 * Both sides need identical behaviour — cache-first through Cache Storage,
 * manifest-aware reassembly of split model files, and validation of what was
 * reassembled — so the logic lives here once. It used to be copied into both
 * places and the copies drifted: the page-side one skipped the length check,
 * so a short part response left zero padding in the buffer, cached it under
 * the plain URL, and the worker then trusted those corrupt bytes forever.
 *
 * public/sw.js does not import this: it is a classic service worker and only
 * *serves* these caches, it never writes model bytes (browsers terminate
 * service workers mid-transfer on ~100 MB bodies).
 */

/** Cache Storage name for model bytes. Must match MODEL_CACHE in public/sw.js. */
export const MODEL_CACHE = 'nutrilens-models-v1';

/**
 * Fetch a model asset as bytes, cache-first.
 *
 * @param {string} url
 * @param {(loaded:number, total:number)=>void} [onProgress] Bytes so far / expected
 *   (total is 0 when the server sends no Content-Length).
 * @returns {Promise<Uint8Array>}
 */
export async function loadModelBytes(url, onProgress) {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const hit = cache && await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const manifest = await readManifest(url);
  const bytes = manifest
    ? await fetchParts(url, manifest, onProgress)
    : await fetchWhole(url, onProgress);

  if (cache) {
    await cache.put(url, new Response(bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    })).catch(() => {});
  }
  return bytes;
}

/**
 * Look for a `<url>.manifest.json` written by tools/split-models.mjs — static
 * hosts with per-file size caps (Cloudflare Pages: 25 MiB) serve the big models
 * pre-split. The manifest is validated rather than detected by 404: SPA-mode
 * hosts answer any missing path with index.html + HTTP 200, which would
 * otherwise get parsed as model bytes.
 * @private
 */
async function readManifest(url) {
  try {
    const res = await fetch(`${url}.manifest.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const m = await res.json();
    return Number.isInteger(m.parts) && Number.isInteger(m.size) ? m : null;
  } catch { return null; } // whole-file host
}

/** @private Reassemble `<url>.pNN` parts into the original bytes. */
async function fetchParts(url, manifest, onProgress) {
  const buf = new Uint8Array(manifest.size);
  let off = 0;
  for (let i = 0; i < manifest.parts; i++) {
    const res = await fetch(`${url}.p${String(i).padStart(2, '0')}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url} part ${i}: HTTP ${res.status}`);
    const part = new Uint8Array(await res.arrayBuffer());
    buf.set(part, off);
    off += part.length;
    onProgress?.(off, manifest.size);
  }
  // Must be exact: a short part leaves zeroes behind, and caching that would
  // hand every later load a silently corrupt model.
  if (off !== manifest.size) throw new Error(`${url}: reassembled ${off} of ${manifest.size} bytes`);
  return buf;
}

/**
 * @private Stream a whole file to bytes with throttled progress.
 * `no-store` bypasses the HTTP disk cache: ~100 MB writes to it can fail with
 * ERR_CACHE_WRITE_FAILURE, and Cache Storage is our persistence layer anyway.
 * Length is deliberately NOT checked against Content-Length here — on hosts
 * that compress responses it reports the encoded size, not the decoded one.
 */
async function fetchWhole(url, onProgress) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - lastPost > 120) { // throttle UI-updating progress
      onProgress?.(loaded, total);
      lastPost = now;
    }
  }
  onProgress?.(loaded, total);
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}
