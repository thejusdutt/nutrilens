# Browser Compatibility

Tested matrix (feature-detection based; the app has no build-time browser targets
beyond ES2022):

| Capability | Chrome/Edge ≥ 113 | Firefox ≥ 128 | Safari ≥ 17 |
|---|---|---|---|
| Core app (ES modules, module workers) | ✅ | ✅ | ✅ |
| ONNX Runtime WASM SIMD | ✅ | ✅ | ✅ |
| Multi-threaded WASM (needs COOP/COEP) | ✅ | ✅ | ✅ (16.4+) |
| WebGPU (opt-in `?webgpu=1`) | ✅ | ⚠️ behind flag/nightly | ⚠️ 18+ partial |
| PWA install prompt | ✅ | ➖ (manual) | ✅ (Add to Home Screen) |
| Camera (getUserMedia) | ✅ | ✅ | ✅ |
| Service worker + Cache Storage (135 MB) | ✅ | ✅ | ✅ (quota prompts possible) |
| IndexedDB history | ✅ | ✅ | ✅ |
| `createImageBitmap` EXIF orientation | ✅ | ✅ | ✅ 17+ |

Notes:

- **Storage quota**: models occupy ~135 MB of Cache Storage. Chromium grants
  this silently; Safari may evict under pressure — the app re-downloads
  transparently (cache-first with network fallback).
- **No COOP/COEP**: everything still works; WASM runs single-threaded
  (first-classification latency roughly 2–4× higher).
- **iOS specifics**: camera capture falls back to `<input capture>` if
  getUserMedia is denied; PWA install is via Share → Add to Home Screen.
- **Graceful degradation order**: WebGPU (opt-in) → threaded WASM →
  single-thread WASM. SlimSAM/portion stage is lazy; if it fails, the app falls
  back to typical-serving portions and stays functional.
- Private/incognito windows may block service workers or IndexedDB; the app
  still analyzes photos (models re-download each visit; history disabled by
  the browser).
