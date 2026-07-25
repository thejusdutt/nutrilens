import { describe, it, expect } from 'vitest';
import {
  unitNoun, niceCount, stepFor, bestServing, servingPhrase,
} from '../src/servings.js';

// The measures below are copied verbatim out of app/public/data/nutrition-db.json,
// so these tests exercise the strings FNDDS actually ships, not tidied ones.
const DOSA = [['1 small', 123], ['1 medium', 197]];
const IDLI = [['1 item', 38], ['1 surface inch', 10]];
const VADA = [['1 item, any size', 30]];
const SAMBAR = [['1 cup', 248]];
const CHAPATI = [['1 large chappatti or roti (8")', 52], ['1 medium chappatti or roti (7")', 40]];

describe('unitNoun', () => {
  it('drops the quantity FNDDS bakes into the label', () => {
    expect(unitNoun('1 cup')).toBe('cup');
    expect(unitNoun('1 medium chappatti or roti (7")')).toBe('medium chappatti or roti (7")');
  });

  it('names the food when the measure says nothing about it', () => {
    // "3¾ 1 item" is what shipped before this existed.
    expect(unitNoun('1 item', 'Idli')).toBe('idli');
    expect(unitNoun('1 item, any size', 'Vada')).toBe('vada');
    expect(unitNoun('1 each', 'Boiled egg')).toBe('boiled egg');
  });

  it('never returns an empty string', () => {
    expect(unitNoun('1')).toBeTruthy();
    expect(unitNoun('')).toBeTruthy();
  });
});

describe('niceCount', () => {
  it('says quarters the way a person does', () => {
    expect(niceCount(0.25)).toBe('¼');
    expect(niceCount(0.5)).toBe('½');
    expect(niceCount(1.25)).toBe('1¼');
    expect(niceCount(3.75)).toBe('3¾');
    expect(niceCount(2)).toBe('2');
  });

  it('rounds to the nearest quarter, and drops fractions once counts get big', () => {
    expect(niceCount(1.47)).toBe('1½');
    expect(niceCount(11.4)).toBe('11');
  });
});

describe('stepFor', () => {
  it('steps in quarters for one-ish servings and whole units for many', () => {
    expect(stepFor(1)).toBe(0.25);
    expect(stepFor(3)).toBe(0.5);
    expect(stepFor(8)).toBe(1);
  });
});

describe('bestServing', () => {
  it('picks the measure that lands near a whole small count', () => {
    const u = bestServing(SAMBAR, 127, 'Sambar');
    expect(u.label).toBe('cup');
    expect(niceCount(u.count)).toBe('½');
  });

  it('counts idli as idli', () => {
    const u = bestServing(IDLI, 146, 'Idli');
    expect(u.label).toBe('idli');
    expect(servingPhrase(IDLI, 146, 'Idli')).toBe('3¾ idli');
  });

  it('ignores measures too small to count with', () => {
    // "1 surface inch" (10 g) would give "14.6 surface inch".
    expect(bestServing(IDLI, 146, 'Idli').grams).toBe(38);
  });

  it('reads a large dosa as a bit over one', () => {
    expect(servingPhrase(DOSA, 154, 'Masala dosa')).toBe('1¼ small');
  });

  it('keeps the count in a range worth showing', () => {
    for (const grams of [20, 60, 150, 400, 900]) {
      const u = bestServing(CHAPATI, grams, 'Chapati');
      expect(u.grams).toBeGreaterThan(0);
      expect(Number.isFinite(u.count)).toBe(true);
    }
  });

  it('falls back to grams when a food has no household measures', () => {
    const u = bestServing([], 200, 'Something');
    expect(u).toEqual({ label: 'g', grams: 1, count: 200 });
  });

  it('still answers when every measure is out of range', () => {
    // 900 g against a single 30 g measure is 30 servings — past the cap, but
    // the control still has to render something sane.
    const u = bestServing(VADA, 900, 'Vada');
    expect(u.grams).toBe(30);
    expect(u.label).toBe('vada');
  });

  it('accepts both the DB tuple form and object form', () => {
    expect(bestServing([{ label: '1 cup', grams: 248 }], 127, 'Sambar').label).toBe('cup');
  });
});
