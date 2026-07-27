/**
 * Vision benchmark: score the shipped photo pipeline against what a person
 * (or a vision model) says is on the plate.
 *
 * The accuracy report in eval/run-eval.mjs measures *classification* — "is the
 * top label right for this crop". That is not what a food tracker is judged
 * on. Users judge it on the number: the dish names it writes into the diary
 * and the calories and macros attached to them. This harness measures exactly
 * that, end to end, on the same code the PWA runs:
 *
 *   whole-image recognition → SAM region proposals → per-region naming
 *   → portion estimation → nutrition lookup → plate totals
 *
 * Ground truth lives in eval/vision-truth.json: for each photo, the dishes a
 * careful human reader identifies and the energy/macros they'd expect. It is
 * deliberately a *range* per field, because portion estimation from one photo
 * is inherently uncertain and a benchmark that demands a single number would
 * reward overfitting.
 *
 * Usage:
 *   node eval/vision-bench.mjs                 # score every image
 *   node eval/vision-bench.mjs --only 'dosa|idli'  # regex filter on the image key
 *   node eval/vision-bench.mjs --json out.json # machine-readable results
 *   node eval/vision-bench.mjs --set globalPrior=0 --set mergeSameFood=false
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { SlimSamSegmenter } from '@nutrilens/food-segmentation';
import { PortionEstimator, detectPlateEllipse } from '@nutrilens/portion-estimator';
import { NutritionEngine } from '@nutrilens/nutrition-engine';
import { proposeRegions, buildPlate, DEFAULTS } from '@nutrilens/plate-analyzer';
import { decodeImage, createRecognizer, root } from './lib/node-runtime.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const only = flag('--only');
const jsonOut = flag('--json');
// The trained linear probe is blended into region naming by default; these turn
// it off or re-weight it, so a run can be attributed to it or not.
const noProbe = args.includes('--no-probe');
const probeAlpha = flag('--probe-alpha');
const overrides = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--set') continue;
  const [k, v] = args[i + 1].split('=');
  overrides[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
}

// Refuse anything not understood. A bare `--containedFraction=0` used to be
// skipped in silence, so the run reported the defaults under the name of the
// setting it was meant to be testing — two benchmark runs that looked like an
// A/B and were the same configuration twice.
const KNOWN = new Set(['--only', '--json', '--set', '--probe-alpha', '--no-probe', '--flat-oov']);
for (let i = 0; i < args.length; i++) {
  if (KNOWN.has(args[i])) { i++; continue; }
  console.error(`unknown argument: ${args[i]}`);
  console.error('usage: vision-bench [--only <id>] [--json <path>] [--set key=value]...');
  process.exit(2);
}

const truth = JSON.parse(readFileSync(join(root, 'eval/vision-truth.json'), 'utf8'));
const db = JSON.parse(readFileSync(join(root, 'app/public/data/nutrition-db.json'), 'utf8'));
const engine = new NutritionEngine(db);

const MODELS = join(root, 'app/public/models');

console.log('loading models…');
const { recognizer } = await createRecognizer({
  probe: !noProbe,
  probeAlpha: probeAlpha == null ? undefined : Number(probeAlpha),
  fusion: args.includes('--flat-oov') ? { oovAdaptive: false } : {},
});
const segmenter = await SlimSamSegmenter.load(
  ort,
  join(MODELS, 'slimsam/onnx/vision_encoder_quantized.onnx'),
  join(MODELS, 'slimsam/onnx/prompt_encoder_mask_decoder_quantized.onnx'),
);
const estimator = new PortionEstimator();

/**
 * Run the exact pipeline the app runs on one photo.
 * @returns {{items:{id,name,grams,kcal}[], totals:object, plate:object|null}}
 */
