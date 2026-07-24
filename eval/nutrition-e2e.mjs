/**
 * End-to-end nutrition exactness: drives the built PWA in headless Chrome and
 * checks that every number it renders — calories, each macro bar, each
 * micronutrient row, %DV, plate totals, diary totals — matches a value computed
 * independently here from app/public/data/nutrition-db.json.
 *
 * The oracle deliberately does NOT use @nutrilens/nutrition-engine: it
 * re-implements the arithmetic and the display formatting from the database, so
 * an engine bug and a rendering bug both show up as a mismatch.
 *
 * Covered:
 *   A. single food, slider grams + household measures — a range of cuisines
 *   B. multi-item plate totals (whole-plate mode, items edited by hand)
 *   C. diary: saved entry, per-slot totals, Goal − Food + Exercise = Remaining
 *
 * Usage: node eval/nutrition-e2e.mjs [--headed]   (requires `npm run build`)
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const headed = process.argv.includes('--headed');
const db = JSON.parse(readFileSync(join(root, 'app/public/data/nutrition-db.json'), 'utf8'));

// Foods spanning cuisines, densities and macro profiles (incl. near-zero kcal).
const FOODS = [
  'plain-rice', 'pizza', 'banana', 'bacon', 'coffee', 'biryani', 'dosa',
  'sushi', 'gazpacho', 'general-tso-chicken', 'chocolate-cake', 'avocado',
];
const MACRO_ORDER = ['protein', 'carbs', 'fat', 'fiber', 'sugars'];
const MACRO_KEYS = new Set(['kcal', ...MACRO_ORDER]);

// --------------------------------------------------------------------------
// Oracle: nutrients for `grams` of a food, formatted the way the UI formats.
// --------------------------------------------------------------------------
function expected(foodId, grams) {
  const f = db.foods[foodId];
  if (!f) throw new Error(`unknown food ${foodId}`);
  const rows = [];
  // Scale as `per100g × (grams/100)`, the order the engine uses. Not pedantry:
  // `0.55 * 150 / 100` and `0.55 * 1.5` differ by one ULP, which is enough to
  // tip toFixed(2) at a …5 boundary (0.82 vs 0.83 mg of iron).
  const factor = grams / 100;
  for (const [key, per100] of Object.entries(f.per100g)) {
    const meta = db.nutrients[key];
    if (!meta) continue;
    const value = per100 * factor;
    rows.push({ key, value, unit: meta.unit, name: meta.name, pctDV: meta.rdi ? value / meta.rdi * 100 : null });
  }
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  const dv = (n, suffix) => (n.pctDV != null ? ` · ${Math.round(n.pctDV)}%${suffix}` : '');
  return {
    kcal: byKey.kcal ? String(Math.round(byKey.kcal.value)) : '–',
    macros: MACRO_ORDER.filter((k) => byKey[k]).map((k) => ({
      name: byKey[k].name,
      val: `${byKey[k].value.toFixed(1)} ${byKey[k].unit}${dv(byKey[k], '')}`,
    })),
    micros: rows.filter((r) => !MACRO_KEYS.has(r.key)).map((r) => ({
      name: r.name,
      val: `${r.value >= 10 ? r.value.toFixed(0) : r.value.toFixed(2)} ${r.unit}${dv(r, ' DV')}`,
    })),
  };
}

/** Totals for a multi-item plate, formatted like the meal card. */
function expectedPlate(items) {
  const acc = {};
  for (const { id, grams } of items) {
    const factor = grams / 100; // same order as forPortion (see expected())
    for (const [key, per100] of Object.entries(db.foods[id].per100g)) {
      if (!db.nutrients[key]) continue;
      acc[key] = (acc[key] ?? 0) + per100 * factor;
    }
  }
  const dv = (key, v, suffix) => {
    const { rdi } = db.nutrients[key];
    return rdi ? ` · ${Math.round(v / rdi * 100)}%${suffix}` : '';
  };
  // Key order follows the first item that introduces each key (engine.aggregate).
  const order = [];
  for (const { id } of items) for (const k of Object.keys(db.foods[id].per100g)) if (db.nutrients[k] && !order.includes(k)) order.push(k);
  return {
    kcal: String(Math.round(acc.kcal ?? 0)),
    macros: MACRO_ORDER.filter((k) => acc[k] != null).map((k) => ({
      name: db.nutrients[k].name,
      val: `${acc[k].toFixed(1)} ${db.nutrients[k].unit}${dv(k, acc[k], '')}`,
    })),
    micros: order.filter((k) => !MACRO_KEYS.has(k)).map((k) => ({
      name: db.nutrients[k].name,
      val: `${acc[k] >= 10 ? acc[k].toFixed(0) : acc[k].toFixed(2)} ${db.nutrients[k].unit}${dv(k, acc[k], ' DV')}`,
    })),
  };
}

