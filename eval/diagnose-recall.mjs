/**
 * Why did a dish go missing?
 *
 * vision-bench says *that* a dish was missed; this says *where*. The pipeline
 * has four places a correct answer can die, and they need opposite fixes, so
 * guessing between them wastes a benchmark run each time:
 *
 *   SEGMENT   no proposed region ever covered the dish
 *   NAME      a region covered it, but the classifier never listed it
 *   FUSE      the region listed it, and the whole-image prior demoted it
 *   FILTER    it survived naming, and a later gate dropped the line
 *
 * For every required dish in eval/vision-truth.json this replays the shipped
 * pipeline, records the dish's standing at each stage, and reports the earliest
 * stage that lost it. Spurious dishes get the same treatment in reverse: where
 * they entered.
 *
 * Usage:
 *   node eval/diagnose-recall.mjs                 # every image
 *   node eval/diagnose-recall.mjs --only biryani  # regex on the image key
 *   node eval/diagnose-recall.mjs --json out.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { SlimSamSegmenter } from '@nutrilens/food-segmentation';
import { PortionEstimator, detectPlateEllipse } from '@nutrilens/portion-estimator';
import { NutritionEngine } from '@nutrilens/nutrition-engine';
import {
  proposeRegions, buildPlate, fuseWithGlobal, regionCrop, DEFAULTS,
} from '@nutrilens/plate-analyzer';
import { decodeImage, createRecognizer, root } from './lib/node-runtime.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const only = flag('--only');
const jsonOut = flag('--json');
const overrides = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--set') continue;
  const [k, v] = args[i + 1].split('=');
  overrides[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
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

/** Rank of `id` in a candidate list, or null. */
const rankOf = (list, id) => {
  const i = list.findIndex((t) => norm(t.id) === id);
  return i < 0 ? null : i;
};

const rows = [];
const entries = Object.entries(truth.images).filter(([k]) => !only || new RegExp(only, 'i').test(k));

