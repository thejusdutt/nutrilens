import { describe, it, expect } from 'vitest';
import { PortionEstimator } from '@nutrilens/portion-estimator';
import {
  proposePoints, proposeRegions, dedupeRegions, bboxOverlap, fuseWithGlobal,
  mergeSameFood, candidateOverlap, touches, unionMask, isSingleDish,
  pickWholeMask, buildPlate, maskContainment, DEFAULTS,
} from '../src/index.js';

const W = 100;
const H = 100;

/** A rectangular region, as the segmenter would report it. */
function region(x0, y0, x1, y1) {
  const mask = new Uint8Array(W * H);
  let areaPx = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) { mask[y * W + x] = 1; areaPx++; }
  }
  return { mask, areaPx, areaFraction: areaPx / (W * H), iou: 0.9, bbox: { x0, y0, x1, y1 } };
}
const item = (id, prob, reg, extra = []) => ({
  id, prob, region: reg, candidates: [{ id, prob }, ...extra],
});

describe('proposePoints', () => {
  it('probes inside the plate and across the whole frame', () => {
    const plate = { cx: 50, cy: 50, rx: 40, ry: 30, confidence: 1 };
    const pts = proposePoints({ width: W, height: H, plate });
    const inside = pts.filter((p) => ((p.x - 50) / 40) ** 2 + ((p.y - 50) / 30) ** 2 <= 1);
    expect(inside.length).toBeGreaterThan(8);
    // Side bowls sit outside the rim; without frame points they are never found.
    expect(pts.length).toBeGreaterThan(inside.length);
  });

  it('leaves the outer margin of the frame unprobed', () => {
    // Documented, not endorsed. A side bowl cropped by the frame edge lives
    // nearer the edge than this and is never offered to the segmenter, which is
    // one way a chutney goes unlogged. Widening the grid to reach it (4×4 at a
    // 5% inset) cost more than it bought — see DEFAULTS.frameGrid for the
    // numbers — so the gap stands until there is a way to reject what the extra
    // probes find.
    const plate = { cx: 60, cy: 50, rx: 35, ry: 35, confidence: 1 };
    const pts = proposePoints({ width: W, height: H, plate });
    const outside = pts.filter((p) => ((p.x - 60) / 35) ** 2 + ((p.y - 50) / 35) ** 2 > 1);
    expect(Math.min(...outside.map((p) => p.x))).toBeGreaterThan(W * 0.2);
  });

  it('keeps every point in bounds', () => {
    const plate = { cx: 95, cy: 95, rx: 60, ry: 60, confidence: 1 };
    for (const p of proposePoints({ width: W, height: H, plate })) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(W);
      expect(p.y).toBeLessThan(H);
    }
  });

  it('probes the frame densely when there is no trustworthy plate', () => {
    const weak = proposePoints({ width: W, height: H, plate: { cx: 50, cy: 50, rx: 40, ry: 40, confidence: 0.4 } });
    const none = proposePoints({ width: W, height: H, plate: null });
    expect(weak).toEqual(none);
  });
});

describe('dedupeRegions', () => {
  it('keeps the small distinct dishes, not the blob containing them', () => {
    const a = region(10, 10, 30, 30);
    const b = region(60, 60, 80, 80);
    const whole = region(5, 5, 90, 90);
    const kept = dedupeRegions([whole, a, b]);
    expect(kept).toHaveLength(2);
    expect(kept.map((k) => k.areaPx)).toEqual([a.areaPx, b.areaPx]);
  });

  it('measures overlap against the smaller box, so containment counts', () => {
    expect(bboxOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 0, y0: 0, x1: 100, y1: 100 })).toBe(1);
    expect(bboxOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 50, y0: 50, x1: 60, y1: 60 })).toBe(0);
  });

  it('stops at the region budget', () => {
    const many = Array.from({ length: 20 }, (_, i) => region(i * 4, 0, i * 4 + 3, 3));
    expect(dedupeRegions(many, { maxItems: 4 })).toHaveLength(4);
  });
});

