/** NutriLens app shell: capture → recognize → portion → nutrition → history. */
import { toRawImage, crop } from '@nutrilens/image-preprocess';
import { overlayMask } from '@nutrilens/food-segmentation';
import { PortionEstimator } from '@nutrilens/portion-estimator';
import { NutritionEngine } from '@nutrilens/nutrition-engine';
import { saveMeal, listMeals, deleteMeal } from './db.js';
import InferenceWorker from './workers/inference-worker.js?worker';

const $ = (id) => document.getElementById(id);
const views = ['home', 'camera', 'analyze', 'history', 'settings'];
const show = (name) => views.forEach((v) => { $(`view-${v}`).hidden = v !== name; });

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
let vocabById = new Map();
const dataReady = (async () => {
  const [db, vocab] = await Promise.all([
    fetch('/data/nutrition-db.json').then((r) => r.json()),
    fetch('/data/vocabulary.json').then((r) => r.json()),
  ]);
  engine = new NutritionEngine(db);
  vocabById = new Map(vocab.map((v) => [v.id, v]));
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
        reject(new Error(m.message));
      } else if (pending.has(m.id)) {
        const { resolve: res, reject: rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.type === 'error') rej(new Error(m.message)); else res(m);
      }
    };
    worker.onerror = (e) => reject(new Error(e.message));
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

const rawToMsg = (raw) => ({ data: raw.data.buffer.slice(0), width: raw.width, height: raw.height });

function setModelStatus(text, pct) {
  const el = $('model-status');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '';
  const p = document.createElement('div');
  p.textContent = text;
  el.append(p);
  if (pct != null) {
    const prog = document.createElement('progress');
    prog.max = 1; prog.value = pct;
    el.append(prog);
  }
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
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (f) startAnalysis(f);
});
dz.addEventListener('click', (e) => { if (e.target === dz || e.target.closest('.drop-inner') === e.target) $('file-input').click(); });
addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (f) startAnalysis(f);
});

// Camera
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
  raw: null,          // full RawImage
  candidates: [],     // fused top list
  isFood: true,
  selectedId: null,
  seg: null,          // { mask:Uint8Array, areaPx, width, height }
  plate: null,
  portion: null,      // { grams, low, high, method }
  userGrams: null,    // manual override
  imageEncoded: false,
  meal: null,         // whole-plate mode: { items: [{id, grams, prob, candidates, region}] }
};

async function startAnalysis(blob) {
  show('analyze');
  resetResultUI();
  setSpinner('Preparing photo…');
  state.raw = await toRawImage(blob, { maxSide: 1280 });
  state.userGrams = null;
  state.imageEncoded = false;
  drawPhoto();
  try {
    setSpinner('Loading models…');
    await Promise.all([ensureWorker(), dataReady]);
    setSpinner('Identifying food…');
    const { result } = await rpc({ type: 'recognize', image: rawToMsg(state.raw) });
    state.candidates = result.top.filter((t) => engine.food(t.id));
    state.isFood = result.isFood;
    $('nonfood-warning').hidden = result.isFood;
    renderCandidates();
    if (state.candidates.length) await selectFood(state.candidates[0].id, { fromAuto: true });
    setSpinner(null);
  } catch (err) {
    setSpinner(null);
    showError(`Analysis failed: ${err.message}`);
    console.error(err);
  }
}

function showError(text) {
  const el = $('nonfood-warning');
  el.textContent = `⚠️ ${text}`;
  el.hidden = false;
}

function resetResultUI() {
  $('candidates').innerHTML = '';
  $('portion-card').hidden = true;
  $('nutrition-card').hidden = true;
  $('nonfood-warning').hidden = true;
  $('search-results').hidden = true;
  $('search-input').value = '';
  $('meal-card').hidden = true;
  $('btn-whole-plate').disabled = false;
  $('btn-whole-plate').hidden = false;
  $('btn-whole-plate').textContent = '🍱 Analyze whole plate (all items)';
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
  const box = $('candidates');
  box.innerHTML = '';
  for (const c of state.candidates.slice(0, 5)) {
    const btn = document.createElement('button');
    btn.className = 'candidate' + (c.id === state.selectedId ? ' selected' : '');
    btn.innerHTML = `<b>${engine.food(c.id)?.name ?? c.name}</b><span class="pct">${(c.prob * 100).toFixed(0)}%</span>
      <span class="conf-track"><span class="conf-fill" style="width:${Math.min(100, c.prob * 100)}%"></span></span>`;
    btn.onclick = () => selectFood(c.id);
    box.append(btn);
  }
}

