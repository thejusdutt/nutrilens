# NutriLens Performance Report

Generated 2026-07-17T16:00:21.669Z · CPU: onnxruntime-node WASM-equivalent (browser numbers depend on device; WebGPU is typically 2–5× faster).

| Stage | mean | p50 | p90 | p99 |
|---|---|---|---|---|
| Swin-Food101 (int8) classify | 1364 ms | 1599.5 ms | 1891.8 ms | 2525.6 ms |
| MobileCLIP-S2 embed+score | 1147 ms | 1268.9 ms | 1591.6 ms | 2117.5 ms |

Measured over 2782 images. Browser-side stage timings (SlimSAM encode ≈1.7 s CPU / decode ≈90 ms, plate detection ≈70 ms) are logged by the app console and in browser-smoke runs.

## Model payload

| Asset | Size |
|---|---|
| swin-food101 model_int8.onnx | 93 MB |
| mobileclip-s2 vision fp16 | 69 MB |
| slimsam encoder+decoder (quantized) | 17.1 MB |
| label embeddings + nutrition DB + vocab | ~0.6 MB |
| ORT runtime (wasm, jsep) | ~31 MB |
