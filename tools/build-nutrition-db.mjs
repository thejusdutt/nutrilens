/**
 * Build the offline nutrition database + runtime vocabulary from USDA FNDDS.
 *
 * Inputs : tools/data/fndds/**  (FoodData Central survey_food CSV release)
 *          tools/vocabulary.mjs (canonical food vocabulary + FNDDS queries)
 *          app/public/models/swin-food101/config.json (id2label → f101 indices)
 * Outputs: app/public/data/nutrition-db.json
 *          app/public/data/vocabulary.json
 *          tools/data/mapping-report.txt (human review of every mapping)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOCABULARY, priorsFor } from './vocabulary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnddsDir = (() => {
  const base = join(root, 'tools/data/fndds');
  const sub = readdirSync(base).find((d) => d.startsWith('FoodData'));
  return join(base, sub);
})();

// --------------------------- tiny CSV parser ---------------------------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}
const load = (f) => parseCSV(readFileSync(join(fnddsDir, f), 'utf8'));

console.log('Loading FNDDS CSVs from', fnddsDir);
const foods = load('food.csv');
const nutrients = load('nutrient.csv');
const foodNutrients = load('food_nutrient.csv');
const portions = load('food_portion.csv');

// --------------------------- nutrient key map ---------------------------
/** canonical key → [FNDDS nutrient name, display name, unit, FDA adult DV] */
const NUTRIENT_MAP = {
  kcal:        ['Energy',                             'Calories',      'kcal', 2000],
  protein:     ['Protein',                            'Protein',       'g',    50],
  fat:         ['Total lipid (fat)',                  'Fat',           'g',    78],
  carbs:       ['Carbohydrate, by difference',        'Carbohydrates', 'g',    275],
  fiber:       ['Fiber, total dietary',               'Fiber',         'g',    28],
  sugars:      ['Sugars, Total'                ,       'Sugars',        'g',    null],
  satFat:      ['Fatty acids, total saturated',       'Saturated fat', 'g',    20],
  monoFat:     ['Fatty acids, total monounsaturated', 'Monounsaturated fat', 'g', null],
  polyFat:     ['Fatty acids, total polyunsaturated', 'Polyunsaturated fat', 'g', null],
  cholesterol: ['Cholesterol',                        'Cholesterol',   'mg',   300],
  sodium:      ['Sodium, Na',                         'Sodium',        'mg',   2300],
  potassium:   ['Potassium, K',                       'Potassium',     'mg',   4700],
  calcium:     ['Calcium, Ca',                        'Calcium',       'mg',   1300],
  iron:        ['Iron, Fe',                           'Iron',          'mg',   18],
  magnesium:   ['Magnesium, Mg',                      'Magnesium',     'mg',   420],
  phosphorus:  ['Phosphorus, P',                      'Phosphorus',    'mg',   1250],
  zinc:        ['Zinc, Zn',                           'Zinc',          'mg',   11],
  copper:      ['Copper, Cu',                         'Copper',        'mg',   0.9],
  selenium:    ['Selenium, Se',                       'Selenium',      'µg',   55],
  vitA:        ['Vitamin A, RAE',                     'Vitamin A',     'µg',   900],
  vitC:        ['Vitamin C, total ascorbic acid',     'Vitamin C',     'mg',   90],
  vitD:        ['Vitamin D (D2 + D3)',                'Vitamin D',     'µg',   20],
  vitE:        ['Vitamin E (alpha-tocopherol)',       'Vitamin E',     'mg',   15],
  vitK:        ['Vitamin K (phylloquinone)',          'Vitamin K',     'µg',   120],
  thiamin:     ['Thiamin',                            'Thiamin (B1)',  'mg',   1.2],
  riboflavin:  ['Riboflavin',                         'Riboflavin (B2)', 'mg', 1.3],
  niacin:      ['Niacin',                             'Niacin (B3)',   'mg',   16],
  vitB6:       ['Vitamin B-6',                        'Vitamin B6',    'mg',   1.7],
  folate:      ['Folate, DFE',                        'Folate',        'µg',   400],
  vitB12:      ['Vitamin B-12',                       'Vitamin B12',   'µg',   2.4],
  choline:     ['Choline, total',                     'Choline',       'mg',   550],
};

// NOTE: food_nutrient.csv's `nutrient_id` column actually holds the legacy
// `nutrient_nbr`, not `nutrient.id`. Join on nutrient_nbr. "Energy" appears
// twice (KCAL and kJ) — keep the KCAL row only.
const nutrientNbrByName = new Map();
for (const n of nutrients) {
  if (n.name === 'Energy' && n.unit_name !== 'KCAL') continue;
  if (!nutrientNbrByName.has(n.name)) nutrientNbrByName.set(n.name, n.nutrient_nbr);
}
const keyByNutrientId = new Map();
for (const [key, [fnddsName]] of Object.entries(NUTRIENT_MAP)) {
  const nbr = nutrientNbrByName.get(fnddsName);
  if (!nbr) { console.error(`!! nutrient not found in FNDDS: ${fnddsName}`); continue; }
  keyByNutrientId.set(nbr, key);
}

