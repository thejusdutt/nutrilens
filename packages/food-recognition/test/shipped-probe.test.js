/**
 * Guards on the shipped probe.json trusted lists.
 *
 * These lists decide which classes the linear probe may override the
 * sentence-matching head on. Getting one wrong is not a crash — it is a plate
 * that reads a masala dosa as an omelette and puts 11 g of protein on the diary
 * that was never eaten. That shipped once, because the classes were selected on
 * recall alone: the probe knew its own omelettes well, so it looked like a win,
 * and trusting it also handed it every golden-brown crepe.
 *
 * tools/select-trusted.mjs now also measures what a class *steals*. This pins
 * the outcome, so a future retrain that regenerates the lists without the
 * precision gate fails here rather than in someone's food diary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const probePath = join(dirname(fileURLToPath(import.meta.url)), '../../../app/public/data/probe.json');
const d = existsSync(probePath) ? describe : describe.skip;

d('shipped probe trusted lists', () => {
  const probe = JSON.parse(readFileSync(probePath, 'utf8'));

  it('carries both lists, with the crop list a subset of the whole-image one', () => {
    expect(Array.isArray(probe.trusted)).toBe(true);
    expect(Array.isArray(probe.trustedWhole)).toBe(true);
    // A class safe on a tight crop is safe on a full frame; the reverse is not true.
    for (const c of probe.trusted) {
      expect(probe.trustedWhole, `${c} trusted on crops but not on whole photos`).toContain(c);
    }
  });

  it('trusts on region crops only the classes trained on region crops', () => {
    // Everything else the probe learned came from whole photographs, and is
    // confidently wrong on a crop — measured: plate recall 76.3% → 71.7%.
    expect([...probe.trusted].sort()).toEqual(
      ['coconut-chutney', 'green-chutney', 'sambar', 'tomato-chutney'],
    );
  });

  it('does not trust classes that steal more than they win', () => {
    // Each of these passed a recall-only filter and was then measured to take
    // about as many right answers from zero-shot as it added. `omelette` is the
    // one that reached production and mis-named a dosa.
    const rejected = ['omelette', 'risotto', 'breakfast-burrito', 'chapati', 'refried-beans'];
    for (const c of rejected) {
      expect(probe.trustedWhole, `${c} must not be whole-trusted: it steals as much as it wins`)
        .not.toContain(c);
    }
  });

  it('every trusted class is one the probe actually knows', () => {
    const known = new Set(probe.classes ?? []);
    for (const c of probe.trustedWhole) {
      expect(known.has(c), `${c} is trusted but is not a probe class`).toBe(true);
    }
  });

  it('the whole-image list stays a deliberate shortlist', () => {
    // Not a magic number: it is a fraction of the 139 classes. If a retrain ever
    // trusts most of them, the selection gates have stopped doing their job.
    expect(probe.trustedWhole.length).toBeGreaterThan(4);
    expect(probe.trustedWhole.length).toBeLessThan(45);
  });
});
