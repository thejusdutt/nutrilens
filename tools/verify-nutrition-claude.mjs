/**
 * Cross-verify every food in the shipped database against an independent Claude
 * computation, and write a correction overlay the build step folds back in.
 *
 * Why this exists: USDA FNDDS is authoritative for the foods it names cleanly,
 * but a lot of real dishes have no honest row in it — composed dishes, regional
 * dishes, anything "as served". Those were hand-mapped or mixed, and a hand map
 * is a guess until something independent checks it. Claude computes each dish
 * from a standard recipe, with no sight of the USDA number, so where the two
 * agree we have two-source confirmation, and where they diverge we have a lead.
 *
 * Independence is the point: Claude is never shown the USDA value. Agreement
 * therefore means something.
 *
 * Outputs (all deterministic, all committed so the build stays offline):
 *   tools/data/claude-nutrition-cache.json   raw Claude records, keyed for reuse
 *   tools/data/nutrition-verification.json    full per-food comparison
 *   tools/data/claude-overlay.json            corrections the builder applies
 *   tools/data/nutrition-verification-report.md
 *
 * Usage:
 *   node tools/verify-nutrition-claude.mjs [--limit N] [--only id,id] [--refresh]
 *                                          [--model eu.anthropic.claude-sonnet-5]
 *                                          [--concurrency 5] [--no-apply]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateNutrition, crossVerify, blendPer100g, validatePer100g } from '@nutrilens/claude-nutrition';
import { bedrockTransport } from '@nutrilens/claude-nutrition/bedrock-cli';
import { SYSTEM_PROMPT } from '@nutrilens/claude-nutrition';
import { VOCABULARY } from './vocabulary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(root, 'tools/data');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };

const MODEL = opt('model', 'eu.anthropic.claude-sonnet-5');
const CONCURRENCY = Number(opt('concurrency', 5));
const LIMIT = opt('limit') ? Number(opt('limit')) : Infinity;
const ONLY = opt('only') ? new Set(opt('only').split(',')) : null;
const REFRESH = flag('refresh');
const APPLY = !flag('no-apply');
// Bumping this invalidates the cache: the numbers depend on the prompt.
const PROMPT_VERSION = 'v1';

// Read the pristine USDA baseline (written by the builder before corrections) so
// verification always compares against source values, never against an artifact
// a previous run already corrected.
const basePath = join(DATA, 'nutrition-db.base.json');
const dbPath = existsSync(basePath) ? basePath : join(root, 'app/public/data/nutrition-db.json');
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const vocabById = Object.fromEntries(VOCABULARY.map((v) => [v.id, v]));

// Golden-anchored foods: USDA is the reference for these, so we verify but never
// overwrite them. (Mirrors GOLDEN in build-nutrition-db.mjs + the shipped test.)
const GOLDEN_IDS = new Set([
  'plain-rice', 'banana', 'apple', 'pizza', 'hamburger', 'boiled-egg', 'chicken-curry',
  'chapati', 'oatmeal', 'apple-pie', 'dal', 'french-fries', 'avocado', 'chocolate-cake',
  'steamed-broccoli', 'potato-chips', 'bacon', 'sushi', 'fried-rice', 'lassi', 'paneer-tikka',
  'coffee', 'refried-beans', 'gazpacho', 'general-tso-chicken', 'tamales',
]);

const cachePath = join(DATA, 'claude-nutrition-cache.json');
const cache = (!REFRESH && existsSync(cachePath)) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

// Adaptive thinking occasionally eats the whole token budget and returns no
// answer; --effort low bounds it (and is plenty for recipe arithmetic).
const EFFORT = opt('effort', null);
const transport = bedrockTransport({ model: MODEL, effort: EFFORT });

/** A short, disambiguating description of the dish for the prompt. */
function contextFor(id, food) {
  const v = vocabById[id];
  const bits = [];
  if (v?.cat) bits.push(`category: ${v.cat}`);
  const syn = (v?.syn ?? []).filter((s) => s.length < 60).slice(0, 3);
  if (syn.length) bits.push(`also known as: ${syn.join('; ')}`);
  return bits.join('. ') || null;
}

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, runner));
  return out;
}

let ids = Object.keys(db.foods);
if (ONLY) ids = ids.filter((id) => ONLY.has(id));
ids = ids.slice(0, LIMIT);

console.log(`Verifying ${ids.length} foods with ${MODEL} (concurrency ${CONCURRENCY}, cache ${Object.keys(cache).length} hits available)`);
let done = 0; let calls = 0;

const records = await pool(ids, CONCURRENCY, async (id) => {
  const food = db.foods[id];
  const key = `${id}::${MODEL}::${PROMPT_VERSION}`;
  let claude = cache[key];
  // A cached failure is not worth keeping — retry it so a transient Bedrock
  // hiccup or a since-fixed transport bug does not poison the food forever.
  if (!claude || !claude.valid) {
    calls++;
    const est = await estimateNutrition(food.name, {
      transport, model: MODEL, context: contextFor(id, food), retries: 1,
    });
    claude = {
      per100g: est.per100g, servingG: est.servingG, confidence: est.confidence,
      ingredients: est.ingredients, valid: est.valid, reasons: est.reasons, attempts: est.attempts,
    };
    cache[key] = claude;
    // Persist as we go so a crash mid-run does not throw away paid work.
    writeFileSync(cachePath, JSON.stringify(cache, null, 0));
  }
  const cmp = crossVerify(food.per100g, claude.per100g);
  done++;
  if (done % 20 === 0) console.log(`  ${done}/${ids.length}`);
  return { id, name: food.name, usda: food.per100g, claude, cmp, golden: GOLDEN_IDS.has(id) };
});

