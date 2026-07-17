/**
 * Evaluation harness. Runs the exact library code that ships in the PWA
 * (via onnxruntime-node) over the fetched datasets and records raw per-image
 * head outputs so fusion parameters can be swept offline.
 *
 * Outputs: eval/results/food101.jsonl, eval/results/extended.jsonl
 *          eval/results/meta.json (runtime, model variant, timings)
 *
 * Usage: node eval/run-eval.mjs [--swin-variant int8|q4f16] [--limit N] [--set food101|extended|cuisine|all]
 */
import { readdirSync, writeFileSync, mkdirSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeImage, createRecognizer, root } from './lib/node-runtime.mjs';

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const SWIN_VARIANT = argVal('--swin-variant', 'int8');
const LIMIT = Number(argVal('--limit', Infinity));
const SET = argVal('--set', 'all');

const resultsDir = join(root, 'eval/results');
mkdirSync(resultsDir, { recursive: true });

const { swin, zs, vocab, labels } = await createRecognizer({ swinVariant: SWIN_VARIANT });
// canonical id ← food101 label index
const canonicalByF101 = new Map(vocab.filter((v) => v.f101 != null).map((v) => [v.f101, v.id]));
const round = (a, d = 5) => Array.from(a, (x) => +x.toFixed(d));

async function evalImage(path) {
  const img = await decodeImage(path);
  const t0 = performance.now();
  const s = await swin.classify(img);
  const t1 = performance.now();
  const z = await zs.classify(img);
  const t2 = performance.now();
  return {
    swinProbs: round(s.probs), zsProbs: round(z.probs),
    swinMs: +(t1 - t0).toFixed(1), zsMs: +(t2 - t1).toFixed(1),
  };
}

async function runSet(name, dir, truthFromDir) {
  const out = join(resultsDir, `${name}.jsonl`);
  if (existsSync(out)) rmSync(out);
  const classes = readdirSync(dir);
  let done = 0;
  for (const cls of classes) {
    const files = readdirSync(join(dir, cls)).slice(0, LIMIT);
    for (const f of files) {
      try {
        const rec = await evalImage(join(dir, cls, f));
        appendFileSync(out, JSON.stringify({ set: name, truth: truthFromDir(cls), file: `${cls}/${f}`, ...rec }) + '\n');
      } catch (err) {
        console.warn(`  !! ${cls}/${f}: ${err.message}`);
      }
      if (++done % 100 === 0) console.log(`${name}: ${done}`);
    }
  }
  console.log(`${name}: ${done} images done`);
}

if (SET === 'all' || SET === 'food101') {
  await runSet('food101', join(root, 'eval/data/food101'),
    (cls) => ({ f101: labels.indexOf(cls), id: canonicalByF101.get(labels.indexOf(cls)) ?? null }));
}
if (SET === 'all' || SET === 'extended') {
  await runSet('extended', join(root, 'eval/data/extended'),
    (cls) => ({ f101: null, id: cls }));
}
if (SET === 'all' || SET === 'cuisine') {
  // Wikimedia Commons per-cuisine sets: eval/data/cuisine/<cuisine>/<id>/*.jpg
  const cuisineRoot = join(root, 'eval/data/cuisine');
  if (existsSync(cuisineRoot)) {
    for (const cuisine of readdirSync(cuisineRoot)) {
      await runSet(`cuisine-${cuisine}`, join(cuisineRoot, cuisine),
        (cls) => ({ f101: null, id: cls }));
    }
  }
}

writeFileSync(join(resultsDir, 'meta.json'), JSON.stringify({
  date: new Date().toISOString(),
  swinVariant: SWIN_VARIANT,
  runtime: `onnxruntime-node ${process.versions.node}`,
  vocabSize: vocab.length,
}, null, 2));
console.log('eval complete');
