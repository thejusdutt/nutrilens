/**
 * Build the list of foods the offline library should cover.
 *
 * The shipped USDA set is ~240 foods, which is enough to name what a camera sees
 * but nowhere near what a person logs. This produces the *catalogue* — names
 * only, no numbers — that compute-food-library.mjs then costs out with Claude.
 *
 * Names come from Claude because the question "what do people actually eat and
 * log, worldwide" is exactly the kind of broad-coverage recall it is good at, and
 * a hand-typed list would be both shorter and skewed to whatever the author eats.
 * Every name is then normalised and deduplicated here, in code, against itself
 * and against the existing vocabulary — the model is never trusted to dedupe.
 *
 * Output: tools/data/food-catalogue.json  { generatedFor, groups, items[] }
 *
 * Usage: node tools/build-food-catalogue.mjs [--per-group 60] [--refresh]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bedrockTransport } from '@nutrilens/claude-nutrition/bedrock-cli';
import { VOCABULARY } from './vocabulary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(root, 'tools/data');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const PER_GROUP = Number(opt('per-group', 60));
const REFRESH = argv.includes('--refresh');
const MODEL = opt('model', 'eu.anthropic.claude-sonnet-5');

/**
 * The coverage plan. Split by cuisine AND by category, because the two miss
 * different things: a cuisine prompt returns restaurant dishes and forgets that
 * people log a plain banana, and a category prompt returns generic staples and
 * forgets regional cooking. Everyday staples get the largest quotas — the long
 * tail matters less than being unable to log an egg the way it was cooked.
 */
const GROUPS = [
  // Staples and single ingredients — the highest-frequency log entries.
  { key: 'staple-grains', prompt: 'plain cooked grains, rices, breads, pastas and noodles as eaten (specify cooked, and the type)', weight: 1.4 },
  { key: 'staple-proteins', prompt: 'plain cooked meats, poultry, fish, eggs, tofu and pulses, by cut and cooking method (grilled, roasted, fried, boiled)', weight: 1.6 },
  { key: 'staple-dairy', prompt: 'milks, yogurts, cheeses, butters and cream, including common varieties and fat levels', weight: 1.0 },
  { key: 'staple-vegetables', prompt: 'common vegetables as eaten, raw and cooked, including the usual cooking methods', weight: 1.3 },
  { key: 'staple-fruits', prompt: 'common fresh fruits, dried fruits and fruit preparations', weight: 1.0 },
  { key: 'staple-fats-nuts', prompt: 'cooking oils, nuts, seeds, nut butters and spreads', weight: 0.8 },
  { key: 'drinks', prompt: 'everyday drinks: teas, coffees with and without milk, juices, soft drinks, beers, wines, spirits, smoothies, protein shakes', weight: 1.2 },
  { key: 'breakfast', prompt: 'breakfast foods and cereals worldwide', weight: 1.0 },
  { key: 'snacks-sweets', prompt: 'snacks, crisps, biscuits, chocolate, ice creams, cakes and desserts', weight: 1.2 },
  { key: 'fastfood', prompt: 'fast food and takeaway items as sold (burgers, fried chicken, pizza slices, wraps, fries, doner, sandwiches)', weight: 1.2 },
  { key: 'condiments', prompt: 'sauces, dressings, chutneys, dips, pickles and spreads', weight: 0.9 },
  { key: 'composed-salads', prompt: 'salads and grain bowls as served, with their dressings', weight: 0.8 },
  { key: 'soups', prompt: 'soups, broths and stews from around the world', weight: 0.9 },
  // Cuisines — cooked dishes as ordered.
  { key: 'indian', prompt: 'Indian and South Asian dishes: curries, breads, rice dishes, South Indian tiffin, street food, sweets', weight: 1.8 },
  { key: 'chinese', prompt: 'Chinese dishes across regions, including dim sum and takeaway staples', weight: 1.2 },
  { key: 'japanese', prompt: 'Japanese dishes: rice bowls, noodles, sushi types, grilled dishes, side dishes', weight: 1.0 },
  { key: 'korean', prompt: 'Korean dishes including banchan, stews and barbecue', weight: 0.8 },
  { key: 'thai-sea', prompt: 'Thai, Vietnamese, Malaysian, Indonesian and Filipino dishes', weight: 1.1 },
  { key: 'italian', prompt: 'Italian dishes: pastas with named sauces, pizzas, risottos, antipasti', weight: 1.1 },
  { key: 'mexican-latam', prompt: 'Mexican and Latin American dishes', weight: 1.1 },
  { key: 'middle-east', prompt: 'Middle Eastern, Levantine, Turkish, Persian and North African dishes', weight: 1.1 },
  { key: 'european', prompt: 'French, German, Spanish, Greek, Polish, Nordic and British dishes', weight: 1.2 },
  { key: 'american', prompt: 'North American home cooking and diner dishes', weight: 1.0 },
  { key: 'african', prompt: 'West, East and Southern African dishes', weight: 0.8 },
  { key: 'caribbean', prompt: 'Caribbean dishes', weight: 0.6 },
  { key: 'baked-goods', prompt: 'breads, pastries, and baked goods worldwide', weight: 0.9 },
];

