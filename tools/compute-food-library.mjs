/**
 * Cost out the food catalogue with Claude and ship it as an offline library.
 *
 * This is the offline answer to "any dish". The app cannot call a model — it is
 * on-device and works with the aeroplane mode on — so the breadth has to be
 * computed here, at build time, and shipped as static JSON. Every row is
 * validated against nutrition-label arithmetic before it is allowed in, and rows
 * that will not add up are dropped rather than shipped as a guess.
 *
 * Batched: one request covers many dishes, which is what makes ~1800 foods
 * affordable. Each batch is validated row by row and any failing row is retried
 * individually with its own error fed back.
 *
 * Scope: energy, macros, fibre, sugar, saturated fat and sodium — the figures a
 * recipe determines and a person logs. It deliberately does NOT invent the 25
 * micronutrients the USDA core set carries; those come from measurement, not
 * reasoning, and a fabricated selenium value would be worse than none. Foods in
 * the core USDA database keep their full micronutrient profile and are excluded
 * from this library.
 *
 * Outputs:
 *   tools/data/food-library-cache.json   raw batch replies, keyed for reuse
 *   app/public/data/nutrition-library.json  the shipped library
 *
 * Usage: node tools/compute-food-library.mjs [--batch 20] [--concurrency 6]
 *                                            [--limit N] [--refresh] [--group key]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePer100g, atwaterKcal } from '@nutrilens/claude-nutrition';
import { bedrockTransport } from '@nutrilens/claude-nutrition/bedrock-cli';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(root, 'tools/data');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const BATCH = Number(opt('batch', 20));
const CONCURRENCY = Number(opt('concurrency', 6));
const LIMIT = opt('limit') ? Number(opt('limit')) : Infinity;
const GROUP = opt('group', null);
const REFRESH = argv.includes('--refresh');
const MODEL = opt('model', 'eu.anthropic.claude-sonnet-5');
const PROMPT_VERSION = 'lib-v1';

const SYSTEM = [
  'You are a rigorous nutrition calculator building a food database.',
  'For EACH food you are given, work out the nutrition of the finished food AS EATEN',
  '(cooked, drained, sauced, with any oil actually absorbed), per 100 grams.',
  '',
  'Method for every item:',
  '1. Think of a standard recipe or the food as normally served.',
  '2. Use well-established per-ingredient reference values (USDA-style).',
  '3. Account for cooking: water lost or gained, fat absorbed in frying, fat rendered off.',
  '4. Divide to per-100-gram of the finished, as-eaten food.',
  '5. Check kcal is within a few percent of 4*protein + 4*carbs + 9*fat - 2*fiber.',
  '   If not, the macros are wrong — fix them before answering.',
  '',
  'Reply with ONLY a minified JSON array, one object per food, in the SAME ORDER as given, keys:',
  'name, kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg,',
  'typical_serving_g (grams in one normal portion), confidence (0-1).',
  'All nutrient values are per 100 g of the finished food. Numbers only, no units, no prose, no code fence.',
].join('\n');

const FIELDS = {
  kcal: 'kcal', protein_g: 'protein', carbs_g: 'carbs', fat_g: 'fat',
  fiber_g: 'fiber', sugar_g: 'sugars', sat_fat_g: 'satFat', sodium_mg: 'sodium',
};

const catalogue = JSON.parse(readFileSync(join(DATA, 'food-catalogue.json'), 'utf8'));
let items = catalogue.items;
if (GROUP) items = items.filter((i) => i.group === GROUP);
items = items.slice(0, LIMIT);

const cachePath = join(DATA, 'food-library-cache.json');
const cache = (!REFRESH && existsSync(cachePath)) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const transport = bedrockTransport({ model: MODEL, effort: 'low', timeoutMs: 180_000 });

const num = (v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
};

/** Map one raw model object to a per100g record + meta, or null if unusable. */
function toRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const per100g = {};
  for (const [k, dbKey] of Object.entries(FIELDS)) {
    const v = num(raw[k]);
    if (v !== undefined) per100g[dbKey] = Math.round(v * 100) / 100;
  }
  if (per100g.kcal === undefined) return null;
  for (const k of ['protein', 'carbs', 'fat']) if (per100g[k] === undefined) return null;
  const check = validatePer100g(per100g);
  return {
    per100g,
    servingG: num(raw.typical_serving_g) ?? null,
    confidence: num(raw.confidence) ?? null,
    valid: check.ok,
    reasons: check.reasons,
  };
}

function parseArray(text) {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('no JSON array in reply');
  return JSON.parse(text.slice(a, b + 1));
}

