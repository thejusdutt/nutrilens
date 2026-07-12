/**
 * Inference worker: owns every ONNX session so the UI thread never blocks.
 *
 * Protocol (postMessage):
 *   → { type:'init' }
 *   ← { type:'progress', label, loaded, total }   (repeated, bytes)
 *   ← { type:'ready', backend }
 *   → { type:'recognize', id, image:{data:ArrayBuffer,width,height} }
 *   ← { type:'recognized', id, result }
 *   → { type:'segment', id, image?:{...}, points:[{x,y,label}], detectPlate:boolean }
 *   ← { type:'segmented', id, mask:ArrayBuffer, width, height, areaPx, areaFraction, iou, bbox, plate }
 *   ← { type:'error', id?, message }
 */
import * as ort from 'onnxruntime-web/webgpu';
import {
  SwinFoodClassifier, ZeroShotFoodClassifier, FusionScorer, FoodRecognizer,
} from '@nutrilens/food-recognition';
import { SlimSamSegmenter } from '@nutrilens/food-segmentation';
import { detectPlateEllipse } from '@nutrilens/portion-estimator';

ort.env.wasm.wasmPaths = '/ort/';
// Multi-threaded WASM when the page is crossOriginIsolated (COOP/COEP served).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let recognizer = null;
let segmenter = null;
let backend = 'wasm';
let samLoading = null;

// Must match MODEL_CACHE in public/sw.js. Model bytes are read/written to
// Cache Storage directly from this worker: the Cache API has no service-worker
// lifetime limits (SWs get terminated mid-download on ~100 MB files), works
// before the page is SW-controlled, and makes repeat loads instant.
const MODEL_CACHE = 'nutrilens-models-v1';

/** Fetch a URL as bytes with progress, cache-first via Cache Storage.
 * Falls back to `<url>.manifest.json` + `<url>.pNN` part files when the plain
 * URL is absent — static hosts with per-file size caps (Cloudflare Pages:
 * 25 MiB) serve the big models pre-split by tools/split-models.mjs. The
 * reassembled bytes are cached under the plain URL either way, so offline and
 * repeat loads behave identically on every host. */
async function fetchWithProgress(url, label) {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const hit = cache && await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  // Manifest first (tiny request), validated — NOT 404-based: SPA-mode hosts
  // (Cloudflare Pages without a 404.html, naive static servers) answer any
  // missing path with index.html + HTTP 200, which would otherwise get parsed
  // as model bytes.
  // no-store everywhere: bypass the HTTP disk cache — 100 MB writes to it can
  // fail (ERR_CACHE_WRITE_FAILURE) and we persist to Cache Storage ourselves.
  let manifest = null;
  try {
    const mres = await fetch(`${url}.manifest.json`, { cache: 'no-store' });
    if (mres.ok) {
      const m = await mres.json();
      if (Number.isInteger(m.parts) && Number.isInteger(m.size)) manifest = m;
    }
  } catch { /* no manifest → whole-file host */ }

  let buf;
  if (manifest) {
    buf = new Uint8Array(manifest.size);
    let off = 0;
    for (let i = 0; i < manifest.parts; i++) {
      const pres = await fetch(`${url}.p${String(i).padStart(2, '0')}`, { cache: 'no-store' });
      if (!pres.ok) throw new Error(`${url} part ${i}: HTTP ${pres.status}`);
      const part = new Uint8Array(await pres.arrayBuffer());
      buf.set(part, off);
      off += part.length;
      postMessage({ type: 'progress', label, loaded: off, total: manifest.size });
    }
    if (off !== manifest.size) throw new Error(`${url}: reassembled ${off} of ${manifest.size} bytes`);
  } else {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    buf = await readWithProgress(res, label);
  }
  if (cache) {
    await cache.put(url, new Response(buf.slice().buffer, {
      headers: { 'Content-Type': 'application/octet-stream' },
    })).catch(() => {});
  }
  return buf;
}

/** Stream a Response body to bytes, posting throttled progress messages. */
async function readWithProgress(res, label) {
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - lastPost > 120) { // throttle DOM-updating progress messages
      postMessage({ type: 'progress', label, loaded, total });
      lastPost = now;
    }
  }
  postMessage({ type: 'progress', label, loaded, total });
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

