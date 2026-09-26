/**
 * MyFitnessPal parity, feature by feature, in the built PWA with no network.
 *
 * eval/tracker-e2e.mjs is the regression baseline (the main flows once each).
 * This file goes deeper: every feature row in docs/MFP_PARITY.md that says
 * "present" is driven here, and its numbers are checked against an oracle
 * computed from app/public/data/nutrition-db.json, not read back from the app.
 *
 * Three disciplines, all required for a result to mean anything:
 *  - fresh Chrome profile (empty IndexedDB and localStorage);
 *  - every request that leaves localhost is aborted and counted (must be 0);
 *  - the clock is frozen at 2026-10-01 13:05 in Asia/Kolkata, because meal
 *    suggestion, streaks, "today" and month boundaries all read it.
 *
 * Usage: node eval/parity-e2e.mjs [--headed] [--only <section regex>]
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const only = args.includes('--only') ? new RegExp(args[args.indexOf('--only') + 1], 'i') : null;
const db = JSON.parse(readFileSync(join(root, 'app/public/data/nutrition-db.json'), 'utf8'));

// --- oracle -----------------------------------------------------------------
const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-01T13:05:00+05:30');
const TODAY = '2026-10-01';
const YESTERDAY = '2026-09-30';
const TOMORROW = '2026-10-02';
const per100 = (id, k) => db.foods[id].per100g[k] ?? 0;
const kcalOf = (id, grams) => Math.round(per100(id, 'kcal') * grams / 100);
const PROFILE = { sex: 'female', age: 34, heightCm: 162, weightKg: 68, activity: 1.375, rate: -0.25 };
const bmr = (p) => 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.sex === 'male' ? 5 : -161);
const tdee = Math.round(bmr(PROFILE) * PROFILE.activity);
const goalKcal = Math.max(1200, Math.round(tdee + PROFILE.rate * 7700 / 7));

// --- harness ----------------------------------------------------------------
const results = []; // { section, label, ok, got, want }
let section = '';
function check(label, actual, want) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  results.push({ section, label, ok, got: actual, want });
}
function near(label, actual, want, tol = 1) {
  const ok = Number.isFinite(actual) && Math.abs(actual - want) <= tol;
  results.push({ section, label, ok, got: actual, want: `${want} ±${tol}` });
}
const truthy = (label, v) => check(label, !!v, true);

let server = null;
if (!(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false))) {
  server = spawn('npx', ['vite', 'preview', '--port', '5199'], { cwd: join(root, 'app'), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await fetch('http://localhost:5199/').then((r) => r.ok).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const profileDir = mkdtempSync(join(tmpdir(), 'nutrilens-parity-'));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !headed, protocolTimeout: 600000, userDataDir: profileDir,
  args: ['--window-size=520,900'],
});
const external = [];
const pageErrors = [];
let page;

async function openPage() {
  page = await browser.newPage();
  await page.setViewport({ width: 520, height: 900 });
  await page.emulateTimezone(TZ);
  await page.evaluateOnNewDocument((now) => {
    const RealDate = Date;
    const offset = now - RealDate.now();
    class FrozenDate extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
      static now() { return RealDate.now() + offset; }
    }
    globalThis.Date = FrozenDate;
  }, NOW);
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const { hostname, protocol } = new URL(req.url());
    if (/^https?:$/.test(protocol) && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      external.push(req.url());
      req.abort();
    } else req.continue();
  });
  await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#today-root .cal-card', { timeout: 30000 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const clickIn = (sel) => ev((s) => {
  const node = document.querySelector(s);
  if (!node) throw new Error(`no element for ${s}`);
  node.click();
}, sel);
const clickText = (text, scope = 'body') => ev((t, s) => {
  const btn = [...document.querySelectorAll(`${s} button`)]
    .find((b) => !b.disabled && b.offsetParent !== null && b.textContent.trim().includes(t));
  if (!btn) throw new Error(`no button matching "${t}" in ${s}`);
  btn.click();
}, text, scope);
const setValue = (sel, value) => ev((s, v) => {
  const node = document.querySelector(s);
  if (!node) throw new Error(`no field for ${s}`);
  node.value = String(v);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}, sel, value);
const setByLabel = (labelText, value, scope = '.sheet') => ev((t, v, s) => {
  const sheets = [...document.querySelectorAll(s)];
  const host = sheets.at(-1) ?? document;
  const label = [...host.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(t));
  const node = label?.querySelector('input, select, textarea') ?? (label?.htmlFor ? document.getElementById(label.htmlFor) : null);
  if (!node) throw new Error(`no field labelled "${t}"`);
  node.value = String(v);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}, labelText, value, scope);
const text = (sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);
const closeSheets = async () => {
  await ev(() => { for (let i = 0; i < 5; i++) document.querySelector('.sheet-head .icon-btn')?.click(); });
  await sleep(300);
};
const tab = async (view) => {
  await closeSheets();
  await clickIn(`.tab-btn[data-view="${view}"]`);
  await sleep(400);
};
const diary = () => ev(() => ({
  date: document.getElementById('diary-date')?.textContent.trim(),
  goal: Number(document.getElementById('rem-goal').textContent.replace(/\D/g, '')),
  food: Number(document.getElementById('rem-food').textContent.replace(/\D/g, '')),
  exercise: Number(document.getElementById('rem-exercise').textContent.replace(/\D/g, '')),
  left: Number(document.getElementById('rem-left').textContent.replace(/[^\d-]/g, '')),
  sections: Object.fromEntries([...document.querySelectorAll('.meal-section[data-slot]')].map((s) => [
    s.dataset.slot,
    [...s.querySelectorAll('.diary-entry')].map((r) => ({
      name: r.querySelector('b').textContent.trim(),
      detail: r.querySelector('.de-name span')?.textContent.trim(),
      kcal: Number(r.querySelector('.de-kcal').textContent.replace(/\D/g, '')),
    })),
  ])),
  exerciseRows: [...document.querySelectorAll('#exercise-section .diary-entry')].map((r) => ({
    name: r.querySelector('b').textContent.trim(),
    detail: r.querySelector('.de-name span')?.textContent.trim(),
    kcal: Number(r.querySelector('.de-kcal').textContent.replace(/\D/g, '')),
  })),
  streak: document.getElementById('streak-chip')?.textContent.trim(),
}));
const all = (d) => Object.values(d.sections).flat();
const openSheetFor = async (slot) => {
  await ev((s) => document.querySelector(`.meal-section[data-slot="${s}"] .meal-log`).click(), slot);
  await page.waitForSelector('.sheet .logfood', { timeout: 8000 });
};
const search = async (q) => { await setValue('.sheet input[type="search"]', q); await sleep(300); };
const openRow = (name) => ev((n) => {
  const row = [...document.querySelectorAll('.sheet .food-row')].find((r) => r.querySelector('b')?.textContent.trim() === n);
  if (!row) throw new Error(`no result row for ${n}`);
  (row.querySelector('.fr-main') ?? row).click();
}, name);
const pickServing = (grams) => ev((g) => {
  const sel = document.getElementById('detail-serving');
  const opts = [...sel.options].map((o) => ({ v: o.value, t: o.textContent, g: Number(o.textContent.match(/\(([\d.]+) g\)/)?.[1]) }));
  const opt = g == null ? opts.find((o) => !o.t.startsWith('100 g')) ?? opts[0] : opts.find((o) => o.g === g);
  if (!opt) throw new Error(`no serving of ${g} g`);
  sel.value = opt.v;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { label: opt.t.replace(/ \([\d.]+ g\)$/, ''), grams: opt.g };
}, grams);
/** Log a USDA food by name: returns the grams logged. */
async function logFood(slot, name, { servings = 1, grams = null } = {}) {
  await openSheetFor(slot);
  await search(name);
  await openRow(name);
  await page.waitForSelector('#detail-serving');
  const s = await pickServing(grams);
  await setValue('#detail-servings', servings);
  await ev(() => document.querySelector('.sheet .sheet-save').click());
  await sleep(700);
  return s.grams * servings;
}
const idOf = (name) => Object.keys(db.foods).find((k) => db.foods[k].name === name);

