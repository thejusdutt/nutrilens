/**
 * App shell: theme, service worker, model worker, the photo-analysis pipeline,
 * navigation and settings. The diary, nutrition, progress, exercise and
 * my-food screens live in their own modules and are wired up at the bottom.
 */
import { toRawImage, crop } from '@nutrilens/image-preprocess';
import { overlayMask } from '@nutrilens/food-segmentation';
import { PortionEstimator, maskAreaInsideEllipse } from '@nutrilens/portion-estimator';
import { NutritionEngine } from '@nutrilens/nutrition-engine';
import { makeEntry, normalizeEntry, toCSV } from '@nutrilens/diary';
import { saveMeal, listMeals, dateKey } from './db.js';
import {
  getProfile, setProfile, dailyGoal, suggestSlot, macroPctSum, macroKcal,
  ACTIVITY, RATE,
} from './goals.js';
import { $, el, fill, fmt, show, view, toast, emit, on, openSheet, closeSheet } from './ui.js';
import { initFoods, food as foodById, servingsFor, nutrients as nutrientsFor } from './foods.js';
import { fillNutritionCard } from './nutrients-ui.js';
import { renderToday, diaryDate, setDiaryDate, openAddMenu } from './today.js';
import { renderNutrition } from './nutrition-view.js';
import { renderProgress, openWeightSheet } from './progress-view.js';
import { renderMyFoods } from './myfoods.js';
import { openExerciseSheet } from './exercise-view.js';
import { initBarcodeView, openBarcodeScanner, closeBarcodeScanner } from './barcode-scan.js';
import { loadModelBytes } from './model-cache.js';
import InferenceWorker from './workers/inference-worker.js?worker';

// ---------------------------------------------------------------------------
// Theme + offline badge + service worker
// ---------------------------------------------------------------------------
const themePref = () => localStorage.getItem('theme') ?? 'auto';
function applyTheme() {
  const t = themePref();
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
applyTheme();
$('btn-theme').onclick = () => {
  const cur = themePref();
  const isDark = document.documentElement.dataset.theme === 'dark'
    || (cur === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  localStorage.setItem('theme', isDark ? 'light' : 'dark');
  applyTheme();
  $('setting-theme').value = themePref();
};

const updateOffline = () => { $('offline-badge').hidden = navigator.onLine; };
addEventListener('online', updateOffline);
addEventListener('offline', updateOffline);
updateOffline();

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register('/sw.js');
}

// ---------------------------------------------------------------------------
// Nutrition data (small JSONs, loaded eagerly)
// ---------------------------------------------------------------------------
let engine = null;
const dataReady = (async () => {
  const db = await fetch('/data/nutrition-db.json').then((r) => r.json());
  engine = new NutritionEngine(db);
  await initFoods(engine);
})();

// ---------------------------------------------------------------------------
// Worker RPC
// ---------------------------------------------------------------------------
let worker = null;
let workerReady = null;
let rpcId = 0;
const pending = new Map();

function ensureWorker() {
  if (workerReady) return workerReady;
  worker = new InferenceWorker();
  workerReady = new Promise((resolve, reject) => {
    const fail = (err) => {
      // Clear the memo so a network blip during the first download does not
      // leave the app permanently broken until a reload.
      workerReady = null;
      worker?.terminate();
      worker = null;
      for (const { reject: rej } of pending.values()) rej(err);
      pending.clear();
      reject(err);
    };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        const pct = m.total ? (m.loaded / m.total) : 0;
        setModelStatus(`Downloading ${m.label}… ${(m.loaded / 1e6).toFixed(1)} / ${(m.total / 1e6).toFixed(1)} MB`, pct);
        setSpinner(`Downloading ${m.label}…`);
      } else if (m.type === 'ready') {
        setModelStatus(null);
        resolve(m.backend);
      } else if (m.type === 'sam-encoding') {
        setSpinner('Measuring portion…');
      } else if (m.type === 'auto-progress') {
        // interim notification, not the RPC result — must not resolve pending
        setSpinner(`Scanning the plate… ${m.done}/${m.total}`);
      } else if (m.type === 'error' && m.id == null) {
        fail(new Error(m.message));
      } else if (pending.has(m.id)) {
        const { resolve: res, reject: rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.type === 'error') rej(new Error(m.message)); else res(m);
      }
    };
    worker.onerror = (e) => fail(new Error(e.message || 'inference worker crashed'));
  });
  worker.postMessage({ type: 'init', webgpu: new URLSearchParams(location.search).has('webgpu') });
  return workerReady;
}

