/**
 * Download the evaluation datasets through the HuggingFace datasets-server:
 *
 *  1. Food-101 official validation split (ethz/food101), stratified
 *     N-per-class sample (default 25 → 2,525 images) — measures the
 *     closed-set head + fusion.
 *  2. Indian food images (rajistics/indian_food_images) for classes that map
 *     faithfully onto the NutriLens canonical vocabulary — measures the
 *     open-vocabulary head on foods outside Food-101.
 *
 * Layout: eval/data/food101/<class_name>/<idx>.jpg
 *         eval/data/extended/<canonical-id>/<idx>.jpg
 *
 * Usage: node eval/fetch-dataset.mjs [--per-class 25] [--extended-per-class 20]
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const PER_CLASS = argVal('--per-class', 25);
const EXT_PER_CLASS = argVal('--extended-per-class', 20);
const API = 'https://datasets-server.huggingface.co';

async function getJSON(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      if (!j.error) return j;
    }
    await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error(`gave up on ${url}`);
}

async function download(url, path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      return true;
    } catch { await new Promise((r) => setTimeout(r, 1500)); }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Food-101 validation, stratified via /filter
// ---------------------------------------------------------------------------
async function fetchFood101() {
  const meta = await getJSON(`${API}/rows?dataset=ethz%2Ffood101&config=default&split=validation&offset=0&length=1`);
  const classNames = meta.features.find((f) => f.name === 'label').type.names;
  console.log(`Food-101: ${classNames.length} classes, ${PER_CLASS}/class`);
  for (let label = 0; label < classNames.length; label++) {
    const cls = classNames[label];
    const dir = join(root, 'eval/data/food101', cls);
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length >= PER_CLASS) { console.log(`  skip ${cls}`); continue; }
    const j = await getJSON(`${API}/filter?dataset=ethz%2Ffood101&config=default&split=validation&where=${encodeURIComponent(`"label"=${label}`)}&offset=0&length=${PER_CLASS}`);
    let n = 0;
    for (const row of j.rows) {
      const ok = await download(row.row.image.src, join(dir, `${row.row_idx}.jpg`));
      if (ok) n++;
    }
    console.log(`  ${cls}: ${n}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Extended vocabulary (Indian foods) — classes with faithful mappings only
// ---------------------------------------------------------------------------
const INDIAN_MAP = {
  butter_naan: 'naan', chapati: 'chapati', chole_bhature: 'chana-masala',
  dal_makhani: 'dal', fried_rice: 'fried-rice', idli: 'idli', jalebi: 'jalebi',
  masala_dosa: 'dosa', momos: 'dumplings', pakode: 'pakora',
  samosa: 'samosa', pizza: 'pizza', burger: 'hamburger',
};

async function fetchExtended() {
  const ds = 'rajistics%2Findian_food_images';
  const meta = await getJSON(`${API}/rows?dataset=${ds}&config=default&split=train&offset=0&length=1`);
  const classNames = meta.features.find((f) => f.name === 'label').type.names;
  console.log(`Extended: ${Object.keys(INDIAN_MAP).length} mapped classes, ${EXT_PER_CLASS}/class`);
  for (const [srcCls, canonical] of Object.entries(INDIAN_MAP)) {
    const label = classNames.indexOf(srcCls);
    if (label < 0) { console.warn(`  !! class missing upstream: ${srcCls}`); continue; }
    const dir = join(root, 'eval/data/extended', canonical);
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length >= EXT_PER_CLASS) { console.log(`  skip ${canonical}`); continue; }
    const j = await getJSON(`${API}/filter?dataset=${ds}&config=default&split=train&where=${encodeURIComponent(`"label"=${label}`)}&offset=0&length=${EXT_PER_CLASS}`);
    let n = 0;
    for (const row of j.rows) {
      const ok = await download(row.row.image.src, join(dir, `${row.row_idx}.jpg`));
      if (ok) n++;
    }
    console.log(`  ${canonical} (${srcCls}): ${n}`);
  }
}

await fetchFood101();
await fetchExtended();
console.log('dataset fetch complete');
