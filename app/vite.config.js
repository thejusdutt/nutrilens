import { defineConfig } from 'vite';

function crossOriginIsolationHeaders() {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
}

// Stable (hash-free) asset names so the hand-written service worker can keep a
// deterministic precache list; cache busting is done via the SW CACHE_VERSION.
export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/worker-[name].js',
      },
    },
  },
  // COOP/COEP make the page crossOriginIsolated, which unlocks
  // SharedArrayBuffer → multi-threaded WASM inference (several× faster).
  // The app still works without them (single-threaded fallback).
  server: { port: 5199, headers: crossOriginIsolationHeaders() },
  preview: { port: 5199, headers: crossOriginIsolationHeaders() },
});
