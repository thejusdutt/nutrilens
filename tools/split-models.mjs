/**
 * Cloudflare Pages compatibility pass over app/dist:
 *
 * Pages rejects any file over 25 MiB. Large model binaries under /models/ are
 * split into numbered part files plus a small manifest; the inference worker
 * transparently reassembles them (see fetchWithProgress) and caches the joined
 * bytes, so the rest of the app never knows the difference.
 *
 *   model_int8.onnx  →  model_int8.onnx.manifest.json
 *                       model_int8.onnx.p00, .p01, ...
 *
 * The one >25 MiB file we cannot split is /ort/ort-wasm-simd-threaded.jsep.wasm
 * (ONNX Runtime loads it directly by URL). It only powers the opt-in ?webgpu=1
 * mode, so it is dropped from the deploy with a notice.
 *
 * Usage: node tools/split-models.mjs   (after `npm run build`)
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'app/dist');
const LIMIT = 24 * 1024 * 1024; // stay safely under Pages' 25 MiB cap
const CHUNK = 20 * 1024 * 1024;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let split = 0, dropped = 0;
for (const file of [...walk(dist)]) {
  const size = statSync(file).size;
  if (size <= LIMIT) continue;
  const rel = relative(dist, file).replaceAll('\\', '/');

  if (rel.startsWith('models/')) {
    const buf = readFileSync(file);
    const parts = Math.ceil(buf.length / CHUNK);
    for (let i = 0; i < parts; i++) {
      writeFileSync(`${file}.p${String(i).padStart(2, '0')}`, buf.subarray(i * CHUNK, (i + 1) * CHUNK));
    }
    writeFileSync(`${file}.manifest.json`, JSON.stringify({ parts, size: buf.length, chunkBytes: CHUNK }));
    rmSync(file);
    console.log(`split   ${rel} (${(size / 1e6).toFixed(1)} MB → ${parts} parts)`);
    split++;
  } else {
    rmSync(file);
    console.log(`dropped ${rel} (${(size / 1e6).toFixed(1)} MB, exceeds Pages limit; only used by opt-in webgpu mode)`);
    dropped++;
  }
}
console.log(`done: ${split} split, ${dropped} dropped`);
