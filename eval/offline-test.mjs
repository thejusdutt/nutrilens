/**
 * Offline verification: proves the PWA works with zero network after first use.
 *
 * 1. Online visit → service worker installs → Settings → "Download all models"
 *    (warms the model cache through the SW).
 * 2. Force the browser fully offline (CDP network emulation).
 * 3. Reload → app shell must come from cache; upload a photo → recognition,
 *    portion and nutrition must all complete offline.
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
  await page.waitForFunction(
    () => document.getElementById('btn-prefetch').textContent.startsWith('✓'),
    { timeout: 300000, polling: 1000 },
  );
  console.log('phase 1: models prefetched, SW active ✓');

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
  const res = await page.evaluate(() => ({
    top: document.querySelector('.meal-item .mi-food')?.selectedOptions[0]?.textContent
      ?? document.querySelector('.candidate b')?.textContent,
    kcal: document.getElementById('kcal-value').textContent,
  }));
  console.log(`phase 3: offline analysis ✓ → ${res.top}, ${res.kcal} kcal`);
  console.log('OFFLINE TEST PASS');
} catch (err) {
  console.error('OFFLINE TEST FAIL:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill();
}