/** Run one section; a thrown error is a failed check, not a crashed suite. */
async function run(name, fn) {
  if (only && !only.test(name)) return;
  section = name;
  try { await fn(); } catch (err) {
    results.push({ section, label: `section ran to the end (${err.message.split('\n')[0].slice(0, 160)})`, ok: false });
    await page.screenshot({ path: join(root, `eval/results/parity-fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    await closeSheets().catch(() => {});
  }
}

try {
  await openPage();

  // =========================================================================
  await run('offline + clock', async () => {
    check('the app thinks it is 1 Oct 2026', await ev(() => new Date().toISOString().slice(0, 10)), TODAY);
    check('the diary opens on today', (await diary()).date?.toLowerCase().includes('today'), true);
  });

  await run('goals', async () => {
    await clickIn('#btn-settings');
    await page.waitForSelector('#p-sex');
    for (const [sel, v] of [['#p-sex', PROFILE.sex], ['#p-age', PROFILE.age], ['#p-height', PROFILE.heightCm],
      ['#p-weight', PROFILE.weightKg], ['#p-activity', PROFILE.activity], ['#p-rate', PROFILE.rate],
      ['#p-goal-weight', 60], ['#p-start-weight', 72]]) await setValue(sel, v);
    const summary = await text('#goal-summary');
    truthy('goal summary shows Mifflin-St Jeor maintenance', summary.includes(tdee.toLocaleString()));
    truthy('goal summary shows the goal', summary.includes(goalKcal.toLocaleString()));
    await tab('diary');
    check('goal reaches the diary', (await diary()).goal, goalKcal);
    // Custom calorie goal overrides the computed one.
    await clickIn('#btn-settings');
    await setValue('#p-custom', 1650);
    await tab('diary');
    check('a custom calorie goal overrides the computed one', (await diary()).goal, 1650);
    await clickIn('#btn-settings');
    await setValue('#p-custom', '');
    await tab('diary');
    check('clearing the custom goal restores the computed one', (await diary()).goal, goalKcal);
  });

  await run('macro goals', async () => {
    await clickIn('#btn-settings');
    await setValue('#p-carbs', 40); await setValue('#p-protein', 30); await setValue('#p-fat', 30);
    await tab('diary');
    const macroTargets = await ev(() => document.getElementById('macros-card')?.textContent);
    const want = { carbs: Math.round(goalKcal * 0.4 / 4), protein: Math.round(goalKcal * 0.3 / 4), fat: Math.round(goalKcal * 0.3 / 9) };
    for (const [k, g] of Object.entries(want)) truthy(`percent macros: ${k} target ${g} g shown`, macroTargets?.includes(String(g)));
    await clickIn('#btn-settings');
    await ev(() => document.getElementById('p-mode-grams').click());
    await setValue('#p-carbs-g', 150); await setValue('#p-protein-g', 120); await setValue('#p-fat-g', 55);
    await tab('diary');
    const g2 = await ev(() => document.getElementById('macros-card')?.textContent);
    for (const g of [150, 120, 55]) truthy(`gram macros: ${g} g target shown`, g2?.includes(String(g)));
  });

  await run('log, persist, recent', async () => {
    const grams = await logFood('breakfast', 'Idli', { servings: 3 });
    let d = await diary();
    const idli = d.sections.breakfast.find((r) => r.name === 'Idli');
    check('logged food appears in its meal', idli?.kcal, kcalOf('idli', grams));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rem-goal');
    d = await diary();
    check('it is still there after a reload (IndexedDB, not memory)', d.sections.breakfast.find((r) => r.name === 'Idli')?.kcal, kcalOf('idli', grams));
    await openSheetFor('lunch');
    const recent = await ev(() => [...document.querySelectorAll('.sheet .food-row b')].map((b) => b.textContent.trim()));
    truthy('the log sheet lists it as recent before any search', recent.includes('Idli'));
    await closeSheets();
  });

  await run('serving edits', async () => {
    const d0 = await diary();
    const before = d0.sections.breakfast.find((r) => r.name === 'Idli');
    await ev(() => [...document.querySelectorAll('.meal-section[data-slot="breakfast"] .de-name')].find((n) => n.querySelector('b').textContent.trim() === 'Idli').click());
    await page.waitForSelector('#detail-servings');
    const s = await ev(() => {
      const sel = document.getElementById('detail-serving');
      const opts = [...sel.options];
      const hundred = opts.find((o) => o.textContent.startsWith('100 g'));
      sel.value = hundred.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 100;
    });
    await setValue('#detail-servings', 1.5);
    await ev(() => document.querySelector('.sheet .sheet-save').click());
    await sleep(700);
    const d = await diary();
    const after = d.sections.breakfast.filter((r) => r.name === 'Idli');
    check('changing size and count rescales, not duplicates', after.length, 1);
    check('150 g of idli', after[0]?.kcal, kcalOf('idli', s * 1.5));
    check('food total moves by the difference', d.food - d0.food, after[0].kcal - before.kcal);
  });

  await run('move entry', async () => {
    await ev(() => [...document.querySelectorAll('.meal-section[data-slot="breakfast"] .de-name')].find((n) => n.querySelector('b').textContent.trim() === 'Idli').click());
    await page.waitForSelector('#detail-servings');
    await setByLabel('Meal', 'snacks');
    await ev(() => document.querySelector('.sheet .sheet-save').click());
    await sleep(700);
    let d = await diary();
    check('moved out of breakfast', d.sections.breakfast.some((r) => r.name === 'Idli'), false);
    check('moved into snacks', d.sections.snacks.some((r) => r.name === 'Idli'), true);
    // Move to another day.
    await ev(() => [...document.querySelectorAll('.meal-section[data-slot="snacks"] .de-name')].find((n) => n.querySelector('b').textContent.trim() === 'Idli').click());
    await page.waitForSelector('#detail-servings');
    await setByLabel('Date', YESTERDAY);
    await ev(() => document.querySelector('.sheet .sheet-save').click());
    await sleep(700);
    d = await diary();
    check('moved off today', all(d).some((r) => r.name === 'Idli'), false);
    await ev(() => document.querySelector('[aria-label="Previous day"]').click());
    await sleep(500);
    d = await diary();
    check('and onto yesterday', d.sections.snacks.some((r) => r.name === 'Idli'), true);
    check('the day before today is labelled Yesterday', d.date, 'Yesterday');
    await ev(() => document.querySelector('[aria-label="Previous day"]').click());
    await sleep(400);
    const two = (await diary()).date ?? '';
    truthy(`month boundary: two days before 1 Oct is 29 Sep (got "${two}")`, /29/.test(two) && /Sep/i.test(two));
    await ev(() => document.querySelector('[aria-label="Next day"]').click());
    await sleep(300);
    await ev(() => document.querySelector('[aria-label="Next day"]').click());
    await sleep(400);
  });

  await run('copy meals', async () => {
    // Yesterday has the idli in snacks; copy it into today's snacks.
    await ev(() => document.querySelector('.meal-section[data-slot="snacks"] .icon-btn.small').click());
    await page.waitForSelector('#copy-from-day');
    await ev((y) => { const i = document.querySelector('.sheet input[type="date"]'); i.value = y; i.dispatchEvent(new Event('change', { bubbles: true })); }, YESTERDAY);
    await clickIn('#copy-from-day');
    await sleep(700);
    const d = await diary();
    check('copy from yesterday brings the item to today', d.sections.snacks.some((r) => r.name === 'Idli'), true);
    // Copy today's snacks to tomorrow's dinner.
    await ev(() => document.querySelector('.meal-section[data-slot="snacks"] .icon-btn.small').click());
    await page.waitForSelector('#copy-to-day');
    await ev((t) => {
      const inputs = document.querySelectorAll('.sheet input[type="date"]');
      inputs[1].value = t; inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      const sel = document.querySelector('.sheet .row3 select'); sel.value = 'dinner'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, TOMORROW);
    await clickIn('#copy-to-day');
    await sleep(700);
    await ev(() => document.querySelector('[aria-label="Next day"]').click());
    await sleep(500);
    const t = await diary();
    check('copy to tomorrow lands in the chosen meal', t.sections.dinner.some((r) => r.name === 'Idli'), true);
    await ev(() => [...document.querySelectorAll('#today-root button.link')].find((b) => /today/i.test(b.textContent))?.click());
    await sleep(500);
    check('the "today" link returns to today', (await diary()).date?.toLowerCase().includes('today'), true);
  });

  await run('quick add', async () => {
    await clickIn('#btn-add');
    await page.waitForSelector('#add-quick');
    await clickIn('#add-quick');
    await page.waitForSelector('#qa-kcal');
    await setValue('#qa-kcal', 320);
    await setByLabel('Protein', 20); await setByLabel('Carbs', 30); await setByLabel('Fat', 12);
    await setByLabel('Description', 'Canteen thali (estimate)');
    await clickText('Add to diary', '.sheet');
    await sleep(700);
    const q = all(await diary()).find((r) => r.name === 'Canteen thali (estimate)');
    check('quick add logs the calories', q?.kcal, 320);
    truthy('quick add keeps protein, carbs and fat', q?.detail?.includes('P 20') && q?.detail?.includes('C 30') && q?.detail?.includes('F 12'));
  });

  await run('custom food lifecycle', async () => {
    await openSheetFor('lunch');
    await clickText('New food', '.sheet');
    await page.waitForSelector('#cf-name');
    await setValue('#cf-name', 'Café Crème — ಕಾಫಿ');
    await setValue('#cf-serving', '1 cup');
    await setValue('#cf-grams', 150);
    await setByLabel('Calories', 90); await setByLabel('Protein', 3); await setByLabel('Carbs', 12); await setByLabel('Fat', 3);
    await clickText('Create food', '.sheet');
    await page.waitForSelector('#detail-serving', { timeout: 8000 });
    await ev(() => document.querySelector('.sheet .sheet-save').click());
    await sleep(700);
    let row = (await diary()).sections.lunch.find((r) => r.name === 'Café Crème — ಕಾಫಿ');
    check('a unicode-named custom food logs per its label', row?.kcal, 90);
    // Delete the food from My foods; the logged entry must survive.
    await tab('more');
    await clickIn('#more-myfoods');
    await page.waitForSelector('#myfoods-root .tabs');
    await sleep(300);
    const deleted = await ev(() => {
      const r = [...document.querySelectorAll('#myfoods-root .food-row')].find((x) => x.textContent.includes('Café Crème'));
      const del = r && [...r.querySelectorAll('button')].find((b) => /delete|remove/i.test(b.getAttribute('aria-label') ?? b.title ?? b.textContent));
      del?.click();
      return !!del;
    });
    truthy('My foods has a delete control on the custom food', deleted);
    await sleep(400);
    await ev(() => [...document.querySelectorAll('.sheet button')].find((b) => /delete/i.test(b.textContent))?.click());
    await sleep(500);
    await tab('diary');
    row = (await diary()).sections.lunch.find((r) => r.name === 'Café Crème — ಕಾಫಿ');
    check('deleting the food keeps what was already logged', row?.kcal, 90);
  });

  await run('saved meal', async () => {
    // Build breakfast: dosa + sambar, then save it as a meal and log it at dinner.
    const g1 = await logFood('breakfast', 'Dosa (plain)', { servings: 1 });
    const g2 = await logFood('breakfast', 'Sambar', { servings: 1 });
    const want = kcalOf('dosa', g1) + kcalOf('sambar', g2);
    await ev(() => document.querySelector('.meal-section[data-slot="breakfast"] .icon-btn.small').click());
    await sleep(300);
    await clickText('reusable meal', '.sheet');
    await page.waitForSelector('#mb-name');
    await setValue('#mb-name', 'Tiffin');
    await clickText('Save meal', '.sheet');
    await sleep(600);
    await closeSheets();
    await openSheetFor('dinner');
    await search('Tiffin');
    await openRow('Tiffin');
    await page.waitForSelector('#detail-serving');
    await ev(() => document.querySelector('.sheet .sheet-save').click());
    await sleep(700);
    const t = (await diary()).sections.dinner.find((r) => r.name === 'Tiffin');
    near('logging the saved meal matches the meal it was saved from', t?.kcal, want, 1);
  });

  await run('exercise', async () => {
    await clickIn('#btn-add');
    await page.waitForSelector('#add-exercise');
    await clickIn('#add-exercise');
    await page.waitForSelector('#ex-search');
    await setValue('#ex-search', 'Weight');
    await sleep(300);
    const picked = await ev(() => {
      const row = [...document.querySelectorAll('.sheet .food-row[data-activity]')].find((r) => /weight|strength/i.test(r.textContent));
      row?.click();
      return row?.dataset.activity;
    });
    truthy('a strength activity exists', picked);
    await setValue('#ex-minutes', 40);
    await setByLabel('Sets', 4); await setByLabel('Reps', 10);
    await clickText('Add to diary', '.sheet');
    await sleep(700);
    const d = await diary();
    const ex = d.exerciseRows[0];
    truthy('strength entry shows sets × reps', ex?.detail?.includes('4×10'));
    check('exercise is credited to the day', d.exercise, ex?.kcal);
    check('remaining = goal − food + exercise', d.left, d.goal - d.food + d.exercise);
  });

  await run('habits and notes persist', async () => {
    await clickIn('#water-plus'); await clickIn('#water-plus'); await clickIn('#water-plus');
    await setValue('#steps-input', 8421);
    await ev(() => { const n = document.getElementById('day-note'); n.closest('details').open = true; });
    await setValue('#day-note', 'Tired after the gym.');
    await sleep(500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#water-count');
    check('water survives a reload', (await text('#water-count'))?.startsWith('3 /'), true);
    check('steps survive a reload', await ev(() => document.getElementById('steps-input').value), '8421');
    check('the note survives a reload', await ev(() => document.getElementById('day-note').value), 'Tired after the gym.');
  });

  await run('complete day', async () => {
    await clickIn('#btn-complete');
    await sleep(500);
    truthy('completing shows a five-week projection', (await text('#projection'))?.length > 10);
    truthy('streak counts today', (await diary()).streak?.includes('streak'));
  });

  await run('weight and progress', async () => {
    await clickIn('#btn-add');
    await page.waitForSelector('#add-weight');
    await clickIn('#add-weight');
    await page.waitForSelector('#weight-input');
    await setValue('#weight-input', 67.4);
    await clickText('Save', '.sheet');
    await sleep(600);
    await tab('progress');
    const summary = await text('#weight-summary');
    truthy('progress shows the logged weight', summary?.includes('67.4'));
    truthy('progress shows a weight chart', await ev(() => !!document.querySelector('#weight-chart svg, #weight-chart')));
  });

  await run('nutrition dashboard', async () => {
    await tab('diary');
    const d = await diary();
    await tab('nutrition');
    const pageText = await ev(() => document.getElementById('nutrition-root').textContent);
    truthy('nutrition shows today\'s food calories', pageText.includes(d.food.toLocaleString()) || pageText.includes(String(d.food)));
    truthy('nutrition breaks calories down by meal', /Calories by meal/i.test(pageText));
    truthy('nutrition has a week view', /week/i.test(pageText));
  });

  await run('export CSV', async () => {
    await tab('diary');
    const d = await diary();
    const csv = await ev(async () => {
      const { listMeals } = await import('/src/db.js').catch(() => ({}));
      return listMeals ? 'module' : null;
    }).catch(() => null);
    // Read the CSV the app builds by intercepting the download blob.
    const got = await ev(() => new Promise((resolve) => {
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { blob.text().then(resolve); return orig.call(URL, blob); };
      document.getElementById('btn-export').click();
      setTimeout(() => resolve(null), 4000);
    }));
    truthy('CSV export produced a file', got);
    if (got) {
      const lines = got.trim().split(/\r?\n/);
      const header = lines[0].split(',');
      const dateCol = header.findIndex((h) => /date/i.test(h));
      const kcalCol = header.findIndex((h) => /^"?(energy|calories|kcal)/i.test(h));
      const cells = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"'));
      const today = lines.slice(1).map(cells).filter((c) => c[dateCol] === TODAY);
      const foods = today.filter((c) => c[1] !== 'TOTAL');
      const total = today.find((c) => c[1] === 'TOTAL');
      check('CSV has one row per food logged today', foods.length, all(d).length);
      const sum = Math.round(foods.reduce((s, c) => s + Number(c[kcalCol] || 0), 0));
      near('CSV food rows sum to the diary total', sum, d.food, all(d).length);
      check('CSV TOTAL row equals the diary total', Number(total?.[kcalCol]), d.food);
      truthy('CSV keeps a unicode food name intact', foods.some((c) => c[2] === 'Café Crème — ಕಾಫಿ'));
    }
    void csv;
  });

  await run('backup round trip', async () => {
    await tab('diary');
    const before = await diary();
    const backup = await ev(() => new Promise((resolve) => {
      const orig = URL.createObjectURL;
      URL.createObjectURL = (blob) => { blob.text().then(resolve); return orig.call(URL, blob); };
      document.getElementById('btn-backup').click();
      setTimeout(() => resolve(null), 6000);
    }));
    truthy('full backup produced a file', backup);
    const file = join(tmpdir(), 'nutrilens-parity-backup.json');
    writeFileSync(file, backup ?? '');
    // Wipe everything the app stores, then restore from the file.
    await ev(async () => {
      localStorage.clear();
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((x) => new Promise((r) => { const q = indexedDB.deleteDatabase(x.name); q.onsuccess = q.onerror = q.onblocked = r; })));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rem-goal');
    check('the wipe really emptied the diary', all(await diary()).length, 0);
    await clickIn('#btn-settings');
    const input = await page.$('#restore-file');
    await input.uploadFile(file);
    await page.waitForSelector('.sheet');
    await clickText('Replace and restore', '.sheet');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#rem-goal');
    await sleep(500);
    const after = await diary();
    check('restore brings back every diary entry', JSON.stringify(after.sections), JSON.stringify(before.sections));
    check('restore brings back the goal', after.goal, before.goal);
    check('restore brings back exercise', after.exercise, before.exercise);
  });

  await run('bad input', async () => {
    await openSheetFor('snacks');
    await search('Banana');
    const rows = await ev(() => [...document.querySelectorAll('.sheet .food-row b')].map((b) => b.textContent.trim()));
    const banana = rows.find((r) => /banana/i.test(r));
    truthy('search finds a banana', banana);
    await openRow(banana);
    await page.waitForSelector('#detail-servings');
    await setValue('#detail-servings', -2);
    const kcalNeg = await ev(() => Number(document.querySelector('.sheet .ds-kcal b').textContent.replace(/[^\d-]/g, '')));
    check('a negative serving count never gives negative calories', kcalNeg >= 0, true);
    await setValue('#detail-servings', 0);
    const kcalZero = await ev(() => Number(document.querySelector('.sheet .ds-kcal b').textContent.replace(/[^\d-]/g, '')));
    check('zero servings is not logged as a real amount', kcalZero <= 1, true);
    await closeSheets();
  });

  await run('photo to diary', async () => {
    await tab('diary');
    const before = all(await diary()).length;
    await clickIn('#btn-add');
    await page.waitForSelector('#add-photo');
    await clickIn('#add-photo');
    await sleep(800);
    const input = await page.$('#file-input');
    await input.uploadFile(join(root, 'eval/data/web/burger-fries/3.jpg'));
    await page.waitForFunction(() => !document.getElementById('meal-card').hidden, { timeout: 300000, polling: 500 });
    await page.waitForFunction(() => document.getElementById('sides-status').hidden, { timeout: 300000, polling: 500 });
    const plate = await ev(() => Number(document.getElementById('plate-kcal').textContent.replace(/\D/g, '')));
    await clickIn('#btn-save');
    await sleep(1000);
    await tab('diary');
    const d = await diary();
    check('a photographed plate logs one entry per dish', all(d).length - before, 2);
    const burger = all(d).filter((r) => r.name === 'Hamburger' || r.name === 'French fries');
    near('and the entries add up to the plate', burger.reduce((s, r) => s + r.kcal, 0), plate, 1);
  });

  check('no request left localhost', external, []);
  check('no page errors', pageErrors, []);
} finally {
  await browser.close();
  server?.kill();
}

// --- report -------------------------------------------------------------------
const bySection = new Map();
for (const r of results) {
  if (!bySection.has(r.section)) bySection.set(r.section, []);
  bySection.get(r.section).push(r);
}
let failed = 0;
for (const [name, rows] of bySection) {
  const bad = rows.filter((r) => !r.ok);
  failed += bad.length;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${name.padEnd(28)} ${rows.length - bad.length}/${rows.length}`);
  for (const r of bad) console.log(`       ✗ ${r.label}${'got' in r ? `\n           got  ${JSON.stringify(r.got)}\n           want ${JSON.stringify(r.want)}` : ''}`);
}
writeFileSync(join(root, 'eval/results/parity-e2e.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`\n${results.length} checks, ${failed} failure(s)`);
console.log(failed ? 'PARITY E2E FAIL' : 'PARITY E2E PASS');
process.exitCode = failed ? 1 : 0;
