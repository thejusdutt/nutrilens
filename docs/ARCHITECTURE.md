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
│  └───────────────────────────┘                │ │ 14MB quantized│ │ellipse   │││  │
│              ▲                                │ └──────────────┘ │RANSAC(JS)│││  │
│              │ Cache Storage (models, shell)  │                  └──────────┘││  │
│  ┌───────────┴───────────┐                    └──────────────────────────────┘│  │
│  │ Service Worker        │  cache-first app shell; big models cached via      │  │
│  └───────────────────────┘  Cache API by the worker itself (SW-lifetime-proof)  │  │
└──────────────────────────────────────────────────────────────────────────────────┘

Build time (Node, never shipped):
  FNDDS CSV ──build-nutrition-db──► nutrition-db.json (238 foods × 31 nutrients)
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
  CLIP logit scale over 238 foods + 11 non-food probes.
- In-set labels: `score = wS·log p_swin + (1−wS)·log p_zs`, where
  `wS = wSwin·min(1, maxp_swin/0.5)` — Swin's weight shrinks when it is itself
  unsure (typical for foods outside Food-101).
- Out-of-set labels: `score = log p_zs + oovBias`.
- Softmax over the union → final calibrated distribution.
- Non-food: if Σ p_zs(probes) > threshold, report "not food" instead of a
  hallucinated dish. Probes span people, pets, vehicles, screens, empty plates,
  packaging, plants, landscapes, bare table surfaces, cloth or paper, and
  cutlery — the last three because an empty corner of a photo is what a region
  proposal lands on when it misses the food.
- `wSwin`/`oovBias` are fitted by the offline sweep in `eval/make-report.mjs`.

## Multi-dish analysis (packages/plate-analyzer)

A photo of a thali is not a classification problem. Between segmentation and
nutrition sits the stage that decides *what things are on this plate and how
much of each*:

```
SAM point grid ─► region proposals ─► dedupe (smallest-first, distinct)
                             └─────► dominant mask (largest plausible)
        │
        ├─ per region: crop → classify → re-rank under the whole-image prior
        ├─ merge regions that are the same dish (same name, or touching and
        │  agreeing) — run to a fixed point, because "same dish" is transitive
        ├─ single-dish check: one label + a confident whole-image read ⇒ use
        │  the dominant mask, not the fragments
        └─ portion per item, then drop garnish by mask area share
```

Two decisions carry most of the accuracy:

- **The whole photo re-ranks each region.** `score(id) = log p_region(id) +
  λ·log p_image(id)`, λ = 0.55. A crop of one corner of a dosa is a perfectly
  plausible tempura; the full frame is 90% sure it is a dosa. Labels absent
  from the truncated whole-image top-k get a floor rather than zero, so a
  confident region can still keep a food the whole-image head never listed.
- **One dish is one diary line.** Segmentation splits a dosa into its crisp
  edge and its folded body, and reads half a stir-fry as kung pao and half as
  sweet-and-sour. Merging by name, and by "touching *and* sharing top
  candidates", is what turns that back into the row a person would log.

## Portion estimation

```
reference = plate ellipse (if its rim is evidenced all round) else the frame
ratio     = food mask area ÷ reference area
expected  = share a typical serving of THIS food would occupy
grams     = serving_prior × clamp( (ratio / expected)^w , 1/2.5 , 2.5 )
```

