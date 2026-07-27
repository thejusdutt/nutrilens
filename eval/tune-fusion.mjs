/**
 * Sweep plate-assembly parameters without paying for the models twice.
 *
 * vision-bench re-runs SlimSAM and both classifier heads for every
 * configuration, so a five-point sweep is forty minutes and nobody runs it.
 * But segmentation and classification do not depend on the parameters being
 * tuned: given an image, the regions and their candidate lists are fixed, and
 * only what buildPlate *does* with them changes.
 *
 * So: classify once, replay many times. Pass 1 computes regions, whole-image
 * top-k and per-region candidate lists. Pass 2 calls the real buildPlate with a
 * `classify` that serves pass 1's answers in order — same masks, same merging,
 * same portions, same filters — for every configuration in the sweep.
 *
 * Fidelity note: buildPlate calls classify exactly once per region, in order,
 * so replaying by position is exact rather than approximate. If that ever stops
 * being true the replay asserts rather than quietly scoring the wrong crop.
 *
 * Usage:
 *   node eval/tune-fusion.mjs                            # baseline + built-in sweep
 *   node eval/tune-fusion.mjs --only 'kungpao|biryani'
 *   node eval/tune-fusion.mjs --grid globalPrior=0,0.25,0.55 --grid minItemProb=0.18,0.3
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { SlimSamSegmenter } from '@nutrilens/food-segmentation';
import { PortionEstimator, detectPlateEllipse } from '@nutrilens/portion-estimator';
import { NutritionEngine } from '@nutrilens/nutrition-engine';
import { proposeRegions, buildPlate, regionCrop, DEFAULTS } from '@nutrilens/plate-analyzer';
import { decodeImage, createRecognizer, root } from './lib/node-runtime.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const only = flag('--only');

/** --grid key=v1,v2,v3 (repeatable) → cartesian product of configurations. */
const grids = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--grid') continue;
  const [k, vs] = args[i + 1].split('=');
  grids.push([k, vs.split(',').map((v) => (v === 'true' ? true : v === 'false' ? false : Number(v)))]);
}

const truth = JSON.parse(readFileSync(join(root, 'eval/vision-truth.json'), 'utf8'));
const db = JSON.parse(readFileSync(join(root, 'app/public/data/nutrition-db.json'), 'utf8'));
const engine = new NutritionEngine(db);
const alias = new Map(Object.entries(truth.acceptableAliases ?? {}));
const norm = (id) => alias.get(id) ?? id;

console.log('loading models…');
const { recognizer } = await createRecognizer();
const segmenter = await SlimSamSegmenter.load(
  ort,
  join(root, 'app/public/models/slimsam/onnx/vision_encoder_quantized.onnx'),
  join(root, 'app/public/models/slimsam/onnx/prompt_encoder_mask_decoder_quantized.onnx'),
);
const estimator = new PortionEstimator();

// ---------------------------------------------------------------------------
// Pass 1 — the expensive half, once
// ---------------------------------------------------------------------------
const entries = Object.entries(truth.images).filter(([k]) => !only || new RegExp(only, 'i').test(k));
const cache = [];
console.log(`caching ${entries.length} images…`);
for (const [key, spec] of entries) {
  const file = join(root, spec.file);
  if (!existsSync(file)) { console.warn(`skip ${key}: ${spec.file} missing`); continue; }
  const image = await decodeImage(readFileSync(file));
  const whole = await recognizer.recognize(image, { whole: true });
  const plate = detectPlateEllipse(image);
  await segmenter.setImage(image);
  const { regions, dominant } = await proposeRegions({
    segment: (points) => segmenter.segment(points),
    width: image.width, height: image.height, plate,
  });
  // Region proposal does not depend on any swept parameter, so one pass is
  // enough — but cropPad does change the crop, so classify at the default and
  // refuse to sweep it (see ASSERT below).
  const results = [];
  for (const region of regions) {
    results.push(region.bbox ? await recognizer.recognize(regionCrop(image, region, DEFAULTS)) : null);
  }
  cache.push({ key, spec, image, plate, regions, dominant, whole, results });
  process.stdout.write('.');
}
console.log(`\ncached ${cache.length} images\n`);