for (const [key, spec] of entries) {
  const file = join(root, spec.file);
  if (!existsSync(file)) { console.warn(`skip ${key}: ${spec.file} missing`); continue; }
  const image = await decodeImage(readFileSync(file));
  const o = { ...DEFAULTS, ...overrides };

  const whole = await recognizer.recognize(image, { whole: true });
  const imageTop = whole.top.filter((t) => engine.food(t.id));
  const plate = detectPlateEllipse(image);
  await segmenter.setImage(image);
  const { regions, dominant } = await proposeRegions({
    segment: (points) => segmenter.segment(points),
    width: image.width, height: image.height, plate, options: overrides,
  });

  // Replay stage 2 exactly as buildPlate does, keeping every intermediate.
  const perRegion = [];
  for (const region of regions) {
    if (!region.bbox) continue;
    const res = await recognizer.recognize(regionCrop(image, region, o));
    const known = res.top.filter((t) => engine.food(t.id));
    const fused = known.length ? fuseWithGlobal(known, imageTop, o.globalPrior, o.priorFloor) : [];
    perRegion.push({
      areaPx: region.areaPx,
      areaFrac: region.areaPx / (image.width * image.height),
      isFood: res.isFood,
      raw: res.top.slice(0, 8).map((t) => ({ id: norm(t.id), prob: +t.prob.toFixed(4) })),
      known: known.slice(0, 8).map((t) => ({ id: norm(t.id), prob: +t.prob.toFixed(4) })),
      fused: fused.slice(0, 8).map((t) => ({ id: norm(t.id), prob: +t.prob.toFixed(4) })),
      // What buildPlate would take from this region.
      picked: fused.length && fused[0].prob >= o.minItemProb ? norm(fused[0].id) : null,
    });
  }

  const final = await buildPlate({
    image, regions, dominant, imageTop, plate,
    classify: (img) => recognizer.recognize(img),
    foodById: (id) => engine.food(id),
    estimator, options: overrides,
  });
  const finalIds = new Set(final.map((i) => norm(i.id)));
  const singleDish = final.some((i) => i.singleDish);

  const required = spec.dishes.filter((d) => !d.optional).map((d) => norm(d.id));
  const allowed = new Set(spec.dishes.map((d) => norm(d.id)));

  const verdicts = [];
  for (const dish of required) {
    if (finalIds.has(dish)) { verdicts.push({ dish, stage: 'OK' }); continue; }
    // Earliest stage that lost it.
    const inImage = rankOf(imageTop, dish);
    const named = perRegion.filter((r) => rankOf(r.known, dish) != null);
    const fusedIn = perRegion.filter((r) => rankOf(r.fused, dish) != null);
    const wouldPick = perRegion.filter((r) => r.picked === dish);
    let stage; let detail;
    if (!named.length) {
      stage = 'NAME';
      detail = `no region listed it (whole-image rank ${inImage ?? '—'})`;
    } else if (wouldPick.length) {
      stage = singleDish ? 'FILTER/single-dish' : 'FILTER';
      detail = `${wouldPick.length} region(s) picked it, dropped after naming`;
    } else {
      const bestKnown = Math.min(...named.map((r) => rankOf(r.known, dish)));
      const bestFused = fusedIn.length ? Math.min(...fusedIn.map((r) => rankOf(r.fused, dish))) : null;
      const kp = Math.max(...named.map((r) => r.known[rankOf(r.known, dish)].prob));
      const fp = fusedIn.length ? Math.max(...fusedIn.map((r) => r.fused[rankOf(r.fused, dish)].prob)) : 0;
      if (bestFused == null || bestFused > bestKnown) {
        stage = 'FUSE';
        detail = `region rank ${bestKnown} (p=${kp}) → fused rank ${bestFused ?? '—'} (p=${fp})`;
      } else {
        stage = 'NAME';
        detail = `best region rank ${bestKnown} (p=${kp}), never top-1`;
      }
    }
    verdicts.push({ dish, stage, detail, imageRank: inImage });
  }

  const spurious = [...finalIds].filter((id) => !allowed.has(id)).map((id) => {
    const from = perRegion.filter((r) => r.picked === id);
    return {
      dish: id,
      viaSingleDish: singleDish,
      regions: from.length,
      areaFrac: from.length ? +Math.min(...from.map((r) => r.areaFrac)).toFixed(4) : null,
      imageRank: rankOf(imageTop, id),
    };
  });

  rows.push({
    key,
    regions: regions.length,
    singleDish,
    imageTop: imageTop.slice(0, 8).map((t) => ({ id: norm(t.id), prob: +t.prob.toFixed(4) })),
    verdicts,
    spurious,
    perRegion,
  });

  console.log(`\n${key}  (${regions.length} regions${singleDish ? ', single-dish path' : ''})`);
  for (const v of verdicts) {
    console.log(`  ${v.stage === 'OK' ? '✓' : '✗'} ${v.dish.padEnd(22)} ${v.stage.padEnd(18)} ${v.detail ?? ''}`);
  }
  for (const s of spurious) {
    console.log(`  + ${s.dish.padEnd(22)} SPURIOUS           `
      + `${s.viaSingleDish ? 'via single-dish path' : `${s.regions} region(s), area ${s.areaFrac}`}`
      + `, whole-image rank ${s.imageRank ?? '—'}`);
  }
}

// ---------------------------------------------------------------------------
const tally = {};
for (const r of rows) for (const v of r.verdicts) tally[v.stage] = (tally[v.stage] ?? 0) + 1;
const total = Object.values(tally).reduce((a, b) => a + b, 0);
console.log(`\n${'='.repeat(72)}`);
console.log('where required dishes stand:');
for (const [stage, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${stage.padEnd(20)} ${String(n).padStart(3)}  ${((n / total) * 100).toFixed(0)}%`);
}
const spur = rows.reduce((a, r) => a + r.spurious.length, 0);
const spurSingle = rows.reduce((a, r) => a + r.spurious.filter((s) => s.viaSingleDish).length, 0);
console.log(`spurious dishes: ${spur} (${spurSingle} via the single-dish path)`);
console.log('='.repeat(72));

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
  console.log(`wrote ${jsonOut}`);
}
