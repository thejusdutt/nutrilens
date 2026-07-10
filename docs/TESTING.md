# Testing Documentation

Four layers, each answering a different question.

## 1. Unit tests — "is the math right?" (`npm test`)

39 vitest cases across the five packages:

- **image-preprocess**: resize correctness (solid-color invariance, seam
  interpolation, aspect preservation), crop/pad geometry, tensor
  normalization (NCHW + NHWC), Sobel edge response, box blur invariants,
  Otsu bimodal separation.
- **food-recognition**: softmax properties + temperature, fusion behavior —
  closed-set dominance on agreement, zero-shot rescue of out-of-set foods when
  the closed-set head is unsure, non-food probe rejection, probability
  normalization.
- **food-segmentation**: connected-component labeling, hole filling (enclosed
  vs border-open), bbox, mask cleaning, overlay tinting.
- **portion-estimator**: least-squares ellipse recovery from synthetic points,
  RANSAC rim detection on a rendered plate (and null on blank images),
  plate-scale gram math, foreshortening direction, serving-prior fallback,
  clamping.
- **nutrition-engine**: linear scaling, %DV, portion-range propagation,
  aggregation, household measures, fuzzy search, malformed-DB rejection.

## 2. Node integration smoke — "do the real models work through our code?"

Inline scripts during development (see git history) exercise
`createRecognizer()` + `SlimSamSegmenter` + `detectPlateEllipse` on a real
Food-101 image via `onnxruntime-node`. The eval harness (layer 4) supersedes
them at scale.

## 3. Browser end-to-end — "does the shipped PWA actually work?"

`node eval/browser-smoke.mjs` (headless Chrome via puppeteer-core):

1. builds are served by `vite preview` (started automatically),
2. uploads a fixture photo through the real file input,
3. waits through model download → recognition → segmentation → portion →
   nutrition, polling visible UI state,
4. asserts: correct top candidate, kcal > 0, ≥4 macro rows, ≥10 micro rows,
   non-food banner hidden, service worker registered,
5. saves to history and asserts the history view renders,
6. captures `eval/results/browser-smoke.png`.

Verified result on the beignets fixture: top-1 "Beignets" (55% fused), plate
detected (`plate-scaled · ±60%`), 25 micronutrient rows, SW active — PASS.

## 4. Statistical evaluation — "how accurate is it, really?"

`npm run eval:fetch && npm run eval && npm run eval:report` measures top-1/
top-5 per head and fused, expected calibration error with a reliability table,
false-non-food rate, per-class breakdowns, latency percentiles, and a fusion
parameter sweep — over the Food-101 validation subsample (2,523 images) and the
extended Indian set (259 images). Raw per-image head outputs are stored
(`eval/results/*.jsonl`) so fusion changes can be re-scored without re-running
inference. Reports: `eval/results/ACCURACY_REPORT.md`,
`eval/results/PERFORMANCE_REPORT.md`.

## What is deliberately not tested

- Pixel-exact golden-image tests of ONNX outputs (fragile across ORT versions);
  the statistical eval catches real regressions instead.
- Portion-estimate ground truth: no public dataset pairs food photos with
  weighed masses and plate sizes. The portion module is validated by unit
  tests on synthetic geometry + the explicit uncertainty design (ranges, method
  tags, mandatory manual adjustment).
