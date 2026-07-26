/**
 * Embed hand-labelled region crops and append them to the probe dataset.
 *
 * The folder-per-dish training set covers everything that is the *subject* of a
 * photo. It has nothing for what sits beside the subject, because nobody
 * photographs a chutney bowl on its own — and those are exactly the items the
 * plate pipeline has to name. These crops come from harvest-crops.mjs and were
 * labelled by eye off the contact sheet.
 *
 * Each crop is embedded several times under small scale and offset jitter. One
 * crop is one photograph of one bowl; without jitter a class of 16 crops is 16
 * points and the probe memorises them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { crop } from '@nutrilens/image-preprocess';
import { decodeImage, createRecognizer, root } from '../eval/lib/node-runtime.mjs';

const DATA = join(root, 'tools/data');
const VIEWS = 5;

/** index → label, read off tools/data/crops/chutney-sheet.png. */
const LABELS = JSON.parse(readFileSync(join(DATA, 'crop-labels.json'), 'utf8'));
const index = JSON.parse(readFileSync(join(DATA, 'crops/chutney/index.json'), 'utf8'));
const byId = new Map(index.map((r) => [r.id, r]));

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const meta = JSON.parse(readFileSync(join(DATA, 'probe-embeddings.json'), 'utf8'));
const buf = readFileSync(join(DATA, 'probe-embeddings.bin'));
const existing = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const { dim, rows } = meta;

// Re-running must not stack duplicates on top of the previous run.
const keep = [];
const keepVecs = [];
for (let i = 0; i < rows.length; i++) {
  if (rows[i].source?.startsWith('handcrop')) continue;
  keep.push(rows[i]);
  keepVecs.push(existing.subarray(i * dim, (i + 1) * dim));
}
console.log(`${rows.length - keep.length} previous hand-crop rows dropped`);

const { zs } = await createRecognizer();
const added = new Map();
for (const [idStr, label] of Object.entries(LABELS)) {
  const rec = byId.get(Number(idStr));
  if (!rec) { console.warn(`  crop ${idStr} not in index`); continue; }
  const png = readFileSync(join(DATA, 'crops/chutney', `${idStr}.png`));
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
  const rand = mulberry32(Number(idStr) * 2654435761 + 17);
  for (let v = 0; v < VIEWS; v++) {
    let view = img;
    if (v > 0) {
      const s = 0.75 + rand() * 0.2;
      const w = Math.round(img.width * s);
      const h = Math.round(img.height * s);
      view = crop(img, Math.round(rand() * (img.width - w)), Math.round(rand() * (img.height - h)), w, h);
    }
    keepVecs.push(await zs.embed(view));
    // `file` is the source photograph, so every view of every crop from one
    // photo lands on the same side of the train/held-out split.
    keep.push({ label, source: `handcrop${v}`, file: rec.file });
  }
  added.set(label, (added.get(label) ?? 0) + VIEWS);
}

const flat = new Float32Array(keepVecs.length * dim);
keepVecs.forEach((v, i) => flat.set(v, i * dim));
writeFileSync(join(DATA, 'probe-embeddings.bin'), Buffer.from(flat.buffer));
writeFileSync(join(DATA, 'probe-embeddings.json'), JSON.stringify({ dim, rows: keep }));
for (const [label, n] of [...added].sort()) console.log(`  +${String(n).padStart(3)} ${label}`);
console.log(`dataset now ${keep.length} embeddings`);
