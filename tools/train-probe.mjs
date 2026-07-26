/**
 * Train a linear probe over frozen MobileCLIP image embeddings.
 *
 * One matrix, W [nClasses x dim], plus a bias. Classification is
 * softmax(W·e + b) on the same L2-normalized embedding the zero-shot path
 * already computes, so inference costs one extra matrix multiply and the
 * browser needs no new model — the vision tower is unchanged and frozen.
 *
 * Why a linear probe rather than fine-tuning: with ~20 photos a class there is
 * not enough signal to move a vision tower without destroying it, and CLIP
 * features are famously close to linearly separable. It also keeps the shipped
 * artefact to a few hundred KB and the training loop to plain arithmetic.
 *
 * Multinomial logistic regression, full-batch gradient descent with momentum
 * and L2 regularisation. Split is by *source photo*, never by embedding — the
 * random crops of one photo are near-duplicates of each other and of the full
 * frame, so splitting by row would leak the answer into the held-out set and
 * report an accuracy that does not exist.
 *
 * Usage: node tools/train-probe.mjs [--epochs 300] [--lr 1.0] [--l2 3e-4] [--holdout 0.2]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../eval/lib/node-runtime.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : Number(process.argv[i + 1]);
};
const EPOCHS = arg('epochs', 300);
const LR = arg('lr', 1.0);
const L2 = arg('l2', 3e-4);
const HOLDOUT = arg('holdout', 0.2);
const SEED = arg('seed', 7);

const DATA = join(root, 'tools/data');
const meta = JSON.parse(readFileSync(join(DATA, 'probe-embeddings.json'), 'utf8'));
const buf = readFileSync(join(DATA, 'probe-embeddings.bin'));
const X = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const { dim, rows } = meta;
const n = rows.length;

const classes = [...new Set(rows.map((r) => r.label))].sort();
const classIndex = new Map(classes.map((c, i) => [c, i]));
const y = rows.map((r) => classIndex.get(r.label));
console.log(`${n} embeddings, ${dim} dims, ${classes.length} classes`);

// --- split by source photo -------------------------------------------------
function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
const photos = [...new Set(rows.map((r) => r.file))];
const heldPhotos = new Set(photos.filter((p) => (hash(`${p}#${SEED}`) % 1000) / 1000 < HOLDOUT));
// A class with every photo held out would be untrainable; keep at least one.
for (const c of classes) {
  const mine = photos.filter((p, i) => rows.find((r) => r.file === p)?.label === c);
  if (mine.length && mine.every((p) => heldPhotos.has(p))) heldPhotos.delete(mine[0]);
}
const trainIdx = [];
const testIdx = [];
for (let i = 0; i < n; i++) (heldPhotos.has(rows[i].file) ? testIdx : trainIdx).push(i);
console.log(`train ${trainIdx.length} rows / ${photos.length - heldPhotos.size} photos`
  + `, held out ${testIdx.length} rows / ${heldPhotos.size} photos`);

// --- model -----------------------------------------------------------------
const K = classes.length;
const W = new Float32Array(K * dim);
const b = new Float32Array(K);
const vW = new Float32Array(K * dim);
const vb = new Float32Array(K);
const MOMENTUM = 0.9;

const logits = new Float64Array(K);
function forward(i) {
  const off = i * dim;
  for (let k = 0; k < K; k++) {
    let s = b[k];
    const wo = k * dim;
    for (let d = 0; d < dim; d++) s += W[wo + d] * X[off + d];
    logits[k] = s;
  }
  let max = -Infinity;
  for (let k = 0; k < K; k++) if (logits[k] > max) max = logits[k];
  let sum = 0;
  for (let k = 0; k < K; k++) { logits[k] = Math.exp(logits[k] - max); sum += logits[k]; }
  for (let k = 0; k < K; k++) logits[k] /= sum;
  return logits;
}

const accuracy = (idx) => {
  let hit = 0;
  for (const i of idx) {
    const p = forward(i);
    let best = 0;
    for (let k = 1; k < K; k++) if (p[k] > p[best]) best = k;
    if (best === y[i]) hit++;
  }
  return hit / idx.length;
};

const gW = new Float32Array(K * dim);
const gb = new Float32Array(K);
const scale = 1 / trainIdx.length;

for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  gW.fill(0); gb.fill(0);
  let loss = 0;
  for (const i of trainIdx) {
    const p = forward(i);
    loss -= Math.log(Math.max(p[y[i]], 1e-12));
    const off = i * dim;
    for (let k = 0; k < K; k++) {
      const g = (p[k] - (k === y[i] ? 1 : 0)) * scale;
      if (g === 0) continue;
      gb[k] += g;
      const wo = k * dim;
      for (let d = 0; d < dim; d++) gW[wo + d] += g * X[off + d];
    }
  }
  for (let k = 0; k < K * dim; k++) {
    vW[k] = MOMENTUM * vW[k] - LR * (gW[k] + L2 * W[k]);
    W[k] += vW[k];
  }
  for (let k = 0; k < K; k++) { vb[k] = MOMENTUM * vb[k] - LR * gb[k]; b[k] += vb[k]; }
  if (epoch % 50 === 0 || epoch === 1) {
    console.log(`  epoch ${String(epoch).padStart(4)}  loss ${(loss * scale).toFixed(4)}`
      + `  train ${(accuracy(trainIdx) * 100).toFixed(1)}%`
      + `  held-out ${(accuracy(testIdx) * 100).toFixed(1)}%`);
  }
}

console.log(`\nfinal held-out top-1: ${(accuracy(testIdx) * 100).toFixed(1)}%`);

writeFileSync(join(DATA, 'probe-weights.json'), JSON.stringify({ dim, classes }));
const out = new Float32Array(K * dim + K);
out.set(W, 0); out.set(b, K * dim);
writeFileSync(join(DATA, 'probe-weights.bin'), Buffer.from(out.buffer));
console.log(`wrote ${K} x ${dim} weights + ${K} biases`);
