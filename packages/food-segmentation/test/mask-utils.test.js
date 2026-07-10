import { describe, it, expect } from 'vitest';
import { largestComponent, fillHoles, maskBBox, cleanMask, overlayMask } from '../src/index.js';

function maskFrom(rows) {
  const h = rows.length, w = rows[0].length;
  const m = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => { m[y * w + x] = c === '#' ? 1 : 0; }));
  return { m, w, h };
}

describe('largestComponent', () => {
  it('keeps only the biggest blob', () => {
    const { m, w, h } = maskFrom([
      '##....',
      '##....',
      '....##',
      '...###',
    ]);
    largestComponent(m, w, h);
    expect(m[0]).toBe(0);          // small blob removed
    expect(m[3 * w + 4]).toBe(1);  // big blob kept
    expect([...m].reduce((a, b) => a + b, 0)).toBe(5);
  });
});

describe('fillHoles', () => {
  it('fills an enclosed hole but not outside background', () => {
    const { m, w, h } = maskFrom([
      '#####',
      '#...#',
      '#.#.#',
      '#...#',
      '#####',
    ]);
    fillHoles(m, w, h);
    expect([...m].every((v) => v === 1)).toBe(true);
  });

  it('leaves border-connected background alone', () => {
    const { m, w, h } = maskFrom([
      '.###.',
      '.#.#.',
      '.#.#.', // hole open to the bottom
      '.#.#.',
    ]);
    fillHoles(m, w, h);
    expect(m[1 * w + 2]).toBe(0);
  });
});

describe('maskBBox', () => {
  it('returns tight bounds', () => {
    const { m, w, h } = maskFrom([
      '....',
      '.##.',
      '.#..',
      '....',
    ]);
    expect(maskBBox(m, w, h)).toEqual({ x0: 1, y0: 1, x1: 2, y1: 2 });
  });
  it('returns null for empty masks', () => {
    expect(maskBBox(new Uint8Array(9), 3, 3)).toBeNull();
  });
});

describe('cleanMask + overlayMask', () => {
  it('cleanMask = largest component + hole fill', () => {
    const { m, w, h } = maskFrom([
      '#.....',
      '.####.',
      '.#..#.',
      '.####.',
    ]);
    cleanMask(m, w, h);
    expect(m[0]).toBe(0);          // stray pixel removed
    expect(m[2 * w + 2]).toBe(1);  // hole filled
  });

  it('overlayMask tints only foreground', () => {
    const img = { data: new Uint8ClampedArray(8).fill(100), width: 2, height: 1 };
    overlayMask(new Uint8Array([1, 0]), img, [255, 0, 0], 0.5);
    expect(img.data[0]).toBeGreaterThan(100); // tinted
    expect(img.data[4]).toBe(100);            // untouched
  });
});