function rpc(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

// The pixel buffer is copied here and handed over, so the worker gets zero-copy
// receipt while the page keeps its own image intact for the canvas.
const rawToMsg = (raw) => ({ data: raw.data.buffer.slice(0), width: raw.width, height: raw.height });
const rpcImage = (msg) => rpc(msg, msg.image ? [msg.image.data] : []);

function setModelStatus(text, pct) {
  const node = $('model-status');
  if (!text) { node.hidden = true; return; }
  node.hidden = false;
  fill(node, el('div', null, text), pct != null && el('progress', { max: 1, value: pct }));
}
function setSpinner(text) {
  if (text == null) { $('analyze-spinner').hidden = true; return; }
  $('analyze-spinner').hidden = false;
  $('spinner-text').textContent = text;
}

// ---------------------------------------------------------------------------
// Image intake: browse / drop / paste / camera
// ---------------------------------------------------------------------------
$('btn-browse').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => { if (e.target.files[0]) startAnalysis(e.target.files[0]); e.target.value = ''; };

const dz = $('drop-zone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragging'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('dragging');
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (f) startAnalysis(f);
});
dz.addEventListener('click', (e) => { if (e.target === dz || e.target.closest('.drop-inner') === e.target) $('file-input').click(); });
addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
  if (f) startAnalysis(f);
});

let stream = null;
let facing = 'environment';
async function openCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 } } });
    $('camera-video').srcObject = stream;
    show('camera');
  } catch {
    $('file-input').setAttribute('capture', 'environment');
    $('file-input').click();
    $('file-input').removeAttribute('capture');
  }
}
function closeCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }
$('btn-camera').onclick = openCamera;
$('btn-cam-cancel').onclick = () => { closeCamera(); show('home'); };
$('btn-cam-flip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; closeCamera(); openCamera(); };
$('btn-shutter').onclick = () => {
  const video = $('camera-video');
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  closeCamera();
  c.toBlob((b) => startAnalysis(b), 'image/jpeg', 0.92);
};

// ---------------------------------------------------------------------------
// Analysis state machine
// ---------------------------------------------------------------------------
const state = {
  raw: null,
  candidates: [],
  isFood: true,
  selectedId: null,
  seg: null,
  plate: null,
  portion: null,
  userGrams: null,
  servingLabel: null,   // set when a household measure is chosen
  imageEncoded: false,
  meal: null,
};

let pendingSlot = null;

async function startAnalysis(blob) {
  show('analyze');
  resetResultUI();
  $('save-slot').value = pendingSlot ?? suggestSlot();
  setSpinner('Preparing photo…');
  state.raw = await toRawImage(blob, { maxSide: 1280 });
  // Everything measured from the previous photo is now meaningless. Leaving
  // `seg` behind made runPortionEstimation reuse the old mask (it only
  // segments when seg is empty), and leaving `plate` behind let a plate from
  // the previous photo scale a picture that has none.
  state.seg = null;
  state.plate = null;
  state.portion = null;
  state.selectedId = null;
  state.userGrams = null;
  state.servingLabel = null;
  state.imageEncoded = false;
  drawPhoto();
  try {
    setSpinner('Loading models…');
    await Promise.all([ensureWorker(), dataReady]);
    setSpinner('Identifying food…');
    const { result } = await rpcImage({ type: 'recognize', image: rawToMsg(state.raw) });
    state.candidates = result.top.filter((t) => engine.food(t.id));
    state.isFood = result.isFood;
    $('nonfood-warning').hidden = result.isFood;
    renderCandidates();
    // Full-plate analysis is the PRIMARY flow: find every item automatically.
    if (state.candidates.length && result.isFood) {
      await analyzeWholePlate({ auto: true });
    } else if (state.candidates.length) {
      await selectFood(state.candidates[0].id);
    }
    setSpinner(null);
  } catch (err) {
    setSpinner(null);
    showError(`Analysis failed: ${err.message}`);
    console.error(err);
  }
}

function showError(text) {
  const node = $('nonfood-warning');
  node.textContent = `⚠️ ${text}`;
  node.hidden = false;
}

function resetResultUI() {
  fill($('candidates'));
  $('portion-card').hidden = true;
  $('nutrition-card').hidden = true;
  $('nonfood-warning').hidden = true;
  $('search-results').hidden = true;
  $('search-input').value = '';
  $('meal-card').hidden = true;
  $('btn-whole-plate').disabled = false;
  $('btn-whole-plate').hidden = false;
  $('btn-save').textContent = '💾 Add to diary';
  state.meal = null;
  const octx = $('overlay-canvas').getContext('2d');
  octx.clearRect(0, 0, octx.canvas.width, octx.canvas.height);
}

function drawPhoto() {
  const { raw } = state;
  const canvas = $('photo-canvas');
  canvas.width = raw.width; canvas.height = raw.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height), 0, 0);
  const ov = $('overlay-canvas');
  ov.width = raw.width; ov.height = raw.height;
}

function renderCandidates() {
  fill($('candidates'), state.candidates.slice(0, 5).map((c) => el('button', {
    class: `candidate${c.id === state.selectedId ? ' selected' : ''}`,
    onclick: () => selectFood(c.id),
  },
  el('b', null, engine.food(c.id)?.name ?? c.name),
  el('span.pct', null, `${(c.prob * 100).toFixed(0)}%`),
  el('span.conf-track', null, el('span.conf-fill', { style: `width:${Math.min(100, c.prob * 100)}%` })))));
}