// fdc_id → { key: per100g }
const nutrientsByFood = new Map();
for (const fn of foodNutrients) {
  const key = keyByNutrientId.get(fn.nutrient_id);
  if (!key) continue;
  let rec = nutrientsByFood.get(fn.fdc_id);
  if (!rec) nutrientsByFood.set(fn.fdc_id, (rec = {}));
  rec[key] = parseFloat(fn.amount);
}

// fdc_id → [[label, grams]]
const portionsByFood = new Map();
for (const p of portions) {
  const g = parseFloat(p.gram_weight);
  if (!g || g <= 0) continue;
  const label = (p.portion_description || p.modifier || '').trim();
  if (!label || /quantity not specified/i.test(label)) continue;
  let list = portionsByFood.get(p.fdc_id);
  if (!list) portionsByFood.set(p.fdc_id, (list = []));
  if (list.length < 6 && !list.some(([l]) => l === label)) list.push([label, Math.round(g)]);
}

// --------------------------- vocabulary → FNDDS matching ---------------------------
const foodIndex = foods.map((f) => {
  const lower = f.description.toLowerCase();
  const words = lower.split(/[^a-z0-9%]+/).filter(Boolean);
  return { fdcId: f.fdc_id, desc: f.description, lower, words: new Set(words), firstWord: words[0] };
});

