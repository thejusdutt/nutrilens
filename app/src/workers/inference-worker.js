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
import { proposeRegions } from '@nutrilens/plate-analyzer';
import { loadModelBytes, MODEL_CACHE } from '../model-cache.js';

ort.env.wasm.wasmPaths = '/ort/';
// Multi-threaded WASM when the page is crossOriginIsolated (COOP/COEP served).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let recognizer = null;
let segmenter = null;
let backend = 'wasm';
let samLoading = null;

// Model bytes are read/written to Cache Storage directly from this worker (see
// ../model-cache.js): the Cache API has no service-worker lifetime limits (SWs
// get terminated mid-download on ~100 MB files), works before the page is
// SW-controlled, and makes repeat loads instant.

/** Model bytes, cache-first, reporting download progress to the page. */
const fetchWithProgress = (url, label) => loadModelBytes(
  url,
  (loaded, total) => postMessage({ type: 'progress', label, loaded, total }),
);

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

/**
 * The trained linear probe, blended into region naming beside the text
 * embeddings. Two small files, no extra model: it reads the same MobileCLIP
 * embedding the zero-shot head already computes.
 *
 * Absent files are not an error — the app then runs on zero-shot alone, which
 * is what every build before this one did.
 */
async function loadProbe() {
  try {
    const meta = await fetch('/data/probe.json').then((r) => (r.ok ? r.json() : null));
    if (!meta) return null;
    const buf = await (await fetch('/data/probe.bin')).arrayBuffer();
    const all = new Float32Array(buf);
    const k = meta.classes.length;
    return {
      classes: meta.classes,
      weights: all.subarray(0, k * meta.dim),
      bias: all.subarray(k * meta.dim),
      index: new Map(meta.classes.map((c, i) => [c, i])),
      trusted: meta.trusted ? new Set(meta.trusted) : null,
      trustedWhole: meta.trustedWhole ? new Set(meta.trustedWhole) : null,
    };
  } catch {
    return null;
  }
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
  }, { probe: await loadProbe() });
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
 * Whole-plate discovery: prompt SAM with the grid from the plate analyzer and
 * keep distinct, plausibly-food-sized masks plus the single largest one.
 * Proposal geometry, dedupe and thresholds live in @nutrilens/plate-analyzer
 * so the evaluation harness scores the same code the app runs.
 * @returns {{regions:object[], dominant:object|null}}
 */
const autoSegment = (seg, width, height, plate, onProgress) => proposeRegions({
  segment: (points) => seg.segment(points),
  width,
  height,
  plate,
  onProgress,
});

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
      const result = await recognizer.recognize(asRaw(msg.image), { whole: !!msg.whole });
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
      const { regions, dominant } = await autoSegment(seg, dims.width, dims.height, plate,
        (done, total) => postMessage({ type: 'auto-progress', id: msg.id, done, total }));
      // The dominant mask usually IS one of the regions; copy it so the two
      // never share a buffer that transfer would then neuter under one of them.
      const wire = (r) => ({ mask: r.mask.slice().buffer, areaPx: r.areaPx, areaFraction: r.areaFraction, iou: r.iou, bbox: r.bbox, point: r.point });
      const payload = {
        type: 'auto-segmented',
        id: msg.id,
        plate,
        width: dims.width,
        height: dims.height,
        regions: regions.map(wire),
        dominant: dominant ? wire(dominant) : null,
      };
      postMessage(payload, [...payload.regions.map((r) => r.mask), ...(payload.dominant ? [payload.dominant.mask] : [])]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: err?.message ?? String(err) });
  }
};
