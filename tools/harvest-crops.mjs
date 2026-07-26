/**
 * Propose region crops from photos and lay them out as one numbered contact
 * sheet, so they can be labelled by eye in a single pass.
 *
 * The training set has a folder per dish, which covers every dish that is the
 * subject of a photo. It has nothing for the things that sit *beside* the
 * subject — chutney, sambar, a dip — because nobody photographs a chutney bowl
 * on its own. Those are exactly the items the plate pipeline has to name, and
 * exactly the ones zero-shot labelling gets wrong.
 *
 * This pulls the small regions out of dishes that are normally served with
 * side bowls, writes them as a grid with an index on each cell, and saves the
 * crops individually. Labelling is then: look at the sheet, list the indices
 * that are coconut chutney.
 *
 * Usage: node tools/harvest-crops.mjs <out-prefix> <dir> [dir...]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { SlimSamSegmenter } from '@nutrilens/food-segmentation';
import { detectPlateEllipse } from '@nutrilens/portion-estimator';
import { proposeRegions, regionCrop, DEFAULTS } from '@nutrilens/plate-analyzer';
import { decodeImage, root } from '../eval/lib/node-runtime.mjs';

const [prefix, ...dirs] = process.argv.slice(2);
const OUT = join(root, 'tools/data/crops', prefix);
mkdirSync(OUT, { recursive: true });

// Reach the frame edge here even though the shipping pipeline does not: side
// bowls crowd in from the sides, and this is a harvester, not the product.
const OPTS = { ...DEFAULTS, frameGrid: 4, frameInset: 0.04, maxItems: 14 };
const CELL = 128;
const COLS = 10;
/** Side bowls are small. Anything above this is the main dish. */
const MAX_FRAME_SHARE = 0.14;

const files = [];
for (const d of dirs) {
  const dir = join(root, d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (/\.(jpe?g|png|webp)$/i.test(f)) files.push(join(dir, f));
  }
}
console.log(`${files.length} photos from ${dirs.length} directories`);

const MODELS = join(root, 'app/public/models');
const segmenter = await SlimSamSegmenter.load(
  ort,
  join(MODELS, 'slimsam/onnx/vision_encoder_quantized.onnx'),
  join(MODELS, 'slimsam/onnx/prompt_encoder_mask_decoder_quantized.onnx'),
);

const cells = [];
const index = [];
for (const file of files) {
  let image;
  try { image = await decodeImage(readFileSync(file), 640); } catch { continue; }
  const plate = detectPlateEllipse(image);
  await segmenter.setImage(image);
  const { regions } = await proposeRegions({
    segment: (points) => segmenter.segment(points),
    width: image.width, height: image.height, plate, options: OPTS,
  });
  for (const region of regions) {
    if (region.areaFraction > MAX_FRAME_SHARE) continue;
    const c = regionCrop(image, region, OPTS);
    const png = await sharp(Buffer.from(c.data.buffer, c.data.byteOffset, c.data.byteLength), {
      raw: { width: c.width, height: c.height, channels: 4 },
    }).png().toBuffer();
    const id = cells.length;
    writeFileSync(join(OUT, `${id}.png`), png);
    cells.push(await sharp(png).resize(CELL, CELL, { fit: 'cover' }).toBuffer());
    index.push({ id, file: relative(root, file).replace(/\\/g, '/'), bbox: region.bbox, areaFraction: region.areaFraction });
  }
  if (index.length && files.indexOf(file) % 10 === 0) console.log(`  ${files.indexOf(file)}/${files.length} → ${cells.length} crops`);
}

// Contact sheet, with the index number burned into each cell.
const rows = Math.ceil(cells.length / COLS);
const label = (i) => Buffer.from(
  `<svg width="${CELL}" height="22"><rect width="34" height="16" fill="#000"/>`
  + `<text x="3" y="13" font-family="monospace" font-size="13" fill="#fff">${i}</text></svg>`,
);
const composite = [];
for (let i = 0; i < cells.length; i++) {
  const x = (i % COLS) * CELL;
  const y = Math.floor(i / COLS) * (CELL + 22);
  composite.push({ input: cells[i], left: x, top: y });
  composite.push({ input: label(i), left: x, top: y + CELL });
}
await sharp({
  create: {
    width: COLS * CELL, height: rows * (CELL + 22),
    channels: 3, background: { r: 240, g: 242, b: 245 },
  },
}).composite(composite).png().toFile(join(root, `tools/data/crops/${prefix}-sheet.png`));

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`${cells.length} crops → tools/data/crops/${prefix}-sheet.png`);
