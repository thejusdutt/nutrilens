/**
 * NutriLens service worker — offline-first.
 *
 * Strategy:
 *  - App shell (small, changes with releases): precached at install,
 *    cache-first at runtime. Bump SHELL_VERSION to ship updates.
 *  - Models + data (large, immutable per release): runtime cache-first into a
 *    separate cache; fetched lazily by the inference worker (with progress UI)
 *    or eagerly via Settings → "Download all models".
 *  - Navigations fall back to the cached shell when offline.
 */

/** Bump to ship an app-shell update. Does NOT touch the model cache. */
const SHELL_VERSION = 'v1';
/**
 * Versioned separately on purpose: the models are ~180 MB and immutable, so
 * shipping a UI fix must never evict them and force a re-download. Bump this
 * only when the model files themselves change — and keep it in step with
 * MODEL_CACHE in app/src/model-cache.js, which is what writes these bytes.
 */
const MODEL_VERSION = 'v1';
const SHELL_CACHE = `nutrilens-shell-${SHELL_VERSION}`;
const MODEL_CACHE = `nutrilens-models-${MODEL_VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/assets/index.js',
  '/assets/index.css',
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
  '/data/vocabulary.json',
  '/data/label-embeddings.json',
  '/data/label-embeddings.bin',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // allSettled: optional files (e.g. jsep variants across ORT versions) may 404.
    await Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(u)));
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