// Backend choice: the shipped models are int8-quantized, which multi-threaded
// SIMD WASM executes efficiently while WebGPU largely cannot (quantized ops
// fall back to CPU node-by-node with synchronous readbacks — orders of
// magnitude slower in practice). WASM is therefore the default; WebGPU is
// opt-in (?webgpu=1) for experiments with fp16 model variants.
let wantWebGPU = false;

// requestAdapter can hang indefinitely in some environments (headless,
// remoting, broken drivers) — always race it against a timeout.
async function webgpuUsable() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter(),
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    return !!adapter;
  } catch { return false; }
}

async function createSession(bytes) {
  if (wantWebGPU && await webgpuUsable()) {
    try {
      const s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu', 'wasm'] });
      backend = 'webgpu';
      return s;
    } catch (e) {
      console.warn('[nutrilens-worker] webgpu session failed, falling back to wasm:', e?.message);
    }
  }
  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}

// Session factory that plugs pre-fetched bytes into the library loaders.
const ortLike = { Tensor: ort.Tensor, InferenceSession: { create: (bytes) => createSession(bytes) } };

/** Cache-first JSON fetch through the same model cache (offline safety). */
async function cachedJson(url) {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const hit = cache && await cache.match(url);
  if (hit) return hit.json();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (cache) await cache.put(url, res.clone()).catch(() => {});
  return res.json();
}

async function init() {
  console.log('[nutrilens-worker] init start');
  const [swinCfg, vocab, embMeta] = await Promise.all([
    cachedJson('/models/swin-food101/config.json'),
    fetch('/data/vocabulary.json').then((r) => r.json()),
    fetch('/data/label-embeddings.json').then((r) => r.json()),
  ]);
  const labels = Object.entries(swinCfg.id2label).sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  const embBuf = await (await fetch('/data/label-embeddings.bin')).arrayBuffer();
  const matrix = new Float32Array(embBuf);

  const swinBytes = await fetchWithProgress('/models/swin-food101/onnx/model_int8.onnx', 'Food classifier');
  console.log('[nutrilens-worker] creating swin session…');
  const swin = await SwinFoodClassifier.load(ortLike, swinBytes, labels);
  console.log('[nutrilens-worker] swin ready, backend:', backend);
  const clipBytes = await fetchWithProgress('/models/mobileclip-s2/onnx/vision_model_fp16.onnx', 'Open-vocabulary model');
  const zs = await ZeroShotFoodClassifier.load(ortLike, clipBytes, {
    labels: vocab.map((v) => v.id), matrix, dim: embMeta.dim, logitScale: embMeta.logitScale,
  });
  recognizer = new FoodRecognizer(swin, zs, new FusionScorer(vocab));
  console.log('[nutrilens-worker] ready');
  postMessage({ type: 'ready', backend });
}

async function loadSegmenter() {
  if (segmenter) return segmenter;
  samLoading ??= (async () => {
    const enc = await fetchWithProgress('/models/slimsam/onnx/vision_encoder_quantized.onnx', 'Segmentation encoder');
    const dec = await fetchWithProgress('/models/slimsam/onnx/prompt_encoder_mask_decoder_quantized.onnx', 'Segmentation decoder');
    segmenter = await SlimSamSegmenter.load(ortLike, enc, dec);
    return segmenter;
  })();
  return samLoading;
}

const asRaw = (m) => ({ data: new Uint8ClampedArray(m.data), width: m.width, height: m.height });

/**
 * Whole-plate discovery: prompt SAM with a grid of points, keep distinct,
 * plausibly-food-sized masks. Regions are deduplicated by bbox overlap and
 * containment so one dish doesn't appear five times.
 * @returns [{ mask:Uint8Array, areaPx, areaFraction, iou, bbox, point }]
 */