export async function analyzePhoto(image, options = {}) {
  const whole = await recognizer.recognize(image, { whole: true });
  const imageTop = whole.top.filter((t) => engine.food(t.id));
  const plate = detectPlateEllipse(image);

  await segmenter.setImage(image);
  const { regions, dominant } = await proposeRegions({
    segment: (points) => segmenter.segment(points),
    width: image.width,
    height: image.height,
    plate,
    options,
  });

  const items = await buildPlate({
    image,
    regions,
    dominant,
    imageTop,
    plate,
    classify: (img) => recognizer.recognize(img),
    foodById: (id) => engine.food(id),
    estimator,
    options,
  });

  const named = items.map((it) => {
    const n = engine.forPortion(it.id, it.grams).nutrients;
    const v = (k) => n[k]?.value ?? 0;
    return {
      id: it.id,
      name: engine.food(it.id).name,
      grams: it.grams,
      prob: Number(it.prob.toFixed(3)),
      method: it.portion.method,
      sizeFactor: it.portion.sizeFactor,
      single: !!it.singleDish,
      areaFrac: it.region ? Number((it.region.areaPx / (image.width * image.height)).toFixed(3)) : null,
      kcal: Math.round(v('kcal')),
      carbs: v('carbs'), protein: v('protein'), fat: v('fat'), fiber: v('fiber'),
    };
  });
  const sum = (k) => named.reduce((a, b) => a + (b[k] ?? 0), 0);
  return {
    whole: whole.top.slice(0, 3).map((t) => `${t.id} ${(t.prob * 100).toFixed(0)}%`),
    items: named,
    plate: plate ? { confidence: Number(plate.confidence.toFixed(2)), used: plate.confidence >= 0.7 } : null,
    totals: {
      kcal: Math.round(sum('kcal')),
      carbs: Math.round(sum('carbs')),
      protein: Math.round(sum('protein')),
      fat: Math.round(sum('fat')),
      fiber: Math.round(sum('fiber')),
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Signed relative miss against a [lo,hi] band: 0 inside the band. */
function bandError(value, band) {
  if (!band) return null;
  const [lo, hi] = band;
  if (value < lo) return (value - lo) / lo;
  if (value > hi) return (value - hi) / hi;
  return 0;
}

const pct = (x) => (x == null ? '   —  ' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`.padStart(6));

const rows = [];
const entries = Object.entries(truth.images).filter(([k]) => !only || new RegExp(only, 'i').test(k));

for (const [key, spec] of entries) {
  const file = join(root, spec.file);
  if (!existsSync(file)) { console.warn(`skip ${key}: ${spec.file} missing`); continue; }
  const image = await decodeImage(readFileSync(file));
  const t0 = Date.now();
  const got = await analyzePhoto(image, overrides);
  const ms = Date.now() - t0;

  // Dish identity: did we name every dish the reader saw, and nothing extra?
  // Aliases normalize both sides: the reader wrote "chutney", the app said
  // "coconut chutney", and nobody looking at the photo would call that a miss.
  const alias = new Map(Object.entries(truth.acceptableAliases ?? {}));
  const norm = (id) => alias.get(id) ?? id;
  const required = spec.dishes.filter((d) => !d.optional);
  const wantIds = new Set(required.map((d) => norm(d.id)));
  // Optional dishes (the tea beside the samosas, a garnish) are in the photo:
  // naming one is not a mistake, and missing one is not either.
  const allowed = new Set(spec.dishes.map((d) => norm(d.id)));
  const gotIds = new Set(got.items.map((i) => norm(i.id)));
  const hit = [...wantIds].filter((id) => gotIds.has(id));
  const missed = [...wantIds].filter((id) => !gotIds.has(id));
  const spurious = [...gotIds].filter((id) => !allowed.has(id));

  rows.push({
    key,
    ms,
    dishRecall: hit.length / wantIds.size,
    missed,
    spurious,
    got,
    want: spec,
    err: {
      kcal: bandError(got.totals.kcal, spec.kcal),
      carbs: bandError(got.totals.carbs, spec.carbs),
      protein: bandError(got.totals.protein, spec.protein),
      fat: bandError(got.totals.fat, spec.fat),
      grams: bandError(got.items.reduce((a, b) => a + b.grams, 0), spec.grams),
    },
  });

  const r = rows.at(-1);
  const line = got.items.map((i) => `${i.name} ${i.grams}g`).join(' + ') || '(nothing)';
  console.log(
    `${key.padEnd(22)} kcal ${String(got.totals.kcal).padStart(4)} vs ${String(spec.kcal[0]).padStart(4)}–${spec.kcal[1]}  `
    + `${pct(r.err.kcal)}  dishes ${hit.length}/${wantIds.size}  ${(ms / 1000).toFixed(1)}s`,
  );
  console.log(`${' '.repeat(22)} → ${line}`);
  if (missed.length) console.log(`${' '.repeat(22)}   missed: ${missed.join(', ')}`);
  if (spurious.length) console.log(`${' '.repeat(22)}   extra:  ${spurious.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const absErrs = (k) => rows.map((r) => r.err[k]).filter((x) => x != null).map(Math.abs);
const within = (k, tol) => absErrs(k).filter((x) => x <= tol).length;

console.log(`\n${'='.repeat(72)}`);
console.log(`images                ${rows.length}`);
console.log(`dish recall           ${(mean(rows.map((r) => r.dishRecall)) * 100).toFixed(1)}%`);
console.log(`spurious dishes       ${rows.reduce((a, r) => a + r.spurious.length, 0)} total`
  + ` (${rows.filter((r) => r.spurious.length).length} images affected)`);
for (const k of ['kcal', 'carbs', 'protein', 'fat', 'grams']) {
  console.log(
    `${k.padEnd(8)} mean |err| ${(mean(absErrs(k)) * 100).toFixed(1).padStart(5)}%`
    + `   in band ${String(within(k, 0)).padStart(2)}/${rows.length}`
    + `   within 25% ${String(within(k, 0.25)).padStart(2)}/${rows.length}`,
  );
}
console.log(`median time           ${(rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] / 1000).toFixed(1)}s`);
console.log('='.repeat(72));

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ options: { ...DEFAULTS, ...overrides }, rows }, null, 2));
  console.log(`wrote ${jsonOut}`);
}
