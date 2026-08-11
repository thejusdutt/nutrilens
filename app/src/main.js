/**
 * App shell: theme, service worker, model worker, the photo-analysis pipeline,
 * navigation and settings. The diary, nutrition, progress, exercise and
 * my-food screens live in their own modules and are wired up at the bottom.
 */
import { toRawImage, crop, ANALYSIS_SIDE } from '@nutrilens/image-preprocess';
import { overlayMask, outlineMask } from '@nutrilens/food-segmentation';
import { PortionEstimator, maskAreaInsideEllipse, MIN_PLATE_CONFIDENCE } from '@nutrilens/portion-estimator';
import { NutritionEngine } from '@nutrilens/nutrition-engine';
import { buildPlate, regionCrop } from '@nutrilens/plate-analyzer';
import { renderPlate, openAddDish, portionControl, REGION_COLORS } from './plate-ui.js';
import { makeEntry, normalizeEntry, toCSV } from '@nutrilens/diary';
import { saveMeal, listMeals, dateKey, exportBackup, restoreBackup } from './db.js';
import {
  getProfile, setProfile, dailyGoal, suggestSlot, macroPctSum, macroKcal,
  ACTIVITY, RATE,
} from './goals.js';
import {
  $, el, fill, fmt, show, view, toast, emit, on, openSheet, closeSheet,
  restoreSheetDepth, MACRO_COLORS,
} from './ui.js';
import { initFoods, food as foodById, search as searchFoods, nutrients as nutrientsFor } from './foods.js';
import { fillNutritionCard } from './nutrients-ui.js';
import { renderToday, diaryDate, setDiaryDate, openAddMenu, initTodayActions } from './today.js';
import { renderNutrition } from './nutrition-view.js';
import { renderProgress, openWeightSheet } from './progress-view.js';
import { renderMyFoods } from './myfoods.js';
import { openExerciseSheet } from './exercise-view.js';
import {
  initBarcodeView, openBarcodeScanner, closeBarcodeScanner,
  ONLINE_LOOKUP_KEY, onlineBarcodeLookupEnabled,
} from './barcode-scan.js';
import { loadModelBytes } from './model-cache.js';
import { hydrateIcons } from './icons.js';
import { confidenceLevel, confidenceNeedsReview } from './confidence.js';
import InferenceWorker from './workers/inference-worker.js?worker';

// The static markup declares its icons by name; draw them before anything else,
// so the chrome is never briefly a row of empty boxes.
hydrateIcons();

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
  // The wider dish library is a separate file so the USDA core stays small and
  // its provenance stays clean. Missing or unreadable is survivable — the app
  // just falls back to the USDA set.
  const lib = await fetch('/data/nutrition-library.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  await initFoods(engine, lib);
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
      state.imageEncoded = false;
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
  const busy = text != null;
  $('view-analyze').setAttribute('aria-busy', String(busy));
  if (!busy) { $('analyze-spinner').hidden = true; return; }
  $('spinner-text').textContent = text;
  $('analyze-spinner').hidden = false;
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
    await goTo('camera');
  } catch {
    $('file-input').setAttribute('capture', 'environment');
    $('file-input').click();
    $('file-input').removeAttribute('capture');
  }
}
function closeCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }
$('btn-camera').onclick = openCamera;
$('btn-cam-cancel').onclick = () => history.back();
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
  servingLabel: null,
  imageEncoded: false,
  meal: null,
  saveDate: null,
};

let pendingPhotoContext = null;

function beginPhotoFlow(context = {}) {
  pendingPhotoContext = {
    date: context.date || diaryDate(),
    slot: context.slot || suggestSlot(),
  };
  goTo('home');
}

function discardAnalysis() {
  state.raw = null;
  state.candidates = [];
  state.selectedId = null;
  state.seg = null;
  state.plate = null;
  state.portion = null;
  state.userGrams = null;
  state.servingLabel = null;
  state.imageEncoded = false;
  state.meal = null;
  state.saveDate = null;
  pendingPhotoContext = null;
  $('btn-resume-analysis').hidden = true;
}

