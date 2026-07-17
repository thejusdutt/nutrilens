/**
 * Fetch per-cuisine evaluation images from Wikimedia Commons for vocabulary
 * classes that no HF dataset covers (Mexican, Spanish, Chinese staples plus
 * extra Indian dishes outside rajistics/indian_food_images).
 *
 * For each class we prefer members of a curated Commons category and fall
 * back to a namespace-6 (File) search. Only bitmap photos are kept; obvious
 * non-photo files (svg, maps, diagrams, logos) are skipped by name.
 *
 * Layout: eval/data/cuisine/<cuisine>/<canonical-id>/<n>.jpg
 * Usage:  node eval/fetch-commons.mjs [--per-class 15]
 */
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--per-class');
const PER_CLASS = i >= 0 ? Number(args[i + 1]) : 15;

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'NutriLens-eval/1.0 (offline food recognition eval; contact: dutt.thejus@gmail.com)';

/**
 * cuisine → classes; each class: canonical vocab id, Commons category, search
 * fallback, and a title regex `re` — a file is kept ONLY if its title matches,
 * which is the main defense against label noise (search once returned a
 * pumpkin pie for "empanada food").
 */
export const CLASSES = [
  // Mexican
  { cuisine: 'mexican', id: 'enchiladas', cat: 'Enchiladas', q: 'enchiladas plate', re: /enchilada/i },
  { cuisine: 'mexican', id: 'tamales', cat: 'Tamales', q: 'tamales food', re: /tamal/i },
  { cuisine: 'mexican', id: 'fajitas', cat: 'Fajitas', q: 'fajitas food', re: /fajita/i },
  { cuisine: 'mexican', id: 'chilaquiles', cat: 'Chilaquiles', q: 'chilaquiles', re: /chilaquil/i },
  { cuisine: 'mexican', id: 'taquitos', cat: 'Taquitos', q: 'taquitos flautas food', re: /taquito|flauta/i },
  { cuisine: 'mexican', id: 'refried-beans', cat: 'Refried beans', q: 'refried beans', re: /refried|refrito/i },
  { cuisine: 'mexican', id: 'mexican-rice', cat: 'Mexican rice', q: 'mexican rice dish', re: /mexican rice|spanish rice|arroz (a la mexicana|rojo|mexicano)/i },
  { cuisine: 'mexican', id: 'pozole', cat: 'Pozole', q: 'pozole soup', re: /po[sz]ole/i },
  { cuisine: 'mexican', id: 'burrito-bowl', cat: 'Burrito bowls', q: 'burrito bowl', re: /burrito bowl/i },
  // Spanish
  { cuisine: 'spanish', id: 'tortilla-espanola', cat: 'Tortilla de patatas', q: 'tortilla española', re: /tortilla (de patatas|espa[ñn]ola)|spanish (tortilla|omelet)/i },
  { cuisine: 'spanish', id: 'gazpacho', cat: 'Gazpacho', q: 'gazpacho soup', re: /gazpacho/i },
  { cuisine: 'spanish', id: 'croquetas', cat: 'Croquettes of Spain', q: 'croquetas', re: /croquet/i },
  { cuisine: 'spanish', id: 'patatas-bravas', cat: 'Patatas bravas', q: 'patatas bravas', re: /bravas/i },
  { cuisine: 'spanish', id: 'empanadas', cat: 'Empanadas', q: 'empanada food', re: /empanad/i },
  // Chinese (classes outside Food-101)
  { cuisine: 'chinese', id: 'chow-mein', cat: 'Chow mein', q: 'chow mein noodles', re: /chow mein|chao ?mian|炒面|炒麵/i },
  { cuisine: 'chinese', id: 'sweet-and-sour-pork', cat: 'Sweet and sour pork', q: 'sweet and sour pork', re: /sweet and sour|gu ?lao ?rou|咕嚕肉|糖醋/i },
  { cuisine: 'chinese', id: 'kung-pao-chicken', cat: 'Kung Pao chicken', q: 'kung pao chicken', re: /kung pao|gong ?bao|宫保|宮保/i },
  { cuisine: 'chinese', id: 'mapo-tofu', cat: 'Mapo doufu', q: 'mapo tofu', re: /mapo|麻婆/i },
  { cuisine: 'chinese', id: 'congee', cat: 'Congee', q: 'congee rice porridge', re: /congee|porridge|juk|zhou|粥/i },
  { cuisine: 'chinese', id: 'wonton-soup', cat: 'Wonton soup', q: 'wonton soup', re: /wonton|wanton|馄饨|雲吞|餛飩/i },
  { cuisine: 'chinese', id: 'general-tso-chicken', cat: "General Tso's chicken", q: 'general tso chicken', re: /general tso|左宗棠/i },
  { cuisine: 'chinese', id: 'baozi', cat: 'Baozi', q: 'baozi steamed bun', re: /baozi|steamed bun|包子|\bbao\b/i },
  // Indian (classes outside rajistics/indian_food_images)
  { cuisine: 'indian', id: 'biryani', cat: 'Biryani', q: 'biryani', re: /bir[iy]?[ay]ani/i },
  { cuisine: 'indian', id: 'vada', cat: 'Vada (food)', q: 'medu vada', re: /vada|vadai/i },
  { cuisine: 'indian', id: 'gulab-jamun', cat: 'Gulab jamun', q: 'gulab jamun', re: /gulab/i },
  { cuisine: 'indian', id: 'paratha', cat: 'Paratha', q: 'paratha', re: /paratha|parotta/i },
];

