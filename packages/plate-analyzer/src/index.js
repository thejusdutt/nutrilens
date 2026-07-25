/**
 * @nutrilens/plate-analyzer
 *
 * The "what is on this plate, and how much of it" stage. It sits between
 * promptable segmentation (which returns anonymous blobs) and the nutrition
 * engine (which needs `{id, grams}` pairs).
 *
 * The hard part is not segmentation — it is that a region crop is a *much*
 * weaker classification input than the whole photo. A crop of one corner of a
 * dosa genuinely does look like tempura. This module therefore treats the
 * whole-image distribution as a prior over the region labels, merges regions
 * that resolve to the same dish, and keeps portions inside the envelope the
 * food's own serving statistics allow.
 *
 * Every stage is a separate exported function so it can be unit-tested without
 * a model, and both the PWA worker and the Node evaluation harness call the
 * same code.
 */

import { crop } from '@nutrilens/image-preprocess';
import { maskAreaInsideEllipse, MIN_PLATE_CONFIDENCE } from '@nutrilens/portion-estimator';

/** Tunables, fitted on eval/vision-bench.mjs. Exported so the bench can sweep them. */
export const DEFAULTS = {
  /** Weight of the whole-image distribution as a prior on each region's label. */
  globalPrior: 0.55,
  /** Min fused probability for a region to become an item. */
  minItemProb: 0.18,
  /**
   * Max regions carried forward from proposal to naming.
   *
   * Dedupe keeps the smallest distinct regions first, so this is a budget on
   * *how far up the size range we look*, not on how many dishes get logged —
   * merging collapses whatever turns out to be the same food. At six, a thali
   * spent the whole budget on four vada and two idli and never reached the
   * sambar and chutney bowls sitting beside them.
   */
  maxItems: 10,
  /** bbox overlap (over the smaller box) above which two proposals are the same thing. */
  dedupeOverlap: 0.55,
  /** Margin added around a region before classifying it, as a fraction of each axis. */
  cropPad: 0.15,
  /**
   * Frame-grid resolution used when a plate was found, and how far in from each
   * edge that grid stays. See proposePoints.
   *
   * 4 / 0.05 reaches the cropped side bowls that 3 / 0.1 never probes, and cost
   * far more than it bought: on the 19-photo benchmark, recall 75.0% → 68.0%,
   * spurious dishes 15 → 21, mean kcal error 2.2% → 10.5%. The extra probes
   * land on tablecloth and background, and the classifier answers anyway —
   * baklava, panna cotta, apple pie, a grilled cheese sandwich. Probing more of
   * the frame needs a way to reject what the extra probes find first.
   */
  frameGrid: 3,
  frameInset: 0.1,
  /** Merge regions that resolve to the same food into one diary line. */
  mergeSameFood: true,
  /** Shared top-candidate probability mass above which two touching regions are one dish. */
  mergeOverlap: 0.3,
  /**
   * Absorb a region whose mask lies this far inside another region's mask.
   *
   * Touching plus agreeing labels catches a dish split in two. It cannot catch
   * a patch *inside* a dish that reads as a different food — the filling and
   * tempering showing through a dosa coming back as an omelette, the browned
   * centre of a pancake stack as yogurt. Those never share a candidate list
   * with their host, so the label test can only fail. Containment is the right
   * signal: food sitting wholly within another dish's outline is part of it.
   *
   * Masks only, never bounding boxes. The box version was tried — a small box
   * wholly inside a big one, area-guarded at 0.35 — because the segmenter often
   * cuts the patch out of its host and leaves a hole where it sat, which the
   * mask test cannot see through. It fails on the dish it was meant to help:
   * a large dosa's box encloses the chutney and sambar bowls beside it, so
   * masala-dosa went from 3/3 dishes to 1/3, reporting the dosa alone and
   * dropping both bowls. A dish's box says nothing about what is part of it.
   *
   * Set to 0 to disable.
   */
  containedFraction: 0.75,
  /** Bounding boxes within this fraction of their own size count as touching. */
  touchPad: 0.08,
  /**
   * Drop an item whose mask is under this fraction of the plate's largest one.
   * Crumbs, garnish and sauce smears are not food log entries.
   */
  minAreaShare: 0.05,
  /** Grams below this are never worth a diary line. */
  minItemGrams: 8,
  /** Reject segmenter output below this self-reported IoU. */
  minMaskIou: 0.7,
  /** Looser bar for the whole-dish mask — see proposeRegions. */
  minDominantIou: 0.45,
  /**
   * A dish covering less of the frame than this cannot be "the whole dish":
   * the mask is a fragment, so measure nothing and use the serving statistic.
   */
  minSingleDishFraction: 0.06,
  /** A dish region must occupy at least this fraction of the frame… */
  minAreaFraction: 0.008,
  /** …and at most this much, or it is the plate/table rather than a dish. */
  maxAreaFraction: 0.45,
  /** The single-dish mask may cover almost everything — that is the point. */
  maxDominantFraction: 0.92,
  /** Whole-image confidence above which a one-label plate is read as one dish. */
  singleDishProb: 0.45,
};

