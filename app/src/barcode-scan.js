/**
 * Barcode scanning.
 *
 * Two decoders, in order of preference:
 *   1. BarcodeDetector — native, GPU-assisted, present on Android Chrome.
 *   2. @nutrilens/barcode — our own EAN/UPC scanline decoder, everywhere else
 *      (desktop browsers, every iOS browser). A scanner that only works on some
 *      phones is not a feature.
 *
 * Product data comes from Open Food Facts and is cached in IndexedDB on first
 * scan, so scanning the same yoghurt next week works with no network at all.
 * When a code is unknown — or the device is offline and has never seen it — the
 * flow lands on "create this food" with the barcode attached, instead of a dead
 * end.
 */
import { decodeImage, isValidBarcode, toEan13 } from '@nutrilens/barcode';
import { fromOffProduct, productUrl } from '@nutrilens/off-food';
import { $, el, fill, openSheet, closeSheet, toast, show, emit } from './ui.js';
import { rememberProduct, cachedProduct } from './foods.js';

let stream = null;
let running = false;
let detector = null;

/** Does this browser have a native detector that can read product codes? */
async function nativeDetector() {
  if (detector !== null) return detector;
  detector = false;
  try {
    if (!('BarcodeDetector' in globalThis)) return detector;
    const formats = await globalThis.BarcodeDetector.getSupportedFormats();
    const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => formats.includes(f));
    if (wanted.length) detector = new globalThis.BarcodeDetector({ formats: wanted });
  } catch { detector = false; }
  return detector;
}

/**
 * Open the scanner view and resolve the first valid code seen.
 * @param {{date:string, slot:string}} ctx
 */
export async function openBarcodeScanner(ctx) {
  closeSheet({ all: true });
  show('barcode');
  const video = $('scan-video');
  const status = $('scan-status');
  status.textContent = 'Starting camera…';

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch {
    status.textContent = 'No camera available — enter the barcode by hand.';
    openManualEntry(ctx);
    return;
  }

  const native = await nativeDetector();
  status.textContent = native ? 'Point at a barcode' : 'Point at a barcode (software decoder)';
  running = true;
  scanLoop(video, native, ctx);
}

export function closeBarcodeScanner() {
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const video = $('scan-video');
  if (video) video.srcObject = null;
}

/** Grab frames until something decodes. Sampling a crop keeps this cheap. */
async function scanLoop(video, native, ctx) {
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  let frames = 0;

  while (running) {
    await new Promise((r) => setTimeout(r, 120));
    if (!video.videoWidth) continue;
    frames++;
    let hit = null;
    try {
      if (native) {
        const codes = await native.detect(video);
        const first = codes.find((c) => isValidBarcode(c.rawValue));
        if (first) hit = { code: first.rawValue, format: first.format };
      } else {
        // Sample the middle band at a modest width: barcodes are wide and short,
        // and full-resolution frames waste time without helping the decode.
        const w = Math.min(960, video.videoWidth);
        const h = Math.round(video.videoHeight * (w / video.videoWidth) * 0.5);
        canvas.width = w; canvas.height = h;
        ctx2d.drawImage(video, 0, Math.round((video.videoHeight - h / (w / video.videoWidth)) / 2),
          video.videoWidth, Math.round(video.videoHeight * 0.5), 0, 0, w, h);
        hit = decodeImage(ctx2d.getImageData(0, 0, w, h), { rows: 25 });
      }
    } catch { /* keep scanning */ }

    if (hit) {
      if (navigator.vibrate) navigator.vibrate(40);
      closeBarcodeScanner();
      await handleCode(toEan13(hit.code), ctx);
      return;
    }
    if (frames === 60) $('scan-status').textContent = 'Still looking… try more light, or enter the number below.';
  }
}

/**
 * Resolve a code to a food: cache first (offline-proof), then Open Food Facts.
 * @param {string} barcode
 * @param {{date:string, slot:string}} ctx
 */