if (grids.some(([k]) => k === 'cropPad' || k === 'cropPerAxis' || k.startsWith('frame') || k.startsWith('min' + 'Mask'))) {
  console.error('refusing to sweep a parameter that changes the crops or the regions —');
  console.error('the cache would no longer describe what the pipeline sees. Use vision-bench.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Pass 2 — replay
// ---------------------------------------------------------------------------
async function score(options) {
  let recall = 0; let spurious = 0; let kcalErr = 0; let inBand = 0;
  const missed = [];
  for (const c of cache) {
    let n = 0;
    const items = await buildPlate({
      image: c.image,
      regions: c.regions,
      dominant: c.dominant,
      imageTop: c.whole.top.filter((t) => engine.food(t.id)),
      plate: c.plate,
      classify: () => {
        const r = c.results[n++];
        if (r === undefined) throw new Error(`replay drift on ${c.key}: classify called ${n} times for ${c.regions.length} regions`);
        return Promise.resolve(r ?? { isFood: false, top: [] });
      },
      foodById: (id) => engine.food(id),
      estimator,
      options,
    });
    const want = new Set(c.spec.dishes.filter((d) => !d.optional).map((d) => norm(d.id)));
    const allowed = new Set(c.spec.dishes.map((d) => norm(d.id)));
    const got = new Set(items.map((i) => norm(i.id)));
    const hit = [...want].filter((id) => got.has(id));
    recall += hit.length / want.size;
    for (const id of want) if (!got.has(id)) missed.push(`${id}@${c.key}`);
    spurious += [...got].filter((id) => !allowed.has(id)).length;
    const kcal = items.reduce((s, i) => s + (engine.forPortion(i.id, i.grams)?.nutrients.kcal.value ?? 0), 0);
    const [lo, hi] = c.spec.kcal;
    const e = kcal < lo ? (kcal - lo) / lo : kcal > hi ? (kcal - hi) / hi : 0;
    if (e === 0) inBand++;
    kcalErr += Math.abs(e);
  }
  return {
    recall: (recall / cache.length) * 100,
    spurious,
    kcal: (kcalErr / cache.length) * 100,
    inBand,
    missed,
  };
}

const combos = grids.length
  ? grids.reduce((acc, [k, vs]) => acc.flatMap((o) => vs.map((v) => ({ ...o, [k]: v }))), [{}])
  : [
    {},
    { globalPrior: 0 }, { globalPrior: 0.25 }, { globalPrior: 0.4 }, { globalPrior: 0.7 },
  ];

const base = await score({});
console.log(`${'configuration'.padEnd(46)} recall  spur  kcal|err|  inBand`);
const line = (label, s) => console.log(
  `${label.padEnd(46)} ${s.recall.toFixed(1).padStart(5)}%  ${String(s.spurious).padStart(4)}`
  + `  ${s.kcal.toFixed(1).padStart(7)}%  ${String(s.inBand).padStart(4)}/${cache.length}`,
);
line('baseline (shipped defaults)', base);
console.log('-'.repeat(78));

const showMissed = args.includes('--show-missed');
const results = [];
for (const c of combos) {
  const label = Object.keys(c).length ? Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ') : '(defaults)';
  const s = await score(c);
  results.push({ label, config: c, ...s });
  line(label, s);
  if (showMissed) {
    // Which dishes moved, not just how many — a net gain that swaps one miss
    // for another is a different thing from one that fixes a miss.
    const gained = base.missed.filter((m) => !s.missed.includes(m));
    const lost = s.missed.filter((m) => !base.missed.includes(m));
    if (gained.length) console.log(`      recovered: ${gained.join(', ')}`);
    if (lost.length) console.log(`      newly lost: ${lost.join(', ')}`);
    if (!gained.length && !lost.length) console.log('      (same dishes as baseline)');
  }
}

console.log('-'.repeat(78));
const best = [...results].sort((a, b) => (b.recall - b.spurious * 0.8 - b.kcal * 0.3) - (a.recall - a.spurious * 0.8 - a.kcal * 0.3))[0];
console.log(`best by recall − 0.8·spurious − 0.3·kcal: ${best.label}`);
console.log(`still missed: ${best.missed.join(', ') || 'nothing'}`);
