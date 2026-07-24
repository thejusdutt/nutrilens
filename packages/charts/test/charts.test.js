import { describe, it, expect } from 'vitest';
import { donut, barRows, stackedColumns, lineChart, ring } from '../src/index.js';

const arcs = (svg) => [...svg.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)].map((m) => Number(m[1]));

describe('donut', () => {
  const slices = [
    { label: 'Carbs', value: 200, color: '#e8a13c' },
    { label: 'Protein', value: 100, color: '#4f8ef7' },
    { label: 'Fat', value: 100, color: '#e05d7b' },
  ];

  it('is valid, sized SVG with an accessible name', () => {
    const svg = donut({ slices, size: 160, title: 'Macros' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Macros"');
    expect(svg).toContain('viewBox="0 0 160 160"');
  });

  it('gives each slice an arc proportional to its share', () => {
    const lengths = arcs(donut({ slices }));
    expect(lengths).toHaveLength(3);
    expect(lengths[0] / (lengths[0] + lengths[1] + lengths[2])).toBeCloseTo(0.5, 3);
    expect(lengths[1]).toBeCloseTo(lengths[2], 3);
  });

  it('labels each slice with its percentage for hover and screen readers', () => {
    const svg = donut({ slices });
    expect(svg).toContain('<title>Carbs: 50%</title>');
    expect(svg).toContain('<title>Protein: 25%</title>');
  });

  it('skips zero and negative slices instead of drawing phantom arcs', () => {
    expect(arcs(donut({ slices: [...slices, { label: 'Alcohol', value: 0, color: '#000' }] }))).toHaveLength(3);
    expect(arcs(donut({ slices: [{ label: 'Bad', value: -50, color: '#000' }, ...slices] }))).toHaveLength(3);
  });

  it('draws a single ring when nothing is logged', () => {
    const svg = donut({ slices: [{ label: 'Carbs', value: 0, color: '#e8a13c' }] });
    expect(arcs(svg)).toHaveLength(0);
    expect(svg).toContain('<circle');
  });

  it('renders a full circle for one non-zero slice', () => {
    const svg = donut({ slices: [{ label: 'All', value: 5, color: '#fff' }], size: 100, thickness: 20 });
    const [len] = arcs(svg);
    expect(len).toBeCloseTo(2 * Math.PI * 40, 1);
  });

  it('puts the centre text and subtitle in the hole', () => {
    const svg = donut({ slices, center: '1,842', sub: 'kcal' });
    expect(svg).toContain('>1,842<');
    expect(svg).toContain('>kcal<');
  });

  it('escapes labels that contain markup', () => {
    const svg = donut({ slices: [{ label: '<script>&"', value: 1, color: '#000' }] });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;&amp;&quot;');
  });
});

describe('barRows', () => {
  const bars = [
    { label: 'Protein', value: 92, goal: 140, color: '#4f8ef7', text: '92 / 140 g' },
    { label: 'Carbs', value: 300, goal: 250, color: '#e8a13c', text: '300 / 250 g' },
  ];

  it('scales each bar against its own goal', () => {
    const svg = barRows({ bars, width: 320 });
    const widths = [...svg.matchAll(/<rect[^>]*fill="#[0-9a-f]{6}"/gi)].length;
    expect(widths).toBe(2);
    expect(svg).toContain('92 / 140 g');
  });

  it('marks bars that exceed their goal and clamps the fill', () => {
    const svg = barRows({ bars });
    expect(svg).toContain('ch-over');
    const fills = [...svg.matchAll(/width="([\d.]+)" height="\d+" rx="[\d.]+" fill="#e8a13c"/g)].map((m) => Number(m[1]));
    const tracks = [...svg.matchAll(/width="([\d.]+)" height="\d+" rx="[\d.]+" class="ch-track"/g)].map((m) => Number(m[1]));
    expect(fills[0]).toBeLessThanOrEqual(tracks[0]);
  });

  it('grows with the number of rows', () => {
    expect(barRows({ bars, rowHeight: 26 })).toContain('viewBox="0 0 320 52"');
  });

  it('survives zero goals and an empty list', () => {
    expect(() => barRows({ bars: [{ label: 'X', value: 0, goal: 0, color: '#000' }] })).not.toThrow();
    expect(barRows({ bars: [] })).toContain('<svg');
  });
});

describe('stackedColumns', () => {
  const columns = [
    { label: 'Mon', segments: [{ value: 500, color: '#a' }, { value: 700, color: '#b' }] },
    { label: 'Tue', segments: [{ value: 400, color: '#a' }, { value: 300, color: '#b' }] },
  ];

  it('stacks segments and scales to the tallest column', () => {
    const svg = stackedColumns({ columns, height: 160, goal: 2000 });
    const heights = [...svg.matchAll(/height="([\d.]+)" fill/g)].map((m) => Number(m[1]));
    expect(heights).toHaveLength(4);
    // Monday totals 1200 against a 2000 goal: 60% of the plot area.
    expect((heights[0] + heights[1]) / (160 - 24)).toBeCloseTo(0.6, 1);
  });

  it('draws the goal line', () => {
    expect(stackedColumns({ columns, goal: 2000 })).toContain('ch-goal-line');
    expect(stackedColumns({ columns })).not.toContain('ch-goal-line');
  });

  it('labels the category axis', () => {
    const svg = stackedColumns({ columns });
    expect(svg).toContain('>Mon<');
    expect(svg).toContain('>Tue<');
  });

  it('handles empty days without dividing by zero', () => {
    const svg = stackedColumns({ columns: [{ label: 'Mon', segments: [] }, ...columns] });
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('NaN');
  });
});

describe('lineChart', () => {
  const points = [
    { label: '1 Jul', value: 82.4 },
    { label: '2 Jul', value: 82.1 },
    { label: '3 Jul', value: null },
    { label: '4 Jul', value: 81.6 },
  ];

  it('draws a polyline per unbroken run, so gaps are not invented', () => {
    const svg = lineChart({ points });
    const lines = [...svg.matchAll(/<polyline/g)];
    const dots = [...svg.matchAll(/<circle/g)];
    expect(lines).toHaveLength(1);   // 82.4→82.1 joined; 81.6 is isolated
    expect(dots.length).toBeGreaterThanOrEqual(3);
  });

  it('annotates points for hover', () => {
    expect(lineChart({ points })).toContain('<title>1 Jul: 82.4</title>');
  });

  it('says so when there is no data', () => {
    expect(lineChart({ points: [{ label: 'x', value: null }] })).toContain('no data yet');
  });

  it('handles a single point and a flat series', () => {
    expect(lineChart({ points: [{ label: 'x', value: 70 }] })).toContain('<circle');
    const flat = lineChart({ points: [{ label: 'a', value: 70 }, { label: 'b', value: 70 }] });
    expect(flat).toContain('<polyline');
    expect(flat).not.toContain('NaN');
  });

  it('always keeps the goal line visible, widening the axis to fit it', () => {
    expect(lineChart({ points, goal: 80 })).toContain('ch-goal-line');
    const far = lineChart({ points, goal: 50 });
    expect(far).toContain('ch-goal-line');
    // The low axis label drops toward the distant goal instead of clipping it.
    expect(Number(far.match(/class="ch-axis">([\d.]+)</g)[1].match(/>([\d.]+)</)[1])).toBeLessThan(51);
  });

  it('never emits NaN coordinates', () => {
    for (const p of [points, [{ label: 'a', value: 0 }], [{ label: 'a', value: -3 }, { label: 'b', value: 5 }]]) {
      expect(lineChart({ points: p })).not.toContain('NaN');
    }
  });
});

describe('ring', () => {
  it('fills proportionally and switches colour when over goal', () => {
    const under = ring({ value: 1500, goal: 2000, color: '#34a86c' });
    expect(under).toContain('#34a86c');
    const over = ring({ value: 2500, goal: 2000, color: '#34a86c', over: '#e05d7b' });
    expect(over).toContain('#e05d7b');
    expect(over).not.toContain('#34a86c');
  });

  it('handles a zero goal without dividing by zero', () => {
    expect(ring({ value: 100, goal: 0 })).not.toContain('NaN');
  });
});
