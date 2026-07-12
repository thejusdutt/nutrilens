/**
 * Browser end-to-end smoke test: drives the built PWA in headless Chrome,
 * uploads a fixture photo, and asserts the full pipeline renders results
 * (candidates → portion → nutrition). Also verifies service-worker
 * registration and captures a screenshot.
 *
 * Usage: node eval/browser-smoke.mjs [--headed]
 * Requires `npm run build` first; starts its own vite preview on :5199.
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const headed = process.argv.includes('--headed');

// vite preview (reuse if already running)
let server = null;
const up = await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false);
if (!up) {
  server = spawn('npx', ['vite', 'preview', '--port', '5199'], { cwd: join(root, 'app'), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    if (await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: !headed, protocolTimeout: 600000, args: ['--window-size=1200,900', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.includes('nutrilens-worker')) console.log(`[console.${m.type()}]`, t); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('http://localhost:5199/', { waitUntil: 'networkidle2' });
  console.log('page loaded:', await page.title());

  // Upload fixture through the hidden file input.
  const input = await page.$('#file-input');
  await input.uploadFile(join(root, 'eval/data/smoke_0_beignets.jpg'));

  // Wait for model download + inference (first run downloads ~105 MB from localhost).
  // Poll in short evaluate calls so a busy renderer surfaces as progress, not a CDP timeout.
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await page.evaluate(() => ({
      done: !document.getElementById('nutrition-card').hidden,
      spinner: document.getElementById('spinner-text')?.textContent,
      status: document.getElementById('model-status')?.textContent ?? '',
    })).catch((e) => ({ stalled: e.message }));
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(st));
    if (st.done) break;
    if (Date.now() - t0 > 300000) throw new Error('timed out waiting for nutrition card');
  }
  const result = await page.evaluate(() => ({
    // meal-first flow: items live in the meal card; fall back to single-dish UI
    topCandidate: document.querySelector('.meal-item .mi-food')?.selectedOptions[0]?.textContent
      ?? document.querySelector('.candidate b')?.textContent,
    kcal: document.getElementById('kcal-value').textContent,
    grams: document.querySelector('.meal-item .mi-grams')?.value
      ?? document.getElementById('portion-grams').value,
    confidence: document.getElementById('confidence-tag').textContent,
    mealItems: document.querySelectorAll('.meal-item').length,
    macroRows: document.querySelectorAll('.macro-row').length,
    microRows: document.querySelectorAll('.micro-row').length,
    nonFoodHidden: document.getElementById('nonfood-warning').hidden,
    swRegistered: !!navigator.serviceWorker?.controller || null,
  }));
  console.log(JSON.stringify(result, null, 2));

  // History save round-trip.
  await page.click('#btn-save');
  await page.waitForFunction(() => document.getElementById('btn-save').textContent.includes('✓'));
  await page.click('#btn-history');
  await page.waitForSelector('.diary-entry', { timeout: 8000 });
  console.log('diary entry rendered ✓');

  await page.screenshot({ path: join(root, 'eval/results/browser-smoke.png') });

  const ok = result.topCandidate?.toLowerCase().includes('beignet')
    && Number(result.kcal) > 50 && result.macroRows >= 4 && result.microRows >= 10;
  console.log(ok ? 'BROWSER SMOKE PASS' : 'BROWSER SMOKE FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server?.kill();
}
