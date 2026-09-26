/**
 * Browser check for the side-dish pass (packages/plate-analyzer/src/companions.js)
 * in the built PWA: the main dish appears first, then the plate card replaces it
 * with the sides that were found. Also records how long each takes, since the
 * side pass is extra work that runs after the main dish is on screen.
 *
 * Needs a build and the benchmark photos (eval/data is not in git; the web set
 * is re-fetched with `node eval/fetch-web-set.mjs`).
 *
 * Usage: node eval/sides-e2e.mjs [--headed]
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

/** photo → the side dishes it must gain (ids), or [] for "stays one dish". */
const CASES = [
  ['eval/data/smoke_0_beignets.jpg', 'Beignets', []],
  ['eval/data/web/burger-fries/3.jpg', 'Hamburger', ['French fries']],
  ['eval/data/user/masala-dosa-original.png', 'Masala dosa', ['Peanut chutney', 'Coconut chutney']],
];

let server = null;
if (!(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false))) {
  server = spawn('npx', ['vite', 'preview', '--port', '5199'], { cwd: join(root, 'app'), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const failures = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: !process.argv.includes('--headed'), protocolTimeout: 600000 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1116, height: 900 });
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message.slice(0, 300)}`));
  await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#file-input');

  for (const [file, main, sides] of CASES) {
    if (!existsSync(join(root, file))) { failures.push(`${file}: missing (fetch the benchmark photos first)`); continue; }
    const t0 = Date.now();
    await (await page.$('#file-input')).uploadFile(join(root, file));
    await page.waitForFunction(() => !document.getElementById('nutrition-card').hidden
      || !document.getElementById('meal-card').hidden, { timeout: 300000 });
    const tMain = Date.now() - t0;
    await page.waitForFunction(() => document.getElementById('sides-status').hidden, { timeout: 300000, polling: 200 });
    const tDone = Date.now() - t0;
    const got = await page.evaluate(() => (document.getElementById('meal-card').hidden
      ? [document.querySelector('.candidate.selected b')?.textContent]
      : [...document.querySelectorAll('.dish .dish-name span')].map((n) => n.textContent).filter((t) => t.trim() && t !== '⇄')));
    const ok = got[0] === main && sides.every((s) => got.includes(s)) && (sides.length || got.length === 1);
    if (!ok) failures.push(`${file}: got ${got.join(' + ')}, want ${[main, ...sides].join(' + ')}`);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${file.split('/').slice(-2).join('/').padEnd(30)} main ${String(tMain).padStart(6)} ms, `
      + `sides done ${String(tDone).padStart(6)} ms  → ${got.join(' + ')}`);
  }
} finally {
  await browser.close();
  server?.kill();
}
if (failures.length) {
  console.log(`\nSIDES E2E FAIL\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('\nSIDES E2E PASS');
}
