import { describe, it, expect } from 'vitest';
import { findCompanions, quadrants, GOES_WITH, COMPANION_MIN_PROB } from '../src/index.js';

const image = { data: new Uint8ClampedArray(40 * 30 * 4), width: 40, height: 30 };
const foods = { idli: { prior: { servingG: 120 } }, sambar: { prior: { servingG: 150 } }, 'coconut-chutney': { prior: { servingG: 40 } }, vada: { prior: { servingG: 90 } } };
const foodById = (id) => foods[id] ?? null;
/** A classifier that answers per crop, in quadrant order. */
const scripted = (answers) => {
  let i = 0;
  return async () => ({ top: answers[i++] ?? [] });
};

describe('findCompanions', () => {
  it('covers the frame with four half-size windows', () => {
    const q = quadrants(40, 30);
    expect(q).toHaveLength(4);
    expect(q.map((w) => [w.x, w.y])).toEqual([[0, 0], [20, 0], [0, 15], [20, 15]]);
  });

  it('adds a listed side dish that one crop names confidently, at its serving', async () => {
    const found = await findCompanions({
      image, mainId: 'idli', foodById,
      classify: scripted([[{ id: 'idli', prob: 0.9 }], [{ id: 'sambar', prob: 0.4 }], [], []]),
    });
    expect(found).toEqual([{ id: 'sambar', prob: 0.4, grams: 150 }]);
  });

  it('ignores weak evidence and foods not on the main dish\'s list', async () => {
    const found = await findCompanions({
      image, mainId: 'idli', foodById,
      classify: scripted([[{ id: 'sambar', prob: COMPANION_MIN_PROB - 0.01 }], [{ id: 'tonic-water', prob: 0.99 }], [], []]),
    });
    expect(found).toEqual([]);
  });

  it('classifies nothing when the main dish has no companions', async () => {
    let calls = 0;
    const found = await findCompanions({ image, mainId: 'pizza', foodById, classify: async () => { calls++; return { top: [] }; } });
    expect(found).toEqual([]);
    expect(calls).toBe(0);
  });

  it('never lists a dish as its own companion', () => {
    for (const [main, sides] of Object.entries(GOES_WITH)) expect(sides).not.toContain(main);
  });
});

describe('findCompanions, one chutney per plate', () => {
  it('keeps only the strongest chutney when a bowl reads as several', async () => {
    const withChutneys = { ...foods, 'green-chutney': { prior: { servingG: 30 } } };
    const found = await findCompanions({
      image, mainId: 'idli', foodById: (id) => withChutneys[id] ?? null,
      classify: scripted([[{ id: 'coconut-chutney', prob: 0.46 }], [{ id: 'green-chutney', prob: 0.3 }], [{ id: 'sambar', prob: 0.7 }], []]),
    });
    expect(found.map((f) => f.id)).toEqual(['sambar', 'coconut-chutney']);
  });
});