async function pool(list, n, worker) {
  const out = new Array(list.length);
  let next = 0;
  const run = async () => { while (true) { const i = next++; if (i >= list.length) return; out[i] = await worker(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, run));
  return out;
}

// --------------------------- batch the catalogue ---------------------------
const batches = [];
for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
console.log(`Computing ${items.length} foods in ${batches.length} batches of ${BATCH} with ${MODEL}`);

let calls = 0; let done = 0;
const results = new Map(); // id -> record

await pool(batches, CONCURRENCY, async (batch, bi) => {
  const key = `${PROMPT_VERSION}::${MODEL}::${batch.map((b) => b.id).join('|')}`;
  let rows = cache[key];
  if (!rows) {
    calls++;
    const list = batch.map((b, i) => `${i + 1}. ${b.name}`).join('\n');
    try {
      const text = await transport({
        system: SYSTEM,
        messages: [{ role: 'user', content: `Foods:\n${list}` }],
        // Roughly 60 output tokens a row, plus headroom for the reasoning pass.
        maxTokens: Math.max(3000, batch.length * 110),
      });
      rows = parseArray(text);
    } catch (e) {
      console.warn(`  ! batch ${bi} failed: ${e.message.slice(0, 120)}`);
      rows = [];
    }
    cache[key] = rows;
    writeFileSync(cachePath, JSON.stringify(cache));
  }
  // Positional mapping: the model was told to keep order. Guard it anyway by
  // preferring a name match when one is available.
  const byName = new Map();
  for (const r of rows) {
    if (r && typeof r.name === 'string') byName.set(r.name.toLowerCase().trim(), r);
  }
  batch.forEach((item, i) => {
    const raw = byName.get(item.name.toLowerCase().trim()) ?? rows[i];
    const rec = toRecord(raw);
    if (rec) results.set(item.id, { ...item, ...rec });
  });
  done += batch.length;
  if (bi % 10 === 0) console.log(`  ${done}/${items.length}`);
});
console.log(`Batch calls this run: ${calls}`);

// --------------------------- retry the failures individually ---------------------------
const failed = items.filter((it) => {
  const r = results.get(it.id);
  return !r || !r.valid;
});
console.log(`${failed.length} foods need an individual retry`);

let retryCalls = 0;
await pool(failed, CONCURRENCY, async (item) => {
  const key = `${PROMPT_VERSION}::${MODEL}::solo::${item.id}`;
  let raw = cache[key];
  if (!raw) {
    retryCalls++;
    const prev = results.get(item.id);
    const why = prev?.reasons?.length ? ` Your previous attempt failed: ${prev.reasons.join('; ')}.` : '';
    try {
      const text = await transport({
        system: SYSTEM,
        messages: [{ role: 'user', content: `Foods:\n1. ${item.name}\n${why} Recompute carefully so energy matches the macros.` }],
        maxTokens: 3000,
      });
      raw = parseArray(text)[0] ?? null;
    } catch { raw = null; }
    cache[key] = raw;
    writeFileSync(cachePath, JSON.stringify(cache));
  }
  const rec = toRecord(raw);
  if (rec?.valid) results.set(item.id, { ...item, ...rec });
});
console.log(`Individual retry calls this run: ${retryCalls}`);

// --------------------------- assemble the shipped library ---------------------------
const foods = {};
let dropped = 0;
for (const it of items) {
  const r = results.get(it.id);
  if (!r || !r.valid) { dropped++; continue; }
  const serve = r.servingG && r.servingG >= 5 && r.servingG <= 1500 ? Math.round(r.servingG) : null;
  foods[it.id] = {
    name: it.name.replace(/\b\w/g, (c) => c.toUpperCase()),
    group: it.group,
    per100g: r.per100g,
    portions: serve ? [['1 serving', serve]] : [],
    prior: serve ? { servingG: serve } : undefined,
    confidence: r.confidence ?? null,
  };
}

const library = {
  version: PROMPT_VERSION,
  source: `Computed at build time by Claude (${MODEL}) from standard recipes, per 100 g as eaten;`
    + ' every row validated against 4P+4C+9F-2Fib energy consistency and physical range limits.'
    + ' Estimates, not laboratory measurements: no micronutrients are reported, because those'
    + ' come from measurement rather than reasoning. Foods in nutrition-db.json (USDA FNDDS) are'
    + ' excluded from this library and keep their full measured profile.',
  count: Object.keys(foods).length,
  foods,
};
writeFileSync(join(root, 'app/public/data/nutrition-library.json'), JSON.stringify(library));

const size = JSON.stringify(library).length;
console.log(`\nlibrary: ${library.count} foods shipped, ${dropped} dropped as unusable`);
console.log(`nutrition-library.json: ${(size / 1024).toFixed(0)} KB raw`);

// A quick honesty check on what shipped.
const kcals = Object.values(foods).map((f) => f.per100g.kcal);
const mean = kcals.reduce((a, b) => a + b, 0) / (kcals.length || 1);
const worst = Object.entries(foods)
  .map(([id, f]) => [id, Math.abs(f.per100g.kcal - atwaterKcal(f.per100g))])
  .sort((a, b) => b[1] - a[1])[0];
console.log(`mean ${mean.toFixed(0)} kcal/100 g · largest Atwater gap: ${worst?.[0]} at ${worst?.[1].toFixed(1)} kcal`);
