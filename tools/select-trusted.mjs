/**
 * Choose which probe classes to trust, from held-out evidence.
 *
 * The probe beats zero-shot on some dishes and is badly worse on others — 81.3%
 * against 82.4% overall, but 100% against 0% on pozole and 0% against 100% on
 * mexican-rice. Blending it everywhere is therefore a wash at best, and
 * blending none of it throws away the classes it genuinely learned. The
 * `trusted` list in probe.json exists to take only the wins; until now it held
 * four hand-labelled chutney classes and nothing else.
 *
 * This picks the rest the only defensible way: on the same held-out photos the
 * probe never trained on, keep a class when the probe beats zero-shot by a
 * margin wide enough not to be one lucky photo.
 *
 * Selection is deliberately conservative — ties go to zero-shot. A class the
 * probe merely matches adds risk (it was trained on whole photographs, and the
 * pipeline also asks it about tight region crops) for no measured gain.
 *
 * Usage: node tools/select-trusted.mjs [--min-n 6] [--margin 0.15] [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../eval/lib/node-runtime.mjs';

const DATA = join(root, 'tools/data');
const APP = join(root, 'app/public/data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : Number(process.argv[i + 1]); };
const MIN_N = arg('min-n', 6);
const MARGIN = arg('margin', 0.15);
const HOLDOUT = arg('holdout', 0.2);
const SEED = arg('seed', 7);
const WRITE = process.argv.includes('--write');

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

const zsBuf = readFileSync(join(APP, 'label-embeddings.bin'));
const T = new Float32Array(zsBuf.buffer, zsBuf.byteOffset, zsBuf.byteLength / 4);
const vocab = JSON.parse(readFileSync(join(APP, 'vocabulary.json'), 'utf8'));
const zsLabels = vocab.map((v) => v.id);

// Same photo-level split as train-probe.mjs, so "held out" means the same rows.
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
  const off = i * dim;
  for (let k = 0; k < K; k++) {
    let s = B[k];
    const wo = k * dim;
    for (let d = 0; d < dim; d++) s += W[wo + d] * X[off + d];
    if (s > bestS) { bestS = s; best = k; }
  }
  return classes[best];
};
const zsTop = (i) => {
  let best = 0; let bestS = -Infinity;
  const off = i * dim;
  for (let k = 0; k < zsLabels.length; k++) {
    let s = 0;
    const wo = k * dim;
    for (let d = 0; d < dim; d++) s += T[wo + d] * X[off + d];
    if (s > bestS) { bestS = s; best = k; }
  }
  return zsLabels[best];
};

const stat = new Map();
for (let i = 0; i < rows.length; i++) {
  if (!held.has(rows[i].file)) continue;
  const label = rows[i].label;
  if (!stat.has(label)) stat.set(label, { n: 0, probe: 0, zs: 0 });
  const s = stat.get(label);
  s.n++;
  if (probeTop(i) === label) s.probe++;
  if (zsTop(i) === label) s.zs++;
}

// The only classes trained on hand-labelled region *crops*, so the only ones
// safe to blend when the pipeline is naming a crop. Everything else the probe
// learned was trained on whole photographs.
const CROP_TRUSTED = ['coconut-chutney', 'green-chutney', 'sambar', 'tomato-chutney'];
const rowsOut = [...stat.entries()]
  .map(([label, s]) => ({ label, n: s.n, probe: s.probe / s.n, zs: s.zs / s.n, gap: s.probe / s.n - s.zs / s.n }))
  .sort((a, b) => b.gap - a.gap);

// Classes where the probe clearly beats zero-shot on held-out *whole photos*.
// These are only ever consulted on a full frame, never on a region crop, so
// crop-transfer is not a concern for them — the held-out set is whole photos.
const picked = rowsOut.filter((r) => r.n >= MIN_N && r.gap >= MARGIN).map((r) => r.label);
const trusted = [...CROP_TRUSTED].sort();
const trustedWhole = [...new Set([...CROP_TRUSTED, ...picked])].sort();

console.log(`held-out photos: ${held.size}, classes scored: ${rowsOut.length}`);
console.log(`selection: n >= ${MIN_N} and probe − zero-shot >= ${(MARGIN * 100).toFixed(0)} points\n`);
console.log('class                      n   probe    zs     gap   whole-trusted');
for (const r of rowsOut) {
  const keep = trustedWhole.includes(r.label);
  if (!keep && r.gap <= 0 && r.gap > -MARGIN) continue; // quiet middle
  console.log(
    `  ${r.label.padEnd(24)} ${String(r.n).padStart(3)}  ${(r.probe * 100).toFixed(0).padStart(4)}%  `
    + `${(r.zs * 100).toFixed(0).padStart(4)}%  ${(r.gap * 100 >= 0 ? '+' : '') + (r.gap * 100).toFixed(0).padStart(4)}   ${keep ? 'YES' : ''}`,
  );
}
console.log(`\ncrop-trusted classes:  ${trusted.length}  ${trusted.join(', ')}`);
console.log(`whole-trusted classes: ${trustedWhole.length} (was ${CROP_TRUSTED.length})`);
console.log(trustedWhole.join(', '));

// Held-out accuracy of the resulting mixed head, against zero-shot everywhere.
// The held-out embeddings are whole photos, so this measures the trustedWhole
// list — the one that governs the whole-image pass.
let mixHit = 0; let zsHit = 0; let n = 0;
const wholeSet = new Set(trustedWhole);
for (let i = 0; i < rows.length; i++) {
  if (!held.has(rows[i].file)) continue;
  n++;
  const z = zsTop(i);
  if (z === rows[i].label) zsHit++;
  const p = probeTop(i);
  // The shipped blend only lets a trusted class win; everything else is zero-shot.
  const mixed = wholeSet.has(p) ? p : z;
  if (mixed === rows[i].label) mixHit++;
}
console.log(`\nwhole-image held-out top-1  zero-shot only ${(zsHit / n * 100).toFixed(1)}%`
  + `  →  with whole-trusted probe classes ${(mixHit / n * 100).toFixed(1)}%   (n=${n})`);

if (WRITE) {
  const probePath = join(APP, 'probe.json');
  const probe = JSON.parse(readFileSync(probePath, 'utf8'));
  probe.trusted = trusted;
  probe.trustedWhole = trustedWhole;
  writeFileSync(probePath, JSON.stringify(probe));
  console.log(`\nwrote trusted + trustedWhole to ${probePath}`);
} else {
  console.log('\n(dry run — pass --write to update app/public/data/probe.json)');
}