The model is deliberately prior-anchored: the answer is the food's own typical
serving, scaled by how large this helping looks *relative to a typical one* —
which is how a person reads a photo ("that's a big dosa, call it one and a
half"). Geometry sets the factor; it never sets the mass outright.

Why bounded, and why not pure geometry:

- A bowl rim and a dinner plate both fit an ellipse, but one is 16 cm and the
  other 26 cm — a 2.6× area error, which the maths cannot see. Unbounded, that
  produced a 22 g naan and a 605 g half-omelette.
- The metric scale cancels out of `ratio / expected`, so the ⌀ 26 cm prior only
  ever affects the reported `areaCm2`, never the mass.
- Food covering most of the ellipse means the ellipse is the food's own bowl,
  not a plate under it. A bowl outline says nothing about depth, which is where
  the mass is, so the weight on geometry drops (`method: 'bowl-scale'`).
- With no usable plate the frame is the reference, divided by √(dishes in the
  photo): four dishes fill more of a shot than one, but not four times as much.

Plate detection itself reports **angular coverage** as its confidence — the
fraction of 5° sectors around the ellipse containing an inlier. Counting
inliers against the circumference saturates: every image scored 1.0, including
photos with no plate. And its RANSAC is **seeded**, because the same photo must
give the same calories twice.

- Priors per food (pile height cm, bulk density g/cm³, typical serving g) live
  in `tools/vocabulary.mjs` and ship inside nutrition-db.json.
- No mask at all → FNDDS median serving ± factor 2, tagged so the UI asks.
- All downstream nutrition values carry the portion range (`low`/`high`).

## Data flow at build time

1. `tools/fetch-assets.sh` — models from HuggingFace (pinned files), FNDDS zip
   from USDA. Nothing is fetched at runtime except from the app's own origin.
2. `tools/build-nutrition-db.mjs` — parses FNDDS CSVs (note: `food_nutrient.
   nutrient_id` actually stores legacy `nutrient_nbr`), maps the 238-entry
   curated vocabulary to FNDDS foods via a scored substring matcher with
   per-entry fallback queries, emits `nutrition-db.json` + `vocabulary.json` +
   a human-reviewable `mapping-report.txt`.
   Entries may declare a `mix` — a mass-weighted recipe over FNDDS rows — for
   dishes FNDDS only lists in a form nobody eats (caesar salad without
   dressing) or does not list at all (coconut chutney). Every value still
   traces to USDA data, and the mapping report prints the recipe.
   The same step folds in `tools/data/claude-overlay.json` (step 4) and then
   runs every validation gate over the result, so a bad correction fails the
   build. It reads the pristine `nutrition-db.base.json` it writes first, never
   its own corrected output — otherwise a re-run would confirm its own past
   corrections.
3. `tools/build-embeddings.mjs` — runs the MobileCLIP text tower in Node
   (onnxruntime-node + transformers.js tokenizer) over ~3–9 ensembled prompts
   per label; ships only the 249×512 float32 matrix (498 KiB).
4. `npm run verify:nutrition` → `npm run adjudicate:nutrition` — two Claude
   models recompute every shipped food from a standard recipe and cross-check
   it against USDA *without seeing the USDA number*, writing
   `tools/data/claude-overlay.json`. `npm run build:catalogue` →
   `npm run build:library` extends breadth the same way, shipping
   `nutrition-library.json` (1,744 dishes, 53 KiB gzipped). All of this happens at
   build time and the results are committed: the app itself never calls a
   model over the network. See `docs/claude-nutrition.md`.

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
  hash-free asset names + `SHELL_VERSION` busting). The ~100 MB model binaries
  are deliberately **not** routed through the SW: browsers terminate service
  workers mid-transfer on bodies that large (and the HTTP disk cache write
  fails outright — `ERR_CACHE_WRITE_FAILURE`). Instead the inference worker
  and the Settings prefetch write model bytes into Cache Storage directly
  (`cache: 'no-store'` fetches to bypass the HTTP cache), cache-first on read —
  both through the one shared loader in `app/src/model-cache.js`.
  The model cache carries its own `MODEL_VERSION`, so shipping a shell update
  never evicts ~180 MB of already-downloaded models.

## App structure

The PWA is plain ES modules, one per screen, with no framework:

| module | responsibility |
|---|---|
| `main.js` | shell, theme, service worker, model worker, photo pipeline, settings |
| `ui.js` | `el()` builder, view switching, bottom-sheet stack, toasts, event bus |
| `db.js` | IndexedDB: entries, days, foods, meals, exercise, measurements, products |
| `foods.js` | one lookup across USDA, custom foods, scanned products, saved meals |
| `logfood.js` | add-food flow: tabs, serving size × count, quick add, builders |
| `today.js` | the diary: streak, calories, macros, meals, habits, completion |
| `nutrition-view.js` | calories / macros / nutrients, day or week |
| `progress-view.js` | weight, calorie trend, measurements |
| `exercise-view.js` | MET-based exercise logging |
| `barcode-scan.js` | camera loop, native or own decoder, Open Food Facts lookup |
| `plate-ui.js` | the plate editor: dish rows, serving stepper, "what is this?" sheet |
| `servings.js` | weight → words ("3¾ idli"), free of DOM and of the database |

Screens never write storage directly through each other: mutations emit `diary`,
`day`, `foods` or `profile` on the shared bus, and whichever screens are mounted
re-render themselves. That is what keeps "log a food from a sheet" correct
without any screen knowing who logged it.

## Error handling & honesty

- Every stage degrades explicitly: no plate → serving prior; segmentation
  failure → serving prior; non-food → warning + manual search; low fused
  confidence → "uncertain" tag. No stage fabricates precision.
- The evaluation harness runs the same library code via `onnxruntime-node`, so
  reported accuracy is the accuracy of what actually ships.
