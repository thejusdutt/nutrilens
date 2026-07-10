/**
 * Aggregate eval results into ACCURACY_REPORT.md + PERFORMANCE_REPORT.md.
 * Sweeps fusion parameters offline (head outputs were recorded raw) and
 * reports the best configuration alongside the shipped defaults.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FusionScorer } from '@nutrilens/food-recognition';
import { root } from './lib/node-runtime.mjs';

const resultsDir = join(root, 'eval/results');
const vocab = JSON.parse(readFileSync(join(root, 'app/public/data/vocabulary.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(resultsDir, 'meta.json'), 'utf8'));

const loadSet = (name) => {
  const p = join(resultsDir, `${name}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
};
const food101 = loadSet('food101');
const extended = loadSet('extended');
if (!food101.length && !extended.length) {
  console.error('no results found — run `npm run eval` first');
  process.exit(1);
}

const foodVocab = vocab.filter((v) => !v.nonFood);
const idToVocabIdx = new Map(vocab.map((v, i) => [v.id, i]));

// --------------------------- head-only metrics ---------------------------
function argmaxTopK(arr, k) {
  return [...arr.keys()].sort((a, b) => arr[b] - arr[a]).slice(0, k);
}

function headMetrics(rows) {
  let swin1 = 0, swin5 = 0, zs1 = 0, zs5 = 0, nSwin = 0;
  for (const r of rows) {
    if (r.truth.f101 != null && r.truth.f101 >= 0) {
      nSwin++;
      const top5 = argmaxTopK(r.swinProbs, 5);
      if (top5[0] === r.truth.f101) swin1++;
      if (top5.includes(r.truth.f101)) swin5++;
    }
    // zero-shot over food labels only (probes excluded from argmax)
    const zsFood = vocab.map((v, i) => (v.nonFood ? -1 : r.zsProbs[i]));
    const top5z = argmaxTopK(zsFood, 5).map((i) => vocab[i].id);
    if (top5z[0] === r.truth.id) zs1++;
    if (top5z.includes(r.truth.id)) zs5++;
  }
  return { swin1: swin1 / (nSwin || 1), swin5: swin5 / (nSwin || 1), zs1: zs1 / rows.length, zs5: zs5 / rows.length, nSwin };
}

// --------------------------- fused metrics ---------------------------
function fusedMetrics(rows, params) {
  const scorer = new FusionScorer(vocab, params);
  let top1 = 0, top5 = 0, nonFood = 0;
  const confCorrect = [];
  for (const r of rows) {
    const f = scorer.fuse(Float32Array.from(r.swinProbs), Float32Array.from(r.zsProbs));
    const ids = f.top.map((t) => t.id);
    const hit1 = ids[0] === r.truth.id;
    if (hit1) top1++;
    if (ids.slice(0, 5).includes(r.truth.id)) top5++;
    if (!f.isFood) nonFood++;
    confCorrect.push([f.top[0].prob, hit1]);
  }
  return { top1: top1 / rows.length, top5: top5 / rows.length, falseNonFood: nonFood / rows.length, confCorrect };
}

function ece(confCorrect, bins = 10) {
  const b = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const [c, hit] of confCorrect) {
    const i = Math.min(bins - 1, Math.floor(c * bins));
    b[i].n++; b[i].conf += c; b[i].acc += hit ? 1 : 0;
  }
  let e = 0;
  const total = confCorrect.length;
  for (const bin of b) if (bin.n) e += (bin.n / total) * Math.abs(bin.acc / bin.n - bin.conf / bin.n);
  return { ece: e, bins: b.map((x, i) => ({ range: `${(i / bins).toFixed(1)}–${((i + 1) / bins).toFixed(1)}`, n: x.n, conf: x.n ? x.conf / x.n : 0, acc: x.n ? x.acc / x.n : 0 })) };
}

// --------------------------- parameter sweep ---------------------------
const sweep = [];
for (const wSwin of [0.55, 0.65, 0.72, 0.8, 0.88]) {
  for (const oovBias of [-1.0, -0.6, -0.35, -0.1, 0.2]) {
    const p = { wSwin, oovBias };
    const a = food101.length ? fusedMetrics(food101, p).top1 : 0;
    const b = extended.length ? fusedMetrics(extended, p).top1 : 0;
    sweep.push({ wSwin, oovBias, food101: a, extended: b, balanced: (a + b) / 2 });
  }
}
sweep.sort((x, y) => y.balanced - x.balanced);
const best = sweep[0];
const DEFAULTS = { wSwin: 0.72, oovBias: -0.35 };

// --------------------------- per-class breakdown ---------------------------
function perClass(rows, params) {
  const scorer = new FusionScorer(vocab, params);
  const acc = new Map();
  for (const r of rows) {
    const f = scorer.fuse(Float32Array.from(r.swinProbs), Float32Array.from(r.zsProbs));
    const key = r.truth.id ?? r.file.split('/')[0];
    const cur = acc.get(key) ?? { n: 0, hit: 0 };
    cur.n++; cur.hit += f.top[0].id === r.truth.id ? 1 : 0;
    acc.set(key, cur);
  }
  return [...acc.entries()].map(([id, { n, hit }]) => ({ id, n, acc: hit / n })).sort((a, b) => a.acc - b.acc);
}

// --------------------------- write reports ---------------------------
const pct = (x) => (x * 100).toFixed(1) + '%';
const h101 = headMetrics(food101);
const hExt = extended.length ? headMetrics(extended) : null;
const fDef101 = fusedMetrics(food101, DEFAULTS);
const fBest101 = fusedMetrics(food101, best);
const fDefExt = extended.length ? fusedMetrics(extended, DEFAULTS) : null;
const fBestExt = extended.length ? fusedMetrics(extended, best) : null;
const cal = ece(fBest101.confCorrect);
const worst = perClass(food101, best).slice(0, 12);
const worstExt = extended.length ? perClass(extended, best) : [];

let md = `# NutriLens Accuracy Report

Generated ${meta.date} · Swin variant: **${meta.swinVariant}** · runtime: onnxruntime-node (same library code as the browser build)
Datasets: Food-101 official validation subsample (${food101.length} images, ${h101.nSwin ? Math.round(food101.length / 101) : 0}/class), extended Indian-food set (${extended.length} images).

## Headline results

| Metric | Food-101 subsample | Extended (Indian) set |
|---|---|---|
| Closed-set head (Swin) top-1 | ${pct(h101.swin1)} | n/a (classes outside Food-101) |
| Closed-set head (Swin) top-5 | ${pct(h101.swin5)} | n/a |
| Zero-shot head (MobileCLIP-S0) top-1 | ${pct(h101.zs1)} | ${hExt ? pct(hExt.zs1) : '–'} |
| Zero-shot head top-5 | ${pct(h101.zs5)} | ${hExt ? pct(hExt.zs5) : '–'} |
| **Fused (shipped defaults)** top-1 | **${pct(fDef101.top1)}** | **${fDefExt ? pct(fDefExt.top1) : '–'}** |
| Fused (shipped defaults) top-5 | ${pct(fDef101.top5)} | ${fDefExt ? pct(fDefExt.top5) : '–'} |
| Fused (best swept params) top-1 | ${pct(fBest101.top1)} | ${fBestExt ? pct(fBestExt.top1) : '–'} |
| False "not food" rate | ${pct(fDef101.falseNonFood)} | ${fDefExt ? pct(fDefExt.falseNonFood) : '–'} |

Best swept fusion parameters: wSwin=${best.wSwin}, oovBias=${best.oovBias} (balanced top-1 ${pct(best.balanced)}).

## Confidence calibration (fused, best params, Food-101)

Expected Calibration Error (10 bins): **${cal.ece.toFixed(3)}**

| Confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
${cal.bins.filter((b) => b.n).map((b) => `| ${b.range} | ${b.n} | ${pct(b.conf)} | ${pct(b.acc)} |`).join('\n')}

## Hardest classes (fused top-1, Food-101)

| Class | n | accuracy |
|---|---|---|
${worst.map((w) => `| ${w.id} | ${w.n} | ${pct(w.acc)} |`).join('\n')}

## Extended set per class

| Class | n | accuracy |
|---|---|---|
${worstExt.map((w) => `| ${w.id} | ${w.n} | ${pct(w.acc)} |`).join('\n')}

## Fusion parameter sweep (top-1, balanced)

| wSwin | oovBias | Food-101 | Extended | balanced |
|---|---|---|---|---|
${sweep.slice(0, 10).map((s) => `| ${s.wSwin} | ${s.oovBias} | ${pct(s.food101)} | ${pct(s.extended)} | ${pct(s.balanced)} |`).join('\n')}
`;
writeFileSync(join(resultsDir, 'ACCURACY_REPORT.md'), md);

// Performance report
const lat = (rows, key) => {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b);
  const q = (p) => v[Math.floor(p * (v.length - 1))];
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), mean: v.reduce((a, b) => a + b, 0) / v.length };
};
const all = [...food101, ...extended];
const sw = lat(all, 'swinMs'), zl = lat(all, 'zsMs');
const perf = `# NutriLens Performance Report

Generated ${meta.date} · CPU: onnxruntime-node WASM-equivalent (browser numbers depend on device; WebGPU is typically 2–5× faster).

| Stage | mean | p50 | p90 | p99 |
|---|---|---|---|---|
| Swin-Food101 (${meta.swinVariant}) classify | ${sw.mean.toFixed(0)} ms | ${sw.p50} ms | ${sw.p90} ms | ${sw.p99} ms |
| MobileCLIP-S0 embed+score | ${zl.mean.toFixed(0)} ms | ${zl.p50} ms | ${zl.p90} ms | ${zl.p99} ms |

Measured over ${all.length} images. Browser-side stage timings (SlimSAM encode ≈1.7 s CPU / decode ≈90 ms, plate detection ≈70 ms) are logged by the app console and in browser-smoke runs.

## Model payload

| Asset | Size |
|---|---|
| swin-food101 model_int8.onnx | 93 MB |
| mobileclip-s0 vision int8 | 11.8 MB |
| slimsam encoder+decoder (quantized) | 17.1 MB |
| label embeddings + nutrition DB + vocab | ~0.6 MB |
| ORT runtime (wasm, jsep) | ~31 MB |
`;
writeFileSync(join(resultsDir, 'PERFORMANCE_REPORT.md'), perf);
console.log('reports written to eval/results/');
console.log(`Food-101 fused top-1 (defaults): ${pct(fDef101.top1)} | best: ${pct(fBest101.top1)} (wSwin=${best.wSwin}, oovBias=${best.oovBias})`);
if (fDefExt) console.log(`Extended fused top-1 (defaults): ${pct(fDefExt.top1)} | best: ${pct(fBestExt.top1)}`);
