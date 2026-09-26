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
 * A full run in the shipping configuration rewrites the tables in
 * eval/results/VISION_BENCH.md and the whole of eval/results/vision-bench.json.
 * Any other run only prints, so an experiment cannot leave its numbers behind
 * under the name of the shipped ones.
 *
 * Usage:
 *   node eval/vision-bench.mjs                 # score every image, write the report
 *   node eval/vision-bench.mjs --only 'dosa|idli'  # regex filter on the image key
 *   node eval/vision-bench.mjs --json out.json # machine-readable results
 *   node eval/vision-bench.mjs --set globalPrior=0 --set mergeSameFood=false
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NutritionEngine } from '@nutrilens/nutrition-engine';
import { DEFAULTS } from '@nutrilens/plate-analyzer';
import { decodeImage, root } from './lib/node-runtime.mjs';
import { createPipeline } from './lib/pipeline.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const only = flag('--only');
const jsonOut = flag('--json');
// The trained linear probe is blended into region naming by default; these turn
// it off or re-weight it, so a run can be attributed to it or not.
const noProbe = args.includes('--no-probe');
const probeAlpha = flag('--probe-alpha');
// Score the plate-splitting path instead of the shipped single-dish default.
const splitPlate = args.includes('--split');
// Turn off the side-dish pass (findCompanions) to measure what it adds.
const noCompanions = args.includes('--no-companions');
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
const KNOWN = new Set(['--only', '--json', '--set', '--probe-alpha', '--no-probe', '--flat-oov', '--split', '--no-companions']);
for (let i = 0; i < args.length; i++) {
  if (KNOWN.has(args[i])) { i++; continue; }
  console.error(`unknown argument: ${args[i]}`);
  console.error('usage: vision-bench [--only <id>] [--json <path>] [--set key=value]...');
  process.exit(2);
}

const truth = JSON.parse(readFileSync(join(root, 'eval/vision-truth.json'), 'utf8'));
const db = JSON.parse(readFileSync(join(root, 'app/public/data/nutrition-db.json'), 'utf8'));
const engine = new NutritionEngine(db);

console.log('loading models…');
const { analyse } = await createPipeline({
  probe: !noProbe,
  probeAlpha: probeAlpha == null ? undefined : Number(probeAlpha),
  fusion: args.includes('--flat-oov') ? { oovAdaptive: false } : {},
});

/**
 * Run the exact pipeline the app runs on one photo.
 *
 * The pipeline itself lives in ./lib/pipeline.mjs and is shared with the
 * stability harness. It was briefly duplicated here, and the duplicate went
 * stale within the hour: this file kept weighing the dominant mask after the
 * app had stopped, so the benchmark reported numbers for a path nothing
 * shipped. One copy, or the copies disagree and the disagreement reads as a
 * result.
 *
 * @returns {{items:{id,name,grams,kcal}[], totals:object, plate:object|null}}
 */
export async function analyzePhoto(image, options = {}) {
  const { whole, plate, regions, items } = await analyse(image, options, { split: splitPlate, companions: !noCompanions });
  return summarise(image, whole, plate, items, items, regions);
}

/**
 * Turn a list of named, weighed items into the record the scorer reads.
 * Shared by both paths so the single-dish default and the split plate cannot
 * drift apart in their arithmetic.
 *
 * `rawItems` keeps the region masks, which the summary throws away. Absorption
 * bugs — a filling inside a dish surviving as its own line — are only
 * diagnosable with the masks in hand.
 */