// ---------------------------------------------------------------------------
// Stage 1: where to prompt the segmenter
// ---------------------------------------------------------------------------

/**
 * Point prompts for whole-plate discovery: a polar grid inside the plate
 * ellipse (where the main dish lives) plus a coarse full-frame grid (side
 * bowls — chutney, sambar, dips — sit outside the rim and would never be
 * probed otherwise).
 *
 * @param {{width:number, height:number, plate?:{cx:number,cy:number,rx:number,ry:number,confidence:number}|null, grid?:number}} p
 * @returns {{x:number,y:number}[]}
 */
export function proposePoints({ width, height, plate = null, grid = 4, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const pts = [];
  const hasPlate = !!plate && plate.confidence >= MIN_PLATE_CONFIDENCE;
  if (hasPlate) {
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const a = ((gx + 0.5) / grid) * Math.PI * 2;
        const r = Math.sqrt((gy + 0.5) / grid) * 0.8;
        pts.push({ x: plate.cx + r * plate.rx * Math.cos(a), y: plate.cy + r * plate.ry * Math.sin(a) });
      }
    }
  }
  // Frame grid, for everything that is not on the plate. Dense when there is no
  // plate to anchor on.
  //
  // Known gap: at 3 × 10% the leftmost probe lands at 23% of the width, so a
  // side bowl cropped by the frame edge — the normal way a South Indian plate
  // is photographed, bowls crowding in from the side — is never prompted, and
  // so cannot be missed by the classifier because it was never offered to it.
  // Widening this is measurably worse today; see DEFAULTS.frameGrid.
  const m = hasPlate ? o.frameGrid : grid;
  const inset = o.frameInset;
  const at = (i, n, size) => size * (inset + (1 - 2 * inset) * (i + 0.5) / n);
  for (let gy = 0; gy < m; gy++) {
    for (let gx = 0; gx < m; gx++) {
      pts.push({ x: at(gx, m, width), y: at(gy, m, height) });
    }
  }
  return pts.filter((p) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height);
}

/** Fraction of the smaller of two boxes that the two share. */
export function bboxOverlap(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  return (ix * iy) / Math.max(1, Math.min(areaA, areaB));
}

/**
 * Collapse duplicate proposals, smallest first.
 *
 * Dishes sit *on* the plate, so a mask that contains an already-kept smaller
 * mask is almost always the plate surface or a merged multi-dish blob — the
 * small distinct regions have to win, or a plate of four things is reported as
 * one. Fragments of a single dish that survive this are re-joined later by
 * {@link mergeSameFood}, once they have names.
 *
 * @param {{areaPx:number, bbox:{x0:number,y0:number,x1:number,y1:number}}[]} candidates
 * @param {{maxItems?:number, dedupeOverlap?:number}} [opts]
 */
export function dedupeRegions(candidates, opts = {}) {
  const { maxItems = DEFAULTS.maxItems, dedupeOverlap = DEFAULTS.dedupeOverlap } = opts;
  const sorted = [...candidates].sort((a, b) => a.areaPx - b.areaPx);
  const kept = [];
  for (const c of sorted) {
    if (!c.bbox) continue;
    if (kept.some((k) => bboxOverlap(c.bbox, k.bbox) > dedupeOverlap)) continue;
    kept.push(c);
    if (kept.length >= maxItems) break;
  }
  return kept;
}

/**
 * Should the whole photo be read as one dish rather than a plate of several?
 *
 * Smallest-first dedupe is right for a thali and wrong for a close-up: a bowl
 * of fried rice shot from above has no internal boundaries a segmenter can
 * respect, so it comes back as a handful of arbitrary crumbs that each get
 * priced separately. Two signals say "this is one dish": the whole-image
 * classifier is confident, and the regions it found all resolve to the same
 * food anyway.
 *
 * @param {{id:string}[]} namedRegions  regions after labelling
 * @param {{prob:number}[]} imageTop
 * @param {number} [minProb]
 */