async function autoSegment(seg, width, height, plate, onProgress) {
  // Sample points inside the plate ellipse when we have one (that's where the
  // main dish lives) PLUS a coarse full-frame grid: side bowls (chutneys,
  // sambar, dips) sit OUTSIDE the plate rim and would otherwise never be
  // probed. Duplicate hits are collapsed by the dedupe below.
  const pts = [];
  const N = 4;
  if (plate && plate.confidence > 0.3) {
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const a = ((gx + 0.5) / N) * Math.PI * 2;
        const r = Math.sqrt((gy + 0.5) / N) * 0.8;
        pts.push({ x: plate.cx + r * plate.rx * Math.cos(a), y: plate.cy + r * plate.ry * Math.sin(a) });
      }
    }
  }
  const M = plate && plate.confidence > 0.3 ? 3 : N; // coarse frame grid (dense when no plate)
  for (let gy = 0; gy < M; gy++) {
    for (let gx = 0; gx < M; gx++) {
      pts.push({ x: width * (0.1 + 0.8 * (gx + 0.5) / M), y: height * (0.1 + 0.8 * (gy + 0.5) / M) });
    }
  }
  const candidates = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) continue;
    try {
      const m = await seg.segment([p]);
      if (m.bbox && m.iou > 0.7 && m.areaFraction > 0.008 && m.areaFraction < 0.45) {
        candidates.push({ ...m, point: p });
      }
    } catch { /* skip failed prompts */ }
    onProgress?.(i + 1, pts.length);
  }
  // Greedy dedupe, SMALLEST first: dishes sit on the plate, so a mask that
  // contains an already-kept smaller mask is almost always the plate surface
  // (or a merged multi-dish blob) — the small distinct regions must win.
  candidates.sort((a, b) => a.areaPx - b.areaPx);
  const kept = [];
  for (const c of candidates) {
    const dup = kept.some((k) => {
      const ix = Math.max(0, Math.min(c.bbox.x1, k.bbox.x1) - Math.max(c.bbox.x0, k.bbox.x0));
      const iy = Math.max(0, Math.min(c.bbox.y1, k.bbox.y1) - Math.max(c.bbox.y0, k.bbox.y0));
      const inter = ix * iy;
      const areaC = (c.bbox.x1 - c.bbox.x0) * (c.bbox.y1 - c.bbox.y0);
      const areaK = (k.bbox.x1 - k.bbox.x0) * (k.bbox.y1 - k.bbox.y0);
      return inter / Math.min(areaC, areaK) > 0.55; // overlap or containment
    });
    if (!dup) kept.push(c);
    if (kept.length >= 6) break;
  }
  return kept;
}

let initPromise = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      wantWebGPU = !!msg.webgpu;
      initPromise ??= init();
      await initPromise;
    } else if (msg.type === 'recognize') {
      // Requests can race ahead of model loading (e.g. a button pressed while
      // the first download is still running) — queue behind init.
      await (initPromise ??= init());
      const result = await recognizer.recognize(asRaw(msg.image));
      postMessage({ type: 'recognized', id: msg.id, result });
    } else if (msg.type === 'segment') {
      const seg = await loadSegmenter();
      let plate = null;
      if (msg.image) {
        const raw = asRaw(msg.image);
        if (msg.detectPlate) plate = detectPlateEllipse(raw);
        postMessage({ type: 'sam-encoding', id: msg.id });
        await seg.setImage(raw);
      }
      const m = await seg.segment(msg.points);
      postMessage(
        { type: 'segmented', id: msg.id, mask: m.mask.buffer, width: m.width, height: m.height, areaPx: m.areaPx, areaFraction: m.areaFraction, iou: m.iou, bbox: m.bbox, plate },
        [m.mask.buffer],
      );
    } else if (msg.type === 'segment-auto') {
      const seg = await loadSegmenter();
      let plate = msg.plate ?? null;
      let dims = { width: msg.width, height: msg.height };
      if (msg.image) {
        const raw = asRaw(msg.image);
        dims = { width: raw.width, height: raw.height };
        if (msg.detectPlate) plate = detectPlateEllipse(raw);
        postMessage({ type: 'sam-encoding', id: msg.id });
        await seg.setImage(raw);
      }
      const regions = await autoSegment(seg, dims.width, dims.height, plate,
        (done, total) => postMessage({ type: 'auto-progress', id: msg.id, done, total }));
      postMessage(
        {
          type: 'auto-segmented',
          id: msg.id,
          plate,
          width: dims.width,
          height: dims.height,
          regions: regions.map((r) => ({ mask: r.mask.buffer, areaPx: r.areaPx, areaFraction: r.areaFraction, iou: r.iou, bbox: r.bbox, point: r.point })),
        },
        regions.map((r) => r.mask.buffer),
      );
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err?.message ?? String(err) });
  }
};
