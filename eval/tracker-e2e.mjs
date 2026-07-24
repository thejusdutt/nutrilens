/**
 * End-to-end verification of the food-tracker features, driving the built PWA in
 * headless Chrome against a fresh profile (empty IndexedDB, empty localStorage).
 *
 * Every flow a food tracker is judged on:
 *   1. goals from body stats            7. barcode scan → packaged product
 *   2. log by search with servings      8. exercise, credited back
 *   3. edit a logged entry              9. water, steps, notes, complete diary
 *   4. quick add calories              10. copy a meal to another day
 *   5. custom food from a label        11. nutrition dashboard totals
 *   6. recipe divided into servings    12. weight logging and progress
 *
 * Expected numbers are computed here, independently of the app, from
 * app/public/data/nutrition-db.json and the published formulas (Mifflin-St Jeor,
 * ACSM, Atwater). The Open Food Facts response is intercepted with a fixture, so
 * the barcode path is deterministic and needs no network.
 *
 * Usage: node eval/tracker-e2e.mjs [--headed]
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

// --- oracle -----------------------------------------------------------------
const PROFILE = { sex: 'male', age: 30, heightCm: 175, weightKg: 80, activity: 1.55, rate: -0.5 };
const bmr = (p) => 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.sex === 'male' ? 5 : -161);
const tdee = Math.round(bmr(PROFILE) * PROFILE.activity);
const goalKcal = Math.max(1200, Math.round(tdee + PROFILE.rate * 7700 / 7));
const kcalOf = (id, grams) => Math.round((db.foods[id].per100g.kcal ?? 0) * (grams / 100));
const acsmNet = (met, minutes, kg) => Math.round((met - 1) * 3.5 * kg / 200 * minutes);

const OFF_FIXTURE = {
  status: 1,
  product: {
    code: '5449000000996',
    product_name: 'Coca-Cola',
    brands: 'Coca-Cola',
    serving_size: '330 ml (330 g)',
    completeness: 0.9,
    nutriments: {
      'energy-kcal_100g': 42, proteins_100g: 0, carbohydrates_100g: 10.6,
      sugars_100g: 10.6, fat_100g: 0, sodium_100g: 0.005,
    },
  },
};
const COLA_SERVING_G = 330;
const colaKcal = Math.round(OFF_FIXTURE.product.nutriments['energy-kcal_100g'] * COLA_SERVING_G / 100);

// --- harness ----------------------------------------------------------------
const failures = [];
let checks = 0;
function check(label, actual, want) {
  checks++;
  const a = JSON.stringify(actual), b = JSON.stringify(want);
  if (a !== b) failures.push(`${label}\n    got  ${a}\n    want ${b}`);
}
const near = (label, actual, want, tol = 1) => {
  checks++;
  if (Math.abs(actual - want) > tol) failures.push(`${label}\n    got  ${actual}\n    want ${want} ±${tol}`);
};

let server = null;
if (!(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false))) {
  server = spawn('npx', ['vite', 'preview', '--port', '5199'], { cwd: join(root, 'app'), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !headed, protocolTimeout: 600000,
  args: ['--window-size=520,900', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 520, height: 900 });
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });

  // Serve the Open Food Facts fixture; let everything else through.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('openfoodfacts.org')) {
      req.respond({
        status: 200,
        contentType: 'application/json',
        // The live API sends CORS headers; a synthesized reply must too, or the
        // browser blocks it and the app sees a network failure.
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(OFF_FIXTURE),
      });
    } else req.continue();
  });

  await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#today-root .cal-card', { timeout: 30000 });

  // ---- helpers -------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickIn = (sel) => page.evaluate((s) => {
    const node = document.querySelector(s);
    if (!node) throw new Error(`no element for ${s}`);
    node.click();
  }, sel);
  /** Click the first button whose visible text contains `text` (within `scope`). */
  const clickText = (text, scope = 'body') => page.evaluate((t, s) => {
    const btn = [...document.querySelectorAll(`${s} button`)]
      .find((b) => !b.disabled && b.offsetParent !== null && b.textContent.trim().includes(t));
    if (!btn) throw new Error(`no button matching "${t}"`);
    btn.click();
  }, text, scope);
  const setValue = (sel, value) => page.evaluate((s, v) => {
    const node = document.querySelector(s);
    if (!node) throw new Error(`no field for ${s}`);
    node.value = String(v);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, sel, value);
  /** Set an input identified by the text of the <label> that wraps or targets it. */
  const setByLabel = (labelText, value, scope = '.sheet') => page.evaluate((t, v, s) => {
    const label = [...document.querySelectorAll(`${s} label`)].find((l) => l.textContent.trim().startsWith(t));
    const node = label?.querySelector('input, select') ?? (label?.htmlFor ? document.getElementById(label.htmlFor) : null);
    if (!node) throw new Error(`no field labelled "${t}"`);
    node.value = String(v);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, labelText, value, scope);
  const text = (sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);
  const diary = () => page.evaluate(() => ({
    goal: Number(document.getElementById('rem-goal').textContent.replace(/\D/g, '')),
    food: Number(document.getElementById('rem-food').textContent.replace(/\D/g, '')),
    exercise: Number(document.getElementById('rem-exercise').textContent.replace(/\D/g, '')),
    left: Number(document.getElementById('rem-left').textContent.replace(/[^\d-]/g, '')),
    sections: Object.fromEntries([...document.querySelectorAll('.meal-section[data-slot]')].map((s) => [
      s.dataset.slot,
      [...s.querySelectorAll('.diary-entry')].map((r) => ({
        name: r.querySelector('b').textContent.trim(),
        detail: r.querySelector('.de-name span').textContent.trim(),
        kcal: Number(r.querySelector('.de-kcal').textContent.replace(/\D/g, '')),
      })),
    ])),
    streak: document.getElementById('streak-chip')?.textContent.trim(),
  }));
  const openSheetFor = async (slot) => {
    await page.evaluate((s) => document.querySelector(`.meal-section[data-slot="${s}"] .meal-log`).click(), slot);
    await page.waitForSelector('.sheet .logfood', { timeout: 8000 });
  };
  const searchInSheet = async (query) => {
    await setValue('.sheet input[type="search"]', query);
    await sleep(250);
  };
  const openRow = (name) => page.evaluate((n) => {
    const row = [...document.querySelectorAll('.sheet .food-row')].find((r) => r.querySelector('b')?.textContent.trim() === n);
    if (!row) throw new Error(`no result row for ${n}`);
    (row.querySelector('.fr-main') ?? row).click();
  }, name);

  // ---- 1. empty state and goals -------------------------------------------
  check('starts with an empty-streak prompt', (await text('#streak-chip')).includes('start a streak'), true);
  await clickIn('#btn-settings');
  await page.waitForSelector('#p-sex');
  for (const [sel, v] of [['#p-sex', PROFILE.sex], ['#p-age', PROFILE.age], ['#p-height', PROFILE.heightCm],
    ['#p-weight', PROFILE.weightKg], ['#p-activity', PROFILE.activity], ['#p-rate', PROFILE.rate],
    ['#p-goal-weight', 75], ['#p-start-weight', 82]]) await setValue(sel, v);
  const summary = await text('#goal-summary');
  check('goal summary states maintenance and goal', summary.includes(tdee.toLocaleString()) && summary.includes(goalKcal.toLocaleString()), true);

  await page.evaluate(() => document.querySelector('.tab-btn[data-view="diary"]').click());
  await page.waitForSelector('#rem-goal');
  let d = await diary();
  check('goal reaches the diary banner', d.goal, goalKcal);
  check('nothing logged yet', [d.food, d.left], [0, goalKcal]);

  // ---- 2. log by search, with a serving count ------------------------------
  await openSheetFor('breakfast');
  await searchInSheet('Pizza');
  await openRow('Pizza');
  await page.waitForSelector('#detail-serving');
  const serving = await page.evaluate(() => {
    const sel = document.getElementById('detail-serving');
    const opt = [...sel.options].find((o) => !o.textContent.startsWith('100 g')) ?? sel.options[0];
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { label: opt.textContent.replace(/ \([\d.]+ g\)$/, ''), grams: Number(opt.textContent.match(/\(([\d.]+) g\)/)[1]) };
  });
  await setValue('#detail-servings', 2);
  await clickText('Add to breakfast', '.sheet');
  await sleep(800);
  d = await diary();
  const pizzaKcal = kcalOf('pizza', serving.grams * 2);
  check('serving count multiplies the entry', d.sections.breakfast[0].kcal, pizzaKcal);
  check('entry shows count × serving', d.sections.breakfast[0].detail.startsWith(`2 × ${serving.label}`), true);
  check('food total follows', d.food, pizzaKcal);
  check('remaining recomputed', d.left, goalKcal - pizzaKcal);
  check('streak starts at one day', d.streak.includes('1-day streak'), true);

  // ---- 3. edit that entry --------------------------------------------------
  await page.evaluate(() => document.querySelector('.meal-section[data-slot="breakfast"] .de-name').click());
  await page.waitForSelector('#detail-servings');
  await setValue('#detail-servings', 0.5);
  await clickText('Save changes', '.sheet');
  await sleep(800);
  d = await diary();
  check('editing rescales the entry', d.sections.breakfast[0].kcal, kcalOf('pizza', serving.grams * 0.5));
  check('editing does not duplicate it', d.sections.breakfast.length, 1);

  // ---- 4. quick add --------------------------------------------------------
  await clickIn('#btn-add');
  await page.waitForSelector('#add-quick');
  await clickIn('#add-quick');
  await page.waitForSelector('#qa-kcal');
  await setValue('#qa-kcal', 250);
  await setByLabel('Protein', 12);
  await setByLabel('Description', 'Office cake');
  await clickText('Add to diary', '.sheet');
  await sleep(800);
  d = await diary();
  const quick = Object.values(d.sections).flat().find((r) => r.name === 'Office cake');
  check('quick add logs calories with no food record', quick?.kcal, 250);
  check('quick add carries the macros given', quick?.detail.includes('P 12'), true);

  // ---- 5. custom food from a label ----------------------------------------
  await openSheetFor('lunch');
  await clickText('New food', '.sheet');
  await page.waitForSelector('#cf-name');
  await setValue('#cf-name', 'Amul Masala Chaas');
  await setValue('#cf-serving', '1 glass');
  await setValue('#cf-grams', 200);
  await setByLabel('Calories', 74);
  await setByLabel('Protein', 3.6);
  await setByLabel('Carbs', 6.2);
  await setByLabel('Fat', 3.4);
  await clickText('Create food', '.sheet');
  await page.waitForSelector('#detail-serving', { timeout: 8000 });
  await setValue('#detail-servings', 2);
  await clickText('Add to lunch', '.sheet');
  await sleep(800);
  d = await diary();
  const chaas = d.sections.lunch.find((r) => r.name === 'Amul Masala Chaas');
  check('custom food logs label calories × servings', chaas?.kcal, 148);
  check('custom food keeps its own serving name', chaas?.detail.startsWith('2 × 1 glass'), true);

  // ---- 6. recipe divided into servings ------------------------------------
  await openSheetFor('dinner');
  await clickText('New food', '.sheet');   // reuse the sheet stack, then close it
  await page.waitForSelector('#cf-name');
  await page.evaluate(() => document.querySelector('.sheet-head .icon-btn').click());
  await sleep(200);
  await clickText('Search foods', '.add-menu').catch(() => {});
  await page.evaluate(() => document.querySelectorAll('.sheet-host .sheet').length && document.querySelector('.sheet-backdrop').click());
  await sleep(300);
  await clickIn('.tab-btn[data-view="more"]');
  await page.waitForSelector('#more-myfoods');
  await clickIn('#more-myfoods');
  await page.waitForSelector('#myfoods-root .tabs');
  await clickText('New recipe', '#myfoods-root');
  await page.waitForSelector('#mb-name');
  await setValue('#mb-name', 'Weeknight dal');
  await setValue('#mb-servings', 4);
  for (const [name, grams] of [['Dal', 600], ['Steamed rice', 400]]) {
    await setValue('.sheet input[type="search"]', name);
    await sleep(250);
    await page.evaluate((n) => {
      const row = [...document.querySelectorAll('.sheet .food-results .food-row')]
        .find((r) => r.querySelector('b')?.textContent.trim().toLowerCase().includes(n.toLowerCase()));
      if (!row) throw new Error(`no ingredient row for ${n}`);
      row.click();
    }, name);
    await sleep(250);
    await page.evaluate((g) => {
      const inputs = [...document.querySelectorAll('.builder-item .bi-grams')];
      const last = inputs.at(-1);
      last.value = String(g);
      last.dispatchEvent(new Event('input', { bubbles: true }));
    }, grams);
    await sleep(150);
  }
  const recipeTotals = await page.evaluate(() => ({
    perServing: document.querySelector('.sheet .ds-kcal b').textContent.trim(),
    items: [...document.querySelectorAll('.sheet .builder-item')].map((n) => ({
      name: n.querySelector('.bi-name').textContent.trim(),
      grams: Number(n.querySelector('.bi-grams').value),
    })),
  }));
  const recipeIds = recipeTotals.items.map((it) => Object.keys(db.foods).find((k) => db.foods[k].name === it.name));
  const recipeTotalKcal = recipeIds.reduce((s, id, i) => s + (db.foods[id].per100g.kcal ?? 0) * recipeTotals.items[i].grams / 100, 0);
  check('recipe shows calories per serving', Number(recipeTotals.perServing.replace(/\D/g, '')), Math.round(recipeTotalKcal / 4));
  await clickText('Save recipe', '.sheet');
  await sleep(600);
  await clickIn('.tab-btn[data-view="diary"]');
  await page.waitForSelector('#rem-goal');
  await openSheetFor('dinner');
  await searchInSheet('Weeknight dal');
  await openRow('Weeknight dal');
  await page.waitForSelector('#detail-serving');
  await clickText('Add to dinner', '.sheet');
  await sleep(800);
  d = await diary();
  const dal = d.sections.dinner.find((r) => r.name === 'Weeknight dal');
  near('logging one recipe serving is a quarter of the pot', dal?.kcal, Math.round(recipeTotalKcal / 4), 2);

  // ---- 7. barcode → packaged product --------------------------------------
  await clickIn('#btn-add');
  await page.waitForSelector('#add-barcode');
  await page.evaluate(() => document.querySelector('.sheet-backdrop').click());
  await sleep(200);
  await clickIn('.tab-btn[data-view="more"]');
  await clickIn('#more-barcode');
  await sleep(1200);
  // No camera in headless: the scanner falls back to manual entry.
  await page.waitForSelector('#manual-barcode', { timeout: 15000 });
  await setValue('#manual-barcode', '5449000000996');
  await clickText('Look it up', '.sheet');
  await page.waitForSelector('.sheet .detail-summary', { timeout: 15000 });
  const productSheet = await page.evaluate(() => document.querySelector('.sheet').textContent);
  check('product sheet names the scanned product', productSheet.includes('Coca-Cola'), true);
  check('product sheet credits Open Food Facts', productSheet.includes('Open Food Facts'), true);
  await clickText('Choose serving and add', '.sheet');
  await page.waitForSelector('#detail-serving');
  await clickText('Add to', '.sheet');
  await sleep(800);
  await clickIn('.tab-btn[data-view="diary"]');
  await sleep(500);
  d = await diary();
  const cola = Object.values(d.sections).flat().find((r) => r.name === 'Coca-Cola');
  check('scanned product logs the label serving', cola?.kcal, colaKcal);

  // ---- 8. exercise, credited back -----------------------------------------
  await page.evaluate(() => document.querySelector('#exercise-section .meal-log').click());
  await page.waitForSelector('#ex-search');
  await setValue('#ex-search', 'Running (10');
  await sleep(250);
  await page.evaluate(() => document.querySelector('.sheet .food-row[data-activity="run-10"]').click());
  await setValue('#ex-minutes', 30);
  const estimate = Number((await text('#ex-estimate')).replace(/\D/g, ''));
  const expectedBurn = acsmNet(10, 30, PROFILE.weightKg);
  check('MET estimate follows the ACSM formula, net of rest', estimate, expectedBurn);
  await clickText('Add to diary', '.sheet');
  await sleep(800);
  d = await diary();
  check('exercise is credited to the day', d.exercise, expectedBurn);
  check('remaining includes the exercise credit', d.left, d.goal - d.food + expectedBurn);

  // ---- 9. water, steps, notes, complete diary ------------------------------
  for (let i = 0; i < 3; i++) { await clickIn('#water-plus'); await sleep(220); }
  check('water counts glasses toward the goal', (await text('#water-count')).startsWith('3 /'), true);
  await setValue('#steps-input', 8200);
  await sleep(300);
  await page.evaluate(() => {
    const t = document.getElementById('day-note');
    t.value = 'Long walk after dinner.';
    t.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  await clickIn('#btn-complete');
  await sleep(700);
  const projection = await text('#projection');
  check('completing the day projects five weeks ahead', /5 weeks|stay about the same/.test(projection), true);

  // ---- 10. copy a meal to another day -------------------------------------
  await page.evaluate(() => document.querySelector('.meal-section[data-slot="breakfast"] .icon-btn.small').click());
  await page.waitForSelector('.sheet .stack');
  await clickIn('#copy-to-day');   // target date is prefilled with tomorrow
  await sleep(700);
  await page.evaluate(() => [...document.querySelectorAll('.diary-date-nav .icon-btn')].at(-1).click());
  await sleep(700);
  const tomorrow = await diary();
  check('copied meal lands on the next day', tomorrow.sections.breakfast.length, 1);
  check('copy keeps the same calories', tomorrow.sections.breakfast[0].kcal, d.sections.breakfast[0].kcal);
  await page.evaluate(() => document.querySelector('.diary-date-nav .icon-btn').click());
  await sleep(600);

  // ---- 11. nutrition dashboard --------------------------------------------
  await clickIn('.tab-btn[data-view="nutrition"]');
  await page.waitForSelector('#cal-pie');
  const pie = await page.evaluate(() => ({
    center: document.querySelector('#cal-pie .ch-center').textContent.trim(),
    legend: [...document.querySelectorAll('#cal-pie ~ .legend .legend-row')].map((r) => r.lastChild.textContent.trim()),
  }));
  const legendKcal = pie.legend.map((t) => Number(t.replace(/ kcal.*/, '').replace(/\D/g, '')));
  d = await page.evaluate(() => ({ food: Number(document.getElementById('rem-goal') ? 0 : 0) })).then(() => diaryFood(page));
  check('calorie pie centre equals the day total', Number(pie.center.replace(/\D/g, '')), d);
  check('meal legend adds up to the day total', legendKcal.reduce((s, v) => s + v, 0), d);
  await clickText('Nutrients', '#nutrition-root');
  await page.waitForSelector('.nutrient-table');
  const nutrientRows = await page.$$eval('.nutrient-table tbody tr', (rows) => rows.length);
  check('nutrient table covers every tracked nutrient', nutrientRows, Object.keys(db.nutrients).length);
  // Week view lives on the Calories tab; the Nutrients tab is a table.
  await clickText('Calories', '#nutrition-root');
  await sleep(300);
  await clickText('Week', '#nutrition-root');
  await page.waitForSelector('#cal-week', { timeout: 8000 });
  const week = await page.evaluate(() => ({
    columns: new Set([...document.querySelectorAll('#cal-week rect')].map((r) => r.getAttribute('x'))).size,
    labels: [...document.querySelectorAll('#cal-week text')].length,
    goalLine: !!document.querySelector('#cal-week .ch-goal-line'),
  }));
  check('week view draws a column per day', week.labels, 7);
  check('week view has at least today’s column', week.columns >= 1, true);
  check('week view marks the calorie goal', week.goalLine, true);

  // ---- 12. weight and progress --------------------------------------------
  await clickIn('.tab-btn[data-view="progress"]');
  await page.waitForSelector('#weight-chart');
  await clickIn('#log-weight');
  await page.waitForSelector('#weight-input');
  await setValue('#weight-input', 79.4);
  await clickText('Save', '.sheet');
  await sleep(900);
  const weightSummary = await text('#weight-summary');
  check('progress summary reflects the new weigh-in',
    weightSummary.includes('79.4') && weightSummary.includes('75'), true);
  check('weight chart plots the point', await page.$eval('#weight-chart', (n) => n.innerHTML.includes('<circle')), true);

  console.log(`flows verified: goals, search+servings, edit, quick add, custom food, recipe, barcode, exercise, habits, complete, copy, dashboard, progress`);
} finally {
  await browser.close();
  server?.kill();
}

async function diaryFood(page) {
  await page.evaluate(() => document.querySelector('.tab-btn[data-view="diary"]').click());
  await page.waitForSelector('#rem-food');
  const food = Number((await page.$eval('#rem-food', (n) => n.textContent)).replace(/\D/g, ''));
  await page.evaluate(() => document.querySelector('.tab-btn[data-view="nutrition"]').click());
  await page.waitForSelector('#cal-pie');
  return food;
}

console.log(`\n${checks} checks, ${failures.length} failure(s)`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  console.log('TRACKER E2E FAIL');
  process.exit(1);
}
console.log('TRACKER E2E PASS');