// --------------------------------------------------------------------------
const failures = [];
let checks = 0;
function check(label, actual, want) {
  checks++;
  const a = JSON.stringify(actual), b = JSON.stringify(want);
  if (a !== b) failures.push(`${label}\n    got  ${a}\n    want ${b}`);
}

let server = null;
if (!(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false))) {
  server = spawn('npx', ['vite', 'preview', '--port', '5199'], { cwd: join(root, 'app'), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !headed, protocolTimeout: 900000,
  args: ['--window-size=1200,900', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message.slice(0, 200)}`));

  await page.goto('http://localhost:5199/', { waitUntil: 'networkidle2' });

  // ---------------- helpers driving the app ----------------
  const waitFor = async (fn, label, ms = 420000) => {
    for (let t = 0; t < ms; t += 2000) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await page.evaluate(fn).catch(() => false)) return;
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  const analysed = () => !document.getElementById('analyze-spinner')
    || (document.getElementById('analyze-spinner').hidden
        && !document.getElementById('nutrition-card').hidden);

  const upload = async (file) => {
    const input = await page.$('#file-input');
    await input.uploadFile(join(root, 'eval/data', file));
    await waitFor(analysed, `analysis of ${file}`);
  };

  // Clicks go through the DOM, not the mouse: rows can sit outside the viewport.
  const clickIn = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel);

  /** Empty the meal card so the single-dish flow is on screen. */
  const leaveMealMode = async () => {
    for (let i = 0; i < 12; i++) {
      if (!(await clickIn('.mi-del'))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  /** Pick a food by its display name through the correction search box. */
  const pickFood = async (id) => {
    const name = db.foods[id].name;
    await page.evaluate((n) => {
      const el = document.getElementById('search-input');
      el.value = n;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, name);
    await new Promise((r) => setTimeout(r, 200));
    const clicked = await page.evaluate((n) => {
      const btn = [...document.querySelectorAll('#search-results button')].find((b) => b.textContent.trim() === n);
      if (!btn) return false;
      btn.click();
      return true;
    }, name);
    if (!clicked) throw new Error(`search did not offer "${name}"`);
    await waitFor(() => document.getElementById('analyze-spinner').hidden, `portion for ${id}`);
  };

  const setSlider = (grams) => page.evaluate((g) => {
    const s = document.getElementById('portion-slider');
    s.value = String(g);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return Number(s.value);
  }, grams);

  const readCard = () => page.evaluate(() => ({
    kcal: document.getElementById('kcal-value').textContent.trim(),
    macros: [...document.querySelectorAll('#macro-bars .macro-row')].map((r) => ({
      name: r.children[0].textContent.trim(),
      val: r.querySelector('.val').textContent.trim(),
    })),
    micros: [...document.querySelectorAll('#micro-table .micro-row')].map((r) => ({
      name: r.children[0].textContent.trim(),
      val: r.querySelector('.dv').textContent.trim(),
    })),
  }));

  // ---------------- A. single food, many portion sizes ----------------
  await upload('smoke_0_beignets.jpg');
  await leaveMealMode();

  for (const id of FOODS) {
    await pickFood(id);
    for (const grams of [10, 250, 1500]) { // slider min / mid / max, step 5
      const applied = await setSlider(grams);
      if (applied !== grams) throw new Error(`slider refused ${grams} (got ${applied})`);
      check(`${id} @ ${grams} g`, await readCard(), expected(id, grams));
    }
    // Household measure: exercises non-round gram weights straight from FNDDS.
    const measure = await page.evaluate(() => {
      const sel = document.getElementById('portion-select');
      const opt = [...sel.options].find((o) => o.value && Number(o.value) !== 100);
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { grams: Number(opt.value), label: opt.textContent };
    });
    if (measure) {
      check(`${id} @ ${measure.label}`, await readCard(), expected(id, measure.grams));
      check(`${id} grams readout`, await page.$eval('#portion-grams', (e) => e.value || e.textContent.trim()), String(measure.grams));
    }
  }
  console.log(`A. single-food rendering: ${FOODS.length} foods × 3 portions + household measures`);

  // ---------------- B. multi-item plate totals ----------------
  await clickIn('#btn-back');
  await upload('multi_plate.jpg');
  const inMeal = await page.evaluate(() => !document.getElementById('meal-card').hidden);
  if (!inMeal) throw new Error('multi_plate.jpg did not enter whole-plate mode');

  // Add two known foods, then set every item's grams to an awkward value.
  for (const id of ['plain-rice', 'dal']) await pickFood(id);
  const items = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.meal-item')];
    rows.forEach((row, i) => {
      const g = row.querySelector('.mi-grams');
      g.value = String(35 + i * 47); // 35, 82, 129, …
      g.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return rows.map((row) => ({
      id: row.querySelector('.mi-food').value,
      grams: Number(row.querySelector('.mi-grams').value),
      kcal: row.querySelector('.mi-kcal').textContent.trim(),
    }));
  });
  if (items.length < 3) throw new Error(`expected ≥3 plate items, got ${items.length}`);
  for (const it of items) {
    check(`plate item ${it.id} @ ${it.grams} g kcal`, it.kcal,
      `${Math.round((db.foods[it.id].per100g.kcal ?? 0) * it.grams / 100)} kcal`);
  }
  check(`plate total (${items.length} items)`, await readCard(), expectedPlate(items));
  console.log(`B. plate totals: ${items.length} items, per-item kcal + summed macros/micros`);

  // ---------------- C. diary arithmetic ----------------
  // Saving a plate writes one diary line per dish, so each stays editable.
  const perItemKcal = items.map((it) => Math.round((db.foods[it.id].per100g.kcal ?? 0) * it.grams / 100));
  await page.select('#save-slot', 'lunch');
  await clickIn('#btn-save');
  await new Promise((r) => setTimeout(r, 900));

  await page.evaluate(() => document.querySelector('.tab-btn[data-view="diary"]').click());
  await page.waitForSelector('.diary-entry', { timeout: 15000 });

  // Log a known food into breakfast through the normal add-food sheet, taking
  // the offered serving with the ＋ button (the one-tap path).
  await page.evaluate(() => document.querySelector('.meal-section[data-slot="breakfast"] .meal-log').click());
  await page.waitForSelector('.sheet .logfood', { timeout: 8000 });
  const offered = await page.evaluate(() => {
    const input = document.querySelector('.sheet input[type="search"]');
    input.value = 'Banana';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const row = [...document.querySelectorAll('.sheet .food-row')]
      .find((r) => r.querySelector('b')?.textContent.trim() === 'Banana');
    if (!row) return null;
    const out = { kcal: row.querySelector('.fr-kcal').textContent.trim(), serving: row.querySelector('.muted').textContent.trim() };
    row.querySelector('.fr-add').click();
    return out;
  });
  if (!offered) throw new Error('the add-food sheet did not offer Banana');
  await new Promise((r) => setTimeout(r, 1200));

  // The offered serving is the food's own first household measure.
  const [bananaLabel, bananaG] = db.foods.banana.portions[0] ?? ['100 g', 100];
  const bananaKcal = Math.round((db.foods.banana.per100g.kcal ?? 0) * bananaG / 100);
  check('offered serving', offered.serving, `1 × ${bananaLabel}`);
  check('offered calories', offered.kcal, `${bananaKcal.toLocaleString()} kcal`);

  const diary = await page.evaluate(() => ({
    goal: document.getElementById('rem-goal').textContent.replace(/[^\d-]/g, ''),
    food: document.getElementById('rem-food').textContent.replace(/[^\d-]/g, ''),
    exercise: document.getElementById('rem-exercise').textContent.replace(/[^\d-]/g, ''),
    left: document.getElementById('rem-left').textContent.replace(/[^\d-]/g, ''),
    sections: [...document.querySelectorAll('.meal-section[data-slot]')].map((s) => ({
      slot: s.dataset.slot,
      head: s.querySelector('.kcal').textContent.trim(),
      rows: [...s.querySelectorAll('.diary-entry')].map((r) => ({
        kcal: r.querySelector('.de-kcal').textContent.trim(),
        detail: r.querySelector('.de-name span').textContent.trim(),
      })),
    })),
  }));
  const kcals = diary.sections.flatMap((s) => s.rows.map((r) => Number(r.kcal.replace(/\D/g, ''))));

  check('every plate item became its own entry',
    kcals.slice().sort((a, b) => a - b),
    [...perItemKcal, bananaKcal].sort((a, b) => a - b));
  check('Food = sum of entries', Number(diary.food), kcals.reduce((s, k) => s + k, 0));
  check('Goal − Food + Exercise = Remaining',
    Number(diary.left), Number(diary.goal) - Number(diary.food) + Number(diary.exercise));
  for (const s of diary.sections) {
    const sum = s.rows.reduce((t, r) => t + Number(r.kcal.replace(/\D/g, '')), 0);
    check(`section total ${s.slot}`, s.head, sum ? `${sum.toLocaleString()} kcal` : '');
  }
  const banana = diary.sections.find((s) => s.slot === 'breakfast').rows[0];
  check('entry records the serving it was logged with', banana.detail.startsWith(`1 × ${bananaLabel}`), true);
  console.log(`C. diary: ${kcals.length} entries, per-serving detail, section totals, remaining banner`);
} finally {
  await browser.close();
  server?.kill();
}

console.log(`\n${checks} comparisons, ${failures.length} mismatch(es)`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  console.log('NUTRITION E2E FAIL');
  process.exit(1);
}
console.log('NUTRITION E2E PASS');
