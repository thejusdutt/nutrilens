/** Post-build: remove bundler-emitted ORT wasm duplicates (runtime loads from
 * /ort/ via env.wasm.wasmPaths) and verify the service-worker precache list
 * matches the build output. */
import { readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'app/dist');

for (const f of readdirSync(join(dist, 'assets'))) {
  if (f.endsWith('.wasm')) {
    rmSync(join(dist, 'assets', f));
    console.log('removed stray', f);
  }
}

const sw = readFileSync(join(root, 'app/public/sw.js'), 'utf8');
const assets = [...sw.matchAll(/'(\/[^']+)'/g)].map((m) => m[1])
  .filter((p) => p !== '/' && !p.startsWith('/models/'));
let missing = 0;
for (const a of assets) {
  if (!existsSync(join(dist, a))) { console.error('SW precache asset missing from dist:', a); missing++; }
}
if (missing) process.exit(1);
console.log(`postbuild OK — ${assets.length} precache assets verified`);
