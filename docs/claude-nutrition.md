# Claude-verified nutrition

NutriLens is fully offline and on-device. This subsystem does not change that:
Claude runs at **build time**, on a developer machine, and its output is baked
into the static `nutrition-db.json` that ships. The app makes no network call for
nutrition, and nothing in `@nutrilens/claude-nutrition` is bundled into it.

What it buys us is accuracy. USDA FNDDS is authoritative for the foods it names
cleanly, but a lot of real dishes have no honest row in it — composed dishes,
regional dishes, anything "as served". Those were hand-mapped, and a hand map is
a guess until something independent checks it. So every food is recomputed from
scratch by Claude and cross-checked against USDA before it ships.

Two rules run through all of it:

1. **Nothing a model says is trusted until it survives nutrition-label
   arithmetic.** Energy has to match `4·protein + 4·carbs + 9·fat − 2·fibre`, and
   no per-100 g figure may exceed what 100 g can hold. A record that fails is
   thrown away, not shipped. (`packages/claude-nutrition/src/schema.js`)
2. **Agreement between independent sources is the evidence.** USDA and Claude
   derive their numbers in completely different ways; when they land on the same
   value it is almost certainly right, and when they diverge the tie-break is
   internal consistency plus a second, independent model.

## The package (build-time only)

| module | role |
|---|---|
| `schema.js` | parse a model reply, map to database keys, validate Atwater + physical ranges |
| `estimate.js` | prompt Claude to compute a dish from a standard recipe, validate, retry with the failure fed back |
| `cross-verify.js` | score how well two per-100 g estimates agree; prefer the more self-consistent; blend; `reconcileFat` keeps fat sub-fractions inside a corrected total |
| `bedrock-cli.js` | Node transport — drives Claude on AWS Bedrock through the AWS CLI |

The package is `private: true` and imported only by `tools/`. It has no browser
entry point on purpose.

## Running it

```
npm run verify:nutrition      # Sonnet computes every food, cross-checks vs USDA
npm run adjudicate:nutrition  # Opus breaks the ties Sonnet and USDA could not
npm run build:db              # folds the overlay into nutrition-db.json
```

`verify-nutrition-claude.mjs` asks Claude for each food's per-100 g **without
showing it the USDA number**, so agreement means something. Foods where the two
agree are stamped verified; the rest are flagged.

`adjudicate-claude.mjs` takes the flagged foods and gets a second, independent
computation from a different model (Opus). With three sources in hand:

- both models agree with USDA → confirmed;
- **both models miss USDA in the same direction → USDA is the outlier**, and is
  corrected to the two-model consensus. This is the decisive rule: it catches a
  thin survey row (clam chowder at 35 kcal/100 g) that is perfectly
  self-consistent and still wrong;
- the models straddle USDA, or one backs it → ambiguous, USDA kept, flagged for a
  human.

The 37 golden-anchored foods (rice, banana, egg, and the hand-composed mixes) are
never overwritten — they have published or carefully authored values and their own
shape tests.

### Why the pipeline reads a base file

The builder writes `tools/data/nutrition-db.base.json` — a pristine USDA baseline —
*before* applying any correction, and the verification tools read that, never the
shipped artifact. Without it a second run would compare Claude against numbers a
previous run had already corrected and "confirm" them, so the corrections would
silently evaporate. The base file is rebuilt from FNDDS every time, so it is
always pristine.

### Everything is cached and committed

`claude-nutrition-cache.json` and `opus-nutrition-cache.json` hold every model
reply, and `claude-overlay.json` holds the resulting corrections. All three are
committed, so `npm run build:db` never calls a model — the build stays offline and
reproducible, and re-running the verification is free.

Corrections still pass through **every** validation gate in
`build-nutrition-db.mjs` (Atwater, physical ranges, golden references, shared-row
detection, protein floor), so a bad correction fails the build instead of
shipping. `tools/test/nutrition-db-provenance.test.js` then checks that corrected
foods trace exactly to the overlay and everything else traces to FNDDS
value-for-value.

Reports for review land in `tools/data/nutrition-verification-report.md` and
`tools/data/adjudication-report.md`.

## The offline dish library

Verification makes the ~240 USDA foods right. It does not make them *enough* —
people log things no survey database names. Since the app cannot call a model, the
breadth is computed at build time too and shipped as a second static file.

```
npm run build:catalogue   # ask Claude what people actually eat; dedupe in code
npm run build:library     # cost every name out, validate, write the shipped JSON
```

`build-food-catalogue.mjs` asks for names only, across 26 groups split by both
cuisine and category — the two miss different things, since a cuisine prompt
returns restaurant dishes and forgets a plain banana, and a category prompt
returns staples and forgets regional cooking. Deduplication happens in code,
against the existing vocabulary and against itself; the model is never trusted to
dedupe. Result: `tools/data/food-catalogue.json`.

`compute-food-library.mjs` prices the catalogue in batches (one request per ~20
dishes, which is what makes it affordable), validates **every row** against the
same Atwater and physical-range rules, and retries any failing row individually
with its own error fed back. Rows that still will not add up are dropped rather
than shipped as a guess. Result: `app/public/data/nutrition-library.json`.

### What the library deliberately does not contain

Energy, macros, fibre, sugar, saturated fat and sodium — the figures a recipe
determines. It reports **no micronutrients**, because those come from measurement
rather than reasoning, and an invented selenium value would be worse than an
absent one. Foods already in the USDA core keep their full measured profile and
are excluded from the library, and `foods.js` ranks library hits below USDA hits
so a measured food is always offered first. A library row is labelled
`Estimate` in the UI.

`packages/nutrition-engine/test/shipped-library.test.js` gates all of this: Atwater
consistency, physical limits, no fabricated micronutrients, no shadowing of a USDA
food, and that the engine can price a library row through the same code path as
every other food.

## The written-up results

`docs/nutrition-accuracy-report.html` is the readable version of what this
pipeline produced: which foods were confirmed, which were corrected and by how
much, and where the corrections came from. Open it in a browser.
