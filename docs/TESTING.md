# Testing Documentation

Six layers, each answering a different question. All of them exercise the code
that ships; only the dataset fetch in layer 6 needs the network.

## 1. Unit tests — "is the math right?" (`npm test`)

308 vitest cases in 20 files, across every package plus the app:

- **image-preprocess** (13): resize correctness (solid-colour invariance, seam
  interpolation, aspect preservation), crop/pad geometry, tensor normalization
  (NCHW + NHWC), Sobel edge response, box blur invariants, Otsu separation.
- **food-recognition** (15): softmax properties + temperature, fusion behaviour —
  closed-set dominance on agreement, zero-shot rescue of out-of-set foods when
  the closed-set head is unsure, non-food rejection — and the shipped linear
  probe's shape, class list and trusted set.
- **food-segmentation** (7): connected components, hole filling, bbox, mask
  cleaning, overlay tinting.
- **portion-estimator** (18): ellipse recovery from synthetic points, RANSAC rim
  detection on a rendered plate (and null on blank images), determinism of the
  seeded fit, plate-scale gram math, foreshortening, serving-prior fallback.
- **plate-analyzer** (46): region proposal geometry, dedupe, absorption,
  merge-to-a-fixed-point, the global prior and its floor, portion methods.
- **nutrition-engine** (25): linear scaling, %DV, portion ranges, aggregation,
  household measures, fuzzy search, malformed-DB rejection, plus two suites that
  run against the **real built data** — `shipped-db` (238 USDA foods) and
  `shipped-library` (1,744 library dishes).
- **exactness** (10, also under nutrition-engine): every food × every nutrient ×
  11 portion sizes recomputed against an independent oracle; no NaN, no
  negative, no infinity.
- **diary** (32), **exercise-db** (15), **barcode** (18), **off-food** (27),
  **charts** (24): serving maths and streaks, METs and ACSM energy, EAN/UPC
  encode–decode round trips, Open Food Facts unit scaling, SVG chart strings.
- **claude-nutrition** (14): the build-time estimate/cross-verify/adjudicate
  logic — Atwater and range validation, fat reconciliation, agreement scoring.
- **app** (36): the tick-scale readout, the icon set, serving wording.
- **provenance** (8): every shipped per-100 g value traced back to the FNDDS
  CSVs, or to the recorded overlay for a corrected food. Skips itself when
  `tools/data/` is absent.

## 2. Nutrition in the browser — "does the screen show what the engine computed?"

`npm run test:nutrition-ui` (`eval/nutrition-e2e.mjs`) drives the built app in
headless Chrome and reads the **rendered** numbers back out of the DOM, against
an oracle computed independently in Node: 76 comparisons over single foods at
three portion sizes, a stepped serving, plate totals for five items, and a day
of six diary entries with section totals and the remaining banner.

The oracle scales as `per100g * (grams / 100)`. Written `p * g / 100` it differs
by one ULP and flips `toFixed(2)` at a `…5` boundary — which is how a test that
should be exact starts disagreeing about iron by 0.01.

## 3. Photo pipeline — "does the number match what a person sees?"

`npm run test:vision` (`eval/vision-bench.mjs`) is the benchmark the app is
judged on: 20 photographed plates through the shipping pipeline end to end —
recognition, region proposals, naming, portion, nutrition — scored against
human ground truth in `eval/vision-truth.json`.

Truth is stated as a **band** per field, never a point value: portion estimation
from one uncalibrated photo is genuinely uncertain, and an exact target would
reward overfitting to twenty photos. A full run in the shipping configuration
writes `eval/results/VISION_BENCH.md`; a filtered or re-tuned run refuses to,
so an experiment cannot leave its numbers under the shipped ones.

## 4. Tracker flows — "does the diary actually work?"

`npm run test:tracker` (`eval/tracker-e2e.mjs`): 35 checks over 13 flows —
goals, search with serving sizes, editing an entry, quick add, custom foods,
recipes, barcode, exercise, habits, completing a day, copying a meal to another
day, the dashboard, progress. Fresh Chrome profile each run; the Open Food Facts
response is stubbed through `page.setRequestInterception`, and the stub **must**
send `Access-Control-Allow-Origin` or the app only sees "Failed to fetch".

## 5. Browser end-to-end — "does the shipped PWA work?"

`npm run test:smoke` (`eval/browser-smoke.mjs`):

1. serves the build (starts its own `vite preview`),
2. uploads a fixture photo through the real file input,
3. waits through model download → recognition → segmentation → portion →
   nutrition, polling visible UI state,
4. asserts the top candidate, kcal > 0, ≥4 macro rows, ≥10 micro rows, the
   non-food banner hidden, and the service worker registered,
5. saves to the diary and asserts the diary renders the entries,
6. captures `eval/results/browser-smoke.png`.

Verified on the beignets fixture: top-1 "Beignets", 440 kcal, 2 dishes, 25
micronutrient rows, service worker active — PASS.

`npm run test:offline` proves the offline claim: prefetch the models online →
force the browser fully offline (CDP emulation) → reload → the shell serves from
cache → a complete analysis succeeds with zero network. Verified: PASS
("Beignets, 440 kcal" offline).

All four browser layers share port 5199 and **reuse whatever is already serving
it** rather than starting a second one, so run them one at a time. The catch is
that killing one of these scripts on Windows leaves its `vite preview` behind —
the child outlives the shell that spawned it. The next run then silently reuses
a server from another session, possibly weeks old. If a browser test behaves
strangely, check for stray node processes holding 5199 before suspecting the
app.

## 6. Statistical evaluation — "how accurate is recognition, really?"

`npm run eval:fetch && node eval/fetch-commons.mjs && npm run eval && npm run
eval:report` measures top-1/top-5 per head and fused, expected calibration error
with a reliability table, false-non-food rate, per-class and per-cuisine
breakdowns, latency percentiles, and a cuisine-balanced fusion sweep — over the
Food-101 validation subsample (2,523 images), the extended Indian set (259
images), and the Wikimedia Commons cuisine sets (361 images). Raw per-image head
outputs are kept in `eval/results/*.jsonl` so fusion changes can be re-scored
without re-running inference. Reports: `eval/results/ACCURACY_REPORT.md`,
`eval/results/PERFORMANCE_REPORT.md`.

Measured 2026-07-17: Food-101 fused 90.4% top-1 / 98.4% top-5, ECE 0.015;
per-cuisine top-1 from Japanese 92.6% down to Mexican 70.0%, with top-5 staying
87–99% throughout.

Never let two `run-eval` processes overlap — they append to the same jsonl and
the lines interleave.

## What is deliberately not tested

- Pixel-exact golden-image tests of ONNX outputs (fragile across ORT versions);
  the statistical eval catches real regressions instead.
- Portion-estimate ground truth from a public dataset: none pairs food photos
  with weighed masses and plate sizes. Layer 3 substitutes human-read bands, and
  the module is otherwise validated by unit tests on synthetic geometry plus the
  explicit uncertainty design (ranges, method tags, adjustable portions).
