# Research & Engineering Decisions

This document records the research phase that preceded implementation: the
candidate technologies that were evaluated, the criteria used, and the
reasoning behind every major decision. Date of research: 2026-07-10.

## 1. Requirements recap

- 100% client-side: HTML/CSS/JS (ES modules), WASM/WebGPU allowed. No backend,
  no remote inference, offline after first install.
- Pipeline: image → detect/segment → classify → portion → nutrition
  (calories, macros, micros) → confidence.
- **Accuracy is the primary goal**, within what a browser can run.
- Custom reusable libraries where no mature JS solution exists.

## 2. Browser inference runtime

| Candidate | Verdict | Notes |
|---|---|---|
| **ONNX Runtime Web** | **chosen** | WebGPU + WASM(SIMD/threads) backends, the widest model coverage (any ONNX export), same API surface as `onnxruntime-node` which lets the evaluation pipeline run the *identical* library code in Node. Actively maintained by Microsoft. |
| TensorFlow.js | rejected | Fewer high-accuracy food models available as TFJS graph models; converting modern ViT/Swin checkpoints to TFJS is lossy and painful. Slower on transformer architectures. |
| transformers.js | partially used | Superb DX but bundles its own preprocessing and model abstraction; we need bit-identical custom preprocessing shared between Node eval and browser. **Used at build time only** (tokenizer + text tower for label-embedding precomputation). |
| MediaPipe | rejected | No food-specific models; classification limited to generic ImageNet-style categories. |
| WebNN | rejected (for now) | Still behind flags in most browsers in 2026; ORT-Web can adopt it later transparently. |

Decision: **onnxruntime-web** at runtime (WebGPU with automatic WASM
fallback), **onnxruntime-node** in the evaluation harness, behind a thin
runtime adapter so every library is isomorphic.

## 3. Food classification model

Candidates surveyed (all fine-tuned on Food-101 unless noted):

| Model | Top-1 (Food-101 test) | ONNX ready | Size (int8) | License |
|---|---|---|---|---|
| **aspis/swin-finetuned-food101** (Swin-Base) | **92.1% (91.4% verified by HF eval)** | ✅ `onnx-community/swin-finetuned-food101-ONNX` | 93 MB (52.7 MB q4f16) | Apache-2.0 |
| nateraw/food (ViT-Base) | ~89% | ❌ (needs export) | ~86 MB | Apache-2.0 |
| prithivMLmods/Food-101-93M (SigLIP2) | ~87% macro-F1 | ❌ (needs export) | ~93 MB | Apache-2.0 |
| dwililiya/food101-model-classification | unverified | ❌ | – | – |
| MobileNetV2/V3 fine-tunes | 75–83% | some | 3–8 MB | varies |
| ImageNet MobileNet (no fine-tune) | n/a (~40 food classes only) | ✅ | 4 MB | Apache-2.0 |

Decision: **Swin-Base fine-tuned on Food-101** — highest verified accuracy
with a ready-made, officially quantized ONNX export under Apache-2.0.
We ship `model_int8.onnx` (93 MB) by default; int8 quantization of
Swin typically costs <0.5pt top-1. The q4f16 variant is also fetched so the
evaluation harness can quantify the accuracy/size trade-off empirically
(see ACCURACY_REPORT.md).

### Why not detection-first (YOLO etc.)?

Public food *detection* models are trained on small datasets (UNIMIB2016,
UECFood-256) with far worse class coverage and accuracy than Food-101
classifiers. A detector would gate the whole pipeline on its recall.
Instead we use **whole-image classification + promptable segmentation**:
classification decides *what*, SlimSAM decides *where/how much*. For
multi-dish photos the UI supports tapping each dish, which re-runs
classification on the tapped region — turning localization into an
interactive rather than automatic problem, which is both more accurate and
more transparent to the user. This is the architecture deviation from the
suggested "Detection → Segmentation → Classification" order, chosen
deliberately: on single-dish photos (the overwhelmingly common case) it
strictly increases accuracy, and on multi-dish photos user-guided points
outperform a weak automatic detector.

## 4. Open-vocabulary head (beyond Food-101's 101 classes)

Food-101 lacks plain rice, biryani, dosa, most Indian/Chinese home dishes,
raw fruits and vegetables. Requirement explicitly lists these. Options:

| Approach | Verdict |
|---|---|
| Train a new classifier on Food-101 + extra data | No browser benefit; training out of scope for accuracy gain available elsewhere; would still be closed-set. |
| Bigger fine-tuned model covering more classes (e.g. Food2K) | No public browser-compatible export; Food2K weights are research-only license. |
| **CLIP-style zero-shot with precomputed text embeddings** | **chosen** — extensible vocabulary at zero retraining cost. |

Zero-shot encoder candidates:

| Model | ImageNet ZS top-1 | Vision tower | ONNX |
|---|---|---|---|
| MobileCLIP-S0 | 67.8% | 11.8 MB int8 / 22.9 MB fp16 | ✅ Xenova/mobileclip_s0 |
| **Apple MobileCLIP-S2** | 74.4% | **69 MB fp16** | ✅ Xenova/mobileclip_s2 |
| SigLIP-Base | ~76% | ~90 MB | ✅ |

Initial choice was S0-int8 for size; **empirical evaluation overturned it
twice** (this is why the eval harness exists):

1. **int8 quantization destroys CLIP vision towers.** The int8 S0 tower's
   cosine similarities collapsed to noise (~0.10–0.125 flat across all 219
   labels; measured zero-shot top-1 = 0.4% ≈ random). fp16/fp32 towers behave
   correctly. Finding: never ship a *metric-embedding* model post-training
   quantized to int8 without verifying the embedding space survives.
