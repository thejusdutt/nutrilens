/** Copy onnxruntime-web WASM/JSEP runtime files into app/public/ort so they
 * are served (and cacheable offline) from a stable path. */
import { mkdirSync, copyFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Prefer the app workspace's resolution (root node_modules may hold a
// different version hoisted for @huggingface/transformers' build tooling).
const src = [
  join(root, 'app/node_modules/onnxruntime-web/dist'),
  join(root, 'node_modules/onnxruntime-web/dist'),
].find(existsSync);
const dst = join(root, 'app/public/ort');
rmSync(dst, { recursive: true, force: true }); // drop files from older ORT versions
mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  // Runtime worker/wasm binaries only (incl. .jsep for WebGPU and .asyncify);
  // skip the large bundler entry points (ort*.mjs) and training/node builds.
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(f) && !f.includes('.min.') && !/training|node/.test(f)) {
    copyFileSync(join(src, f), join(dst, f));
    n++;
  }
}
console.log(`copied ${n} ORT runtime files -> app/public/ort`);
