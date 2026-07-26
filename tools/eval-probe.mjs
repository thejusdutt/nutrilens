/**
 * Compare the trained linear probe against zero-shot labelling on the same
 * held-out photos, using the same embeddings.
 *
 * Both heads read the identical frozen MobileCLIP embedding, so this isolates
 * exactly one thing: whether a matrix learned from photographs beats cosine
 * similarity to a sentence describing the dish.
 *
 * Zero-shot is scored two ways. Over the whole vocabulary is what ships and is
 * the number that matters. Restricted to the classes the probe was trained on
 * is the fairer head-to-head, since the probe cannot answer outside them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../eval/lib/node-runtime.mjs';

const DATA = join(root, 'tools/data');
const APP = join(root, 'app/public/data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : Number(process.argv[i + 1]); };
const HOLDOUT = arg('holdout', 0.2);
const SEED = arg('seed', 7);

const meta = JSON.parse(readFileSync(join(DATA, 'probe-embeddings.json'), 'utf8'));
const eBuf = readFileSync(join(DATA, 'probe-embeddings.bin'));
const X = new Float32Array(eBuf.buffer, eBuf.byteOffset, eBuf.byteLength / 4);
const { dim, rows } = meta;

const pMeta = JSON.parse(readFileSync(join(DATA, 'probe-weights.json'), 'utf8'));
const pBuf = readFileSync(join(DATA, 'probe-weights.bin'));
const P = new Float32Array(pBuf.buffer, pBuf.byteOffset, pBuf.byteLength / 4);
const classes = pMeta.classes;
const K = classes.length;
const W = P.subarray(0, K * dim);
const B = P.subarray(K * dim);

const zsMeta = JSON.parse(readFileSync(join(APP, 'label-embeddings.json'), 'utf8'));
const zsBuf = readFileSync(join(APP, 'label-embeddings.bin'));
const T = new Float32Array(zsBuf.buffer, zsBuf.byteOffset, zsBuf.byteLength / 4);
const vocab = JSON.parse(readFileSync(join(APP, 'vocabulary.json'), 'utf8'));
const zsLabels = vocab.map((v) => v.id);

function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
const photos = [...new Set(rows.map((r) => r.file))];
const held = new Set(photos.filter((p) => (hash(`${p}#${SEED}`) % 1000) / 1000 < HOLDOUT));
for (const c of classes) {
  const mine = photos.filter((p) => rows.find((r) => r.file === p)?.label === c);
  if (mine.length && mine.every((p) => held.has(p))) held.delete(mine[0]);
}

const probeTop = (i) => {
  let best = 0; let bestS = -Infinity;
  for (let k = 0; k < K; k++) {
    let s = B[k];
    const wo = k * dim; const off = i * dim;
    for (let d = 0; d < dim; d++) s += W[wo + d] * X[off + d];
    if (s > bestS) { bestS = s; best = k; }
  }
  return classes[best];
};

const zsTop = (i, allowed) => {
  let best = -1; let bestS = -Infinity;
  for (let k = 0; k < zsLabels.length; k++) {
    if (allowed && !allowed.has(zsLabels[k])) continue;
    let s = 0;
    const to = k * dim; const off = i * dim;
    for (let d = 0; d < dim; d++) s += T[to + d] * X[off + d];
    if (s > bestS) { bestS = s; best = k; }
  }
  return zsLabels[best];
};

const allowed = new Set(classes);
const idx = [];
for (let i = 0; i < rows.length; i++) if (held.has(rows[i].file)) idx.push(i);

let pHit = 0; let zAll = 0; let zRes = 0;
const perClass = new Map();
for (const i of idx) {
  const truth = rows[i].label;
  const p = probeTop(i);
  const za = zsTop(i, null);
  const zr = zsTop(i, allowed);
  if (p === truth) pHit++;
  if (za === truth) zAll++;
  if (zr === truth) zRes++;
  if (!perClass.has(truth)) perClass.set(truth, { n: 0, p: 0, z: 0 });
  const s = perClass.get(truth);
  s.n++; if (p === truth) s.p++; if (zr === truth) s.z++;
}

const pct = (a, b) => `${(a / b * 100).toFixed(1)}%`;
console.log(`held-out: ${idx.length} embeddings from ${held.size} photos, ${perClass.size} classes\n`);
console.log(`  linear probe             ${pct(pHit, idx.length)}`);
console.log(`  zero-shot (probe labels) ${pct(zRes, idx.length)}`);
console.log(`  zero-shot (whole vocab)  ${pct(zAll, idx.length)}`);

const deltas = [...perClass.entries()]
  .map(([id, s]) => ({ id, n: s.n, p: s.p / s.n, z: s.z / s.n, d: (s.p - s.z) / s.n }))
  .sort((a, b) => a.d - b.d);
const show = (t, xs) => {
  console.log(`\n${t}`);
  for (const x of xs) console.log(`  ${x.id.padEnd(26)} probe ${(x.p * 100).toFixed(0).padStart(3)}%  zero-shot ${(x.z * 100).toFixed(0).padStart(3)}%  (n=${x.n})`);
};
show('worst regressions:', deltas.slice(0, 8));
show('biggest gains:', deltas.slice(-8).reverse());

// --- ensemble --------------------------------------------------------------
// The two heads fail on different classes, which is the case where blending
// wins. Both are turned into log-probabilities over the same label set first,
// so the mix is over comparable quantities rather than raw scores on different
// scales. Labels the probe was never trained on keep their zero-shot score.
const LOGIT_SCALE = zsMeta.logitScale ?? 100;
const probeIndex = new Map(classes.map((c, i) => [c, i]));

function logSoftmax(scores) {
  let max = -Infinity;
  for (const s of scores) if (s > max) max = s;
  let sum = 0;
  for (const s of scores) sum += Math.exp(s - max);
  const lse = max + Math.log(sum);
  return scores.map((s) => s - lse);
}

function ensembleTop(i, alpha) {
  const off = i * dim;
  const zScores = zsLabels.map((_, k) => {
    let s = 0;
    const to = k * dim;
    for (let d = 0; d < dim; d++) s += T[to + d] * X[off + d];
    return s * LOGIT_SCALE;
  });
  const pScores = classes.map((_, k) => {
    let s = B[k];
    const wo = k * dim;
    for (let d = 0; d < dim; d++) s += W[wo + d] * X[off + d];
    return s;
  });
  const zLog = logSoftmax(zScores);
  const pLog = logSoftmax(pScores);
  let best = -1; let bestS = -Infinity;
  for (let k = 0; k < zsLabels.length; k++) {
    const pi = probeIndex.get(zsLabels[k]);
    // Untrained labels are scored by zero-shot alone rather than pushed to
    // -inf: the probe has no opinion about them, which is not evidence against.
    const s = pi === undefined ? zLog[k] : (1 - alpha) * zLog[k] + alpha * pLog[pi];
    if (s > bestS) { bestS = s; best = k; }
  }
  return zsLabels[best];
}

console.log('\nensemble (alpha = weight on the probe):');
for (const alpha of [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1]) {
  let hit = 0;
  for (const i of idx) if (ensembleTop(i, alpha) === rows[i].label) hit++;
  const bar = '#'.repeat(Math.round(hit / idx.length * 50));
  console.log(`  a=${alpha.toFixed(1)}  ${pct(hit, idx.length).padStart(6)}  ${bar}`);
}