describe('fuseWithGlobal', () => {
  const regionTop = [{ id: 'tempura', prob: 0.55 }, { id: 'dosa', prob: 0.35 }];
  const imageTop = [{ id: 'dosa', prob: 0.9 }, { id: 'samosa', prob: 0.05 }];

  it('lets the whole photo overrule a misread fragment', () => {
    // The bug this exists for: one corner of a dosa really does look like
    // tempura, while the whole photo is 90% sure it is a dosa.
    expect(fuseWithGlobal(regionTop, imageTop)[0].id).toBe('dosa');
  });

  it('leaves the region alone at lambda 0', () => {
    expect(fuseWithGlobal(regionTop, imageTop, 0)[0].id).toBe('tempura');
  });

  it('returns a probability distribution', () => {
    const out = fuseWithGlobal(regionTop, imageTop);
    expect(out.reduce((a, b) => a + b.prob, 0)).toBeCloseTo(1, 6);
    expect(out.map((t) => t.prob)).toEqual([...out.map((t) => t.prob)].sort((a, b) => b - a));
  });

  it('does not treat absence from a truncated top-k as proof', () => {
    // 'chutney' is not in the whole-image list at all, but a confident region
    // must still be able to keep it.
    const out = fuseWithGlobal([{ id: 'chutney', prob: 0.98 }, { id: 'dosa', prob: 0.02 }], imageTop);
    expect(out[0].id).toBe('chutney');
  });
});

