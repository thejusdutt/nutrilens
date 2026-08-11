/**
 * Post-build: remove bundler-emitted ORT wasm duplicates, stamp deterministic
 * service-worker cache names, and verify every required precache asset exists.
 */
import {
  readdirSync, rmSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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

const swPath = join(dist, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
const assets = [...sw.matchAll(/'(\/[^']+)'/g)].map((m) => m[1])
  .filter((p) => p !== '/' && !p.startsWith('/models/'));
let missing = 0;
for (const asset of assets) {
  if (!existsSync(join(dist, asset))) {
    console.error('SW precache asset missing from dist:', asset);
    missing++;
  }
}
if (missing) process.exit(1);

const hash = createHash('sha256');
for (const asset of [...new Set(assets)].sort()) {
  hash.update(asset);
  hash.update(readFileSync(join(dist, asset)));
}
const shellVersion = hash.digest('hex').slice(0, 16);

const modelSource = readFileSync(join(root, 'app/src/model-cache.js'), 'utf8');
const modelMatch = modelSource.match(/export const MODEL_CACHE = '([^']+)'/);
if (!modelMatch) throw new Error('Could not read MODEL_CACHE from app/src/model-cache.js');

const shellPlaceholder = '__NUTRILENS_SHELL_VERSION__';
const modelPlaceholder = '__NUTRILENS_MODEL_CACHE__';
if (!sw.includes(shellPlaceholder) || !sw.includes(modelPlaceholder)) {
  throw new Error('Service-worker cache placeholders are missing');
}
sw = sw.replace(shellPlaceholder, shellVersion).replace(modelPlaceholder, modelMatch[1]);
writeFileSync(swPath, sw);

if (sw.includes('__NUTRILENS_')) throw new Error('Service-worker placeholders were not fully stamped');
console.log(`postbuild OK — ${assets.length} precache assets verified; shell ${shellVersion}; models ${modelMatch[1]}`);
