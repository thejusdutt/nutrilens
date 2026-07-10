/**
 * Precompute L2-normalized MobileCLIP-S0 text embeddings for the food
 * vocabulary with prompt ensembling. Runs the text tower ONCE at build time —
 * only the resulting matrix ships to the browser (the 43 MB text model and
 * tokenizer never leave the repo).
 *
 * Outputs:
 *   app/public/data/label-embeddings.bin   Float32 [nLabels x dim] row-major
 *   app/public/data/label-embeddings.json  { dim, logitScale, count, sha }
 * Row order is exactly app/public/data/vocabulary.json order.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as ort from 'onnxruntime-node';
import { AutoTokenizer } from '@huggingface/transformers';
import { VOCABULARY, promptsFor } from './vocabulary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const textDir = join(root, 'tools/data/mobileclip-s0-text');

const vocabJson = JSON.parse(readFileSync(join(root, 'app/public/data/vocabulary.json'), 'utf8'));
const byId = new Map(VOCABULARY.map((v) => [v.id, v]));

const tokenizer = await AutoTokenizer.from_pretrained(textDir, { local_files_only: true });
const session = await ort.InferenceSession.create(join(textDir, 'onnx/text_model_int8.onnx'));

/** Embed a batch of prompts → array of L2-normalized Float32Array. */
async function embedPrompts(prompts) {
  const enc = tokenizer(prompts, { padding: 'max_length', truncation: true, max_length: 77 });
  const ids = enc.input_ids;
  const input = new ort.Tensor('int64', BigInt64Array.from(ids.data), ids.dims);
  const out = await session.run({ input_ids: input });
  const [n, dim] = out.text_embeds.dims;
  const res = [];
  for (let i = 0; i < n; i++) {
    const e = Float32Array.from(out.text_embeds.data.subarray(i * dim, (i + 1) * dim));
    let norm = 0;
    for (const v of e) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dim; j++) e[j] /= norm;
    res.push(e);
  }
  return res;
}

let dim = 0;
const rows = [];
for (const v of vocabJson) {
  const entry = byId.get(v.id);
  if (!entry) throw new Error(`vocabulary.json id not in VOCABULARY: ${v.id}`);
  const prompts = promptsFor(entry);
  const embs = await embedPrompts(prompts);
  dim = embs[0].length;
  // Ensemble: average of normalized prompt embeddings, then re-normalize.
  const avg = new Float32Array(dim);
  for (const e of embs) for (let j = 0; j < dim; j++) avg[j] += e[j];
  let norm = 0;
  for (const x of avg) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < dim; j++) avg[j] /= norm;
  rows.push(avg);
  process.stdout.write(`\r${rows.length}/${vocabJson.length} ${v.id.padEnd(30)}`);
}
console.log();

const matrix = new Float32Array(rows.length * dim);
rows.forEach((r, i) => matrix.set(r, i * dim));
const buf = Buffer.from(matrix.buffer);
writeFileSync(join(root, 'app/public/data/label-embeddings.bin'), buf);
writeFileSync(join(root, 'app/public/data/label-embeddings.json'), JSON.stringify({
  dim,
  count: rows.length,
  logitScale: 100,
  model: 'Xenova/mobileclip_s0 text tower (int8), prompt-ensembled',
  sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
}));
console.log(`wrote ${rows.length} x ${dim} embeddings (${(buf.length / 1024).toFixed(0)} KB)`);
