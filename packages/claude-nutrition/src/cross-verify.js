import { atwaterKcal } from './schema.js';

/** Relative gap between two values, with a floor so tiny nutrients do not blow up. */
function rel(a, b, floor) {
  const denom = Math.max(Math.abs(a), Math.abs(b), floor);
  return Math.abs(a - b) / denom;
}

/**
 * Compare two independent per-100 g estimates of the same food — here USDA
 * FNDDS on one side and Claude on the other — and say how well they agree and
 * which, if either, to trust.
 *
 * The philosophy: two sources derived in completely different ways (a survey
 * food database vs a recipe reasoned from scratch) landing on the same numbers
 * is strong evidence those numbers are right. When they diverge, the tie-break
 * is internal consistency — the estimate whose energy actually matches its own
 * macros is the one that was computed rather than misremembered.
 *
 * @param {object} usda   per-100 g from the reference database
 * @param {object} claude per-100 g from Claude
 * @param {{kcalTolPct?:number, kcalTolAbs?:number, proteinTol?:number, fatTol?:number}} [opts]
 */
export function crossVerify(usda, claude, opts = {}) {
  const kcalTolPct = opts.kcalTolPct ?? 0.20;
  const kcalTolAbs = opts.kcalTolAbs ?? 15;
  const proteinTol = opts.proteinTol ?? 0.30;
  const fatTol = opts.fatTol ?? 0.35;

  const keys = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'sodium'];
  const deltas = {};
  for (const k of keys) {
    if (usda?.[k] === undefined && claude?.[k] === undefined) continue;
    const u = usda?.[k] ?? 0;
    const c = claude?.[k] ?? 0;
    const floor = k === 'sodium' ? 50 : k === 'kcal' ? 20 : 1;
    deltas[k] = { usda: u, claude: c, absDelta: Math.abs(u - c), relDelta: rel(u, c, floor) };
  }

  const kcalRel = deltas.kcal ? deltas.kcal.relDelta : null;
  const kcalAbs = deltas.kcal ? deltas.kcal.absDelta : null;
  const kcalAgree = deltas.kcal
    ? kcalAbs <= Math.max(kcalTolAbs, deltas.kcal.usda * kcalTolPct)
    : false;
  const proteinAgree = deltas.protein ? deltas.protein.relDelta <= proteinTol || deltas.protein.absDelta <= 2 : true;
  const fatAgree = deltas.fat ? deltas.fat.relDelta <= fatTol || deltas.fat.absDelta <= 2.5 : true;
  const agree = kcalAgree && proteinAgree && fatAgree;

  // Overall agreement scalar: kcal weighted heaviest, then the macros.
  const parts = [];
  if (deltas.kcal) parts.push([deltas.kcal.relDelta, 3]);
  if (deltas.protein) parts.push([deltas.protein.relDelta, 2]);
  if (deltas.fat) parts.push([deltas.fat.relDelta, 2]);
  if (deltas.carbs) parts.push([deltas.carbs.relDelta, 1]);
  const wsum = parts.reduce((s, [, w]) => s + w, 0) || 1;
  const meanRel = parts.reduce((s, [r, w]) => s + r * w, 0) / wsum;
  const score = Math.max(0, Math.min(1, 1 - meanRel));

  const usdaAtwaterErr = usda?.kcal !== undefined
    ? Math.abs(usda.kcal - atwaterKcal(usda)) : null;
  const claudeAtwaterErr = claude?.kcal !== undefined
    ? Math.abs(claude.kcal - atwaterKcal(claude)) : null;

  return {
    deltas,
    kcalRel,
    kcalAbs,
    agree,
    score,
    kcalAgree,
    proteinAgree,
    fatAgree,
    usdaAtwaterErr,
    claudeAtwaterErr,
    // Which side is more internally consistent (lower is better); null if tied/unknown.
    moreConsistent: (usdaAtwaterErr == null || claudeAtwaterErr == null) ? null
      : (claudeAtwaterErr < usdaAtwaterErr - 3 ? 'claude'
        : usdaAtwaterErr < claudeAtwaterErr - 3 ? 'usda' : 'tie'),
  };
}

/**
 * Keep a corrected record physically consistent. Changing total `fat` without
 * touching the fat sub-fractions (saturated / mono / poly) leaves them summing
 * to more than the new total — impossible. This rescales the three from a
 * reference (USDA) in proportion to the corrected fat, preserving the measured
 * composition, so `satFat + monoFat + polyFat ≤ fat` still holds. Mutates and
 * returns `per100g`.
 */
export function reconcileFat(per100g, reference) {
  const newFat = per100g.fat;
  const refFat = reference?.fat;
  if (newFat != null && refFat > 0) {
    const r = newFat / refFat;
    for (const k of ['satFat', 'monoFat', 'polyFat']) {
      if (reference[k] != null) per100g[k] = Math.round(reference[k] * r * 100) / 100;
    }
  }
  return per100g;
}

/**
 * Blend two estimates into one shipped per-100 g record, given how much to lean
 * on Claude (0 = keep USDA untouched, 1 = take Claude wholesale). Missing keys
 * on either side fall back to the side that has them, so micronutrients that
 * only USDA carries survive a Claude-weighted blend.
 */
export function blendPer100g(usda, claude, claudeWeight) {
  const w = Math.max(0, Math.min(1, claudeWeight));
  const out = { ...usda };
  const keys = new Set([...Object.keys(usda || {}), ...Object.keys(claude || {})]);
  for (const k of keys) {
    const u = usda?.[k];
    const c = claude?.[k];
    if (u === undefined) out[k] = c;
    else if (c === undefined) out[k] = u;
    else out[k] = Math.round((u * (1 - w) + c * w) * 100) / 100;
  }
  return out;
}