async function selectFood(id, { point = null } = {}) {
  state.selectedId = id;
  state.servingLabel = null;
  renderCandidates();
  await runPortionEstimation(point);
  renderNutritionCard();
}

async function runPortionEstimation(point) {
  const { raw } = state;
  const foodRec = engine.food(state.selectedId);
  const prior = foodRec?.prior ?? {};
  try {
    if (!state.seg || point) {
      setSpinner(state.imageEncoded ? 'Refining portion…' : 'Measuring portion…');
      const pts = [point ?? { x: raw.width / 2, y: raw.height / 2 }];
      const detectPlate = !state.imageEncoded;
      const m = await rpcImage({
        type: 'segment',
        image: detectPlate ? rawToMsg(raw) : undefined,
        detectPlate,
        points: pts,
      });
      state.imageEncoded = true;
      // Only a run that actually looked for a plate may set it — and when one
      // did look, "no plate" is an answer, not a reason to keep the old one.
      if (detectPlate) state.plate = m.plate ?? null;
      state.seg = { mask: new Uint8Array(m.mask), areaPx: m.areaPx };
      drawOverlay();
    }
    const estimator = new PortionEstimator({ plateDiameterCm: plateCm() });
    state.portion = estimator.estimate({
      areaPx: foodAreaPx(state.seg.mask, raw.width, raw.height, state.seg.areaPx),
      imageWidth: raw.width,
      imageHeight: raw.height,
      plate: state.plate,
      prior,
    });
  } catch (err) {
    console.warn('portion estimation failed, using serving prior', err);
    const s = prior.servingG ?? 250;
    state.portion = { grams: s, low: Math.round(s / 2), high: Math.round(s * 2), method: 'serving-prior' };
  } finally {
    setSpinner(null);
  }
  renderPortion();
}

const plateCm = () => Number(localStorage.getItem('plateCm') ?? 26);

function drawOverlay() {
  const { raw, seg } = state;
  const viewImg = { data: new Uint8ClampedArray(raw.data), width: raw.width, height: raw.height };
  overlayMask(seg.mask, viewImg, [46, 204, 113], 0.4);
  const octx = $('overlay-canvas').getContext('2d');
  octx.putImageData(new ImageData(viewImg.data, raw.width, raw.height), 0, 0);
  if (state.plate) {
    const p = state.plate;
    octx.strokeStyle = 'rgba(255,255,255,.85)';
    octx.setLineDash([10, 8]);
    octx.lineWidth = Math.max(2, raw.width / 300);
    octx.beginPath();
    octx.ellipse(p.cx, p.cy, p.rx, p.ry, 0, 0, Math.PI * 2);
    octx.stroke();
    octx.setLineDash([]);
  }
}

// Tap-to-refine; in whole-plate mode a tap ADDS the item under the finger.
$('overlay-canvas').addEventListener('click', async (e) => {
  if (!state.raw) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * state.raw.width;
  const y = (e.clientY - rect.top) / rect.height * state.raw.height;
  if (state.meal) { await addMealItemAt(x, y); return; }
  setSpinner('Analyzing that spot…');
  try {
    const side = Math.round(Math.min(state.raw.width, state.raw.height) * 0.6);
    const region = crop(state.raw, Math.round(x - side / 2), Math.round(y - side / 2), side, side);
    const { result } = await rpcImage({ type: 'recognize', image: rawToMsg(region) });
    state.candidates = result.top.filter((t) => engine.food(t.id));
    state.isFood = result.isFood;
    $('nonfood-warning').hidden = result.isFood;
    state.seg = null; // force re-segmentation from the tapped point
    renderCandidates();
    if (state.candidates.length) await selectFood(state.candidates[0].id, { point: { x, y } });
  } catch (err) {
    console.error(err);
  } finally {
    setSpinner(null);
  }
});

async function addMealItemAt(x, y) {
  setSpinner('Adding that item…');
  try {
    const m = await rpcImage({ type: 'segment', points: [{ x, y }] }); // image already encoded
    const region = { mask: new Uint8Array(m.mask), areaPx: m.areaPx, bbox: m.bbox };
    if (!region.bbox) return;
    const b = region.bbox;
    const pad = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.15);
    const cropped = crop(state.raw, b.x0 - pad, b.y0 - pad, (b.x1 - b.x0) + 2 * pad, (b.y1 - b.y0) + 2 * pad);
    const { result } = await rpcImage({ type: 'recognize', image: rawToMsg(cropped) });
    const candidates = result.top.filter((t) => engine.food(t.id));
    if (!candidates.length) return;
    const estimator = new PortionEstimator({ plateDiameterCm: plateCm() });
    const est = estimator.estimate({
      areaPx: foodAreaPx(region.mask, state.raw.width, state.raw.height, region.areaPx),
      imageWidth: state.raw.width, imageHeight: state.raw.height,
      plate: state.plate, prior: engine.food(candidates[0].id).prior,
    });
    state.meal.items.push({ id: candidates[0].id, grams: est.grams, prob: candidates[0].prob, candidates, region });
    drawMealOverlay();
    renderMeal();
  } catch (err) {
    console.error(err);
  } finally {
    setSpinner(null);
  }
}