export function isSingleDish(namedRegions, imageTop, minProb = DEFAULTS.singleDishProb) {
  const distinct = new Set(namedRegions.map((r) => r.id));
  if (distinct.size > 1) return false;
  return !namedRegions.length || (imageTop[0]?.prob ?? 0) >= minProb;
}

/**
 * Run the point grid through a promptable segmenter and return both the
 * distinct dish regions and the single largest plausible food mask.
 *
 * The dominant mask is kept because the small-regions view is wrong for
 * close-ups (see {@link isSingleDish}) — and it costs nothing extra, since it
 * comes from prompts already paid for.
 *
 * @param {Object} p
 * @param {(points:{x:number,y:number}[]) => Promise<object>} p.segment
 * @param {number} p.width @param {number} p.height
 * @param {object|null} [p.plate]
 * @param {(done:number,total:number) => void} [p.onProgress]
 * @param {Partial<typeof DEFAULTS>} [p.options]
 * @returns {Promise<{regions:object[], dominant:object|null}>}
 */
export async function proposeRegions({ segment, width, height, plate = null, onProgress, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const pts = proposePoints({ width, height, plate, options: o });
  const candidates = [];
  let dominant = null;
  for (let i = 0; i < pts.length; i++) {
    try {
      const m = await segment([pts[i]]);
      if (!m.bbox) continue;
      if (m.iou > o.minMaskIou
        && m.areaFraction > o.minAreaFraction && m.areaFraction < o.maxAreaFraction) {
        candidates.push({ ...m, point: pts[i] });
      }
      // The whole-dish mask is held to a lower IoU bar on purpose. SlimSAM
      // scores a confident little blob (one pea, one crouton) above the
      // sprawling boundary of a bowl of rice, so gating the dominant mask at
      // the same threshold as the dish regions left close-ups measuring a
      // crumb — and quoting 120 g for a 300 g bowl.
      if (m.iou > o.minDominantIou
        && m.areaFraction < o.maxDominantFraction
        && (!dominant || m.areaPx > dominant.areaPx)) {
        dominant = { ...m, point: pts[i] };
      }
    } catch { /* a failed prompt is one lost proposal, not a failed analysis */ }
    onProgress?.(i + 1, pts.length);
  }
  return { regions: dedupeRegions(candidates, o), dominant };
}

// ---------------------------------------------------------------------------
// Stage 2: naming a region
// ---------------------------------------------------------------------------

/**
 * Re-rank a region's candidate list using the whole-image distribution.
 *
 * A region crop carries far less context than the full photo: a torn-off piece
 * of dosa is a plausible tempura, a bowl of coconut chutney is a plausible
 * hummus. The whole photo, meanwhile, is the single most accurate signal the
 * pipeline has (90% top-1). Blending the two in the log domain lets a region
 * keep its own identity when it is confident, and fall back on what the plate
 * as a whole says when it is not.
 *
 *   score(id) = log p_region(id) + λ · log p_image(id)
 *
 * λ = 0 reproduces region-only labelling.
 *
 * @param {{id:string, name?:string, prob:number}[]} regionTop
 * @param {{id:string, name?:string, prob:number}[]} imageTop
 * @param {number} [lambda]
 * @returns {{id:string, name?:string, prob:number}[]} renormalized, best first
 */
export function fuseWithGlobal(regionTop, imageTop, lambda = DEFAULTS.globalPrior) {
  if (!regionTop.length) return [];
  if (!lambda || !imageTop?.length) return [...regionTop].sort((a, b) => b.prob - a.prob);
  const EPS = 1e-9;
  const global = new Map(imageTop.map((t) => [t.id, t.prob]));
  // Unlisted labels get less than the smallest listed one, not zero: absence
  // from a truncated top-k is weak evidence, not proof.
  const floor = Math.min(...imageTop.map((t) => t.prob)) * 0.25;
  const scored = regionTop.map((t) => ({
    ...t,
    score: Math.log(t.prob + EPS) + lambda * Math.log((global.get(t.id) ?? floor) + EPS),
  }));
  const max = Math.max(...scored.map((s) => s.score));
  let sum = 0;
  for (const s of scored) { s.exp = Math.exp(s.score - max); sum += s.exp; }
  return scored
    .map(({ score, exp, ...t }) => ({ ...t, prob: exp / sum }))
    .sort((a, b) => b.prob - a.prob);
}

// ---------------------------------------------------------------------------
// Stage 3: one dish, one line
// ---------------------------------------------------------------------------

/** Bitwise-OR two 0/1 masks into a new mask, returning it and its area. */
export function unionMask(a, b) {
  const out = new Uint8Array(a.length);
  let areaPx = 0;
  for (let i = 0; i < a.length; i++) {
    const v = (a[i] | b[i]) & 1;
    out[i] = v;
    areaPx += v;
  }
  return { mask: out, areaPx };
}

/**
 * How much of the smaller mask lies inside the larger one, 0–1.
 *
 * Deliberately asymmetric on area: a 20 px garnish sitting inside a 4000 px
 * dosa is 100% contained, while the dosa is 0.5% contained in the garnish. The
 * question worth asking is always "is the small thing part of the big one".
 */
export function maskContainment(a, b) {
  if (!a?.mask || !b?.mask || a.mask.length !== b.mask.length) return 0;
  const [inner, outer] = (a.areaPx ?? 0) <= (b.areaPx ?? 0) ? [a, b] : [b, a];
  if (!(inner.areaPx > 0)) return 0;
  let both = 0;
  for (let i = 0; i < inner.mask.length; i++) if (inner.mask[i] & outer.mask[i] & 1) both++;
  return both / inner.areaPx;
}

/**
 * The crop handed to the classifier for one region: its box plus a margin,
 * slid to stay inside the frame rather than clipped against it.
 *
 * For a region against the edge — a chutney bowl half out of shot — the padded
 * box runs off the image, and a crop truncated to what is left classifies worse
 * than the same crop nudged inward. On the benchmark, clipping costs 16 → 19
 * spurious dishes and takes mean kcal error from 2.1% to 3.9%: the classifier
 * wants a full-size view more than it wants a centred one.
 *
 * That used to happen by accident inside crop(), which clamped a negative
 * origin without shrinking the width. It is deliberate here now, crop() clips
 * the way its name says, and both callers — the automatic pass and tap-to-add —
 * go through this, so they cannot drift apart again.
 *
 * @param {RawImage} image @param {{x0,y0,x1,y1}} bbox @param {object} [o] resolved options
 */
export function regionCrop(image, bbox, o = DEFAULTS) {
  const pad = Math.round(Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) * o.cropPad);
  const w = (bbox.x1 - bbox.x0) + 2 * pad;
  const h = (bbox.y1 - bbox.y0) + 2 * pad;
  return crop(
    image,
    Math.max(0, Math.min(image.width - w, bbox.x0 - pad)),
    Math.max(0, Math.min(image.height - h, bbox.y0 - pad)),
    w, h,
  );
}