function matchQuery(query) {
  const q = query.toLowerCase();
  const tokens = q.split(/[^a-z0-9%]+/).filter(Boolean); // same tokenization as descriptions
  let best = null, bestScore = -Infinity;
  for (const f of foodIndex) {
    // Whole-word matching only. Substring matching caused catastrophic
    // mis-mappings: 'Roti' ⊂ 'ROTIsserie chicken', 'Lassi' ⊂ 'cLASSIc mixed
    // vegetables', 'meat' ⊂ 'no MEAT'.
    if (!tokens.every((t) => f.words.has(t))) continue;
    let score = -f.desc.length;
    if (f.lower === q) score += 1000;
    // FNDDS names the primary food first ("Cake, chocolate…", "Oatmeal,
    // regular…"); a description that *starts* with the query's head token is
    // that food, one that merely mentions it ("Cookie, oatmeal") is not.
    if (f.firstWord === tokens[0]) score += 120;
    if (f.lower.startsWith(q)) score += 80;
    if (/\bNFS\b|NS as to/i.test(f.desc)) score += 25; // generic entries better represent a class
    if (nutrientsByFood.get(f.fdcId)?.kcal == null) score -= 500;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return best;
}

const dbFoods = {};
const vocabOut = [];
const reportLines = [];
let unmatched = 0;

// Resolve Food-101 label → logits index from the classifier config.
const swinCfg = JSON.parse(readFileSync(join(root, 'app/public/models/swin-food101/config.json'), 'utf8'));
const f101Index = new Map(Object.entries(swinCfg.id2label).map(([i, l]) => [l, Number(i)]));

for (const entry of VOCABULARY) {
  if (entry.nonFood) {
    vocabOut.push({ id: entry.id, name: entry.name, f101: null, nonFood: true });
    continue;
  }
  const queries = Array.isArray(entry.fndds) ? entry.fndds : [entry.fndds];
  let match = null, usedQuery = null;
  for (const q of queries) {
    match = matchQuery(q);
    if (match) { usedQuery = q; break; }
  }
  if (!match) {
    unmatched++;
    reportLines.push(`UNMATCHED  ${entry.id}  (queries: ${queries.join(' | ')})`);
    continue;
  }
  const per100g = nutrientsByFood.get(match.fdcId) ?? {};
  const prior = priorsFor(entry);
  const portionList = portionsByFood.get(match.fdcId) ?? [];
  dbFoods[entry.id] = {
    name: entry.name,
    fdcId: Number(match.fdcId),
    fdcDesc: match.desc,
    aliases: entry.syn ?? [],
    per100g: Object.fromEntries(Object.entries(per100g).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    portions: portionList,
    prior,
  };
  const f101 = entry.f101 != null ? f101Index.get(entry.f101) : null;
  if (entry.f101 != null && f101 == null) throw new Error(`bad f101 label: ${entry.f101}`);
  vocabOut.push({ id: entry.id, name: entry.name, f101, nonFood: false });
  reportLines.push(`${entry.id.padEnd(26)} ${String(per100g.kcal ?? '??').padStart(5)} kcal/100g  ← [${usedQuery}] ${match.desc}`);
}

// --------------------------- validation gate ---------------------------
// The build FAILS if the data is implausible. Three layers:
//  1. Atwater consistency: kcal ≈ 4·protein + 4·carbs + 9·fat (catches join
//     errors and unit mix-ups).
//  2. Physical ranges per 100 g.
//  3. Golden references: well-known foods must match published USDA values
//     (catches semantic mis-mappings like 'Roti' → 'ROTIsserie chicken').
const GOLDEN = {
  // id: [kcal, ±kcalTol, protein g, ±proteinTol] per 100 g
  'plain-rice': [130, 20, 2.7, 1],
  banana: [93, 15, 1, 0.6],
  apple: [58, 12, 0.4, 0.4],
  pizza: [270, 45, 11, 3],
  hamburger: [280, 60, 16, 4],
  'boiled-egg': [150, 25, 12.5, 2],
  'chicken-curry': [120, 45, 9, 4],
  chapati: [300, 70, 8, 3.5],
  oatmeal: [70, 25, 2.5, 1.5],
  'apple-pie': [240, 60, 2, 1.5],
  dal: [130, 50, 7, 3],
  'french-fries': [280, 70, 3.5, 1.5],
  avocado: [160, 25, 2, 1],
  'chocolate-cake': [370, 70, 4.5, 2],
  'steamed-broccoli': [40, 25, 3, 1.5],
  'potato-chips': [540, 60, 6.5, 2.5],
  bacon: [470, 90, 34, 8],
  sushi: [140, 50, 5, 3],
  'fried-rice': [175, 45, 4.5, 2],
  'lassi': [80, 40, 3, 2],
  'paneer-tikka': [300, 80, 19, 6],
  coffee: [2, 3, 0.2, 0.3],
};
const problems = [];
for (const [id, f] of Object.entries(dbFoods)) {
  const { kcal = 0, protein = 0, carbs = 0, fat = 0 } = f.per100g;
  const atwater = 4 * protein + 4 * carbs + 9 * fat;
  if (Math.abs(kcal - atwater) > Math.max(20, atwater * 0.25)) {
    problems.push(`${id}: kcal=${kcal} inconsistent with macros (4P+4C+9F=${atwater.toFixed(0)}) [${f.fdcDesc}]`);
  }
  if (kcal < 0 || kcal > 900 || protein > 45 || fat > 100 || carbs > 95 || protein + carbs + fat > 105) {
    problems.push(`${id}: implausible per-100g values kcal=${kcal} P=${protein} C=${carbs} F=${fat} [${f.fdcDesc}]`);
  }
}
for (const [id, [kcal, kTol, protein, pTol]] of Object.entries(GOLDEN)) {
  const f = dbFoods[id];
  if (!f) { problems.push(`golden food missing from DB: ${id}`); continue; }
  if (Math.abs(f.per100g.kcal - kcal) > kTol) {
    problems.push(`${id}: kcal ${f.per100g.kcal} outside golden ${kcal}±${kTol} [${f.fdcDesc}]`);
  }
  if (Math.abs(f.per100g.protein - protein) > pTol) {
    problems.push(`${id}: protein ${f.per100g.protein} outside golden ${protein}±${pTol} [${f.fdcDesc}]`);
  }
}
if (problems.length) {
  console.error(`\nVALIDATION FAILED (${problems.length}):`);
  for (const p of problems) console.error('  ✗', p);
  process.exit(1);
}
console.log(`validation: Atwater + ranges (${Object.keys(dbFoods).length} foods) + ${Object.keys(GOLDEN).length} golden references — all pass`);

const db = {
  version: '2024-10-31',
  source: 'USDA FoodData Central, Survey Foods (FNDDS 2021-2023), public domain',
  nutrients: Object.fromEntries(Object.entries(NUTRIENT_MAP).map(([k, [, name, unit, rdi]]) => [k, { name, unit, rdi }])),
  foods: dbFoods,
};

writeFileSync(join(root, 'app/public/data/nutrition-db.json'), JSON.stringify(db));
writeFileSync(join(root, 'app/public/data/vocabulary.json'), JSON.stringify(vocabOut));
writeFileSync(join(root, 'tools/data/mapping-report.txt'), reportLines.join('\n'));

const size = JSON.stringify(db).length;
console.log(`foods mapped: ${Object.keys(dbFoods).length}, unmatched: ${unmatched}`);
console.log(`nutrition-db.json: ${(size / 1024).toFixed(0)} KB raw`);
if (unmatched) console.log('review tools/data/mapping-report.txt for UNMATCHED entries');