const SYSTEM = [
  'You list food names for a nutrition database. You are asked for a category and',
  'you reply with dish and food names only — no numbers, no descriptions.',
  '',
  'Rules:',
  '- Name foods the way a person logging a meal would search for them.',
  '- Be specific enough that the nutrition is well defined: say "grilled chicken breast, skinless"',
  '  rather than "chicken", and "whole milk" rather than "milk".',
  '- Prefer things that are actually eaten often over obscure regional rarities.',
  '- Include the cooking method where it changes the nutrition (fried vs boiled).',
  '- No brand names. No duplicates within your list.',
  '- Use plain lowercase English names; keep well-known non-English dish names as they are',
  '  (dosa, pho, gnocchi), without diacritics where avoidable.',
  '',
  'Reply with ONLY a minified JSON array of strings. No prose, no code fence.',
].join('\n');

const cachePath = join(DATA, 'food-catalogue-cache.json');
const cache = (!REFRESH && existsSync(cachePath)) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const transport = bedrockTransport({ model: MODEL, effort: 'low' });

/** Normalise a name to a comparison key: lowercase, no punctuation/diacritics, sorted-insensitive. */
function normKey(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Stable kebab id from a name. */
function toId(s) {
  return normKey(s).replace(/ /g, '-').slice(0, 60);
}

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => { while (true) { const i = next++; if (i >= items.length) return; out[i] = await worker(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

console.log(`Requesting ${GROUPS.length} groups (~${PER_GROUP} names each, weighted) with ${MODEL}`);
let calls = 0;
const lists = await pool(GROUPS, 5, async (g) => {
  const want = Math.round(PER_GROUP * g.weight);
  const key = `${g.key}::${want}`;
  if (cache[key]) return { g, names: cache[key] };
  calls++;
  const text = await transport({
    system: SYSTEM,
    messages: [{ role: 'user', content: `Category: ${g.prompt}\nList ${want} food names.` }],
    maxTokens: 4000,
  });
  let names = [];
  try {
    names = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  } catch (e) {
    console.warn(`  ! ${g.key}: unparseable reply (${e.message})`);
  }
  names = names.filter((x) => typeof x === 'string' && x.trim().length > 1);
  cache[key] = names;
  writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`  ${g.key}: ${names.length}`);
  return { g, names };
});
console.log(`Catalogue calls this run: ${calls}`);

// --------------------------- dedupe, in code ---------------------------
// Against the existing vocabulary first (those foods already ship with full USDA
// micronutrients — the library must not shadow them), then against itself.
const existing = new Set();
for (const v of VOCABULARY) {
  if (v.nonFood) continue;
  existing.add(normKey(v.name));
  for (const s of v.syn ?? []) existing.add(normKey(s));
}

const items = [];
const seen = new Set();
let dropExisting = 0; let dropDup = 0;
for (const { g, names } of lists) {
  for (const raw of names) {
    const name = String(raw).trim().replace(/\s+/g, ' ');
    const k = normKey(name);
    if (!k || k.length < 2) continue;
    if (existing.has(k)) { dropExisting++; continue; }
    if (seen.has(k)) { dropDup++; continue; }
    seen.add(k);
    items.push({ id: toId(name), name, group: g.key });
  }
}
// Ids must be unique too (two different names can normalise alike after slicing).
const byId = new Map();
for (const it of items) {
  let id = it.id; let n = 2;
  while (byId.has(id)) id = `${it.id}-${n++}`;
  it.id = id;
  byId.set(id, it);
}

const out = {
  generatedFor: MODEL,
  groups: GROUPS.map((g) => g.key),
  count: items.length,
  items,
};
writeFileSync(join(DATA, 'food-catalogue.json'), JSON.stringify(out, null, 0));
console.log(`\ncatalogue: ${items.length} foods (dropped ${dropExisting} already in vocabulary, ${dropDup} duplicates)`);
const perGroup = {};
for (const it of items) perGroup[it.group] = (perGroup[it.group] ?? 0) + 1;
console.log(Object.entries(perGroup).map(([k, n]) => `${k}:${n}`).join('  '));
console.log('wrote tools/data/food-catalogue.json');