/**
 * Is the smaller region a part of the larger one rather than a dish of its own?
 * @param {object|null} a @param {object|null} b @param {object} o resolved options
 */
export function isPartOf(a, b, o = DEFAULTS) {
  return o.containedFraction > 0 && maskContainment(a, b) >= o.containedFraction;
}

/**
 * Merge two named regions.
 *
 * The surviving label is normally the more confident one. When one region
 * contains the other, the container wins instead, however sure the smaller
 * patch is of itself: a confident "omelette" reading of the filling inside a
 * dosa is confidently describing a part, and the part does not get to rename
 * the whole.
 */
function joinItems(a, b, o = DEFAULTS) {
  const enclosing = isPartOf(a.region, b.region, o)
    ? ((a.region.areaPx ?? 0) >= (b.region.areaPx ?? 0) ? a : b)
    : null;
  const [keep, other] = enclosing
    ? (enclosing === a ? [a, b] : [b, a])
    : (a.prob >= b.prob ? [a, b] : [b, a]);
  // An absorbed part does not lend its confidence to the whole: a sure reading
  // of the filling says nothing about how sure we are of the dish around it.
  const out = { ...keep, prob: enclosing ? keep.prob : Math.max(a.prob, b.prob) };
  if (keep.region && other.region) {
    const u = unionMask(keep.region.mask, other.region.mask);
    out.region = {
      ...keep.region,
      mask: u.mask,
      areaPx: u.areaPx,
      bbox: {
        x0: Math.min(keep.region.bbox.x0, other.region.bbox.x0),
        y0: Math.min(keep.region.bbox.y0, other.region.bbox.y0),
        x1: Math.max(keep.region.bbox.x1, other.region.bbox.x1),
        y1: Math.max(keep.region.bbox.y1, other.region.bbox.y1),
      },
    };
  } else {
    out.region = keep.region ?? other.region;
  }
  return out;
}

