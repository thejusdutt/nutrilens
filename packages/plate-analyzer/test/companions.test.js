import { describe, it, expect } from 'vitest';
import {
  findCompanions, findMissedCompanions, quadrants, edgeTiles, GOES_WITH, COMPANION_MIN_PROB, TILE_MIN_PROB, CHUTNEY_COLOUR,
} from '../src/index.js';

const image = { data: new Uint8ClampedArray(40 * 30 * 4), width: 40, height: 30 };
const foods = Object.fromEntries(['idli', 'sambar', 'vada', 'masala-dosa', ...Object.keys(CHUTNEY_COLOUR)]
  .map((id) => [id, { prior: { servingG: id === 'sambar' ? 150 : 40 } }]));
const foodById = (id) => foods[id] ?? null;
/** A classifier that answers per crop, in quadrant order. */
const scripted = (answers) => {
  let i = 0;
  return async () => ({ top: answers[i++] ?? [] });
};

describe('quadrants', () => {
  it('covers the frame with four half-size windows', () => {
    const q = quadrants(40, 30);
    expect(q).toHaveLength(4);
    expect(q.map((w) => [w.x, w.y])).toEqual([[0, 0], [20, 0], [0, 15], [20, 15]]);
  });
});

describe('findCompanions', () => {
  it('adds a listed side dish that one tile names confidently, at its serving', async () => {
    const found = await findCompanions({
      image, mainId: 'idli', foodById,
      classify: scripted([[{ id: 'idli', prob: 0.9 }], [{ id: 'sambar', prob: 0.4 }]]),
    });
    expect(found).toEqual([{ id: 'sambar', prob: 0.4, grams: 150 }]);
  });

  it('ignores weak evidence and foods not on the main dish\'s list', async () => {
    const found = await findCompanions({
      image, mainId: 'idli', foodById,
      classify: scripted([[{ id: 'sambar', prob: COMPANION_MIN_PROB - 0.01 }], [{ id: 'tonic-water', prob: 0.99 }]]),
    });
    expect(found).toEqual([]);
  });

  it('classifies nothing when the main dish has no companions', async () => {
    let calls = 0;
    const found = await findCompanions({ image, mainId: 'pizza', foodById, classify: async () => { calls++; return { top: [] }; } });
    expect(found).toEqual([]);
    expect(calls).toBe(0);
  });

  it('logs two chutneys when two crops show two colours', async () => {
    // An orange bowl top-left, a white bowl bottom-left.
    const found = await findCompanions({
      image, mainId: 'masala-dosa', foodById,
      classify: scripted([
        [{ id: 'peanut-chutney', prob: 0.4 }, { id: 'tomato-chutney', prob: 0.2 }],
        [],
        [{ id: 'coconut-chutney', prob: 0.28 }],
      ]),
    });
    expect(found.map((f) => f.id)).toEqual(['peanut-chutney', 'coconut-chutney']);
  });

  it('logs one bowl once, even when its crop also scores another chutney', async () => {
    // One white bowl split over two crops; one crop also reads it as peanut.
    const found = await findCompanions({
      image, mainId: 'idli', foodById,
      classify: scripted([
        [{ id: 'coconut-chutney', prob: 0.25 }, { id: 'peanut-chutney', prob: 0.22 }],
        [{ id: 'coconut-chutney', prob: 0.45 }],
      ]),
    });
    expect(found.map((f) => f.id)).toEqual(['coconut-chutney']);
    expect(found[0].prob).toBe(0.45);
  });

  it('does not add up chutney names: a white bowl stays white', async () => {
    // Summing orange names (0.12 + 0.1 + 0.08) would outvote coconut 0.25.
    const found = await findCompanions({
      image, mainId: 'idli', foodById,
      classify: scripted([[{ id: 'coconut-chutney', prob: 0.25 }, { id: 'tomato-chutney', prob: 0.12 },
        { id: 'peanut-chutney', prob: 0.1 }, { id: 'onion-chutney', prob: 0.08 }]]),
    });
    expect(found.map((f) => f.id)).toEqual(['coconut-chutney']);
  });

  it('never lists a dish as its own companion', () => {
    for (const [main, sides] of Object.entries(GOES_WITH)) expect(sides).not.toContain(main);
  });
});

describe('edgeTiles', () => {
  it('covers the eight outer thirds and skips the centre', () => {
    const t = edgeTiles(30, 30);
    expect(t).toHaveLength(8);
    expect(t.map((w) => [w.x, w.y])).toEqual([[0, 0], [10, 0], [20, 0], [0, 10], [20, 10], [0, 20], [10, 20], [20, 20]]);
  });
});

describe('findMissedCompanions', () => {
  it('adds a chutney colour the first pass missed, at the stricter cut-off', async () => {
    // The user's dosa: peanut found by the quadrants, coconut only in a tile.
    const found = await findMissedCompanions({
      image, mainId: 'masala-dosa', foodById,
      found: [{ id: 'peanut-chutney', prob: 0.28 }],
      classify: scripted([[], [], [], [{ id: 'coconut-chutney', prob: 0.28 }, { id: 'tomato-chutney', prob: 0.26 }]]),
    });
    expect(found.map((f) => f.id)).toEqual(['coconut-chutney']);
  });

  it('never adds a second chutney of a colour already on the plate', async () => {
    const found = await findMissedCompanions({
      image, mainId: 'masala-dosa', foodById,
      found: [{ id: 'peanut-chutney', prob: 0.28 }],
      classify: scripted([[{ id: 'tomato-chutney', prob: 0.9 }]]),
    });
    expect(found).toEqual([]);
  });

  it('ignores tile scores below TILE_MIN_PROB even when above the quadrant cut-off', async () => {
    expect(TILE_MIN_PROB).toBeGreaterThan(COMPANION_MIN_PROB);
    const found = await findMissedCompanions({
      image, mainId: 'idli', foodById, found: [],
      classify: scripted([[{ id: 'tomato-chutney', prob: (COMPANION_MIN_PROB + TILE_MIN_PROB) / 2 }]]),
    });
    expect(found).toEqual([]);
  });

  it('skips the tiles entirely when every listed side is already found', async () => {
    let calls = 0;
    const found = await findMissedCompanions({
      image, mainId: 'hamburger', foodById: (id) => ({ prior: { servingG: 100 } }),
      found: [{ id: 'french-fries' }, { id: 'onion-rings' }],
      classify: async () => { calls++; return { top: [] }; },
    });
    expect(found).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('GOES_WITH', () => {
  it('never lists a dish as its own companion', () => {
    for (const [main, sides] of Object.entries(GOES_WITH)) expect(sides).not.toContain(main);
  });
});