function summarise(image, whole, plate, items, rawItems, regions) {
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
    rawItems,
    regions,
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
const skipped = [];
const entries = Object.entries(truth.images).filter(([k]) => !only || new RegExp(only, 'i').test(k));

for (const [key, spec] of entries) {
  const file = join(root, spec.file);
  if (!existsSync(file)) { console.warn(`skip ${key}: ${spec.file} missing`); skipped.push(key); continue; }
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
    found: hit.length,
    wanted: wantIds.size,
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
const FIELDS = ['kcal', 'carbs', 'protein', 'fat', 'grams'];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const absErrs = (k) => rows.map((r) => r.err[k]).filter((x) => x != null).map(Math.abs);
const within = (k, tol) => absErrs(k).filter((x) => x <= tol).length;

/** Every headline number, computed once so the console and the report agree. */
const summary = {
  images: rows.length,
  dishRecall: mean(rows.map((r) => r.dishRecall)) * 100,
  spurious: rows.reduce((a, r) => a + r.spurious.length, 0),
  spuriousImages: rows.filter((r) => r.spurious.length).length,
  medianMs: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0,
  fields: Object.fromEntries(FIELDS.map((k) => [k, {
    meanAbs: mean(absErrs(k)) * 100, inBand: within(k, 0), within25: within(k, 0.25),
  }])),
};

console.log(`\n${'='.repeat(72)}`);
console.log(`images                ${summary.images}`);
console.log(`dish recall           ${summary.dishRecall.toFixed(1)}%`);
console.log(`spurious dishes       ${summary.spurious} total (${summary.spuriousImages} images affected)`);
for (const k of FIELDS) {
  const f = summary.fields[k];
  console.log(
    `${k.padEnd(8)} mean |err| ${f.meanAbs.toFixed(1).padStart(5)}%`
    + `   in band ${String(f.inBand).padStart(2)}/${summary.images}`
    + `   within 25% ${String(f.within25).padStart(2)}/${summary.images}`,
  );
}
console.log(`median time           ${(summary.medianMs / 1000).toFixed(1)}s`);
console.log('='.repeat(72));

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * A row without the pixels.
 *
 * `got.rawItems` and `got.regions` carry every region's mask — one byte per
 * pixel, so a single photo is megabytes and twenty of them overflow the largest
 * string V8 will build. `--json` threw `RangeError: Invalid string length` on
 * every full run from the moment the masks were kept. They exist for in-process
 * diagnosis; nothing downstream reads them back.
 */
function serializable({ got, ...row }) {
  const { rawItems, regions, ...rest } = got;
  return { ...row, got: rest };
}

const asJson = () => JSON.stringify({
  options: { ...DEFAULTS, ...overrides },
  summary,
  rows: rows.map(serializable),
}, null, 2);

if (jsonOut) {
  writeFileSync(jsonOut, asJson());
  console.log(`wrote ${jsonOut}`);
}

/**
 * The tracked report is only rewritten by a run that can stand behind it: the
 * whole set, shipping settings, nothing skipped. A `--only` run or a fresh
 * clone without `eval/data/` would otherwise overwrite the numbers with a
 * partial measurement that still reads like the full one.
 */
const tweaked = only || Object.keys(overrides).length || noProbe
  || probeAlpha != null || args.includes('--flat-oov')
  // --split measures the opt-in path, not the default one the report describes.
  || splitPlate || noCompanions;
const complete = !skipped.length && rows.length === Object.keys(truth.images).length;

if (tweaked) {
  console.log('\nreport not written: this run is not the shipping configuration');
} else if (!complete) {
  console.log(`\nreport not written: ${skipped.length} of ${Object.keys(truth.images).length} images missing`
    + ` (${skipped.join(', ')})`);
} else {
  writeFileSync(join(root, 'eval/results/vision-bench.json'), asJson());
  writeReport();
  console.log('\nwrote eval/results/VISION_BENCH.md + vision-bench.json');
}

/**
 * Rewrite the generated half of eval/results/VISION_BENCH.md.
 *
 * The report said "Generated by npm run test:vision" and was not: its tables
 * were pasted in by hand, so commits that changed how a region gets named left
 * a report describing a pipeline that no longer existed. Everything between the
 * markers now comes from the run; the analysis below them is written by hand
 * and left alone.
 */
function writeReport() {
  const path = join(root, 'eval/results/VISION_BENCH.md');
  const START = '<!-- generated: rewritten by npm run test:vision -->';
  const END = '<!-- /generated: everything below is written by hand -->';
  const date = new Date().toISOString().slice(0, 10);
  const one = (n) => n.toFixed(1);

  const metric = (k) => {
    const f = summary.fields[k];
    return `| ${k} mean abs error | ${one(f.meanAbs)}% `
      + `(in band ${f.inBand}/${summary.images}, within 25% ${f.within25}/${summary.images}) |`;
  };

  const block = [
    START,
    '',
    `Generated by \`npm run test:vision\` on ${date}. Scores the shipped photo`,
    'pipeline end to end — recognition, segmentation, portion, nutrition — against',
    'what a careful human reader says is on each plate (eval/vision-truth.json).',
    '',
    'Bands, not point values: portion estimation from one uncalibrated photo is',
    'genuinely uncertain, and a benchmark demanding an exact number would reward',
    `overfitting to these ${summary.images} photos.`,
    '',
    '| metric | value |',
    '|---|---|',
    `| images | ${summary.images} |`,
    `| dish recall | ${one(summary.dishRecall)}% |`,
    `| spurious dishes | ${summary.spurious} (${summary.spuriousImages} images affected) |`,
    ...FIELDS.map(metric),
    `| median time per photo | ${one(summary.medianMs / 1000)} s |`,
    '',
    'Every row but the last is deterministic — the same photo gives the same',
    'dishes, the same grams and the same calories on every run. The time is only',
    'what the machine that ran it could do: across four runs of this set on one',
    'laptop the median ranged from 11 s to 32 s a photo.',
    '',
    '## Per photo',
    '',
    '| photo | reported | accepted band | dishes found | what it logged |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.key} | ${r.got.totals.kcal} kcal | ${r.want.kcal[0]}–${r.want.kcal[1]}`
      + ` | ${r.found}/${r.wanted} | ${r.got.items.map((i) => `${i.name} ${i.grams} g`).join(' + ') || '(nothing)'} |`),
    '',
    END,
  ].join('\n');

  // Refuse rather than silently drop the analysis: without the end marker there
  // is no way to tell the generated tables from the writing underneath them.
  const prose = readFileSync(path, 'utf8').split(END)[1];
  if (prose == null) throw new Error(`${path} has no "${END}" marker — not overwriting it`);
  writeFileSync(path, `# Vision benchmark\n\n${block}${prose}`);
}