async function selectFood(id, { fromAuto = false, point = null } = {}) {
  state.selectedId = id;
  renderCandidates();
  await runPortionEstimation(point);
  renderNutrition();
}

async function runPortionEstimation(point) {
  const { raw } = state;
  const food = engine.food(state.selectedId);
  const prior = food?.prior ?? {};
  try {
    if (!state.seg || point) {
      setSpinner(state.imageEncoded ? 'Refining portion…' : 'Measuring portion…');
      const pts = [point ?? { x: raw.width / 2, y: raw.height / 2 }];
      const m = await rpc({
        type: 'segment',
        image: state.imageEncoded ? undefined : rawToMsg(raw),
        detectPlate: !state.imageEncoded,
        points: pts,
      });
      state.imageEncoded = true;
      if (m.plate) state.plate = m.plate;
      state.seg = { mask: new Uint8Array(m.mask), areaPx: m.areaPx, width: m.width, height: m.height, iou: m.iou };
      drawOverlay();
    }
    const estimator = new PortionEstimator({ plateDiameterCm: Number(localStorage.getItem('plateCm') ?? 26) });
    state.portion = estimator.estimate({
      areaPx: state.seg.areaPx,
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

function drawOverlay() {
  const { raw, seg } = state;
  const view = { data: new Uint8ClampedArray(raw.data), width: raw.width, height: raw.height };
  overlayMask(seg.mask, view, [46, 204, 113], 0.4);
  const octx = $('overlay-canvas').getContext('2d');
  octx.putImageData(new ImageData(view.data, raw.width, raw.height), 0, 0);
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

// Tap-to-refine: crop around the tap for re-classification + point-prompted
// mask. In whole-plate mode a tap ADDS the item under the finger to the meal.
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
    const { result } = await rpc({ type: 'recognize', image: rawToMsg(region) });
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

/** Whole-plate mode: segment + classify the tapped spot and add it as an item. */
async function addMealItemAt(x, y) {
  setSpinner('Adding that item…');
  try {
    const m = await rpc({ type: 'segment', points: [{ x, y }] }); // image already encoded
    const region = { mask: new Uint8Array(m.mask), areaPx: m.areaPx, bbox: m.bbox, iou: m.iou, point: { x, y } };
    if (!region.bbox) return;
    const b = region.bbox;
    const pad = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.15);
    const cropped = crop(state.raw, b.x0 - pad, b.y0 - pad, (b.x1 - b.x0) + 2 * pad, (b.y1 - b.y0) + 2 * pad);
    const { result } = await rpc({ type: 'recognize', image: rawToMsg(cropped) });
    const candidates = result.top.filter((t) => engine.food(t.id));
    if (!candidates.length) return;
    const estimator = new PortionEstimator({ plateDiameterCm: Number(localStorage.getItem('plateCm') ?? 26) });
    const est = estimator.estimate({
      areaPx: region.areaPx, imageWidth: state.raw.width, imageHeight: state.raw.height,
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

// Manual correction search
$('search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  const box = $('search-results');
  if (q.length < 2) { box.hidden = true; return; }
  const hits = engine.search(q);
  box.innerHTML = '';
  box.hidden = hits.length === 0;
  for (const h of hits) {
    const b = document.createElement('button');
    b.textContent = h.name;
    b.onclick = () => {
      box.hidden = true;
      $('search-input').value = '';
      $('nonfood-warning').hidden = true;
      if (state.meal) {
        // Whole-plate mode: add the searched food as a typical serving.
        const food = engine.food(h.id);
        state.meal.items.push({
          id: h.id,
          grams: food.prior?.servingG ?? 100,
          prob: 1,
          candidates: [{ id: h.id, name: h.name, prob: 1 }],
          region: null, // no mask — added manually
        });
        drawMealOverlay();
        renderMeal();
        return;
      }
      state.candidates = [{ id: h.id, name: h.name, prob: 1, sources: { manual: true } }, ...state.candidates.filter((c) => c.id !== h.id)];
      selectFood(h.id);
    };
    box.append(b);
  }
});

// ---------------------------------------------------------------------------
// Portion + nutrition rendering
// ---------------------------------------------------------------------------
function currentGrams() { return state.userGrams ?? state.portion?.grams ?? 100; }

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
    $('portion-note').textContent = `Estimated from the detected plate (${localStorage.getItem('plateCm') ?? 26} cm) and food area ≈ ${p.areaCm2} cm². Adjust if needed.`;
  } else {
    methodTag.textContent = 'typical serving';
    methodTag.className = 'tag warn';
    $('portion-note').textContent = 'No plate found for scale — showing a typical serving. Adjust to match your portion.';
  }
  const slider = $('portion-slider');
  slider.value = currentGrams();
  $('portion-grams').value = currentGrams();

  const sel = $('portion-select');
  sel.innerHTML = '<option value="">Household measures…</option>';
  for (const [label, g] of engine.portions(state.selectedId)) {
    const o = document.createElement('option');
    o.value = g;
    o.textContent = `${label} (${g} g)`;
    sel.append(o);
  }
}

$('portion-slider').addEventListener('input', (e) => {
  state.userGrams = Number(e.target.value);
  $('portion-grams').value = state.userGrams;
  $('portion-method').textContent = 'manual';
  $('portion-method').className = 'tag';
  renderNutrition();
});
$('portion-select').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.userGrams = Number(e.target.value);
  $('portion-slider').value = state.userGrams;
  $('portion-grams').value = state.userGrams;
  renderNutrition();
});

const MACRO_STYLE = [
  ['protein', '#4f8ef7'], ['carbs', '#e8a13c'], ['fat', '#e05d7b'], ['fiber', '#34a86c'], ['sugars', '#b06fd8'],
];

/** Fill the nutrition card from a nutrient table (shared by single + meal modes). */
function fillNutritionCard(nutrients, { kcalRange = '', confText, confWarn = false } = {}) {
  $('nutrition-card').hidden = false;
  const tag = $('confidence-tag');
  tag.textContent = confText ?? '';
  tag.className = confWarn ? 'tag warn' : 'tag';

  const kcal = nutrients.kcal;
  $('kcal-value').textContent = kcal ? Math.round(kcal.value) : '–';
  $('kcal-range').textContent = kcalRange;

  const bars = $('macro-bars');
  bars.innerHTML = '';
  for (const [key, color] of MACRO_STYLE) {
    const n = nutrients[key];
    if (!n) continue;
    const pct = n.pctDV != null ? Math.min(100, n.pctDV) : Math.min(100, n.value);
    const row = document.createElement('div');
    row.className = 'macro-row';
    row.innerHTML = `<span>${n.name}</span>
      <span class="bar"><span class="fill" style="width:${pct}%;background:${color}"></span></span>
      <span class="val">${n.value.toFixed(1)} ${n.unit}${n.pctDV != null ? ` · ${Math.round(n.pctDV)}%` : ''}</span>`;
    bars.append(row);
  }

  const micro = $('micro-table');
  micro.innerHTML = '';
  const macroKeys = new Set(['kcal', ...MACRO_STYLE.map(([k]) => k)]);
  for (const [key, n] of Object.entries(nutrients)) {
    if (macroKeys.has(key)) continue;
    const row = document.createElement('div');
    row.className = 'micro-row';
    const val = n.value >= 10 ? n.value.toFixed(0) : n.value.toFixed(2);
    row.innerHTML = `<span>${n.name}</span><span class="dv">${val} ${n.unit}${n.pctDV != null ? ` · ${Math.round(n.pctDV)}% DV` : ''}</span>`;
    micro.append(row);
  }
}

function renderNutrition() {
  if (state.meal) { renderMealNutrition(); return; }
  const id = state.selectedId;
  if (!id) return;
  const grams = currentGrams();
  const manual = state.userGrams != null;
  const p = state.portion ?? { grams, low: grams, high: grams };
  const portionRange = manual
    ? { grams, low: grams, high: grams }
    : { grams: p.grams, low: p.low, high: p.high };
  const r = engine.forPortionRange(id, portionRange);
  if (!r) return;

  const conf = state.candidates.find((c) => c.id === id)?.prob ?? 1;
  const level = conf >= 0.6 ? 'high' : conf >= 0.3 ? 'medium' : 'low';
  const kcal = r.nutrients.kcal;
  fillNutritionCard(r.nutrients, {
    kcalRange: kcal && !manual && kcal.low !== kcal.high ? `(${Math.round(kcal.low)}–${Math.round(kcal.high)})` : '',
    confText: state.candidates[0]?.sources?.manual ? 'manual' : `${level} confidence · ${(conf * 100).toFixed(0)}%`,
    confWarn: level === 'low',
  });
}

// ---------------------------------------------------------------------------
// Whole-plate mode: detect every item, per-item portions, meal totals
// ---------------------------------------------------------------------------
const REGION_COLORS = [
  [46, 204, 113], [79, 142, 247], [232, 161, 60], [224, 93, 123], [176, 111, 216], [52, 199, 190],
];

$('btn-whole-plate').onclick = () => analyzeWholePlate();

async function analyzeWholePlate() {
  if (!state.raw) return;
  const btn = $('btn-whole-plate');
  btn.disabled = true;
  try {
    setSpinner('Loading models…');
    await Promise.all([ensureWorker(), dataReady]); // button can be pressed before first-load finishes
    setSpinner('Finding everything on the plate…');
    const m = await rpc({
      type: 'segment-auto',
      image: state.imageEncoded ? undefined : rawToMsg(state.raw),
      detectPlate: !state.imageEncoded,
      plate: state.plate,
      width: state.raw.width,
      height: state.raw.height,
    });
    state.imageEncoded = true;
    if (m.plate) state.plate = m.plate;

    const estimator = new PortionEstimator({ plateDiameterCm: Number(localStorage.getItem('plateCm') ?? 26) });
    const items = [];
    for (let i = 0; i < m.regions.length; i++) {
      const region = { ...m.regions[i], mask: new Uint8Array(m.regions[i].mask) };
      setSpinner(`Identifying item ${i + 1} of ${m.regions.length}…`);
      // Classify a padded crop around the region so context is preserved.
      const b = region.bbox;
      const pad = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.15);
      const cropped = crop(state.raw, b.x0 - pad, b.y0 - pad, (b.x1 - b.x0) + 2 * pad, (b.y1 - b.y0) + 2 * pad);
      const { result } = await rpc({ type: 'recognize', image: rawToMsg(cropped) });
      const candidates = result.top.filter((t) => engine.food(t.id));
      if (!result.isFood || !candidates.length || candidates[0].prob < 0.18) continue; // plate rim, cutlery, shadows
      const food = engine.food(candidates[0].id);
      const est = estimator.estimate({
        areaPx: region.areaPx,
        imageWidth: state.raw.width,
        imageHeight: state.raw.height,
        plate: state.plate,
        prior: food.prior,
      });
      items.push({ id: candidates[0].id, grams: est.grams, prob: candidates[0].prob, candidates, region });
    }
    if (!items.length) {
      showError('Couldn’t isolate separate items — tap each food in the photo instead.');
      btn.disabled = false;
      return;
    }
    state.meal = { items };
    $('candidates').innerHTML = '';
    $('portion-card').hidden = true;
    $('nonfood-warning').hidden = true;
    btn.hidden = true;
    drawMealOverlay();
    renderMeal();
  } catch (err) {
    console.error(err);
    showError(`Whole-plate analysis failed: ${err.message}`);
    btn.disabled = false;
  } finally {
    setSpinner(null);
  }
}

function drawMealOverlay() {
  const { raw, meal } = state;
  const view = { data: new Uint8ClampedArray(raw.data), width: raw.width, height: raw.height };
  meal.items.forEach((it, i) => { if (it.region) overlayMask(it.region.mask, view, REGION_COLORS[i % REGION_COLORS.length], 0.38); });
  const octx = $('overlay-canvas').getContext('2d');
  octx.putImageData(new ImageData(view.data, raw.width, raw.height), 0, 0);
  const fontPx = Math.max(16, Math.round(raw.width / 40));
  octx.font = `800 ${fontPx}px system-ui`;
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  meal.items.forEach((it, i) => {
    if (!it.region?.bbox) return; // manually-added items have no mask
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
  const box = $('meal-items');
  box.innerHTML = '';
  meal.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'meal-item';
    const [r, g, b] = REGION_COLORS[i % REGION_COLORS.length];
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `rgb(${r},${g},${b})`;
    dot.textContent = i + 1;

    const sel = document.createElement('select');
    sel.className = 'mi-food';
    sel.title = `${(it.prob * 100).toFixed(0)}% confidence`;
    const seen = new Set();
    for (const c of [{ id: it.id }, ...it.candidates]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = engine.food(c.id).name;
      sel.append(o);
    }
    sel.value = it.id;
    sel.onchange = () => {
      it.id = sel.value;
      if (it.region) {
        // Re-derive grams from the same region area with the new food's priors.
        const estimator = new PortionEstimator({ plateDiameterCm: Number(localStorage.getItem('plateCm') ?? 26) });
        it.grams = estimator.estimate({
          areaPx: it.region.areaPx, imageWidth: state.raw.width, imageHeight: state.raw.height,
          plate: state.plate, prior: engine.food(it.id).prior,
        }).grams;
      } else {
        it.grams = engine.food(it.id).prior?.servingG ?? 100;
      }
      renderMeal();
    };

    const grams = document.createElement('input');
    grams.type = 'number';
    grams.className = 'mi-grams';
    grams.min = 5; grams.max = 1500; grams.step = 5;
    grams.value = it.grams;
    grams.setAttribute('aria-label', 'grams');
    grams.oninput = () => {
      it.grams = Math.max(1, Number(grams.value) || 0);
      renderMealNutrition();
      kcalEl.textContent = itemKcal(it);
    };

    const kcalEl = document.createElement('span');
    kcalEl.className = 'mi-kcal';
    kcalEl.textContent = itemKcal(it);

    const del = document.createElement('button');
    del.className = 'mi-del';
    del.title = 'Remove item';
    del.textContent = '✕';
    del.onclick = () => {
      meal.items.splice(i, 1);
      if (!meal.items.length) { resetResultUI(); drawPhoto(); return; }
      drawMealOverlay();
      renderMeal();
    };

    row.append(dot, sel, grams, kcalEl, del);
    box.append(row);
  });
  renderMealNutrition();
}

const itemKcal = (it) => `${Math.round((engine.food(it.id).per100g.kcal ?? 0) * it.grams / 100)} kcal`;

function renderMealNutrition() {
  const meal = state.meal;
  if (!meal?.items.length) return;
  const totals = engine.aggregate(meal.items.map((it) => ({ id: it.id, grams: it.grams })));
  fillNutritionCard(totals.nutrients, {
    confText: `plate total · ${meal.items.length} item${meal.items.length > 1 ? 's' : ''}`,
  });
}

// ---------------------------------------------------------------------------
// Save + history
// ---------------------------------------------------------------------------
$('btn-save').onclick = async () => {
  const thumb = await makeThumb(state.raw);
  let entry;
  if (state.meal) {
    const items = state.meal.items.map((it) => ({ id: it.id, grams: it.grams }));
    const totals = engine.aggregate(items);
    entry = {
      foodId: items[0].id,
      foodName: totals.name,
      grams: items.reduce((s, it) => s + it.grams, 0),
      kcal: Math.round(totals.nutrients.kcal?.value ?? 0),
      nutrients: Object.fromEntries(Object.entries(totals.nutrients).map(([k, n]) => [k, +n.value.toFixed(2)])),
      items,
    };
  } else {
    const id = state.selectedId;
    const grams = currentGrams();
    const r = engine.forPortion(id, grams);
    entry = {
      foodId: id,
      foodName: r.name,
      grams,
      kcal: Math.round(r.nutrients.kcal?.value ?? 0),
      nutrients: Object.fromEntries(Object.entries(r.nutrients).map(([k, n]) => [k, +n.value.toFixed(2)])),
    };
  }
  await saveMeal({ ...entry, thumb, ts: Date.now() });
  $('btn-save').textContent = '✓ Saved';
  setTimeout(() => { $('btn-save').textContent = '💾 Save to history'; }, 1600);
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

async function renderRecent() {
  const meals = await listMeals(6);
  $('recent').hidden = meals.length === 0;
  const list = $('recent-list');
  list.innerHTML = '';
  for (const m of meals) {
    const card = document.createElement('div');
    card.className = 'recent-card';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(m.thumb);
    img.alt = m.foodName;
    card.append(img);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b>${m.foodName}</b><span class="muted">${m.kcal} kcal · ${m.grams} g</span>`;
    card.append(meta);
    card.onclick = () => openHistory();
    list.append(card);
  }
}

async function openHistory() {
  show('history');
  const meals = await listMeals();
  const today = new Date().toDateString();
  const todayKcal = meals.filter((m) => new Date(m.ts).toDateString() === today).reduce((s, m) => s + m.kcal, 0);
  $('history-summary').textContent = meals.length
    ? `${meals.length} meals logged · ${todayKcal} kcal today`
    : 'Nothing logged yet — analyze a photo and hit Save.';
  const list = $('history-list');
  list.innerHTML = '';
  for (const m of meals) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(m.thumb);
    img.alt = m.foodName;
    const meta = document.createElement('div');
    meta.className = 'hi-meta';
    meta.innerHTML = `<b>${m.foodName}</b><span class="muted">${new Date(m.ts).toLocaleString()} · ${m.grams} g · P ${m.nutrients.protein ?? 0} g · C ${m.nutrients.carbs ?? 0} g · F ${m.nutrients.fat ?? 0} g</span>`;
    const right = document.createElement('div');
    right.innerHTML = `<div class="hi-kcal">${m.kcal} kcal</div>`;
    const del = document.createElement('button');
    del.className = 'hi-del';
    del.textContent = '🗑';
    del.title = 'Delete';
    del.onclick = async () => { await deleteMeal(m.id); openHistory(); renderRecent(); };
    right.append(del);
    item.append(img, meta, right);
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
$('setting-plate').value = localStorage.getItem('plateCm') ?? '26';
$('setting-plate').onchange = (e) => localStorage.setItem('plateCm', e.target.value);
$('setting-theme').value = themePref();
$('setting-theme').onchange = (e) => { localStorage.setItem('theme', e.target.value); applyTheme(); };

async function refreshStorageStatus() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    $('storage-status').textContent = `Using ${(usage / 1e6).toFixed(0)} MB of ${(quota / 1e9).toFixed(1)} GB available.`;
  } catch { $('storage-status').textContent = ''; }
}

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
 * works on the very first visit before the SW controls the page. Idempotent
 * (cache-first) and deduplicated against concurrent calls.
 */
let prefetchRun = null;
function swPrefetch(onProgress) {
  prefetchRun ??= (async () => {
    try {
      const cache = await caches.open('nutrilens-models-v1'); // must match sw.js MODEL_CACHE
      for (let i = 0; i < PREFETCH_URLS.length; i++) {
        const url = PREFETCH_URLS[i];
        if (!(await cache.match(url))) {
          // Manifest first, validated (mirrors the inference worker): hosts
          // with per-file caps (Cloudflare Pages: 25 MiB) serve big models as
          // .pNN parts, and SPA-mode hosts answer missing paths with
          // index.html + 200, so 404-based detection is unreliable.
          // no-store: skip the HTTP disk cache (fails on ~100 MB bodies);
          // Cache Storage below is our persistence layer.
          let manifest = null;
          try {
            const mres = await fetch(`${url}.manifest.json`, { cache: 'no-store' });
            if (mres.ok) {
              const m = await mres.json();
              if (Number.isInteger(m.parts) && Number.isInteger(m.size)) manifest = m;
            }
          } catch { /* whole-file host */ }
          let body;
          if (manifest) {
            const buf = new Uint8Array(manifest.size);
            let off = 0;
            for (let p = 0; p < manifest.parts; p++) {
              const pres = await fetch(`${url}.p${String(p).padStart(2, '0')}`, { cache: 'no-store' });
              if (!pres.ok) throw new Error(`${url} part ${p}: HTTP ${pres.status}`);
              const chunk = new Uint8Array(await pres.arrayBuffer());
              buf.set(chunk, off);
              off += chunk.length;
              onProgress?.((i + off / manifest.size) / PREFETCH_URLS.length);
            }
            body = buf.buffer;
          } else {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
            // Buffer before put(): streaming put can fail on large bodies
            // served without Content-Length (compressed static hosts).
            body = await res.arrayBuffer();
          }
          await cache.put(url, new Response(body, {
            headers: { 'Content-Type': 'application/octet-stream' },
          }));
        }
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
$('btn-history').onclick = openHistory;
$('btn-settings').onclick = () => { refreshStorageStatus(); show('settings'); };
$('btn-back').onclick = () => { show('home'); renderRecent(); };
$('btn-back-history').onclick = () => { show('home'); renderRecent(); };
$('btn-back-settings').onclick = () => show('home');

show('home');
renderRecent();
// Warm the model download in the background on first visit (non-blocking),
// and make sure the SW model cache is populated for offline use even when
// this page wasn't yet controlled by the SW (very first visit).
if (navigator.onLine) {
  setTimeout(() => ensureWorker().catch(() => {}), 800);
  setTimeout(() => swPrefetch().catch(() => {}), 20000);
}
