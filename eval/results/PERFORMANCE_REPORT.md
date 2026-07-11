# NutriLens Performance Report

Generated 2026-07-11T06:49:35.293Z · CPU: onnxruntime-node WASM-equivalent (browser numbers depend on device; WebGPU is typically 2–5× faster).

| Stage | mean | p50 | p90 | p99 |
|---|---|---|---|---|
| Swin-Food101 (int8) classify | 4548 ms | 599.5 ms | 769.4 ms | 962.7 ms |
| MobileCLIP-S0 embed+score | 7699 ms | 1077.8 ms | 1311.5 ms | 1706.2 ms |

Measured over 2782 images. Browser-side stage timings (SlimSAM encode ≈1.7 s CPU / decode ≈90 ms, plate detection ≈70 ms) are logged by the app console and in browser-smoke runs.

## Model payload

| Asset | Size |
|---|---|
| swin-food101 model_int8.onnx | 93 MB |
| mobileclip-s0 vision int8 | 11.8 MB |
| slimsam encoder+decoder (quantized) | 17.1 MB |
| label embeddings + nutrition DB + vocab | ~0.6 MB |
| ORT runtime (wasm, jsep) | ~31 MB |