export async function handleCode(barcode, ctx) {
  show('home');
  const cached = await cachedProduct(barcode);
  if (cached) { openProduct(cached, barcode, ctx, 'from your device'); return; }

  if (!navigator.onLine) { openUnknown(barcode, ctx, 'You are offline and this product has not been scanned before.'); return; }

  openSheet({ title: 'Looking up…', body: el('div.stack', null, el('div.spinner'), el('p.muted', null, barcode)) });
  try {
    const res = await fetch(productUrl(barcode), { headers: { Accept: 'application/json' } });
    const json = await res.json();
    const mapped = fromOffProduct(json.product ?? json, { barcode });
    closeSheet();
    if (!mapped.ok) { openUnknown(barcode, ctx, mapped.reason); return; }
    await rememberProduct(barcode, mapped.food);
    emit('foods');
    openProduct(mapped.food, barcode, ctx, 'Open Food Facts');
  } catch (err) {
    closeSheet();
    openUnknown(barcode, ctx, `Lookup failed: ${err.message}`);
  }
}

/** Found it: show what we know, then hand over to the normal food detail sheet. */
function openProduct(foodRecord, barcode, ctx, provenance) {
  import('./logfood.js').then(({ openFoodDetail }) => {
    const per = foodRecord.per100g ?? {};
    openSheet({
      title: foodRecord.name,
      body: el('div.stack', null,
        el('div.detail-title', null,
          el('b', null, foodRecord.name),
          foodRecord.brand && el('span.muted', null, foodRecord.brand),
          el('span.muted.tiny', null, `${barcode} · ${provenance}`)),
        el('div.detail-summary', null,
          el('div.ds-kcal', null, el('b', null, Math.round(per.kcal ?? 0)), ' kcal / 100 g'),
          el('div.muted', null, `P ${Math.round(per.protein ?? 0)} · C ${Math.round(per.carbs ?? 0)} · F ${Math.round(per.fat ?? 0)} g`)),
        foodRecord.quality && foodRecord.quality.nutrientCount < 6
          && el('p.warning', null, '⚠️ This product record is sparse — check the numbers against the packet.'),
        el('button.primary.wide', {
          onclick: () => openFoodDetail({ foodId: foodRecord.id, date: ctx.date, slot: ctx.slot }),
        }, 'Choose serving and add'),
        el('button.wide', { onclick: () => openBarcodeScanner(ctx) }, 'Scan another')),
    });
  });
}

/** Not found: offer to create the food, with the barcode already attached. */
function openUnknown(barcode, ctx, reason) {
  import('./logfood.js').then(({ openCreateFood, openFoodDetail }) => {
    openSheet({
      title: 'Product not found',
      body: el('div.stack', null,
        el('p', null, `Barcode ${barcode}`),
        el('p.muted', null, reason),
        el('button.primary.wide', {
          onclick: () => openCreateFood({
            prefill: { name: '', brand: null },
            onSaved: (id) => openFoodDetail({ foodId: id, date: ctx.date, slot: ctx.slot }),
          }),
        }, 'Create it from the label'),
        el('button.wide', { onclick: () => openBarcodeScanner(ctx) }, 'Scan again'),
        el('button.wide', { onclick: () => openManualEntry(ctx) }, 'Type a barcode')),
    });
  });
}

/** Typing the digits is a legitimate way in — worn labels and no-camera desktops. */
export function openManualEntry(ctx) {
  const input = el('input', {
    type: 'text', inputmode: 'numeric', pattern: '\\d*', id: 'manual-barcode',
    placeholder: '8 to 13 digits', autocomplete: 'off',
  });
  const submit = async () => {
    const code = input.value.replace(/\D/g, '');
    if (!isValidBarcode(code)) { toast('That is not a valid barcode — check the digits'); return; }
    closeSheet({ all: true });
    await handleCode(toEan13(code), ctx);
  };
  openSheet({
    title: 'Enter barcode',
    body: el('div.stack', null,
      el('label', { for: 'manual-barcode' }, 'Barcode number'), input,
      el('button.primary.wide', { onclick: submit }, 'Look it up')),
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

/** Wire the scanner view's own controls once at startup. */
export function initBarcodeView(getContext) {
  $('scan-cancel').onclick = () => { closeBarcodeScanner(); show('home'); };
  $('scan-manual').onclick = () => { closeBarcodeScanner(); show('home'); openManualEntry(getContext()); };
}