// Manual correction search over every food source
$('search-input').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  const box = $('search-results');
  if (q.length < 2) { box.hidden = true; return; }
  await dataReady;
  const { search } = await import('./foods.js');
  const hits = search(q, { limit: 12 });
  box.hidden = hits.length === 0;
  fill(box, hits.map((h) => el('button', {
    onclick: () => {
      box.hidden = true;
      $('search-input').value = '';
      $('nonfood-warning').hidden = true;
      if (state.meal) {
        const f = foodById(h.id);
        state.meal.items.push({
          id: h.id, grams: f.prior?.servingG ?? 100, prob: 1,
          candidates: [{ id: h.id, name: f.name, prob: 1 }], region: null,
        });
        drawMealOverlay();
        renderMeal();
        return;
      }
      state.candidates = [{ id: h.id, name: h.name, prob: 1, sources: { manual: true } }, ...state.candidates.filter((c) => c.id !== h.id)];
      selectFood(h.id);
    },
  }, h.name)));
});

// ---------------------------------------------------------------------------
// Portion + nutrition rendering
// ---------------------------------------------------------------------------
function currentGrams() { return state.userGrams ?? state.portion?.grams ?? 100; }

/** Food pixels that actually lie on the plate — bleed outside the rim is background. */
function foodAreaPx(mask, w, h, fallbackAreaPx) {
  if (state.plate && state.plate.confidence > 0.3 && mask) {
    return maskAreaInsideEllipse(mask, w, h, state.plate);
  }
  return fallbackAreaPx;
}

function renderPortion() {
  const card = $('portion-card');
  card.hidden = false;
  const p = state.portion;
  const methodTag = $('portion-method');
  if (state.userGrams != null) {
    methodTag.textContent = 'manual';
    methodTag.className = 'tag';
    $('portion-note').textContent = 'Portion set manually.';
  } else if (p.method === 'plate-scale') {
    methodTag.textContent = `plate-scaled · ±${Math.round((p.high / p.grams - 1) * 100)}%`;
    methodTag.className = 'tag';
    $('portion-note').textContent = `Estimated from the detected plate (${plateCm()} cm) and food area ≈ ${p.areaCm2} cm². Adjust if needed.`;
  } else {
    methodTag.textContent = 'typical serving';
    methodTag.className = 'tag warn';
    $('portion-note').textContent = 'No plate found for scale — showing a typical serving. Adjust to match your portion.';
  }
  $('portion-slider').value = currentGrams();
  $('portion-grams').value = currentGrams();

  const sel = $('portion-select');
  fill(sel, el('option', { value: '' }, 'Household measures…'),
    (engine.portions(state.selectedId) ?? []).map(([label, g]) => el('option', { value: String(g), dataset: { label } }, `${label} (${g} g)`)));
}

$('portion-slider').addEventListener('input', (e) => {
  state.userGrams = Number(e.target.value);
  state.servingLabel = null;
  $('portion-grams').value = state.userGrams;
  $('portion-method').textContent = 'manual';
  $('portion-method').className = 'tag';
  renderNutritionCard();
});
$('portion-select').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.userGrams = Number(e.target.value);
  state.servingLabel = e.target.selectedOptions[0]?.dataset.label ?? null;
  $('portion-slider').value = state.userGrams;
  $('portion-grams').value = state.userGrams;
  renderNutritionCard();
});

const CARD_NODES = () => ({
  card: $('nutrition-card'), tag: $('confidence-tag'), kcal: $('kcal-value'),
  range: $('kcal-range'), macros: $('macro-bars'), micros: $('micro-table'),
});

function renderNutritionCard() {
  if (state.meal) { renderMealNutrition(); return; }
  const id = state.selectedId;
  if (!id) return;
  const grams = currentGrams();
  const manual = state.userGrams != null;
  const p = state.portion ?? { grams, low: grams, high: grams };
  const r = engine.forPortionRange(id, manual ? { grams, low: grams, high: grams } : { grams: p.grams, low: p.low, high: p.high });
  if (!r) return;

  const conf = state.candidates.find((c) => c.id === id)?.prob ?? 1;
  const level = conf >= 0.6 ? 'high' : conf >= 0.3 ? 'medium' : 'low';
  const kcal = r.nutrients.kcal;
  fillNutritionCard(CARD_NODES(), r.nutrients, {
    kcalRange: kcal && !manual && kcal.low !== kcal.high ? `(${Math.round(kcal.low)}–${Math.round(kcal.high)})` : '',
    confText: state.candidates[0]?.sources?.manual ? 'manual' : `${level} confidence · ${(conf * 100).toFixed(0)}%`,
    confWarn: level === 'low',
  });
}

