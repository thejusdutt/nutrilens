# NutriLens Architecture

## System overview

```
┌────────────────────────────── Browser (no server) ──────────────────────────────┐
│                                                                                  │
│  Main thread (app/src/main.js)                Web Worker (inference-worker.js)   │
│  ┌───────────────────────────┐   postMessage  ┌───────────────────────────────┐  │
│  │ capture: camera/file/drop │◄──────────────►│ ONNX Runtime Web (WASM/WebGPU)│  │
│  │ toRawImage (EXIF, resize) │  RawImage /    │ ┌──────────┐  ┌─────────────┐ │  │
│  │ candidates + confidence UI│  probs / masks │ │Swin-F101 │  │MobileCLIP-S2│ │  │
│  │ portion slider + measures │                │ │ int8 93MB│  │vision fp16  │ │  │
│  │ NutritionEngine (%DV,     │                │ └────┬─────┘  └──────┬──────┘ │  │
│  │  ranges, search)          │                │      └─── FusionScorer ──────┐│  │
│  │ IndexedDB history         │                │ ┌──────────────┐ ┌──────────┐││  │
│  │ PortionEstimator (grams)  │                │ │SlimSAM enc/dec│ │plate     │││  │
│  └───────────────────────────┘                │ │ 17MB quantized│ │ellipse   │││  │
│              ▲                                │ └──────────────┘ │RANSAC(JS)│││  │
│              │ Cache Storage (models, shell)  │                  └──────────┘││  │
│  ┌───────────┴───────────┐                    └──────────────────────────────┘│  │
│  │ Service Worker        │  cache-first app shell; big models cached via      │  │
│  └───────────────────────┘  Cache API by the worker itself (SW-lifetime-proof)  │  │
└──────────────────────────────────────────────────────────────────────────────────┘

Build time (Node, never shipped):
  FNDDS CSV ──build-nutrition-db──► nutrition-db.json (211 foods × 30 nutrients)
  vocabulary.mjs ──MobileCLIP text tower + prompt ensembling──► label-embeddings.bin
```

## Recognition pipeline (and why it differs from detect-first)

The classic proposal is `Detection → Segmentation → Classification`. NutriLens
deliberately inverts it to **Classification (+ zero-shot) → promptable
Segmentation → Portion**, because:

1. Public food *detectors* are trained on small datasets (UECFood, UNIMIB) with
   far lower class coverage/accuracy than Food-101 classifiers; putting one
   first would gate the whole pipeline on its recall.
2. Whole-image classification is the highest-accuracy signal available in a
   browser (92% top-1), and most food photos contain one dish.
3. SAM-style segmentation is *promptable* — it does not need a detector; the
   image center (or the user's tap) is the prompt. Multi-dish photos become an
   interactive flow: tap each dish → the app crops around the tap,
   re-classifies the region and re-segments from that point. Encoder
   embeddings are computed once per image, so each tap costs only ~90 ms.

### Fusion (packages/food-recognition/src/fusion.js)

- Closed-set head: `p_swin` over 101 dishes (calibrated by temperature).
- Open-vocab head: cosine(image embed, precomputed label embeds) → softmax at
  CLIP logit scale over 211 foods + 8 non-food probes.
- In-set labels: `score = wS·log p_swin + (1−wS)·log p_zs`, where
  `wS = wSwin·min(1, maxp_swin/0.5)` — Swin's weight shrinks when it is itself
  unsure (typical for foods outside Food-101).
- Out-of-set labels: `score = log p_zs + oovBias`.
- Softmax over the union → final calibrated distribution.
- Non-food: if Σ p_zs(probes) > threshold, report "not food" instead of a
  hallucinated dish. Probes span people, pets, vehicles, screens, empty plates,
  packaging, plants, landscapes.
- `wSwin`/`oovBias` are fitted by the offline sweep in `eval/make-report.mjs`.

## Portion estimation

```
SlimSAM mask (px²) ── plate ellipse (rx, ry px; ⌀ 26 cm prior) ──►
cm²/px² = (D/2rx)·(D/2ry)   (product of axis scales ⇒ foreshortening handled)
grams = area_cm² × height_prior(food) × density_prior(food)
```

- Priors per food (pile height cm, bulk density g/cm³, typical serving g) live
  in `tools/vocabulary.mjs` and ship inside nutrition-db.json.
- No plate → FNDDS median serving ± factor 2, tagged so the UI asks the user.
- All downstream nutrition values carry the portion range (`low`/`high`).

## Data flow at build time

1. `tools/fetch-assets.sh` — models from HuggingFace (pinned files), FNDDS zip
   from USDA. Nothing is fetched at runtime except from the app's own origin.
2. `tools/build-nutrition-db.mjs` — parses FNDDS CSVs (note: `food_nutrient.
   nutrient_id` actually stores legacy `nutrient_nbr`), maps the 211-entry
   curated vocabulary to FNDDS foods via a scored substring matcher with
   per-entry fallback queries, emits `nutrition-db.json` + `vocabulary.json` +
   a human-reviewable `mapping-report.txt`.
3. `tools/build-embeddings.mjs` — runs the MobileCLIP text tower in Node
   (onnxruntime-node + transformers.js tokenizer) over ~3–9 ensembled prompts
   per label; ships only the 219×512 float32 matrix (438 KB).

## Performance decisions

- **All ONNX sessions live in one Web Worker** — the UI thread never runs
  inference; progress/results stream via postMessage (transferables for
  pixel buffers and masks).
- **WASM over WebGPU by default**: the Swin/SlimSAM models are int8-quantized;
  quantized ops are not WebGPU-resident in ORT, causing per-node CPU fallback
  with synchronous readbacks (measured: hangs/minutes vs seconds). WASM
  SIMD+threads executes them efficiently. WebGPU stays one query-param away
  (`?webgpu=1`).
- **COOP/COEP headers** documented + set in dev/preview so wasm gets threads;
  graceful single-thread fallback otherwise.
- **Lazy loading**: classifier models load on first analysis (with byte
  progress); SlimSAM loads only when portion estimation is first needed;
  nutrition JSONs are eager (<1 MB).
- **Caching**: hand-written service worker precaches the app shell (stable,
  hash-free asset names + `CACHE_VERSION` busting). The ~100 MB model binaries
  are deliberately **not** routed through the SW: browsers terminate service
  workers mid-transfer on bodies that large (and the HTTP disk cache write
  fails outright — `ERR_CACHE_WRITE_FAILURE`). Instead the inference worker
  and the Settings prefetch write model bytes into Cache Storage directly
  (`cache: 'no-store'` fetches to bypass the HTTP cache), cache-first on read.

## Error handling & honesty

- Every stage degrades explicitly: no plate → serving prior; segmentation
  failure → serving prior; non-food → warning + manual search; low fused
  confidence → "uncertain" tag. No stage fabricates precision.
- The evaluation harness runs the same library code via `onnxruntime-node`, so
  reported accuracy is the accuracy of what actually ships.
