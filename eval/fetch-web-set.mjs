/**
 * Fetch candidate photos for the vision benchmark from Wikimedia Commons.
 *
 * Unlike eval/fetch-commons.mjs (many images per class, for classifier
 * accuracy), this pulls a few whole-plate photos per query at a phone-like
 * resolution, to be looked at and given ground truth in eval/vision-truth.json.
 * Every file is recorded with its Commons title, page, licence and author in
 * eval/web-sources.json (committed: the images are not ours, and eval/data/ is
 * not in git). When that file exists, the same files are fetched again by
 * exact title, so a fresh clone gets the photos vision-truth.json describes
 * rather than whatever a search returns today.
 *
 * Usage: node eval/fetch-web-set.mjs              # re-fetch the recorded set
 *        node eval/fetch-web-set.mjs --search     # search for new candidates
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'eval/data/web');
const args = process.argv.slice(2);
const i = args.indexOf('--per-query'); // search mode only
const PER = i >= 0 ? Number(args[i + 1]) : 3;

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'NutriLens-eval/1.0 (offline food recognition eval; contact: dutt.thejus@gmail.com)';

/** slug → [search query, title regex a file must match] */
export const QUERIES = {
  'masala-dosa': ['masala dosa chutney', /dosa/i],
  'idli-sambar': ['idli sambar', /idli|idly/i],
  'poha': ['poha breakfast', /poha/i],
  'chole-bhature': ['chole bhature', /bhatur|chole/i],
  'pav-bhaji': ['pav bhaji', /pav.?bhaji/i],
  'rajma-chawal': ['rajma chawal', /rajma/i],
  'aloo-paratha': ['aloo paratha', /paratha|parotta/i],
  'upma': ['upma', /upma/i],
  'biryani': ['chicken biryani plate', /biryani|biriyani/i],
  'omelette': ['omelette plate breakfast', /omelet/i],
  'spaghetti': ['spaghetti bolognese plate', /spaghetti|bolognese/i],
  'burger-fries': ['hamburger french fries plate', /burger/i],
  'ramen': ['ramen bowl', /ramen/i],
  'pancakes': ['pancakes plate syrup', /pancake/i],
  'greek-salad': ['greek salad', /greek salad|horiatiki/i],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    return res.json();
  }
  throw new Error('Commons API kept throttling');
}

const SOURCES = join(root, 'eval/web-sources.json');

if (!args.includes('--search')) {
  // Re-fetch exactly the photos the benchmark uses, by Commons title.
  const recorded = JSON.parse(readFileSync(SOURCES, 'utf8'));
  for (const [path, src] of Object.entries(recorded)) {
    const file = join(OUT, path);
    if (existsSync(file)) continue;
    const found = await api({ action: 'query', titles: src.title, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '1280' });
    const info = Object.values(found.query?.pages ?? {})[0]?.imageinfo?.[0];
    if (!info) { console.log(`${path}: ${src.title} is no longer on Commons`); continue; }
    const res = await fetch(info.thumburl ?? info.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) { console.log(`${path}: HTTP ${res.status}`); continue; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`fetched ${path}`);
    await sleep(400);
  }
  process.exit(0);
}

// Search mode: candidates only. Their sources go to a local file; copy the
// entries for photos you keep into eval/web-sources.json.
const CANDIDATES = join(OUT, 'CANDIDATES.json');
const sources = existsSync(CANDIDATES) ? JSON.parse(readFileSync(CANDIDATES, 'utf8')) : {};
for (const [slug, [q, re]] of Object.entries(QUERIES)) {
  const found = await api({
    action: 'query', generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '30',
    prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: '1280',
  });
  const pages = Object.values(found.query?.pages ?? {})
    .filter((p) => re.test(p.title) && /\.(jpe?g|png)$/i.test(p.title))
    .filter((p) => (p.imageinfo?.[0]?.width ?? 0) >= 800)
    .sort((a, b) => a.index - b.index)
    .slice(0, PER);
  mkdirSync(join(OUT, slug), { recursive: true });
  let n = 0;
  for (const p of pages) {
    const info = p.imageinfo[0];
    const file = join(OUT, slug, `${++n}.jpg`);
    const res = await fetch(info.thumburl ?? info.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) { console.log(`  ${slug}/${n}: HTTP ${res.status}`); continue; }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    sources[`${slug}/${n}.jpg`] = {
      title: p.title, page: info.descriptionurl,
      license: info.extmetadata?.LicenseShortName?.value ?? 'unknown',
      artist: (info.extmetadata?.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim(),
    };
    await sleep(400);
  }
  console.log(`${slug}: ${n} of ${pages.length} candidates`);
}
writeFileSync(CANDIDATES, `${JSON.stringify(sources, null, 2)}\n`);