// ---------------------------------------------------------------------------
// Whole-plate mode
// ---------------------------------------------------------------------------
const REGION_COLORS = [
  [46, 204, 113], [79, 142, 247], [232, 161, 60], [224, 93, 123], [176, 111, 216], [52, 199, 190],
];

$('btn-whole-plate').onclick = () => analyzeWholePlate();

async function analyzeWholePlate({ auto = false } = {}) {
  if (!state.raw) return;
  const btn = $('btn-whole-plate');
  btn.disabled = true;
  try {
    setSpinner('Loading models…');
    await Promise.all([ensureWorker(), dataReady]);
    setSpinner('Scanning the whole plate…');
    const detectPlate = !state.imageEncoded;
    const m = await rpcImage({
      type: 'segment-auto',
      image: detectPlate ? rawToMsg(state.raw) : undefined,
      detectPlate,
      plate: state.plate,
      width: state.raw.width,
      height: state.raw.height,
    });
    state.imageEncoded = true;
    if (detectPlate) state.plate = m.plate ?? null;

    const estimator = new PortionEstimator({ plateDiameterCm: plateCm() });
    const items = [];
    for (let i = 0; i < m.regions.length; i++) {
      const region = { ...m.regions[i], mask: new Uint8Array(m.regions[i].mask) };
      setSpinner(`Identifying item ${i + 1} of ${m.regions.length}…`);
      const b = region.bbox;
      const pad = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.15);
      const cropped = crop(state.raw, b.x0 - pad, b.y0 - pad, (b.x1 - b.x0) + 2 * pad, (b.y1 - b.y0) + 2 * pad);
      const { result } = await rpcImage({ type: 'recognize', image: rawToMsg(cropped) });
      const candidates = result.top.filter((t) => engine.food(t.id));
      if (!result.isFood || !candidates.length || candidates[0].prob < 0.18) continue;
      const foodRec = engine.food(candidates[0].id);
      const est = estimator.estimate({
        areaPx: foodAreaPx(region.mask, state.raw.width, state.raw.height, region.areaPx),
        imageWidth: state.raw.width,
        imageHeight: state.raw.height,
        plate: state.plate,
        prior: foodRec.prior,
      });
      items.push({ id: candidates[0].id, grams: est.grams, prob: candidates[0].prob, candidates, region });
    }
    if (!items.length) {
      btn.disabled = false;
      if (auto) {
        if (state.candidates.length) await selectFood(state.candidates[0].id);
      } else {
        showError('Couldn’t isolate separate items — tap each food in the photo instead.');
      }
      return;
    }
    state.meal = { items };
    fill($('candidates'));
    $('portion-card').hidden = true;
    $('nonfood-warning').hidden = true;
    btn.hidden = true;
    drawMealOverlay();
    renderMeal();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    if (auto) {
      if (state.candidates.length) await selectFood(state.candidates[0].id).catch(() => {});
    } else {
      showError(`Whole-plate analysis failed: ${err.message}`);
    }
  } finally {
    setSpinner(null);
  }
}

function drawMealOverlay() {
  const { raw, meal } = state;
  const viewImg = { data: new Uint8ClampedArray(raw.data), width: raw.width, height: raw.height };
  meal.items.forEach((it, i) => { if (it.region) overlayMask(it.region.mask, viewImg, REGION_COLORS[i % REGION_COLORS.length], 0.38); });
  const octx = $('overlay-canvas').getContext('2d');
  octx.putImageData(new ImageData(viewImg.data, raw.width, raw.height), 0, 0);
  const fontPx = Math.max(16, Math.round(raw.width / 40));
  octx.font = `800 ${fontPx}px system-ui`;
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  meal.items.forEach((it, i) => {
    if (!it.region?.bbox) return;
    const b = it.region.bbox;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const [r, g, bl] = REGION_COLORS[i % REGION_COLORS.length];
    octx.beginPath();
    octx.arc(cx, cy, fontPx * 0.85, 0, Math.PI * 2);
    octx.fillStyle = `rgb(${r},${g},${bl})`;
    octx.fill();
    octx.fillStyle = '#fff';
    octx.fillText(String(i + 1), cx, cy + 1);
  });
}