2. **S0 is too weak on the extended vocabulary** even at fp16 (dosa 1/10,
   idli 2/10, naan 2/10 zero-shot top-1 on held-out images). MobileCLIP-S2
   fp16 scores 8/10, 8/10, 5/10 on the same samples (pizza 10/10, sushi 8/10).

Decision: **MobileCLIP-S2, fp16 vision tower (69 MB)** — accuracy is the
stated priority and the extended vocabulary is the entire point of this head.
The S2 text tower (fp32, 254 MB) runs at build time only: label embeddings
for the full vocabulary (211 foods + 8 non-food probes, prompt-ensembled) ship
as a 438 KB binary matrix. The browser runs the vision tower and one matmul.

Fusion strategy (implemented in `@nutrilens/food-recognition`):
- Swin gives a calibrated distribution over 101 dishes.
- MobileCLIP gives similarity over the full vocabulary (which *includes* the
  101 dishes, mapped to the same canonical IDs).
- Fused score: weighted log-linear combination on the union label space;
  weights fitted on the validation split during evaluation.
- Non-food rejection: vocabulary includes non-food probe labels ("a person",
  "a car", "an empty plate", …); if probes win, the app reports "no food
  detected" instead of a hallucinated dish.

## 5. Segmentation

| Candidate | Verdict |
|---|---|
| **SlimSAM-77 (uniform)** | **chosen** — promptable SAM distillation, quantized ONNX 12.2 MB encoder + 4.9 MB decoder, MIT-licensed, proven in-browser via transformers.js demos. |
| MobileSAM | comparable, slightly larger; SlimSAM has official Xenova ONNX export. |
| DeepLabV3 (TFJS) | closed 21-class Pascal set; useless for food. |
| Custom GrabCut/saliency in JS | kept as zero-model fallback in `@nutrilens/food-segmentation` for very low-end devices, but measurably worse. |

Segmentation is prompted with the image center (single-dish flow) or the
user's tap (multi-dish flow); the mask feeds portion estimation.

## 6. Portion estimation

True metric portion estimation from one uncalibrated RGB image is an open
research problem (Im2Calories, MenuMatch, DPF-Nutrition all use depth or
reference objects). Best practical browser approach, implemented in
`@nutrilens/portion-estimator`:

1. **Scale reference — plate detection.** Custom pure-JS ellipse detector
   (Sobel gradients → edge sampling → RANSAC ellipse fit). Dinner plates
   cluster tightly around 26–27 cm diameter (default prior 26 cm,
   user-configurable). The fitted ellipse gives cm-per-pixel on the food
   plane, including foreshortening from the ellipse axis ratio.
2. **Area → mass.** Food mask area (cm²) × per-category height prior (cm) ×
   density prior (g/cm³) → grams. 101+ per-category priors derived from
   FNDDS portion weights and food-density literature (FAO/INFOODS density
   tables).
3. **Fallback.** No plate found → FNDDS median serving mass for the
   predicted food, flagged as lower confidence.
4. **Always user-adjustable** with a serving slider (grams / household
   measures); nutrition recomputes live.

Uncertainty is propagated: each stage returns a log-normal spread; the UI
shows a range (e.g. "310–420 kcal"), never a false-precision single number,
unless the user pins an exact portion.

## 7. Nutrition database

| Source | Verdict |
|---|---|
| **USDA FNDDS 2021-2023 (Survey)** | **chosen as primary** — ~7,000 *as-consumed* mixed dishes (pizza, biryani, curries, sushi…), 65 nutrients each, plus standard portion weights (critical for portion priors). Public domain. Single 3.3 MB zip. |
| USDA Foundation/SR Legacy | supplement — raw ingredients (fruits, vegetables) with the deepest micronutrient coverage; merged for produce classes. |
| Open Food Facts | rejected — branded/packaged goods, wrong domain for photographed meals, patchy micronutrients. |
| CIQUAL / IFCT | rejected as machine sources (licensing/format friction); IFCT values informed the density priors and Indian-dish mappings qualitatively. |

Build pipeline (`tools/build-nutrition-db.mjs`) maps every vocabulary label
to one or more FNDDS foods (hand-curated mapping table, reviewed food by
food), extracts the full nutrient vector per 100 g + portion weights, and
emits a compact JSON (~keyed by canonical label). Shipped size ≈ 400 KB
gzipped; loaded into IndexedDB on first run.

## 8. Datasets for evaluation

- **Food-101 official test split** (ethz/food101 on HF) — 250 verified
  images/class. We evaluate on a stratified subsample (25/class = 2,525
  images) fetched through the HF datasets server; full-split eval is a flag.
- **Extended-vocabulary set** — for foods outside Food-101 (biryani, dosa,
  idli, fried rice variants, fruits…), images fetched from public datasets
  (see eval/fetch-dataset.mjs) to measure the zero-shot head.
- Metrics: top-1/top-5, per-class recall, ECE (expected calibration error),
  reliability diagram, latency percentiles per stage, model-variant
  comparison (int8 vs q4f16).

## 9. Total shipped payload

| Asset | Size |
|---|---|
| Swin-Food101 int8 | 93 MB |
| MobileCLIP-S2 vision fp16 | 69 MB |
| SlimSAM quantized (enc+dec) | 17.1 MB |
| Label embeddings + nutrition DB | <1 MB |
| App code + ORT wasm runtime | ~72 MB (4 wasm variants; ~13 MB actually loaded) |
| **Total (one-time, cached)** | **~180 MB models+data** |

Comparable to a small mobile app; cached via Cache Storage + streamed
progress UI on first run. Models lazy-load: classification first, SlimSAM
only when portion estimation is requested.
