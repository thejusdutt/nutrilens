import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static checks over the icon set.
 *
 * Read as source rather than imported: app/src/icons.js imports the DOM helper
 * from ui.js, which registers a global keydown listener at module scope, so
 * importing it outside a browser throws. What matters here is the icon table
 * itself, and that is inspectable as text.
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');
const iconsSrc = readFileSync(join(srcDir, 'icons.js'), 'utf8');

const names = [...iconsSrc.matchAll(/^ {2}([a-z][a-zA-Z]*):\s*'/gm)].map((m) => m[1]);
const bodies = [...iconsSrc.matchAll(/^ {2}[a-z][a-zA-Z]*:\s*('(?:[^'\\]|\\.)*')/gm)].map((m) => m[1]);

describe('the icon table', () => {
  it('defines every icon the app asks for', () => {
    const used = new Set();
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
      const s = readFileSync(join(srcDir, file), 'utf8');
      for (const m of s.matchAll(/\bicon(?:El)?\('([a-zA-Z]+)'/g)) used.add(m[1]);
    }
    // A missing name is not an error at runtime — `icon()` falls back to an
    // empty body and draws a blank box, which is easy to ship without noticing.
    expect([...used].filter((n) => !names.includes(n))).toEqual([]);
  });

  it('draws every icon on one grid, at one stroke weight', () => {
    // Mixed viewBoxes or stroke widths are why an icon set stops looking like a
    // set. Geometry lives in the `svg()` helper, so no path may re-declare it.
    expect(iconsSrc).toContain('viewBox="0 0 24 24"');
    for (const body of bodies) {
      expect(body).not.toMatch(/viewBox|stroke-width(?!=")/);
    }
  });

  it('inherits colour instead of hard-coding it', () => {
    // An icon that names its own colour cannot follow the theme.
    for (const [i, body] of bodies.entries()) {
      expect(body, names[i]).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
      if (/fill="/.test(body)) expect(body, names[i]).toMatch(/fill="currentColor"/);
    }
  });

  it('keeps every number at the scale of a 24-unit box', () => {
    // Deliberately a magnitude check, not a bounds check: path data mixes
    // absolute coordinates with relative deltas (`a2 2 0 0 1-2-2z` is an arc
    // with negative offsets, and perfectly in bounds), and telling the two
    // apart needs a real path parser. What this does catch is the typo that
    // actually happens — a digit slipped, 240 for 24 — which draws an icon
    // wildly outside its box.
    for (const [i, body] of bodies.entries()) {
      for (const m of body.matchAll(/-?\d+(?:\.\d+)?/g)) {
        expect(Math.abs(Number(m[0])), `${names[i]} has ${m[0]}`).toBeLessThanOrEqual(25);
      }
    }
  });

  it('covers the four meal slots, since the diary keys straight off them', () => {
    for (const slot of ['breakfast', 'lunch', 'dinner', 'snacks']) {
      expect(names).toContain(slot);
    }
  });

  it('has no emoji left in it', () => {
    expect(iconsSrc).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('the app chrome', () => {
  it('is drawn, not typed — no emoji anywhere in the interface', () => {
    const offenders = [];
    const files = ['../index.html', ...readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)];
    for (const rel of files) {
      const path = rel.startsWith('..') ? join(srcDir, rel) : join(srcDir, '..', rel);
      const s = readFileSync(path, 'utf8');
      const found = s.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu);
      if (found) offenders.push(`${rel}: ${[...new Set(found)].join(' ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
