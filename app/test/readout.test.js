import { describe, it, expect } from 'vitest';
import { tickScale, stackedScale, bandLabel } from '../src/readout.js';

/** Every <rect> in an SVG string, as attributes, in document order. */
const rects = (svg) => [...svg.matchAll(/<rect\b[^>]*>/g)].map(([tag]) => ({
  x: Number(/\bx="([\d.]+)%?"/.exec(tag)?.[1] ?? 0),
  width: Number(/\bwidth="([\d.]+)%?"/.exec(tag)?.[1] ?? 0),
  cls: /class="([^"]+)"/.exec(tag)?.[1] ?? '',
}));

/**
 * Just the value bars — not the track, the graduations or the uncertainty band.
 * Matching on `width="…%"` across the whole string instead picks up the <svg>
 * element's own width and the full-width track, which silently shifts every
 * index by two.
 */
const bars = (svg) => rects(svg).filter((r) => !r.cls || r.cls === 'over');

describe('tickScale', () => {
  it('fills in proportion to the scale', () => {
    expect(bars(tickScale({ value: 1250, max: 2500 }))[0].width).toBeCloseTo(50, 5);
  });

  it('never runs past the end of the track', () => {
    const over = tickScale({ value: 9000, max: 2500 });
    for (const r of rects(over)) expect(r.x + r.width).toBeLessThanOrEqual(100.001);
  });

  it('clamps a negative value to zero rather than drawing backwards', () => {
    expect(bars(tickScale({ value: -400, max: 2000 }))[0].width).toBe(0);
  });

  it('survives a zero scale instead of dividing by it', () => {
    const svg = tickScale({ value: 100, max: 0 });
    expect(svg).toContain('<svg');
    for (const r of rects(svg)) expect(Number.isFinite(r.width)).toBe(true);
  });

  it('draws the plausible band behind the fill, not instead of it', () => {
    const svg = tickScale({ value: 400, max: 1000, low: 300, high: 600 });
    expect(svg).toContain('class="band"');
    // Band before fill in document order, so the fill reads on top of it.
    expect(svg.indexOf('class="band"')).toBeLessThan(svg.lastIndexOf('rx="3" fill='));
  });

  it('omits the band when there is no range to show', () => {
    expect(tickScale({ value: 400, max: 1000 })).not.toContain('class="band"');
    // An estimate whose bounds collapsed to a point is a count, not a range.
    expect(tickScale({ value: 400, max: 1000, low: 400, high: 400 })).not.toContain('class="band"');
  });

  it('marks an overrun as an overrun', () => {
    expect(tickScale({ value: 3000, max: 2500, over: true })).toContain('class="over"');
    expect(tickScale({ value: 1000, max: 2500 })).not.toContain('class="over"');
  });

  it('is graduated — that is the whole point of the component', () => {
    expect((tickScale({ value: 1, max: 2 }).match(/class="tick"/g) ?? []).length).toBe(5);
  });

  it('is hidden from assistive tech, because the figure beside it says the same thing', () => {
    expect(tickScale({ value: 1, max: 2 })).toContain('aria-hidden="true"');
  });
});

describe('stackedScale', () => {
  it('lays segments end to end', () => {
    const svg = stackedScale([
      { value: 500, color: 'a' }, { value: 250, color: 'b' },
    ], 1000);
    // Half the scale, then a quarter starting where the first left off.
    expect(bars(svg).map((r) => [r.x, r.width])).toEqual([[0, 50], [50, 25]]);
  });

  it('stops at the end of the track when the parts overflow it', () => {
    const svg = stackedScale([
      { value: 900, color: 'a' }, { value: 900, color: 'b' },
    ], 1000);
    const total = bars(svg).reduce((a, r) => a + r.width, 0);
    expect(total).toBeLessThanOrEqual(100.001);
  });

  it('skips empty contributions rather than drawing zero-width slivers', () => {
    const svg = stackedScale([
      { value: 0, color: 'a' }, { value: 500, color: 'b' },
    ], 1000);
    expect(svg).not.toContain('color="a"');
    expect((svg.match(/fill="b"/g) ?? []).length).toBe(1);
  });

  it('renders a track even with nothing logged', () => {
    const svg = stackedScale([], 2000);
    expect(svg).toContain('class="track"');
  });
});

describe('bandLabel', () => {
  it('prints a range with thousands separators', () => {
    expect(bandLabel(1200, 2400)).toBe(`${(1200).toLocaleString()}–${(2400).toLocaleString()}`);
  });

  it('says nothing when the value is a count rather than an estimate', () => {
    expect(bandLabel(300, 300)).toBe('');
    expect(bandLabel(null, 500)).toBe('');
    expect(bandLabel(undefined, undefined)).toBe('');
  });
});
