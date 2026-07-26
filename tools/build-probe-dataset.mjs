/**
 * Extract MobileCLIP image embeddings for every labelled photo in eval/data,
 * so a classifier head can be trained on them.
 *
 * Zero-shot labelling compares an image embedding to *text* embeddings of the
 * label names. That is a strong baseline and a hard ceiling: it can only ever
 * be as good as the prompt, and "a photo of coconut chutney" sits almost
 * exactly as close to a bowl of pale paste as "a photo of clam chowder" does.
 * A head trained on actual photographs of each dish is not bound that way.
 *
 * Only the head is trained. The vision tower is frozen and already ships, so
 * the extra weight in the browser is one matrix.
 *
 * Each photo contributes several embeddings: the whole frame, and a few random
 * crops. The pipeline classifies *region crops*, never whole frames, so
 * training on whole frames alone would fit the wrong distribution.
 *
 * Output: tools/data/probe-embeddings.bin  Float32 [n x dim]
 *         tools/data/probe-embeddings.json { dim, rows:[{label, source}] }
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crop } from '@nutrilens/image-preprocess';
import { VOCABULARY } from './vocabulary.mjs';
import { decodeImage, createRecognizer, root } from '../eval/lib/node-runtime.mjs';

const OUT_DIR = join(root, 'tools/data');
const CROPS_PER_IMAGE = 2;

/** Deterministic PRNG: the dataset must be identical run to run. */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Folder name → vocabulary id. Food-101 directories use underscores and the
// vocabulary records that spelling in `f101`; the other sets are already named
// by id.
const byF101 = new Map(VOCABULARY.filter((v) => v.f101).map((v) => [v.f101, v.id]));
const ids = new Set(VOCABULARY.map((v) => v.id));
const toId = (dir) => byF101.get(dir) ?? (ids.has(dir) ? dir : null);

/** Every (file, label) pair under a directory of class folders. */
function collect(dir, depth = 1) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (depth > 1) { out.push(...collect(p, depth - 1)); continue; }
    const id = toId(name);
    if (!id) { console.warn(`  skip ${relative(root, p)} — no vocabulary id`); continue; }
    for (const f of readdirSync(p)) {
      if (/\.(jpe?g|png|webp)$/i.test(f)) out.push({ file: join(p, f), label: id });
    }
  }
  return out;
}

const samples = [
  ...collect(join(root, 'eval/data/food101')),
  ...collect(join(root, 'eval/data/extended')),
  ...collect(join(root, 'eval/data/cuisine'), 2),
];
console.log(`${samples.length} labelled photos across ${new Set(samples.map((s) => s.label)).size} classes`);

const { zs } = await createRecognizer();
const rows = [];
const vectors = [];
let done = 0;

for (const { file, label } of samples) {
  let image;
  try { image = await decodeImage(readFileSync(file), 640); } catch { continue; }
  const rand = mulberry32(file.length * 2654435761 + image.width);
  const views = [{ img: image, source: 'full' }];
  for (let i = 0; i < CROPS_PER_IMAGE; i++) {
    const scale = 0.6 + rand() * 0.3;
    const w = Math.round(image.width * scale);
    const h = Math.round(image.height * scale);
    const x = Math.round(rand() * (image.width - w));
    const y = Math.round(rand() * (image.height - h));
    views.push({ img: crop(image, x, y, w, h), source: `crop${i}` });
  }
  for (const { img, source } of views) {
    vectors.push(await zs.embed(img));
    rows.push({ label, source, file: relative(root, file).replace(/\\/g, '/') });
  }
  if (++done % 200 === 0) console.log(`  ${done}/${samples.length}`);
}

const dim = vectors[0].length;
const flat = new Float32Array(vectors.length * dim);
vectors.forEach((v, i) => flat.set(v, i * dim));
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'probe-embeddings.bin'), Buffer.from(flat.buffer));
writeFileSync(join(OUT_DIR, 'probe-embeddings.json'), JSON.stringify({ dim, rows }));
console.log(`wrote ${vectors.length} x ${dim} embeddings`);
