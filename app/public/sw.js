/**
 * NutriLens service worker — offline-first.
 *
 * Strategy:
 *  - App shell (small, changes with releases): precached at install,
 *    cache-first at runtime. The build stamps its content hash as the version.
 *  - Models + data (large, immutable per release): runtime cache-first into a
 *    separate cache; fetched lazily by the inference worker (with progress UI)
 *    or eagerly via Settings → "Download all models".
 *  - Navigations fall back to the cached shell when offline.
 */

/** Stamped from the precached file contents by tools/postbuild.mjs. */
const SHELL_VERSION = '__NUTRILENS_SHELL_VERSION__';
/**
 * Stamped from app/src/model-cache.js by tools/postbuild.mjs. Models are
 * versioned separately so a UI release never forces a ~180 MB re-download.
 */
const MODEL_CACHE = '__NUTRILENS_MODEL_CACHE__';
const SHELL_CACHE = `nutrilens-shell-${SHELL_VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/assets/index.js',
  '/assets/index.css',
  // The type system is not decoration: without these the app falls back to a
  // system font offline, and every figure loses the tabular alignment the
  // layout depends on.
  '/fonts/instrument-sans.woff2',
  '/fonts/martian-mono.woff2',
  '/assets/inference-worker.js',
  // ONNX Runtime web runtime (needed to run any model offline)
  '/ort/ort-wasm-simd-threaded.wasm',
  '/ort/ort-wasm-simd-threaded.mjs',
  '/ort/ort-wasm-simd-threaded.jsep.wasm',
  '/ort/ort-wasm-simd-threaded.jsep.mjs',
  '/ort/ort-wasm-simd-threaded.asyncify.wasm',
  '/ort/ort-wasm-simd-threaded.asyncify.mjs',
  // Small data files
  '/data/nutrition-db.json',
  '/data/nutrition-library.json',
  '/data/vocabulary.json',
  '/data/label-embeddings.json',
  '/data/label-embeddings.bin',
  // Trained linear probe: read alongside the text embeddings when naming a
  // region. Precached with them so offline naming is identical to online.
  '/data/probe.json',
  '/data/probe.bin',
  // Names the current barcode table. The table itself is ~4 MB and lives in
  // the model cache (see app/src/barcode-db.js), so it is not listed here.
  '/data/barcodes.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // allSettled: optional files (e.g. jsep variants across ORT versions) may 404.
    // `reload` prevents a new shell cache being populated from a stale HTTP cache.
    await Promise.allSettled(SHELL_ASSETS.map(async (url) => {
      const request = new Request(url, { cache: 'reload' });
      const response = await fetch(request);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const keep = new Set([SHELL_CACHE, MODEL_CACHE]);
    await Promise.all(names
      .filter((n) => n.startsWith('nutrilens-') && !keep.has(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// NOTE: model prefetching is intentionally done page/worker-side via the
// Cache API (see app/src/main.js swPrefetch and the inference worker's
// fetchWithProgress): browsers terminate service workers mid-download on
// ~100 MB files, so the SW's job here is only to *serve* the caches.

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // Model files: intercept only small metadata (.json). The ~10–100 MB .onnx
  // binaries are deliberately NOT intercepted — streaming them through the SW
  // dies when the browser terminates the SW mid-transfer. The inference worker
  // reads/writes them via the Cache API itself (cache-first), so offline works
  // without the SW ever touching those requests.
  // The barcode table is written to the model cache by the page itself; letting
  // the shell handler also copy it would store it twice and drop it every release.
  if (/^\/data\/barcodes-/.test(url.pathname)) return;
  if (url.pathname.startsWith('/models/')) {
    if (url.pathname.endsWith('.json')) {
      event.respondWith(cacheFirst(MODEL_CACHE, event.request));
    }
    return;
  }
  // SPA navigations → shell.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      cacheFirst(SHELL_CACHE, new Request('/index.html')).catch(() => fetch(event.request)),
    );
    return;
  }
  event.respondWith(cacheFirst(SHELL_CACHE, event.request));
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}