function renderMeal() {
  const meal = state.meal;
  $('meal-card').hidden = false;
  $('meal-count').textContent = `${meal.items.length} item${meal.items.length > 1 ? 's' : ''}`;
  fill($('meal-items'), meal.items.map((it, i) => {
    const [r, g, b] = REGION_COLORS[i % REGION_COLORS.length];
    const kcalEl = el('span.mi-kcal', null, itemKcal(it));
    const sel = el('select.mi-food', { title: `${(it.prob * 100).toFixed(0)}% confidence` });
    const seen = new Set();
    for (const c of [{ id: it.id }, ...it.candidates]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      sel.append(el('option', { value: c.id }, foodById(c.id)?.name ?? c.id));
    }
    sel.value = it.id;
    sel.onchange = () => {
      it.id = sel.value;
      if (it.region) {
        const estimator = new PortionEstimator({ plateDiameterCm: plateCm() });
        it.grams = estimator.estimate({
          areaPx: foodAreaPx(it.region.mask, state.raw.width, state.raw.height, it.region.areaPx),
          imageWidth: state.raw.width, imageHeight: state.raw.height,
          plate: state.plate, prior: foodById(it.id).prior,
        }).grams;
      } else {
        it.grams = foodById(it.id).prior?.servingG ?? 100;
      }
      renderMeal();
    };
    const grams = el('input.mi-grams', {
      type: 'number', min: 5, max: 1500, step: 5, value: it.grams, 'aria-label': 'grams',
      oninput: (e) => {
        it.grams = Math.max(1, Number(e.target.value) || 0);
        renderMealNutrition();
        kcalEl.textContent = itemKcal(it);
      },
    });
    return el('div.meal-item', null,
      el('span.dot', { style: `background:rgb(${r},${g},${b})` }, i + 1),
      sel, grams, kcalEl,
      el('button.mi-del', {
        title: 'Remove item',
        onclick: () => {
          meal.items.splice(i, 1);
          if (!meal.items.length) { resetResultUI(); drawPhoto(); return; }
          drawMealOverlay();
          renderMeal();
        },
      }, '✕'));
  }));
  renderMealNutrition();
}

const itemKcal = (it) => `${Math.round((foodById(it.id).per100g.kcal ?? 0) * it.grams / 100)} kcal`;

function renderMealNutrition() {
  const meal = state.meal;
  if (!meal?.items.length) return;
  const totals = engine.aggregate(meal.items.map((it) => ({ id: it.id, grams: it.grams })), foodById);
  fillNutritionCard(CARD_NODES(), totals.nutrients, {
    confText: `plate total · ${meal.items.length} item${meal.items.length > 1 ? 's' : ''}`,
  });
}

// ---------------------------------------------------------------------------
// Save the photo analysis into the diary
// ---------------------------------------------------------------------------
$('btn-save').onclick = async () => {
  const thumb = await makeThumb(state.raw);
  const slot = $('save-slot').value;
  const date = diaryDate();
  if (state.meal) {
    // Each detected dish becomes its own diary line: that is what makes them
    // individually editable, swappable and deletable afterwards.
    for (const [i, it] of state.meal.items.entries()) {
      const f = foodById(it.id);
      const r = nutrientsFor(f, it.grams);
      await saveMeal(makeEntry({
        foodId: it.id, foodName: f.name, brand: f.brand, date, slot,
        servingLabel: 'measured portion', servingGrams: it.grams, servings: 1,
        nutrients: r.nutrients, source: 'photo', thumb: i === 0 ? thumb : null, ts: Date.now() + i,
      }));
    }
    toast(`${state.meal.items.length} items added to ${slot}`);
  } else {
    const id = state.selectedId;
    const grams = currentGrams();
    const f = foodById(id);
    const r = nutrientsFor(f, grams);
    await saveMeal(makeEntry({
      foodId: id, foodName: f.name, brand: f.brand, date, slot,
      servingLabel: state.servingLabel ?? 'measured portion', servingGrams: grams, servings: 1,
      nutrients: r.nutrients, source: 'photo', thumb, ts: Date.now(),
    }));
    toast(`${f.name} added to ${slot}`);
  }
  pendingSlot = null;
  emit('diary', { date });
  $('btn-save').textContent = '✓ Added';
  setTimeout(() => { $('btn-save').textContent = '💾 Add to diary'; }, 1600);
  renderRecent();
};

function makeThumb(raw) {
  const c = document.createElement('canvas');
  const s = 320 / Math.max(raw.width, raw.height);
  c.width = Math.round(raw.width * s); c.height = Math.round(raw.height * s);
  const full = document.createElement('canvas');
  full.width = raw.width; full.height = raw.height;
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height), 0, 0);
  c.getContext('2d').drawImage(full, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
}

