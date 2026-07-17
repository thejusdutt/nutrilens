# Dataset Documentation

## Nutrition source: USDA FNDDS 2021-2023 (Survey Foods)

- Download: FoodData Central "Survey (FNDDS)" CSV, release 2024-10-31
  (`tools/fetch-assets.sh` → `tools/data/fndds.zip`, 3.3 MB).
- 5,432 *as-consumed* foods × 65 nutrients + household portion weights.
- Public domain (U.S. Government work).
- Why FNDDS over Foundation/SR Legacy/Open Food Facts/CIQUAL: it describes
  **prepared dishes** (pizza, biryani, curries, sushi) rather than raw
  ingredients or branded packages, includes portion weights (feeds our portion
  priors), and is small enough to process in seconds. See RESEARCH.md §7.

### Curated mapping

`tools/vocabulary.mjs` defines 231 canonical foods; each carries one or more
FNDDS query strings. `tools/build-nutrition-db.mjs` resolves them with a scored
matcher (all-token substring match; prefers exact description, shorter
descriptions, and `NFS`/`NS as to` generic entries) and writes
`tools/data/mapping-report.txt` — one line per food with the matched FNDDS
description and kcal/100 g for human review. Spot-checked values: pizza 266,
white rice 129, banana 97, biryani 104, dosa 210 kcal/100 g — all consistent
with USDA reference values.

Known imperfect proxies (documented deliberately rather than silently):
`gulab-jamun → Barfi (Indian dessert)`, `takoyaki → Octopus/Fritter`,
`spring-roll-fresh → Egg roll, meatless`, `cannoli → Cream puff`. FNDDS has no
closer entries; the proxy is the nearest culinary/nutritional neighbour.

## Evaluation datasets

### Food-101 (ethz/food101)

- Official validation split (250 verified images × 101 classes).
- We evaluate on a stratified subsample of 25/class = **2,523 images**
  (2 failed downloads), fetched through the HF datasets-server `/filter` API —
  no 5 GB archive needed. `--per-class` raises this to the full split.
- License: research dataset (Bossard et al., ETH Zürich 2014); used for
  evaluation only, never shipped.

### Extended vocabulary set (rajistics/indian_food_images)

- 13 classes with faithful mappings onto our canonical vocabulary
  (naan, chapati, chana-masala, dal, fried-rice, idli, jalebi, dosa, dumplings,
  pakora, samosa, pizza, hamburger), 20 images each = **259 images**.
- Purpose: measure the zero-shot head + fusion on foods **outside** Food-101 —
  the scenario the open-vocabulary design exists for.
- Classes without a faithful canonical equivalent (kulfi, paani_puri, chai,
  kaathi_rolls, momos→dumplings is the loosest accepted mapping) were excluded
  or mapped conservatively.

### Cuisine sets (Wikimedia Commons)

- 2026-07-17: 26 classes with no faithful Food-101/HF mapping — Mexican
  (enchiladas, tamales, fajitas, chilaquiles, taquitos, refried beans, Mexican
  rice, pozole, burrito bowl), Spanish (tortilla española, gazpacho, croquetas,
  patatas bravas, empanadas), Chinese (chow mein, sweet-and-sour pork, kung
  pao chicken, mapo tofu, congee, wonton soup, General Tso chicken, baozi),
  extra Indian (biryani, vada, gulab jamun, paratha) — 15 images/class,
  **361 images**, fetched by `eval/fetch-commons.mjs`.
- Sourcing: prefer members of a curated Commons category, fall back to a
  File-namespace search. Both are filtered through a per-class title regex
  (e.g. `/empanad/i`) before download — unfiltered search results contain
  real label noise (a search for "empanada food" once returned a pumpkin pie).
  Requests are paced (~400 ms) with exponential backoff on HTTP 429; Commons
  throttles unauthenticated bursts hard enough that an unpaced fetch silently
  drops most of a class.
- Purpose: measure cuisines Food-101 barely covers (Mexican: only 6 classes;
  Spanish: 2; Chinese: 5) end-to-end, not just the Indian set.
- Reproduce: `node eval/fetch-commons.mjs [--per-class 15]` →
  `eval/data/cuisine/<cuisine>/<id>/*.jpg`.

### What we did not use

- Fruits-360: studio images on white backgrounds — would inflate fruit accuracy
  unrealistically.
- UNIMIB2016/UECFood: detection-oriented, tiny, license friction; our pipeline
  is not detector-based.

## Reproduction

```bash
npm run eval:fetch                     # ~2,800 images into eval/data/
node eval/fetch-commons.mjs            # +361 cuisine images into eval/data/cuisine/
npm run eval                           # both heads over every image (--set all is the default)
npm run eval:report                    # markdown reports incl. per-cuisine + fusion sweep
node eval/run-eval.mjs --swin-variant q4f16   # A/B the 52.7 MB quantization
```

Never run two `eval` processes concurrently against the same `eval/results/*.jsonl` —
`run-eval.mjs` appends, so overlapping runs interleave rows from different
label-embedding versions into one file with no way to tell them apart after
the fact.
