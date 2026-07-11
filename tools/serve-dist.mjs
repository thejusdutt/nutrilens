/**
 * Minimal production-faithful static server for app/dist:
 *  - correct Content-Length, no on-the-fly compression (large model files
 *    stream reliably through service workers),
 *  - COOP/COEP headers → crossOriginIsolated → multi-threaded WASM,
 *  - SPA fallback to index.html.
 *
 * Usage: node tools/serve-dist.mjs [port=5199] [dir=app/dist]
 */
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 5199);
const dir = join(root, process.argv[3] ?? 'app/dist');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream',
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = normalize(join(dir, decodeURIComponent(url.pathname))).replace(/[\\/]+$/, '');
  if (!path.startsWith(dir)) { res.writeHead(403).end(); return; }
  if (!existsSync(path) || statSync(path).isDirectory()) {
    path = existsSync(join(path, 'index.html')) ? join(path, 'index.html') : join(dir, 'index.html');
  }
  const stat = statSync(path);
  res.writeHead(200, {
    'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': url.pathname.startsWith('/models/') || url.pathname.startsWith('/ort/')
      ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(path).pipe(res);
}).listen(port, () => console.log(`serving ${dir} on http://localhost:${port}`));
