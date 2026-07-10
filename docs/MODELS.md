# Model Documentation

All models run locally via ONNX Runtime Web (WASM SIMD, multi-threaded when
COOP/COEP headers are served; WebGPU opt-in). They are fetched once from the
app's own origin and cached in Cache Storage.

## 1. Swin-Food101 (closed-set classifier)

| | |
|---|---|
| Source | `onnx-community/swin-finetuned-food101-ONNX` (export of `aspis/swin-finetuned-food101`) |
| Architecture | Swin-Base transformer, 224×224 input |
| Training | Fine-tuned on Food-101 (75,750 train images, 101 dishes) |
| Accuracy | 92.1% top-1 self-reported; 91.4% verified by HF eval; see ACCURACY_REPORT for our measurement of the shipped int8 file |
| Shipped file | `onnx/model_int8.onnx`, 93 MB (q4f16 52.7 MB also fetched for A/B eval) |
| Preprocessing | bicubic resize 224², rescale 1/255, ImageNet mean/std (`resizeBicubic` in @nutrilens/image-preprocess for training parity) |
| License | Apache-2.0 |

## 2. MobileCLIP-S0 vision tower (open-vocabulary head)

| | |
|---|---|
| Source | `Xenova/mobileclip_s0` (ONNX export of Apple MobileCLIP-S0) |
| Shipped file | `onnx/vision_model_int8.onnx`, 11.8 MB |
| Preprocessing | shortest-side 256 bilinear + center crop 256², rescale only (no mean/std) |
| Text tower | **build-time only** (43 MB int8 + tokenizer, in `tools/data/`); produces the shipped `label-embeddings.bin` (219 labels × 512 dims, prompt-ensembled: "a photo of X", "a close-up photo of X, food photography", "a plate of X" + synonyms) |
| Zero-shot quality | 67.8% ImageNet top-1 (reference); see ACCURACY_REPORT for food-domain numbers |
| License | Apple AML research license (weights), MIT (export tooling) |

Adding a food requires **no retraining**: add a vocabulary entry + FNDDS
mapping, rebuild embeddings + DB (two Node scripts, seconds).

## 3. SlimSAM-77 uniform (segmentation)

| | |
|---|---|
| Source | `Xenova/slimsam-77-uniform` (SlimSAM: 1.4%-size SAM distillation) |
| Shipped files | `vision_encoder_quantized.onnx` 12.2 MB + `prompt_encoder_mask_decoder_quantized.onnx` 4.9 MB |
| I/O | encoder: 1024² padded image → embeddings; decoder: point prompts (int64 labels!) → 3 mask hypotheses at 256² + IoU scores |
| Preprocessing | longest-side 1024 bilinear, zero pad, ImageNet mean/std |
| Latency | ~1.7 s encode (CPU, once per image), ~90 ms per prompt |
| License | MIT / Apache-2.0 |

## Alternatives evaluated and rejected

See [RESEARCH.md](RESEARCH.md) §3–5 for the comparison tables (ViT/SigLIP2
fine-tunes without ONNX exports, MobileNet fine-tunes at −10 to −17 pts top-1,
MobileCLIP-S2/SigLIP as heavier zero-shot options, MobileSAM/DeepLab, YOLO
detectors on small food datasets).

## Updating / swapping a model

Model URLs are pinned in `tools/fetch-assets.sh`; the app reads whatever is in
`app/public/models/`. To try another classifier: place its ONNX + config there,
adjust preprocessing constants in `@nutrilens/food-recognition`, and re-run
`npm run eval` — the harness immediately quantifies the change.