/** Recent photo entries on the capture screen. */
async function renderRecent() {
  const meals = (await listMeals(30)).filter((m) => m.thumb).slice(0, 6);
  $('recent').hidden = meals.length === 0;
  fill($('recent-list'), meals.map((m) => {
    const img = el('img', { alt: m.foodName });
    if (m.thumb) {
      const url = URL.createObjectURL(m.thumb);
      img.src = url;
      // Revoke as soon as the bitmap is decoded: this list re-renders on every
      // save and delete, and each un-revoked URL pins its blob for the session.
      img.onload = () => URL.revokeObjectURL(url);
    }
    return el('div.recent-card', {
      role: 'button', tabindex: '0',
      onclick: () => { show('diary'); renderToday(); },
    }, img, el('div.meta', null, el('b', null, m.foodName), el('span.muted', null, `${m.kcal} kcal · ${Math.round(m.grams)} g`)));
  }));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
$('setting-plate').value = String(plateCm());
$('setting-plate').onchange = (e) => { localStorage.setItem('plateCm', e.target.value); };
$('setting-theme').value = themePref();
$('setting-theme').onchange = (e) => { localStorage.setItem('theme', e.target.value); applyTheme(); };

for (const [v, label] of ACTIVITY) $('p-activity').append(el('option', { value: v }, label));
for (const [v, label] of RATE) $('p-rate').append(el('option', { value: v }, label));

const PROFILE_FIELDS = ['p-sex', 'p-age', 'p-height', 'p-weight', 'p-start-weight', 'p-goal-weight',
  'p-activity', 'p-rate', 'p-custom', 'p-water', 'p-steps', 'p-credit',
  'p-carbs', 'p-protein', 'p-fat', 'p-carbs-g', 'p-protein-g', 'p-fat-g'];

function loadProfileForm() {
  const p = getProfile();
  $('p-sex').value = p.sex;
  $('p-age').value = p.age;
  $('p-height').value = p.heightCm;
  $('p-weight').value = p.weightKg;
  $('p-start-weight').value = p.startWeightKg ?? '';
  $('p-goal-weight').value = p.goalWeightKg ?? '';
  $('p-activity').value = String(p.activity);
  $('p-rate').value = String(p.rateKgWeek);
  $('p-custom').value = p.customKcal ?? '';
  $('p-water').value = p.waterGoal;
  $('p-steps').value = p.stepGoal;
  $('p-credit').checked = p.creditExercise;
  $('p-carbs').value = p.macroPct.carbs;
  $('p-protein').value = p.macroPct.protein;
  $('p-fat').value = p.macroPct.fat;
  const goal = dailyGoal(p);
  $('p-carbs-g').value = p.macroG.carbs ?? goal.macros.carbs;
  $('p-protein-g').value = p.macroG.protein ?? goal.macros.protein;
  $('p-fat-g').value = p.macroG.fat ?? goal.macros.fat;
  setMacroMode(p.macroMode, { save: false });
  renderGoalSummary();
}

function setMacroMode(mode, { save = true } = {}) {
  $('macro-percent-fields').hidden = mode !== 'percent';
  $('macro-gram-fields').hidden = mode !== 'grams';
  $('p-mode-percent').classList.toggle('active', mode === 'percent');
  $('p-mode-grams').classList.toggle('active', mode === 'grams');
  if (save) { setProfile({ macroMode: mode }); renderGoalSummary(); emit('profile'); }
}
$('p-mode-percent').onclick = () => setMacroMode('percent');
$('p-mode-grams').onclick = () => setMacroMode('grams');

function renderGoalSummary() {
  const p = getProfile();
  const g = dailyGoal(p);
  const notes = [];
  if (g.floored) notes.push(`⚠️ raised to the ${1200} kcal minimum`);
  if (p.macroMode === 'percent' && macroPctSum(p) !== 100) notes.push('⚠️ macro percentages must add up to 100');
  if (p.macroMode === 'grams') {
    const implied = macroKcal(g.macros);
    if (Math.abs(implied - g.kcal) > 50) notes.push(`⚠️ these grams are ${implied.toLocaleString()} kcal, not ${g.kcal.toLocaleString()}`);
  }
  fill($('goal-summary'),
    el('span', null, `Maintenance ≈ ${g.tdee.toLocaleString()} kcal · daily goal `),
    el('b', null, g.kcal.toLocaleString()),
    el('span', null, ` kcal (${g.source === 'custom' ? 'manual override' : 'computed'}) · targets C ${g.macros.carbs} g / P ${g.macros.protein} g / F ${g.macros.fat} g`),
    notes.length ? el('span.warn-text', null, ` — ${notes.join(' · ')}`) : null);
}

function saveProfileForm() {
  const num = (id) => (($(id).value ?? '') === '' ? null : Number($(id).value));
  setProfile({
    sex: $('p-sex').value,
    age: num('p-age') ?? 30,
    heightCm: num('p-height') ?? 170,
    weightKg: num('p-weight') ?? 70,
    startWeightKg: num('p-start-weight'),
    goalWeightKg: num('p-goal-weight'),
    activity: Number($('p-activity').value),
    rateKgWeek: Number($('p-rate').value),
    customKcal: num('p-custom'),
    waterGoal: Math.max(1, num('p-water') ?? 8),
    stepGoal: Math.max(1000, num('p-steps') ?? 10000),
    creditExercise: $('p-credit').checked,
    macroPct: { carbs: num('p-carbs') ?? 50, protein: num('p-protein') ?? 20, fat: num('p-fat') ?? 30 },
    macroG: { carbs: num('p-carbs-g'), protein: num('p-protein-g'), fat: num('p-fat-g') },
  });
  renderGoalSummary();
  emit('profile');
}
for (const id of PROFILE_FIELDS) $(id).addEventListener('change', saveProfileForm);
loadProfileForm();

async function refreshStorageStatus() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    $('storage-status').textContent = `Using ${(usage / 1e6).toFixed(0)} MB of ${(quota / 1e9).toFixed(1)} GB available.`;
  } catch { $('storage-status').textContent = ''; }
}