/** How much two candidate lists agree, by shared probability mass over the top few. */
export function candidateOverlap(a, b, depth = 4) {
  const top = (xs) => new Map(xs.slice(0, depth).map((t) => [t.id, t.prob]));
  const ma = top(a); const mb = top(b);
  let shared = 0;
  for (const [id, p] of ma) if (mb.has(id)) shared += Math.min(p, mb.get(id));
  return shared;
}

/**
 * Fold regions that are really one dish into a single item.
 *
 * Two cases, both of which produced nonsense before:
 *
 *  1. Same name. Segmentation splits one dosa into the crisp edge and the
 *     folded body, and prompts two idlis as two blobs. Neither is two diary
 *     entries — people log "dosa, 180 g", not "dosa 24 g" and "dosa 86 g" —
 *     and merging repairs the portion, since a dish weighs what all of its
 *     pixels weigh.
 *  2. Different names for the same food. Half a stir-fry reads as kung pao and
 *     half as sweet-and-sour; one plate of momos comes back as dumplings plus
 *     ravioli. When two regions touch *and* their candidate lists largely
 *     agree, they are one dish seen twice, and the confident label wins.
 *
 * @param {{id:string, region:object|null, prob:number, candidates:object[]}[]} items
 * @param {{mergeOverlap?:number, touchPad?:number}} [opts]
 */
export function mergeSameFood(items, opts = {}) {
  const mergeOverlap = opts.mergeOverlap ?? DEFAULTS.mergeOverlap;
  const touchPad = opts.touchPad ?? DEFAULTS.touchPad;
  const o = { ...DEFAULTS, ...opts };
  const same = (a, b) => (
    a.id === b.id
    || (touches(a.region, b.region, touchPad)
      && candidateOverlap(a.candidates ?? [], b.candidates ?? []) >= mergeOverlap)
    // Geometry alone, no label agreement required — that is the whole point.
    || isPartOf(a.region, b.region, o)
  );

  // Run to a fixed point. "Same dish" is transitive but the pairwise test is
  // not: a region can fail to match the group it belongs to and then match it
  // after an unrelated merge widens that group's box or changes its label.
  // A single pass therefore left one omelette and one tortilla where there was
  // only ever one tortilla.
  let out = items.map((it) => ({ ...it }));
  for (let pass = 0; pass < out.length; pass++) {
    const next = [];
    for (const it of out) {
      const at = next.findIndex((o) => same(o, it));
      if (at < 0) next.push(it);
      else next[at] = joinItems(next[at], it, o);
    }
    if (next.length === out.length) return next;
    out = next;
  }
  return out;
}

/** Do two regions' bounding boxes touch, allowing a small gap (fraction of size)? */
export function touches(a, b, pad = DEFAULTS.touchPad) {
  if (!a?.bbox || !b?.bbox) return false;
  const grow = (r) => {
    const dx = (r.bbox.x1 - r.bbox.x0) * pad;
    const dy = (r.bbox.y1 - r.bbox.y0) * pad;
    return { x0: r.bbox.x0 - dx, y0: r.bbox.y0 - dy, x1: r.bbox.x1 + dx, y1: r.bbox.y1 + dy };
  };
  const ga = grow(a); const gb = grow(b);
  return ga.x0 < gb.x1 && gb.x0 < ga.x1 && ga.y0 < gb.y1 && gb.y0 < ga.y1;
}

/**
 * The mask that best represents "all of this dish": the dominant proposal, or
 * the union of the fragments when that covers more.
 * @param {{region:object}[]} named @param {object|null} dominant
 */
export function pickWholeMask(named, dominant) {
  let union = null;
  for (const n of named) {
    if (!n.region?.mask) continue;
    if (!union) { union = n.region; continue; }
    const u = unionMask(union.mask, n.region.mask);
    union = {
      mask: u.mask,
      areaPx: u.areaPx,
      bbox: {
        x0: Math.min(union.bbox.x0, n.region.bbox.x0),
        y0: Math.min(union.bbox.y0, n.region.bbox.y0),
        x1: Math.max(union.bbox.x1, n.region.bbox.x1),
        y1: Math.max(union.bbox.y1, n.region.bbox.y1),
      },
    };
  }
  if (!dominant) return union;
  if (!union) return dominant;
  return dominant.areaPx >= union.areaPx ? dominant : union;
}

