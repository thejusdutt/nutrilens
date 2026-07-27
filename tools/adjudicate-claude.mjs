/**
 * Break the ties the first pass could not.
 *
 * verify-nutrition-claude.mjs leaves a pile of "flagged" foods: USDA and Claude
 * both add up internally but land on different numbers, so neither is provably
 * wrong and the first pass will not touch USDA on a hunch. Those are the foods
 * whose USDA row is a hand-composed mix or a loose fallback match — right on
 * paper, possibly wrong about the real dish.
 *
 * To decide them we get a SECOND independent computation from a different model
 * (Opus), shown no prior number, and treat the two language models as two
 * independent witnesses:
 *
 *   - Sonnet and Opus agree with each other but not USDA  -> USDA is outvoted;
 *     correct the database to the two-model consensus.
 *   - The two models disagree with each other too         -> genuinely ambiguous;
 *     leave USDA, flag for a human.
 *
 * Golden-anchored foods are never touched — USDA is the reference for those.
 *
 * Writes the FINAL tools/data/claude-overlay.json (supersedes the first pass's)
 * plus tools/data/adjudication-report.md.
 *
 * Usage: node tools/adjudicate-claude.mjs [--model eu.anthropic.claude-opus-4-8]
 *                                         [--concurrency 4] [--min-gap 0.15] [--refresh]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  estimateNutrition, crossVerify, blendPer100g, validatePer100g, reconcileFat,
} from '@nutrilens/claude-nutrition';
import { bedrockTransport } from '@nutrilens/claude-nutrition/bedrock-cli';
import { VOCABULARY } from './vocabulary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(root, 'tools/data');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };

const OPUS = opt('model', 'eu.anthropic.claude-opus-4-8');
const CONCURRENCY = Number(opt('concurrency', 4));
const MIN_GAP = Number(opt('min-gap', 0.12)); // only adjudicate gaps worth the Opus call
const REFRESH = flag('refresh');
const PROMPT_VERSION = 'v1';

// Hand-authored ground-truth foods: every id pinned in GOLDEN in
// build-nutrition-db.mjs. These have a published or carefully composed value and
// their own shape tests; Claude may confirm them but must never overwrite them.
const PROTECTED = new Set([
  'plain-rice', 'banana', 'apple', 'pizza', 'hamburger', 'boiled-egg', 'chicken-curry',
  'chapati', 'oatmeal', 'apple-pie', 'dal', 'french-fries', 'avocado', 'chocolate-cake',
  'steamed-broccoli', 'potato-chips', 'bacon', 'sushi', 'fried-rice', 'lassi', 'paneer-tikka',
  'coffee', 'refried-beans', 'gazpacho', 'general-tso-chicken', 'tamales',
  'spring-onion-pancake', 'aloo-gobi', 'avocado-toast', 'panna-cotta', 'foie-gras',
  'lobster-roll-sandwich', 'butter-chicken', 'chocolate-bar', 'mochi', 'poha', 'spring-roll-fresh',
]);

// Pristine USDA baseline (builder-written), so re-running re-derives corrections
// from source rather than confirming values a prior build already applied.
const basePath = join(DATA, 'nutrition-db.base.json');
const dbPath = existsSync(basePath) ? basePath : join(root, 'app/public/data/nutrition-db.json');
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const verification = JSON.parse(readFileSync(join(DATA, 'nutrition-verification.json'), 'utf8'));
const sonnetCache = JSON.parse(readFileSync(join(DATA, 'claude-nutrition-cache.json'), 'utf8'));
const vocabById = Object.fromEntries(VOCABULARY.map((v) => [v.id, v]));

const opusCachePath = join(DATA, 'opus-nutrition-cache.json');
const opusCache = (!REFRESH && existsSync(opusCachePath)) ? JSON.parse(readFileSync(opusCachePath, 'utf8')) : {};
const transport = bedrockTransport({ model: OPUS });

const SONNET_MODEL = 'eu.anthropic.claude-sonnet-5';
const sonnetPer100g = (id) => sonnetCache[`${id}::${SONNET_MODEL}::v1`]?.per100g;

function contextFor(id) {
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
  const runner = async () => { while (true) { const i = next++; if (i >= items.length) return; out[i] = await worker(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, runner));
  return out;
}

// Which foods actually need Opus: non-golden, Claude usable, sources disagree
// by more than MIN_GAP on kcal.
const toAdjudicate = Object.entries(verification)
  .filter(([id, v]) => !v.golden && !PROTECTED.has(id) && v.claudeValid && !v.agree
    && (v.kcalRel ?? 0) >= MIN_GAP && db.foods[id])
  .map(([id]) => id);

console.log(`${toAdjudicate.length} foods to adjudicate with ${OPUS} (min kcal gap ${MIN_GAP})`);

let calls = 0;
const opusResults = await pool(toAdjudicate, CONCURRENCY, async (id) => {
  const key = `${id}::${OPUS}::${PROMPT_VERSION}`;
  let rec = opusCache[key];
  if (!rec || !rec.valid) {
    calls++;
    const est = await estimateNutrition(db.foods[id].name, { transport, model: OPUS, context: contextFor(id), retries: 1 });
    rec = { per100g: est.per100g, servingG: est.servingG, confidence: est.confidence, ingredients: est.ingredients, valid: est.valid, reasons: est.reasons };
    opusCache[key] = rec;
    writeFileSync(opusCachePath, JSON.stringify(opusCache, null, 0));
  }
  return { id, opus: rec };
});
const opusById = Object.fromEntries(opusResults.map((r) => [r.id, r.opus]));
console.log(`Opus calls this run: ${calls}`);

// --------------------------- build the final overlay ---------------------------
const overlay = {};
const report = [['food', 'USDA', 'Sonnet', 'Opus', 'decision', 'final kcal']];
let verified = 0; let corrected = 0; let flagged = 0; let modelsSplit = 0;

for (const [id, v] of Object.entries(verification)) {
  if (!v.claudeValid || !db.foods[id]) continue;
  const usda = db.foods[id].per100g;
  if (v.agree) {
    verified++;
    overlay[id] = { source: 'usda-verified', score: v.score, verifiedAt: today() };
    continue;
  }
  if (v.golden || PROTECTED.has(id)) {
    // Hand-authored ground truth that Claude did not confirm: keep USDA, flag.
    // (Protected foods Claude agreed with were already stamped verified above.)
    flagged++;
    continue;
  }
  const sonnet = sonnetPer100g(id);
  const opus = opusById[id]?.valid ? opusById[id].per100g : null;
  if (!opus) {
    // Not adjudicated (small gap) or Opus failed: fall back to conservative first-pass logic.
    const cmp = crossVerify(usda, sonnet);
    const usdaBroken = (cmp.usdaAtwaterErr ?? 0) > Math.max(20, usda.kcal * 0.25);
    if (cmp.moreConsistent === 'claude' || usdaBroken) {
      const w = usdaBroken ? 0.9 : 0.6;
      const consensus = round(reconcileFat(blendPer100g(usda, sonnet, w), usda));
      if (validatePer100g(consensus).ok) {
        corrected++;
        overlay[id] = { source: 'claude-corrected', claudeWeight: w, per100g: consensus, claudePer100g: round(sonnet), servingG: sonnetCache[`${id}::${SONNET_MODEL}::v1`]?.servingG, ingredients: v.claudeIngredients, score: v.score, verifiedAt: today() };
        report.push([db.foods[id].name, usda.kcal, sonnet.kcal, '—', `sonnet-only w=${w}`, consensus.kcal]);
        continue;
      }
    }
    flagged++;
    continue;
  }
  // Three sources in hand: USDA, Sonnet, Opus.
  const name = db.foods[id].name;
  const llm = crossVerify(sonnet, opus);
  const uS = crossVerify(usda, sonnet);
  const uO = crossVerify(usda, opus);
  const llmConsensus = round(blendPer100g(sonnet, opus, 0.5));

  if (uS.agree && uO.agree) {
    // Both independent models land on USDA — as strong a confirmation as exists.
    verified++;
    overlay[id] = { source: 'usda-verified', score: Number(((uS.score + uO.score) / 2).toFixed(3)), verifiedAt: today() };
    report.push([name, usda.kcal, sonnet.kcal, opus.kcal, 'all three agree → USDA confirmed', usda.kcal]);
    continue;
  }
  // The decisive signal is not whether the two models agree with each other, but
  // whether USDA is the odd one out: both models missing it in the SAME
  // direction means the USDA row is wrong (typically a thin "NS" survey average
  // standing in for the dish as actually served), even if the two models scatter.
  const dS = sonnet.kcal - usda.kcal;
  const dO = opus.kcal - usda.kcal;
  const sameSide = Math.sign(dS) === Math.sign(dO) && dS !== 0;
  const bothDisagree = !uS.agree && !uO.agree;

  if (bothDisagree && sameSide) {
    // Confidence is higher when the two models also agree with each other; lower
    // when they only agree on the direction. Either way USDA is outvoted.
    const w = llm.agree ? 0.9 : 0.8;
    const consensus = round(reconcileFat(blendPer100g(usda, llmConsensus, w), usda));
    const check = validatePer100g(consensus);
    if (!check.ok) {
      flagged++;
      report.push([name, usda.kcal, sonnet.kcal, opus.kcal, `consensus invalid (${check.reasons[0]}) → keep USDA`, usda.kcal]);
      continue;
    }
    corrected++;
    overlay[id] = {
      source: llm.agree ? 'two-model-consensus' : 'two-model-outlier',
      per100g: consensus, sonnetPer100g: round(sonnet), opusPer100g: round(opus),
      servingG: median([sonnetCache[`${id}::${SONNET_MODEL}::v1`]?.servingG, opusById[id].servingG]),
      ingredients: v.claudeIngredients, score: Number(llm.score.toFixed(3)), verifiedAt: today(),
    };
    report.push([name, usda.kcal, sonnet.kcal, opus.kcal,
      llm.agree ? 'two models outvote USDA' : 'both models same-side → outvote USDA', consensus.kcal]);
    continue;
  }
  // Models straddle USDA (one above, one below) or one supports it: USDA has
  // independent backing, so keep it and flag for a human.
  if (bothDisagree && !sameSide) modelsSplit++;
  flagged++;
  report.push([name, usda.kcal, sonnet.kcal, opus.kcal,
    bothDisagree ? 'models straddle USDA → keep' : 'one model backs USDA → keep', usda.kcal]);
}

function today() { return new Date().toISOString().slice(0, 10); }
function round(o) { return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, Math.round(x * 100) / 100])); }
function median(xs) { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; }

writeFileSync(join(DATA, 'claude-overlay.json'), JSON.stringify(overlay, null, 2));

const md = ['# Adjudication: two independent models vs USDA', '',
  `Reference model: \`${OPUS}\` · adjudicated ${toAdjudicate.length} disagreements`, '',
  `verified ${verified} · corrected ${corrected} · flagged ${flagged} (of which ${modelsSplit} models-split)`, '',
  '| food | USDA | Sonnet | Opus | decision | final |', '|---|---|---|---|---|---|',
  ...report.slice(1).map((r) => `| ${r.join(' | ')} |`)];
writeFileSync(join(DATA, 'adjudication-report.md'), md.join('\n'));

console.log(`\nverified ${verified} · corrected ${corrected} · flagged ${flagged} (models-split ${modelsSplit})`);
console.log('wrote claude-overlay.json + adjudication-report.md');