describe('mergeSameFood', () => {
  it('joins two pieces of one dosa into one diary line', () => {
    const merged = mergeSameFood([
      item('dosa', 0.6, region(0, 0, 20, 20)),
      item('dosa', 0.4, region(60, 60, 80, 80)),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].region.areaPx).toBe(800); // both pieces weigh in
    expect(merged[0].region.bbox).toEqual({ x0: 0, y0: 0, x1: 80, y1: 80 });
  });

  it('joins touching regions that disagree only on the name', () => {
    // Half a stir-fry read as kung pao, half as sweet-and-sour.
    const a = item('kung-pao-chicken', 0.5, region(0, 0, 40, 40), [{ id: 'sweet-and-sour-pork', prob: 0.4 }]);
    const b = item('sweet-and-sour-pork', 0.45, region(38, 0, 70, 40), [{ id: 'kung-pao-chicken', prob: 0.44 }]);
    const merged = mergeSameFood([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('kung-pao-chicken'); // the more confident label wins
  });

  it('keeps genuinely different dishes apart', () => {
    const dosa = item('dosa', 0.9, region(0, 0, 40, 40));
    const sambar = item('sambar', 0.9, region(41, 0, 70, 40));
    expect(mergeSameFood([dosa, sambar])).toHaveLength(2);
  });

  it('runs to a fixed point across a chain of regions', () => {
    // A single pass leaves two groups when a later region bridges two earlier
    // ones — which is exactly how one omelette and one tortilla appeared where
    // there was only ever one tortilla.
    const shared = [{ id: 'omelette', prob: 0.42 }];
    const merged = mergeSameFood([
      item('omelette', 0.55, region(30, 0, 46, 20), [{ id: 'tortilla-espanola', prob: 0.42 }]),
      item('tortilla-espanola', 0.48, region(52, 0, 71, 21), shared),
      item('tortilla-espanola', 0.98, region(3, 19, 80, 57), shared),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('tortilla-espanola');
  });

  it('is unaffected by input order', () => {
    const xs = [
      item('idli', 0.9, region(0, 0, 20, 20)),
      item('vada', 0.9, region(60, 0, 80, 20)),
      item('idli', 0.8, region(0, 60, 20, 80)),
    ];
    const ids = (list) => mergeSameFood(list).map((i) => i.id).sort();
    expect(ids(xs)).toEqual(ids([...xs].reverse()));
  });

  it('absorbs a patch lying inside a dish, whatever it thinks it is', () => {
    // The filling and tempering showing through a masala dosa, read as an
    // omelette. It shares no candidate with the dosa, so only geometry can
    // catch it — and it is wholly inside the dosa's outline.
    const dosa = item('dosa', 0.52, region(0, 0, 80, 80));
    const patch = item('omelette', 0.91, region(30, 30, 44, 44));
    const merged = mergeSameFood([dosa, patch]);
    expect(merged).toHaveLength(1);
    // The container names the result even though the patch was far surer.
    expect(merged[0].id).toBe('dosa');
    expect(merged[0].prob).toBeCloseTo(0.52);
    // Absorbing a patch already inside the dish adds no area, so no grams.
    expect(merged[0].region.areaPx).toBe(6400);
  });

  it('keeps a side bowl that merely overlaps the plate', () => {
    // A chutney bowl half over the rim is not contained by the dosa, and two
    // dishes on one plate must stay two lines.
    const dosa = item('dosa', 0.8, region(0, 0, 60, 60));
    const bowl = item('coconut-chutney', 0.7, region(50, 50, 90, 90));
    expect(mergeSameFood([dosa, bowl])).toHaveLength(2);
  });

  it('keeps a side bowl whose box falls inside a large dish', () => {
    // A dosa spanning the frame with a chutney bowl beside it: the bowl's box
    // is entirely within the dosa's, and the two are still two dishes. Judging
    // this by boxes took masala-dosa from 3/3 dishes to 1/3 on the benchmark,
    // swallowing both the chutney and the sambar.
    const dosa = region(0, 0, 90, 90);
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 30; x++) { dosa.mask[y * 100 + x] = 0; dosa.areaPx--; }
    }
    const bowl = region(10, 10, 30, 30);
    expect(bboxOverlap(bowl.bbox, dosa.bbox)).toBe(1);   // the box says "inside"
    expect(maskContainment(bowl, dosa)).toBe(0);         // the mask says otherwise
    expect(mergeSameFood([
      { id: 'dosa', prob: 0.8, region: dosa, candidates: [{ id: 'dosa', prob: 0.8 }] },
      item('coconut-chutney', 0.7, bowl),
    ])).toHaveLength(2);
  });

  it('leaves contained patches alone when the rule is switched off', () => {
    const dosa = item('dosa', 0.52, region(0, 0, 80, 80));
    const patch = item('omelette', 0.91, region(30, 30, 44, 44));
    expect(mergeSameFood([dosa, patch], { containedFraction: 0 })).toHaveLength(2);
  });
});

describe('maskContainment', () => {
  it('asks whether the small thing is inside the big one, not the reverse', () => {
    const big = region(0, 0, 80, 80);
    const small = region(30, 30, 44, 44);
    expect(maskContainment(small, big)).toBeCloseTo(1);
    // Argument order must not change the answer.
    expect(maskContainment(big, small)).toBeCloseTo(1);
  });

  it('scores partial overlap by the smaller region', () => {
    // Half of the 20×20 square lies inside the 40×40 one.
    expect(maskContainment(region(0, 0, 40, 40), region(30, 0, 50, 20))).toBeCloseTo(0.5);
  });

  it('is zero for disjoint regions and for a missing mask', () => {
    expect(maskContainment(region(0, 0, 10, 10), region(50, 50, 60, 60))).toBe(0);
    expect(maskContainment(null, region(0, 0, 10, 10))).toBe(0);
  });
});

describe('candidateOverlap / touches / unionMask', () => {
  it('scores shared probability mass', () => {
    expect(candidateOverlap([{ id: 'a', prob: 0.6 }], [{ id: 'a', prob: 0.3 }])).toBeCloseTo(0.3);
    expect(candidateOverlap([{ id: 'a', prob: 0.6 }], [{ id: 'b', prob: 0.9 }])).toBe(0);
  });

  it('treats a small gap as touching, a real gap as not', () => {
    expect(touches(region(0, 0, 40, 40), region(42, 0, 80, 40))).toBe(true);
    expect(touches(region(0, 0, 10, 10), region(80, 80, 90, 90))).toBe(false);
    expect(touches(null, region(0, 0, 10, 10))).toBe(false);
  });

  it('unions masks without double-counting the overlap', () => {
    const u = unionMask(region(0, 0, 20, 20).mask, region(10, 10, 30, 30).mask);
    expect(u.areaPx).toBe(400 + 400 - 100);
  });
});

describe('isSingleDish / pickWholeMask', () => {
  it('reads a confident one-label photo as one dish', () => {
    expect(isSingleDish([item('dal', 0.7, region(0, 0, 50, 50))], [{ id: 'dal', prob: 0.9 }])).toBe(true);
  });

  it('never collapses a plate that holds two different foods', () => {
    const named = [item('dosa', 0.9, region(0, 0, 20, 20)), item('sambar', 0.9, region(60, 60, 80, 80))];
    expect(isSingleDish(named, [{ id: 'dosa', prob: 0.99 }])).toBe(false);
  });

  it('stays multi-dish when the whole photo is itself unsure', () => {
    expect(isSingleDish([item('dal', 0.5, region(0, 0, 50, 50))], [{ id: 'dal', prob: 0.2 }])).toBe(false);
  });

  it('prefers whichever of the dominant mask and the fragments covers more', () => {
    const frags = [item('a', 0.5, region(0, 0, 20, 20)), item('a', 0.5, region(60, 60, 90, 90))];
    const small = region(0, 0, 10, 10);
    const big = region(0, 0, 95, 95);
    expect(pickWholeMask(frags, small).areaPx).toBe(400 + 900);
    expect(pickWholeMask(frags, big).areaPx).toBe(big.areaPx);
    expect(pickWholeMask([], big)).toBe(big);
    expect(pickWholeMask([], null)).toBeNull();
  });
});

describe('proposeRegions', () => {
  /** Serve a fixed list of masks, one per prompt, repeating the last. */
  const serve = (masks) => {
    let i = 0;
    return async () => masks[Math.min(i++, masks.length - 1)];
  };

  it('keeps a whole-frame dish as the dominant mask, out of the dish regions', async () => {
    // A bowl of rice fills the shot. It is too big to be one dish among
    // several, but it is exactly the thing to measure when it is the only one.
    const big = { ...region(2, 2, 95, 95), iou: 0.6 };
    const { regions, dominant } = await proposeRegions({
      segment: serve([big]), width: W, height: H,
    });
    expect(regions).toHaveLength(0);
    expect(dominant.areaPx).toBe(big.areaPx);
  });

  it('holds dish regions to a stricter confidence bar than the whole-dish mask', async () => {
    const unsure = { ...region(10, 10, 40, 40), iou: 0.5 };
    const { regions, dominant } = await proposeRegions({
      segment: serve([unsure]), width: W, height: H,
    });
    expect(regions).toHaveLength(0); // below minMaskIou
    expect(dominant).not.toBeNull(); // above minDominantIou
  });

  it('survives a segmenter that throws on some prompts', async () => {
    let n = 0;
    const { regions } = await proposeRegions({
      width: W,
      height: H,
      segment: async () => {
        n += 1;
        if (n % 2) throw new Error('prompt failed');
        return region(10, 10, 40, 40);
      },
    });
    expect(regions.length).toBeGreaterThan(0);
  });

  it('reports progress for every prompt', async () => {
    let last = null;
    await proposeRegions({
      segment: serve([region(10, 10, 40, 40)]),
      width: W,
      height: H,
      onProgress: (done, total) => { last = [done, total]; },
    });
    expect(last[0]).toBe(last[1]);
  });
});

describe('buildPlate', () => {
  const image = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  const foods = {
    dosa: { name: 'Dosa', prior: { heightCm: 0.5, densityGml: 0.5, servingG: 110 } },
    sambar: { name: 'Sambar', prior: { heightCm: 4, densityGml: 1, servingG: 150 } },
    tempura: { name: 'Tempura', prior: { heightCm: 2.2, densityGml: 0.6, servingG: 150 } },
  };
  const base = {
    image,
    foodById: (id) => foods[id] ?? null,
    estimator: new PortionEstimator(),
    plate: null,
  };
  /** Answer each region in turn, so a test can say what every crop looks like. */
  const classifySequence = (...results) => {
    let i = 0;
    return async () => results[Math.min(i++, results.length - 1)];
  };
  const looksLike = (id, prob = 0.95) => ({ isFood: true, top: [{ id, prob }] });

  it('names a fragment with what the whole photo says it is', async () => {
    const items = await buildPlate({
      ...base,
      regions: [region(5, 5, 45, 45), region(55, 55, 95, 95)],
      imageTop: [{ id: 'dosa', prob: 0.9 }, { id: 'sambar', prob: 0.05 }],
      classify: async () => ({
        isFood: true,
        top: [{ id: 'tempura', prob: 0.55 }, { id: 'dosa', prob: 0.4 }],
      }),
    });
    expect(items.map((i) => i.id)).toEqual(['dosa']); // merged, and not "tempura"
  });

  it('keeps two real dishes as two diary lines', async () => {
    const items = await buildPlate({
      ...base,
      regions: [region(2, 2, 40, 40), region(60, 60, 96, 96)],
      imageTop: [{ id: 'dosa', prob: 0.6 }, { id: 'sambar', prob: 0.3 }],
      classify: classifySequence(looksLike('dosa'), looksLike('sambar')),
    });
    expect(items.map((i) => i.id).sort()).toEqual(['dosa', 'sambar']);
    for (const i of items) expect(i.grams).toBeGreaterThan(0);
  });

  it('drops garnish rather than logging it', async () => {
    const items = await buildPlate({
      ...base,
      regions: [region(0, 0, 90, 90), region(95, 95, 97, 97)],
      imageTop: [{ id: 'dosa', prob: 0.9 }],
      classify: classifySequence(looksLike('dosa'), looksLike('sambar')),
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('dosa');
  });

  it('logs nothing when the photo is not food', async () => {
    const items = await buildPlate({
      ...base,
      regions: [region(5, 5, 45, 45)],
      imageTop: [],
      classify: async () => ({ isFood: false, top: [{ id: 'dosa', prob: 0.9 }] }),
    });
    expect(items).toEqual([]);
  });

  it('falls back to the serving statistic when the only mask is a crumb', async () => {
    const items = await buildPlate({
      ...base,
      regions: [region(0, 0, 8, 8)], // 0.6% of the frame — not a whole dish
      dominant: region(0, 0, 8, 8),
      imageTop: [{ id: 'dosa', prob: 0.95 }],
      classify: async () => ({ isFood: true, top: [{ id: 'dosa', prob: 0.9 }] }),
    });
    expect(items).toHaveLength(1);
    expect(items[0].portion.method).toBe('serving-prior');
    expect(items[0].grams).toBe(110);
  });

  it('reports progress once per region plus a final tick', async () => {
    const seen = [];
    await buildPlate({
      ...base,
      regions: [region(5, 5, 45, 45), region(55, 55, 95, 95)],
      imageTop: [{ id: 'dosa', prob: 0.9 }],
      classify: async () => ({ isFood: true, top: [{ id: 'dosa', prob: 0.9 }] }),
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([[0, 2], [1, 2], [2, 2]]);
  });
});

describe('DEFAULTS', () => {
  it('exposes every tunable the bench sweeps', () => {
    for (const k of ['globalPrior', 'minItemProb', 'maxItems', 'mergeSameFood', 'singleDishProb']) {
      expect(DEFAULTS[k]).toBeDefined();
    }
  });
});