// ---------------------------------------------------------------------------
// Stage 4: the whole plate
// ---------------------------------------------------------------------------

/**
 * Name and weigh every region on a plate.
 *
 * @param {Object} p
 * @param {{data:Uint8ClampedArray,width:number,height:number}} p.image
 * @param {{mask:Uint8Array, areaPx:number, bbox:object}[]} p.regions  from {@link dedupeRegions}
 * @param {{id:string,name?:string,prob:number}[]} p.imageTop  whole-photo distribution
 * @param {object|null} p.plate  detected plate ellipse
 * @param {(img:object) => Promise<{top:{id:string,name:string,prob:number}[], isFood:boolean}>} p.classify
 * @param {(id:string) => {name:string, prior:object}|null} p.foodById
 * @param {import('@nutrilens/portion-estimator').PortionEstimator} p.estimator
 * @param {(done:number,total:number) => void} [p.onProgress]
 * @param {Partial<typeof DEFAULTS>} [p.options]
 * @returns {Promise<{id:string, grams:number, prob:number, candidates:object[], region:object}[]>}
 */
export async function buildPlate({
  image, regions, dominant = null, imageTop = [], plate = null, classify, foodById, estimator,
  onProgress, options = {},
}) {
  const o = { ...DEFAULTS, ...options };
  const areaFor = (mask, fallback) => (
    plate && plate.confidence >= MIN_PLATE_CONFIDENCE && mask
      ? maskAreaInsideEllipse(mask, image.width, image.height, plate)
      : fallback
  );

  let named = [];
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    onProgress?.(i, regions.length);
    const b = region.bbox;
    if (!b) continue;
    const res = await classify(regionCrop(image, b, o));
    if (!res.isFood) continue;
    const known = res.top.filter((t) => foodById(t.id));
    if (!known.length) continue;
    const candidates = fuseWithGlobal(known, imageTop, o.globalPrior);
    if (candidates[0].prob < o.minItemProb) continue;
    named.push({ id: candidates[0].id, prob: candidates[0].prob, candidates, region });
  }
  onProgress?.(regions.length, regions.length);

  // One dish photographed close up: replace the fragments with the whole thing,
  // named by the whole-image classifier — the strongest signal available, and
  // the one that agrees with what a person says when they look at the photo.
  const globalKnown = imageTop.filter((t) => foodById(t.id));
  if (globalKnown.length && isSingleDish(named, globalKnown, o.singleDishProb)) {
    const whole = pickWholeMask(named, dominant);
    const frameShare = whole ? whole.areaPx / (image.width * image.height) : 0;
    named = [{
      id: globalKnown[0].id,
      prob: globalKnown[0].prob,
      candidates: globalKnown.slice(0, 6),
      // A mask far too small to be the whole dish is worse than no mask: it
      // drags the portion to the floor. Hand the estimator nothing and let it
      // answer with the serving statistic, which is what a person would say.
      region: frameShare >= o.minSingleDishFraction ? whole : null,
      singleDish: true,
    }];
  } else if (o.mergeSameFood) {
    named = mergeSameFood(named, o);
  }

  const items = named.map((it) => {
    const food = foodById(it.id);
    const est = estimator.estimate({
      areaPx: it.region ? areaFor(it.region.mask, it.region.areaPx) : 0,
      imageWidth: image.width,
      imageHeight: image.height,
      plate,
      prior: food.prior,
      dishCount: named.length,
    });
    return { ...it, grams: est.grams, portion: est };
  });

  // Garnish filter: a curry leaf or a coriander sprig is a real segment and a
  // real food, but logging it as a line item is noise. Judge it against the
  // plate's main dish, not an absolute threshold, so a plate of small things
  // (three chutneys) survives while a crumb next to a burger does not.
  //
  // The test is on *area*, not mass. Portions are anchored to each food's
  // typical serving and bounded around it, so even a four-pixel speck comes
  // back weighing 40% of a serving — by the time you look at grams the
  // evidence that it was a speck is gone.
  const biggest = Math.max(0, ...items.map((it) => it.region?.areaPx ?? 0));
  return items.filter((it) => it.grams >= o.minItemGrams
    && (it.region?.areaPx ?? biggest) >= biggest * o.minAreaShare);
}