console.log(`Claude calls made this run: ${calls} (rest served from cache)`);

// --------------------------- correction policy ---------------------------
// Conservative on purpose. USDA stays unless Claude is BOTH valid AND clearly
// the more internally consistent estimate, and the food is not golden-anchored.
const overlay = {};
const verification = {};
let agreed = 0; let corrected = 0; let flagged = 0; let claudeInvalid = 0;

for (const r of records) {
  const { id, cmp, claude, golden } = r;
  verification[id] = {
    name: r.name, golden, agree: cmp.agree, score: Number(cmp.score.toFixed(3)),
    kcal_usda: r.usda.kcal, kcal_claude: claude.per100g.kcal,
    kcalRel: cmp.kcalRel == null ? null : Number(cmp.kcalRel.toFixed(3)),
    usdaAtwaterErr: cmp.usdaAtwaterErr == null ? null : Number(cmp.usdaAtwaterErr.toFixed(1)),
    claudeAtwaterErr: cmp.claudeAtwaterErr == null ? null : Number(cmp.claudeAtwaterErr.toFixed(1)),
    moreConsistent: cmp.moreConsistent, claudeValid: claude.valid,
    claudeIngredients: claude.ingredients,
  };
  if (!claude.valid) { claudeInvalid++; verification[id].note = 'claude estimate failed validation; ignored'; continue; }
  if (cmp.agree) {
    agreed++;
    overlay[id] = { source: 'usda-verified', score: Number(cmp.score.toFixed(3)), verifiedAt: new Date().toISOString().slice(0, 10) };
    continue;
  }
  // Disagreement.
  if (golden) { flagged++; verification[id].note = 'golden-anchored: USDA kept, disagreement logged'; continue; }
  const usdaInconsistent = (cmp.usdaAtwaterErr ?? 0) > Math.max(20, r.usda.kcal * 0.25);
  const claudeBetter = cmp.moreConsistent === 'claude';
  if (claudeBetter || usdaInconsistent) {
    // Take Claude for the macros; keep USDA's micronutrients. Full weight when
    // USDA is internally broken, half weight when it is merely different.
    const w = usdaInconsistent ? 0.9 : 0.6;
    const consensus = blendPer100g(r.usda, claude.per100g, w);
    const check = validatePer100g(consensus);
    if (!check.ok) { flagged++; verification[id].note = `consensus failed validation (${check.reasons.join(';')}); USDA kept`; continue; }
    corrected++;
    overlay[id] = {
      source: 'claude-corrected', claudeWeight: w, per100g: roundAll(consensus),
      claudePer100g: roundAll(claude.per100g), servingG: claude.servingG,
      confidence: claude.confidence, ingredients: claude.ingredients,
      score: Number(cmp.score.toFixed(3)), verifiedAt: new Date().toISOString().slice(0, 10),
    };
    verification[id].note = `corrected toward Claude (w=${w})`;
  } else {
    flagged++;
    verification[id].note = 'disagreement, neither clearly better: USDA kept, review';
  }
}

function roundAll(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v * 100) / 100]));
}

writeFileSync(join(DATA, 'nutrition-verification.json'), JSON.stringify(verification, null, 2));
if (APPLY) writeFileSync(join(DATA, 'claude-overlay.json'), JSON.stringify(overlay, null, 2));

// --------------------------- report ---------------------------
const disagreements = records
  .filter((r) => r.claude.valid && !r.cmp.agree)
  .sort((a, b) => (b.cmp.kcalRel ?? 0) - (a.cmp.kcalRel ?? 0));
const lines = [];
lines.push('# Claude × USDA nutrition cross-verification');
lines.push('');
lines.push(`Model: \`${MODEL}\` · foods checked: ${records.length} · prompt ${PROMPT_VERSION}`);
lines.push('');
lines.push('| outcome | count |');
lines.push('|---|---|');
lines.push(`| agree (two-source confirmed) | ${agreed} |`);
lines.push(`| corrected toward Claude | ${corrected} |`);
lines.push(`| flagged, USDA kept | ${flagged} |`);
lines.push(`| Claude estimate unusable | ${claudeInvalid} |`);
lines.push('');
lines.push(`Two-source agreement rate: **${((agreed / Math.max(1, records.length - claudeInvalid)) * 100).toFixed(0)}%** of usable estimates.`);
lines.push('');
lines.push('## Biggest disagreements (by kcal gap)');
lines.push('');
lines.push('| food | USDA kcal | Claude kcal | gap | USDA Atwater err | Claude Atwater err | more consistent | action |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const r of disagreements.slice(0, 40)) {
  const v = verification[r.id];
  lines.push(`| ${r.name} | ${r.usda.kcal} | ${r.claude.per100g.kcal} | ${(100 * (r.cmp.kcalRel ?? 0)).toFixed(0)}% `
    + `| ${v.usdaAtwaterErr ?? '—'} | ${v.claudeAtwaterErr ?? '—'} | ${r.cmp.moreConsistent ?? '—'} | ${v.note ?? ''} |`);
}
lines.push('');
lines.push('_USDA Atwater err = how far USDA\'s own kcal is from its own macros. A large value means the USDA row itself does not add up — usually a mis-map — and is the signal used to prefer Claude._');
writeFileSync(join(DATA, 'nutrition-verification-report.md'), lines.join('\n'));

console.log('\n=== summary ===');
console.log(`agree ${agreed} · corrected ${corrected} · flagged ${flagged} · claude-unusable ${claudeInvalid}`);
console.log(`wrote nutrition-verification.json, ${APPLY ? 'claude-overlay.json, ' : ''}nutrition-verification-report.md`);