async function startAnalysis(blob) {
  const context = pendingPhotoContext ?? { date: diaryDate(), slot: suggestSlot() };
  pendingPhotoContext = null;
  await goTo('analyze', { history: view() === 'camera' ? 'replace' : 'push' });
  resetResultUI();
  state.saveDate = context.date;
  $('save-slot').value = context.slot;
  setSpinner('Preparing photo…');
  state.raw = await toRawImage(blob, { fitSide: ANALYSIS_SIDE });
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
    const { result } = await rpcImage({ type: 'recognize', image: rawToMsg(state.raw), whole: true });
    state.candidates = result.top.filter((t) => engine.food(t.id));
    state.isFood = result.isFood;
    $('nonfood-warning').hidden = result.isFood;
    renderCandidates();
    // One dish, from the whole photograph. Splitting the plate into separate
    // items is offered (btn-split-plate) rather than done automatically,
    // because measured over the benchmark it invents food that is not on the
    // plate — 16 phantom dishes across 20 photos — and does so *confidently*:
    // the invented ones score 0.26–0.99 against 0.40–1.00 for the real ones, so
    // no confidence threshold can tell them apart. Reading the whole frame is
    // the stable half of the pipeline and it is what the user sees first.
    if (state.candidates.length) {
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
  node.textContent = text;
  node.hidden = false;
}

function resetResultUI() {
  fill($('candidates'));
  $('portion-card').hidden = true;
  $('nutrition-card').hidden = true;
  $('nonfood-warning').textContent = 'This does not look like food. Pick one of the guesses below, or search for it.';
  $('nonfood-warning').hidden = true;
  $('search-results').hidden = true;
  $('search-input').value = '';
  $('meal-card').hidden = true;
  $('correction').hidden = false;
  $('btn-whole-plate').disabled = false;
  $('btn-whole-plate').hidden = false;
  // Offered again for the new photo; hidden while there is no result to split.
  $('plate-offer').hidden = true;
  $('btn-split-plate').disabled = false;
  $('btn-save').textContent = 'Add to diary';
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
    'aria-pressed': c.id === state.selectedId,
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
  // There is a result to split now, so offer it — unless the plate is already
  // split, in which case the card's own rescan button is the way back.
  $('plate-offer').hidden = !!state.meal;
}

async function runPortionEstimation(point) {
  const { raw } = state;
  const foodRec = engine.food(state.selectedId);
  const prior = foodRec?.prior ?? {};
  try {
    // A tap says "this food, here", so it is worth segmenting. Without one the
    // portion is the food's typical serving and nothing is segmented at all.
    //
    // Scaling a portion by how much of the plate a mask covers was measured to
    // carry more noise than information: the mask swings up to 6.5x across
    // re-encodings of the identical photograph — changes no eye can see — and
    // the plate ellipse it is measured against moves with it. Bounding how far
    // that reading may move the answer, over the whole benchmark:
    //
    //   maxFactor   in band   mean err   mean spread   worst spread
    //   2.5 (was)     13/20      15.8%          8.1%          53.8%
    //   1.4           15/20      13.3%          7.2%          41.4%
    //   1.0 (none)    14/20      13.7%          2.1%          22.0%
    //
    // Four times steadier for one photo of accuracy, which is noise at n=20.
    // It also takes ~8 SAM prompts and the encode out of the common path, so
    // the answer arrives in about a second instead of ten.
    if (point) {
      if (!state.seg || point) {
        setSpinner(state.imageEncoded ? 'Refining portion…' : 'Measuring portion…');
        const detectPlate = !state.imageEncoded;
        const m = await rpcImage({
          type: 'segment',
          image: detectPlate ? rawToMsg(raw) : undefined,
          detectPlate,
          points: [point],
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
    } else {
      state.portion = new PortionEstimator().estimate({
        areaPx: 0, imageWidth: raw.width, imageHeight: raw.height, prior,
      });
    }
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
  // The first dish colour, not a literal: a hard-coded green here disagreed
  // with the badge the plate list draws for the same region.
  const [dish] = REGION_COLORS;
  overlayMask(seg.mask, viewImg, dish, 0.14);
  outlineMask(seg.mask, viewImg, dish, Math.max(2, Math.round(raw.width / 320)));
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
    // Same crop the automatic pass uses, from the same helper — tapping a spot
    // should not name it differently from finding it.
    const cropped = regionCrop(state.raw, region.bbox);
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
  const hits = searchFoods(q, { limit: 12 });
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
  if (state.plate && state.plate.confidence >= MIN_PLATE_CONFIDENCE && mask) {
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
  const item = { id: state.selectedId, grams: currentGrams() };
  fill($('single-portion-control'), portionControl(item, foodById(state.selectedId), (_changed, unit) => {
    state.userGrams = item.grams;
    state.servingLabel = unit?.label ?? null;
    $('portion-method').textContent = 'manual';
    $('portion-method').className = 'tag';
    $('portion-note').textContent = 'Portion set manually.';
    renderNutritionCard();
  }, { gramsId: 'portion-grams' }));
}

const CARD_NODES = () => ({
  card: $('nutrition-card'), tag: $('confidence-tag'), kcal: $('kcal-value'),
  range: $('kcal-range'), macros: $('macro-bars'), micros: $('micro-table'),
  hero: $('kcal-hero'), title: $('nutrition-title'),
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
  const level = confidenceLevel(conf);
  const kcal = r.nutrients.kcal;
  const nodes = CARD_NODES();
  nodes.title.textContent = 'Nutrition';
  fillNutritionCard(nodes, r.nutrients, {
    kcalRange: kcal && !manual && kcal.low !== kcal.high ? `(${Math.round(kcal.low)}–${Math.round(kcal.high)})` : '',
    confText: state.candidates[0]?.sources?.manual ? 'manual' : `${level} confidence · ${(conf * 100).toFixed(0)}%`,
    confWarn: confidenceNeedsReview(conf),
  });
}

// ---------------------------------------------------------------------------
// Whole-plate mode
// ---------------------------------------------------------------------------
$('btn-whole-plate').onclick = () => analyzeWholePlate();
// Same action from the single-dish view, where the plate card is not on screen
// yet and the button inside it cannot be reached.
$('btn-split-plate').onclick = () => analyzeWholePlate();
$('btn-add-dish').onclick = () => openAddDish((id) => {
  const f = foodById(id);
  state.meal.items.push({
    id, grams: f.prior?.servingG ?? 100, prob: 1,
    candidates: [{ id, name: f.name, prob: 1 }], region: null,
  });
  drawMealOverlay();
  renderMeal();
});

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

    const items = await buildPlate({
      image: state.raw,
      regions: m.regions.map((r) => ({ ...r, mask: new Uint8Array(r.mask) })),
      dominant: m.dominant ? { ...m.dominant, mask: new Uint8Array(m.dominant.mask) } : null,
      imageTop: state.candidates,
      plate: state.plate,
      classify: async (img) => (await rpcImage({ type: 'recognize', image: rawToMsg(img) })).result,
      foodById: (id) => engine.food(id),
      estimator: new PortionEstimator({ plateDiameterCm: plateCm() }),
      onProgress: (done, total) => setSpinner(`Identifying item ${Math.min(done + 1, total)} of ${total}…`),
    });
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
    // The plate is split; the offer to split it has nothing left to do. The
    // rescan button inside the plate card takes over from here.
    $('plate-offer').hidden = true;
    // Every dish name is now its own "change this" button, so the free-text
    // correction box below the list has nothing left to correct.
    $('correction').hidden = true;
    // The rescan button now lives inside the plate card as a secondary action,
    // so it stays available: a bad scan is exactly when you want to retry.
    btn.disabled = false;
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
  // Tint faintly, then outline: the point of the overlay is to show what was
  // measured, and a heavy fill hides the very food the user is checking.
  meal.items.forEach((it, i) => {
    if (!it.region) return;
    overlayMask(it.region.mask, viewImg, REGION_COLORS[i % REGION_COLORS.length], 0.14);
  });
  const stroke = Math.max(2, Math.round(raw.width / 320));
  meal.items.forEach((it, i) => {
    if (it.region) outlineMask(it.region.mask, viewImg, REGION_COLORS[i % REGION_COLORS.length], stroke);
  });
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
  renderPlate($('meal-items'), meal, {
    onChanged: ({ rerender = false } = {}) => {
      if (!meal.items.length) { resetResultUI(); drawPhoto(); return; }
      drawMealOverlay();
      if (rerender) renderMeal(); else renderMealNutrition();
    },
    reestimate: (it) => reestimateItem(it),
  });
  renderMealNutrition();
}

/** Grams for a dish the user just renamed: re-measure its mask under the new food's priors. */
function reestimateItem(it) {
  const food = foodById(it.id);
  if (!it.region) return food?.prior?.servingG ?? 100;
  return new PortionEstimator({ plateDiameterCm: plateCm() }).estimate({
    areaPx: foodAreaPx(it.region.mask, state.raw.width, state.raw.height, it.region.areaPx),
    imageWidth: state.raw.width,
    imageHeight: state.raw.height,
    plate: state.plate,
    prior: food.prior,
    dishCount: state.meal?.items.length ?? 1,
  }).grams;
}

const itemKcal = (it) => `${Math.round((foodById(it.id).per100g.kcal ?? 0) * it.grams / 100)} kcal`;

function renderMealNutrition() {
  const meal = state.meal;
  if (!meal?.items.length) return;
  const totals = engine.aggregate(meal.items.map((it) => ({ id: it.id, grams: it.grams })), foodById);
  const v = (k) => totals.nutrients[k]?.value ?? 0;

  // The summary carries the number people came for, above the detail. It
  // updates on every portion tap, so it has to be cheap to redraw.
  $('plate-kcal').textContent = fmt.kcal(v('kcal'));
  $('meal-count').textContent = `${meal.items.length} item${meal.items.length > 1 ? 's' : ''}`;
  const macros = [['Protein', 'protein'], ['Carbs', 'carbs'], ['Fat', 'fat']];
  fill($('plate-macros'), macros.map(([label, key]) => el('span.plate-macro', { style: `--macro: ${MACRO_COLORS[key]}` },
    el('b', null, `${fmt.g(v(key))} g`), el('span', null, label))));

  const nodes = CARD_NODES();
  nodes.title.textContent = 'Full breakdown';
  fillNutritionCard(nodes, totals.nutrients, { hero: false, confText: 'every nutrient on this plate' });
}

// ---------------------------------------------------------------------------
// Save the photo analysis into the diary
// ---------------------------------------------------------------------------
$('btn-save').onclick = async () => {
  const thumb = await makeThumb(state.raw);
  const slot = $('save-slot').value;
  const date = state.saveDate ?? diaryDate();
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
  state.saveDate = date;
  emit('diary', { date });
  $('btn-save').textContent = 'Added';
  setTimeout(() => { $('btn-save').textContent = 'Add to diary'; }, 1600);
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
    return el('button.recent-card', {
      onclick: () => goTo('diary', { history: 'replace' }),
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
  if (g.floored) notes.push(`raised to the ${1200} kcal minimum`);
  if (p.macroMode === 'percent' && macroPctSum(p) !== 100) notes.push('macro percentages must add up to 100');
  if (p.macroMode === 'grams') {
    const implied = macroKcal(g.macros);
    if (Math.abs(implied - g.kcal) > 50) notes.push(`these grams are ${implied.toLocaleString()} kcal, not ${g.kcal.toLocaleString()}`);
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
    const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? Promise.resolve(false),
    ]);
    const quotaText = quota ? `${(quota / 1e9).toFixed(1)} GB available` : 'browser-managed storage';
    $('storage-status').textContent = `Using ${(usage / 1e6).toFixed(0)} MB of ${quotaText}. ${persisted ? 'Protected from automatic cleanup.' : 'The browser may clear it under storage pressure.'}`;
  } catch { $('storage-status').textContent = 'Storage status is unavailable in this browser.'; }
}

function downloadFile(contents, type, filename) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Diary CSV — a readable report, not a restorable backup. */
async function exportDiary() {
  await dataReady;
  const entries = (await listMeals(20000)).map(normalizeEntry);
  if (!entries.length) { toast('Nothing logged yet'); return; }
  downloadFile(toCSV(entries, engine.db.nutrients), 'text/csv', `nutrilens-diary-${dateKey()}.csv`);
  toast(`${entries.length} entries exported`);
}
$('btn-export').onclick = exportDiary;
$('more-export').onclick = exportDiary;

const BACKUP_PREFS = ['theme', 'plateCm', 'profile', ONLINE_LOOKUP_KEY];
$('btn-backup').onclick = async () => {
  try {
    const preferences = Object.fromEntries(BACKUP_PREFS.map((key) => [key, localStorage.getItem(key)]));
    const backup = await exportBackup(preferences);
    downloadFile(JSON.stringify(backup), 'application/json', `nutrilens-backup-${dateKey()}.json`);
    toast('Full backup exported');
  } catch (err) { toast(`Backup failed: ${err.message}`, { ms: 5000 }); }
};
$('btn-restore').onclick = () => $('restore-file').click();
$('restore-file').onchange = async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  let text;
  try { text = await file.text(); } catch { toast('Could not read that backup'); return; }
  openSheet({
    title: 'Replace all local data?',
    body: el('div.stack', null,
      el('p', null, 'Restoring replaces this device’s diary, foods, measurements, cached products and supported preferences.'),
      el('p.warning', null, 'Export a current backup first if you may need it.'),
      el('button.danger.wide', {
        onclick: async () => {
          try {
            const backup = await restoreBackup(text);
            for (const key of BACKUP_PREFS) {
              const value = backup.preferences[key];
              if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value);
            }
            closeSheet({ all: true });
            location.reload();
          } catch (err) { toast(`Restore failed: ${err.message}`, { ms: 6000 }); }
        },
      }, 'Replace and restore'),
      el('button.wide', { onclick: () => closeSheet() }, 'Cancel')),
  });
};

$('setting-barcode-online').checked = onlineBarcodeLookupEnabled();
$('setting-barcode-online').onchange = (event) => {
  localStorage.setItem(ONLINE_LOOKUP_KEY, String(event.target.checked));
};

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
    await navigator.storage.persist?.().catch(() => false);
    await swPrefetch((p) => { prog.value = p; });
    $('btn-prefetch').textContent = 'Available offline';
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

async function goTo(name, { history: historyMode = 'push' } = {}) {
  if (name !== 'barcode') closeBarcodeScanner();
  if (name !== 'camera') closeCamera();
  show(name, { history: historyMode });
  $('btn-resume-analysis').hidden = !state.raw || name === 'analyze';
  await dataReady.catch(() => {});
  await RENDERERS[name]?.();
}

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.onclick = () => goTo(btn.dataset.view, { history: 'replace' });
}
initTodayActions({
  navigate: goTo,
  startPhoto: beginPhotoFlow,
  startBarcode: openBarcodeScanner,
});

$('btn-add').onclick = () => openAddMenu();
$('btn-settings').onclick = () => goTo('settings');
$('btn-back').onclick = () => { discardAnalysis(); goTo('home', { history: 'replace' }); };
$('btn-resume-analysis').onclick = () => goTo('analyze');

$('more-myfoods').onclick = () => goTo('myfoods');
$('more-photo').onclick = () => beginPhotoFlow({ date: diaryDate(), slot: suggestSlot() });
$('more-barcode').onclick = () => openBarcodeScanner({ date: diaryDate(), slot: suggestSlot() });
$('more-exercise').onclick = () => openExerciseSheet({ date: diaryDate() });
$('more-weight').onclick = () => openWeightSheet();
$('more-settings').onclick = () => goTo('settings');

initBarcodeView(() => ({ date: diaryDate(), slot: suggestSlot() }), goTo);

addEventListener('popstate', (event) => {
  const targetDepth = event.state?.sheetDepth ?? 0;
  if (restoreSheetDepth(targetDepth)) return;
  const target = event.state?.view;
  if (target) goTo(target, { history: 'none' });
});

// Keep the diary date honest across midnight and long-lived tabs.
on('diary', () => { if (view() === 'home') renderRecent(); });
addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (diaryDate() < dateKey()) { setDiaryDate(dateKey()); if (view() === 'diary') renderToday(); }
});

// First paint: the diary, because that is what a food tracker is for. Models are
// loaded only when analysis starts or the user explicitly downloads them.
goTo('diary', { history: 'replace' });
