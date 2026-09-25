/**
 * Offline verification: proves the PWA works with zero network after first use.
 *
 * 1. Online visit → service worker installs → Settings → "Download all models"
 *    (warms the model cache through the SW).
 * 2. Force the browser fully offline (CDP network emulation).
 * 3. Reload → app shell must come from cache; upload a photo → recognition,
 *    portion and nutrition must all complete offline.
 * 4. Type a barcode → the product must resolve from the bundled table.
 *
 * Usage: node eval/offline-test.mjs   (requires `npm run build`; starts vite preview)
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

let server = null;
if (!(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false))) {
  server = spawn('npx', ['vite', 'preview', '--port', '5199'], { cwd: join(root, 'app'), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 600000 });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));

  // --- Phase 1: online, install SW, prefetch everything ---
  await page.goto('http://localhost:5199/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => navigator.serviceWorker?.ready.then(() => true), { timeout: 20000 });
  await page.click('#btn-settings');
  // The models section is a collapsed <details>: open it, then click through the
  // DOM so the test does not depend on the button being in the viewport.
  await page.evaluate(() => {
    document.getElementById('btn-prefetch').closest('details')?.setAttribute('open', '');
    document.getElementById('btn-prefetch').click();
  });
  // Wait for either terminal state, not just success: watching only for the
  // happy label means a failed download burns the full timeout and then reports
  // "waiting failed", which says nothing about what actually went wrong.
  await page.waitForFunction(
    () => /Available offline|Failed/.test(document.getElementById('btn-prefetch').textContent),
    { timeout: 300000, polling: 1000 },
  );
  const prefetch = await page.$eval('#btn-prefetch', (n) => n.textContent);
  if (!prefetch.includes('Available offline')) throw new Error(`prefetch did not finish: ${prefetch}`);
  // The barcode table is fetched in the background, not by the button.
  await page.waitForFunction(async () => {
    const cache = await caches.open('nutrilens-models-v1');
    return (await cache.keys()).some((r) => new URL(r.url).pathname.startsWith('/data/barcodes-'));
  }, { timeout: 120000, polling: 1000 });
  console.log('phase 1: models prefetched, barcode table cached, SW active ✓');

  // --- Phase 2: go fully offline, reload ---
  await page.emulateNetworkConditions({ offline: true, download: 0, upload: 0, latency: 0 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const title = await page.title();
  if (!title.includes('NutriLens')) throw new Error(`offline shell failed: title="${title}"`);
  console.log('phase 2: app shell loads offline ✓');

  // --- Phase 3: full analysis offline ---
  const input = await page.$('#file-input');
  await input.uploadFile(join(root, 'eval/data/smoke_0_beignets.jpg'));
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const done = await page.evaluate(() => !document.getElementById('nutrition-card').hidden).catch(() => false);
    if (done) break;
    if (Date.now() - t0 > 240000) throw new Error('offline analysis timed out');
  }
  // Read whichever card is on screen. The plate card's elements exist even
  // while it is hidden, so `??` cannot be used to choose between them — it
  // reported "0 kcal" here, and the test passed anyway because it only checked
  // that a dish had been named.
  const res = await page.evaluate(() => {
    const plate = document.getElementById('meal-card');
    const split = plate && !plate.hidden;
    return {
      top: split
        ? document.querySelector('.dish .dish-name span')?.textContent
        : document.querySelector('.candidate.selected b')?.textContent
          ?? document.querySelector('.candidate b')?.textContent,
      kcal: split
        ? document.getElementById('plate-kcal').textContent
        : document.getElementById('kcal-value').textContent,
    };
  });
  if (!res.top) throw new Error('offline analysis produced no named dish');
  // An offline run that reports no energy has not proven anything.
  if (!(Number(String(res.kcal).replace(/[^0-9.]/g, '')) > 0)) {
    throw new Error(`offline analysis reported ${res.kcal} kcal`);
  }
  console.log(`phase 3: offline analysis ✓ → ${res.top}, ${res.kcal} kcal`);

  // --- Phase 4: barcode offline, from the bundled table ---
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#more-barcode', { timeout: 30000 });
  await page.evaluate(() => document.querySelector('.tab-btn[data-view="more"]').click());
  await page.evaluate(() => document.getElementById('more-barcode').click());
  await page.waitForSelector('#manual-barcode', { timeout: 15000 });
  await page.evaluate(() => {
    const input = document.getElementById('manual-barcode');
    input.value = '5449000000996';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.includes('Look it up')).click();
  });
  await page.waitForSelector('.sheet .detail-summary', { timeout: 30000 });
  const sheet = await page.$eval('.sheet', (n) => n.textContent);
  if (!sheet.includes('offline database')) throw new Error(`barcode did not resolve offline: ${sheet.slice(0, 200)}`);
  console.log(`phase 4: barcode offline ✓ → ${sheet.match(/^\s*(.*?)\d{13}/)?.[1]?.slice(0, 60) ?? 'found'}`);
  console.log('OFFLINE TEST PASS');
} catch (err) {
  console.error('OFFLINE TEST FAIL:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill();
}