/** Diary export — a real file, written locally, no upload anywhere. */
async function exportDiary() {
  await dataReady;
  const entries = (await listMeals(20000)).map(normalizeEntry);
  if (!entries.length) { toast('Nothing logged yet'); return; }
  const csv = toCSV(entries, engine.db.nutrients);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = el('a', { href: url, download: `nutrilens-diary-${dateKey()}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`${entries.length} entries exported`);
}
$('btn-export').onclick = exportDiary;
$('more-export').onclick = exportDiary;

const PREFETCH_URLS = [
  '/models/swin-food101/onnx/model_int8.onnx',
  '/models/swin-food101/config.json',
  '/models/mobileclip-s2/onnx/vision_model_fp16.onnx',
  '/models/slimsam/onnx/vision_encoder_quantized.onnx',
  '/models/slimsam/onnx/prompt_encoder_mask_decoder_quantized.onnx',
  '/data/nutrition-db.json', '/data/vocabulary.json',
  '/data/label-embeddings.json', '/data/label-embeddings.bin',
];

/**
 * Download-and-cache all model assets into Cache Storage, directly from the
 * page. Deliberately NOT delegated to the service worker: SWs are terminated
 * by the browser mid-download on ~100 MB files, and page-side caching also
 * works on the very first visit before the SW controls the page.
 */
let prefetchRun = null;
function swPrefetch(onProgress) {
  prefetchRun ??= (async () => {
    try {
      for (let i = 0; i < PREFETCH_URLS.length; i++) {
        await loadModelBytes(PREFETCH_URLS[i], (loaded, total) => {
          onProgress?.((i + (total ? loaded / total : 0)) / PREFETCH_URLS.length);
        });
        onProgress?.((i + 1) / PREFETCH_URLS.length);
      }
    } finally {
      prefetchRun = null;
    }
  })();
  return prefetchRun;
}

$('btn-prefetch').onclick = async () => {
  const prog = $('prefetch-progress');
  prog.hidden = false;
  $('btn-prefetch').disabled = true;
  $('btn-prefetch').textContent = 'Downloading models…';
  try {
    await swPrefetch((p) => { prog.value = p; });
    $('btn-prefetch').textContent = '✓ Available offline';
  } catch (err) {
    $('btn-prefetch').textContent = `Failed: ${err.message} — retry`;
    $('btn-prefetch').disabled = false;
  }
  refreshStorageStatus();
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const RENDERERS = {
  diary: renderToday,
  nutrition: renderNutrition,
  progress: renderProgress,
  myfoods: renderMyFoods,
  home: renderRecent,
  settings: () => { loadProfileForm(); refreshStorageStatus(); },
};

async function goTo(name) {
  if (name !== 'barcode') closeBarcodeScanner();
  if (name !== 'camera') closeCamera();
  show(name);
  await dataReady.catch(() => {});
  await RENDERERS[name]?.();
}

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.onclick = () => goTo(btn.dataset.view);
}
$('btn-add').onclick = () => openAddMenu({ onPhoto: () => goTo('home') });
$('btn-settings').onclick = () => goTo('settings');
$('btn-back').onclick = () => goTo('home');

$('more-myfoods').onclick = () => goTo('myfoods');
$('more-photo').onclick = () => goTo('home');
$('more-barcode').onclick = () => openBarcodeScanner({ date: diaryDate(), slot: suggestSlot() });
$('more-exercise').onclick = () => openExerciseSheet({ date: diaryDate() });
$('more-weight').onclick = () => openWeightSheet();
$('more-settings').onclick = () => goTo('settings');

initBarcodeView(() => ({ date: diaryDate(), slot: suggestSlot() }));

// Keep the diary date honest across midnight and long-lived tabs.
on('diary', () => { if (view() === 'home') renderRecent(); });
addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (diaryDate() < dateKey()) { setDiaryDate(dateKey()); if (view() === 'diary') renderToday(); }
});

// First paint: the diary, because that is what a food tracker is for.
goTo('diary');

// Warm the model download in the background on a metered-friendly connection.
// Recognition needs ~180 MB, so a saveData or 2G/3G hint means wait to be asked.
const conn = navigator.connection ?? {};
const metered = conn.saveData || /^(slow-)?2g$|^3g$/.test(conn.effectiveType ?? '');
if (navigator.onLine && !metered) {
  setTimeout(() => ensureWorker().catch(() => {}), 2000);
  setTimeout(() => swPrefetch().catch(() => {}), 20000);
}
