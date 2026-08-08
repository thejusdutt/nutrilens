/**
 * Stability: does the same photograph give the same answer when the *file*
 * changes but the picture does not?
 *
 * vision-bench asks whether the number is right. This asks whether it is the
 * same number twice, which is a different property and was not being measured
 * at all. It was found the hard way: one plate of dumplings gave 415 kcal saved
 * as PNG and 671 kcal saved as JPEG — the same pixels to any eye — because a
 * region sat close to the probability at which it becomes a diary line and
 * imperceptible noise decided it.
 *
 * Perturbations are things that happen to a photo in normal use: re-encoding it
 * at a different quality, saving it losslessly, sending it through an app that
 * resizes it slightly. None of them change what is on the plate, so none of
 * them should change what is logged.
 *
 * Usage:
 *   node eval/stability.mjs            # every photo in vision-truth
 *   node eval/stability.mjs --only dosa
 *   node eval/stability.mjs --split    # measure the opt-in breakdown instead
 */
import sharp from 'sharp';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeImage, root } from './lib/node-runtime.mjs';
import { createPipeline } from './lib/pipeline.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const only = flag('--only');
const split = args.includes('--split');
const verbose = args.includes('--verbose');
const maxFactor = flag('--max-factor');

const truth = JSON.parse(readFileSync(join(root, 'eval/vision-truth.json'), 'utf8'));

/**
 * Variants of one photograph that a person would call the same picture.
 * Deliberately not exotic: this is what saving, sharing and re-uploading do.
 */
const VARIANTS = [
  ['as-is', (s) => sharp(s).png().toBuffer()],
  ['jpeg q95', (s) => sharp(s).jpeg({ quality: 95 }).toBuffer()],
  ['jpeg q85', (s) => sharp(s).jpeg({ quality: 85 }).toBuffer()],
  ['jpeg q75', (s) => sharp(s).jpeg({ quality: 75 }).toBuffer()],
  // A 1% resize: enough to change every pixel, not enough to see.
  ['resized 99%', async (s) => {
    const m = await sharp(s).metadata();
    return sharp(s).resize({ width: Math.round(m.width * 0.99) }).png().toBuffer();
  }],
];

console.log('loading models…');
const { analyse, engine } = await createPipeline({}, maxFactor ? { maxFactor: Number(maxFactor) } : {});

const rows = [];
for (const [key, spec] of Object.entries(truth.images)) {
  if (only && !new RegExp(only, 'i').test(key)) continue;
  const file = join(root, spec.file);
  if (!existsSync(file)) { console.warn(`skip ${key}: ${spec.file} missing`); continue; }
  const src = readFileSync(file);

  const runs = [];
  for (const [label, make] of VARIANTS) {
    const image = await decodeImage(await make(src));
    const { items, plate, regions } = await analyse(image, {}, { split });
    const kcal = Math.round(items.reduce(
      (a, it) => a + (engine.forPortion(it.id, it.grams)?.nutrients.kcal.value ?? 0), 0,
    ));
    runs.push({
      label,
      kcal,
      dishes: items.map((i) => i.id).sort().join('+') || '(none)',
      // What the portion was computed from, so an unstable number can be
      // attributed: the plate is a threshold (used only above
      // MIN_PLATE_CONFIDENCE), and the mask area is the other input.
      plateConf: plate ? Number(plate.confidence.toFixed(2)) : null,
      areaPx: items[0]?.region?.areaPx ?? 0,
      grams: items[0]?.grams ?? 0,
      nRegions: regions.length,
    });
  }

  const kcals = runs.map((r) => r.kcal);
  const lo = Math.min(...kcals); const hi = Math.max(...kcals);
  const names = new Set(runs.map((r) => r.dishes));
  const spread = hi === 0 ? 0 : (hi - lo) / hi;
  rows.push({ key, lo, hi, spread, nameChanges: names.size - 1, runs });

  const flagged = names.size > 1 ? '  DISHES CHANGED' : (spread > 0.1 ? '  kcal unstable' : '');
  console.log(`${key.padEnd(27)}${String(lo).padStart(5)}–${String(hi).padEnd(6)} `
    + `${(spread * 100).toFixed(0).padStart(3)}% spread${flagged}`);
  if (verbose || names.size > 1 || spread > 0.1) {
    for (const r of runs) {
      console.log(`      ${r.label.padEnd(13)} ${String(r.kcal).padStart(5)} kcal  ${String(r.grams).padStart(4)} g  `
        + `plate ${String(r.plateConf ?? '—').padStart(4)}  mask ${String(r.areaPx).padStart(7)} px  `
        + `${r.nRegions} regions  ${r.dishes}`);
    }
  }
}

// ---------------------------------------------------------------------------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const changed = rows.filter((r) => r.nameChanges > 0);
const wobbly = rows.filter((r) => r.spread > 0.1);
console.log(`\n${'='.repeat(64)}`);
console.log(`photos                      ${rows.length}`);
console.log(`dish list changed           ${changed.length}${changed.length ? `  (${changed.map((r) => r.key).join(', ')})` : ''}`);
console.log(`kcal spread over 10%        ${wobbly.length}${wobbly.length ? `  (${wobbly.map((r) => r.key).join(', ')})` : ''}`);
console.log(`mean kcal spread            ${(mean(rows.map((r) => r.spread)) * 100).toFixed(1)}%`);
console.log(`worst kcal spread           ${(Math.max(0, ...rows.map((r) => r.spread)) * 100).toFixed(1)}%`);
console.log('='.repeat(64));

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
// Two different failures, held to two different standards.
//
// The PORTION is now stable by construction: a photo read as one dish is
// weighed at that food's typical serving, with no mask area involved. Any
// wobble here means something has started scaling portions by an unstable
// measurement again, which is the regression this file exists to prevent.
//
// The DISH NAME still changes on three photos, and that is a known defect
// rather than an acceptable one: the classifier near-ties between two similar
// foods (biryani/poha, kung pao/General Tso) and imperceptible noise picks the
// winner. It is recorded as a baseline so it cannot quietly get worse, and it
// is not counted as a pass. Averaging over augmented views would damp it but
// cannot break a genuine tie, so it needs its own work.
const KNOWN_UNSTABLE_NAMES = 3;
const stableNamed = rows.filter((r) => r.nameChanges === 0);
const portionSpread = mean(stableNamed.map((r) => r.spread));

const problems = [];
if (portionSpread > 0.02) {
  problems.push(`portions moved ${(portionSpread * 100).toFixed(1)}% on photos whose dish did not change`
    + ' — the portion should not depend on the file at all');
}
if (changed.length > KNOWN_UNSTABLE_NAMES) {
  problems.push(`${changed.length} photos changed dish, over the known ${KNOWN_UNSTABLE_NAMES}`);
}
if (problems.length) {
  console.log(`\nSTABILITY FAIL\n  ${problems.join('\n  ')}`);
} else {
  console.log(`\nSTABILITY PASS — portions steady across every re-encoding`
    + `\n  ${changed.length} photos still change dish under noise (known: ${KNOWN_UNSTABLE_NAMES}); see VISION_BENCH.md`);
}
process.exitCode = problems.length ? 1 : 0;