const BAD_NAME = /\.(svg|gif|tiff?|pdf|webm|ogv)$|map|logo|diagram|chart|menu|sign|label|poster|drawing|painting|illustration|packag|can of|tin of/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paced download with backoff — Commons throttles unauthenticated bursts. */
async function fetchWithBackoff(url, tries = 5) {
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404) return null;
      await sleep(res.status === 429 ? 8000 * (t + 1) : 2500 * (t + 1));
    } catch { await sleep(2500 * (t + 1)); }
  }
  return null;
}

async function api(params, tries = 4) {
  const url = `${API}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000 * (t + 1)));
  }
  throw new Error(`commons api gave up: ${JSON.stringify(params)}`);
}

/** File titles from a category (files only). */
async function categoryFiles(cat) {
  const j = await api({ action: 'query', list: 'categorymembers', cmtitle: `Category:${cat}`, cmtype: 'file', cmlimit: '100' });
  return (j.query?.categorymembers ?? []).map((m) => m.title);
}

/** File titles from full-text search in the File namespace. */
async function searchFiles(q) {
  const j = await api({ action: 'query', list: 'search', srnamespace: '6', srsearch: q, srlimit: '50' });
  return (j.query?.search ?? []).map((m) => m.title);
}

/** title → 640px thumb URL (jpeg/png only). */
async function thumbUrls(titles) {
  const out = new Map();
  for (let k = 0; k < titles.length; k += 50) {
    const j = await api({ action: 'query', titles: titles.slice(k, k + 50).join('|'), prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '640' });
    for (const p of Object.values(j.query?.pages ?? {})) {
      const ii = p.imageinfo?.[0];
      if (ii && /image\/(jpeg|png)/.test(ii.mime)) out.set(p.title, ii.thumburl ?? ii.url);
    }
  }
  return out;
}

async function fetchClass({ cuisine, id, cat, q, re }) {
  const dir = join(root, 'eval/data/cuisine', cuisine, id);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length >= PER_CLASS) { console.log(`  skip ${cuisine}/${id}`); return; }

  const keep = (t) => !BAD_NAME.test(t) && re.test(t);
  let titles = (await categoryFiles(cat)).filter(keep);
  const source = titles.length >= 8 ? `category (${titles.length})` : 'search';
  if (titles.length < 8) {
    const extra = (await searchFiles(q)).filter(keep);
    titles = [...new Set([...titles, ...extra])];
  }
  const urls = await thumbUrls(titles.slice(0, PER_CLASS * 3));
  let n = readdirSync(dir).length;
  for (const [, url] of urls) {
    if (n >= PER_CLASS) break;
    const buf = await fetchWithBackoff(url);
    await sleep(400);
    if (!buf || buf.length < 8_000) continue; // failed / icons / tiny thumbs
    writeFileSync(join(dir, `${n}.jpg`), buf);
    n++;
  }
  console.log(`  ${cuisine}/${id}: ${n} images via ${source}`);
}

for (const c of CLASSES) await fetchClass(c);
console.log('commons fetch complete');
