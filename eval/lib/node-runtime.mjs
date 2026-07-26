/**
 * Node-side runtime helpers for the evaluation harness: decode images with
 * sharp into the same RawImage record the browser produces, and construct the
 * recognizer from local model files — exercising the exact same library code
 * that ships in the PWA.
 */
import sharp from 'sharp';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import {
  SwinFoodClassifier, ZeroShotFoodClassifier, FusionScorer, FoodRecognizer,
} from '@nutrilens/food-recognition';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Decode any image file/buffer to a RawImage (RGBA), EXIF-rotated. */
export async function decodeImage(input, maxSide = 1280) {
  const img = sharp(input).rotate();
  const meta = await img.metadata();
  const scale = Math.min(1, maxSide / Math.max(meta.width, meta.height));
  const pipeline = scale < 1 ? img.resize(Math.round(meta.width * scale)) : img;
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/**
 * Load the trained linear probe, if it has been built and shipped.
 *
 * Returns null when the files are absent, so a clone that has not run
 * `npm run train:probe` still works — on zero-shot alone, exactly as before.
 * @param {string} dataDir @param {boolean} [enabled=true]
 */
export function loadProbe(dataDir, enabled = true) {
  if (enabled === false) return null;
  const metaPath = join(dataDir, 'probe.json');
  const binPath = join(dataDir, 'probe.bin');
  if (!existsSync(metaPath) || !existsSync(binPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const buf = readFileSync(binPath);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const k = meta.classes.length;
  return {
    classes: meta.classes,
    weights: all.subarray(0, k * meta.dim),
    bias: all.subarray(k * meta.dim),
    index: new Map(meta.classes.map((c, i) => [c, i])),
    // Only the classes trained on hand-labelled region crops are trusted; the
    // rest were trained on whole photographs and do not transfer. See
    // ZeroShotFoodClassifier#blendProbe.
    trusted: meta.trusted ? new Set(meta.trusted) : null,
  };
}

/** Build the full FoodRecognizer from repo-local model + data files. */
export async function createRecognizer(opts = {}) {
  const models = join(root, 'app/public/models');
  const dataDir = join(root, 'app/public/data');
  const swinCfg = JSON.parse(readFileSync(join(models, 'swin-food101/config.json'), 'utf8'));
  const labels = Object.entries(swinCfg.id2label).sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  const vocab = JSON.parse(readFileSync(join(dataDir, 'vocabulary.json'), 'utf8'));
  const embMeta = JSON.parse(readFileSync(join(dataDir, 'label-embeddings.json'), 'utf8'));
  const embBuf = readFileSync(join(dataDir, 'label-embeddings.bin'));
  const matrix = new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4);

  const swinModel = join(models, `swin-food101/onnx/model_${opts.swinVariant ?? 'int8'}.onnx`);
  const swin = await SwinFoodClassifier.load(ort, swinModel, labels, { temperature: opts.temperature ?? 1 });
  const zs = await ZeroShotFoodClassifier.load(
    ort,
    join(models, 'mobileclip-s2/onnx/vision_model_fp16.onnx'),
    { labels: vocab.map((v) => v.id), matrix, dim: embMeta.dim, logitScale: embMeta.logitScale },
    { probe: loadProbe(dataDir, opts.probe), probeAlpha: opts.probeAlpha },
  );
  const scorer = new FusionScorer(vocab, opts.fusion ?? {});
  return { recognizer: new FoodRecognizer(swin, zs, scorer), swin, zs, scorer, vocab, labels };
}
