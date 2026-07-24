/**
 * @nutrilens/charts
 *
 * Small SVG chart generators, no dependencies and no DOM: each function returns
 * an SVG string, so the same code renders in the app, in a printable report and
 * in a test assertion. Colours are passed in by the caller — the app owns its
 * palette and its light/dark themes; a chart library should not.
 *
 * Every chart carries `role="img"` and a `<title>`, because a calorie dashboard
 * that only exists as coloured pixels is unusable with a screen reader.
 */

const esc = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const n = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

/**
 * Donut chart. Slices with a zero (or negative) value are skipped rather than
 * drawn as invisible arcs, so hovering never hits a phantom segment.
 *
 * @param {Object} p
 * @param {{label:string, value:number, color:string}[]} p.slices
 * @param {number} [p.size=160]
 * @param {number} [p.thickness=26]
 * @param {string} [p.center]  Text drawn in the hole (e.g. "1,842 kcal").
 * @param {string} [p.sub]     Second line under `center`.
 * @param {string} [p.title]   Accessible name.
 * @param {string} [p.empty='#8883'] Ring colour when everything is zero.
 * @returns {string} SVG
 */
export function donut({ slices, size = 160, thickness = 26, center, sub, title = 'Chart', empty = '#8883' }) {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const total = slices.reduce((s, x) => s + Math.max(0, x.value || 0), 0);
  const circ = 2 * Math.PI * r;
  const parts = [];
  if (total <= 0) {
    parts.push(`<circle cx="${c}" cy="${c}" r="${n(r)}" fill="none" stroke="${esc(empty)}" stroke-width="${thickness}"/>`);
  } else {
    let offset = 0;
    for (const s of slices) {
      const v = Math.max(0, s.value || 0);
      if (v <= 0) continue;
      const len = v / total * circ;
      parts.push(
        `<circle cx="${c}" cy="${c}" r="${n(r)}" fill="none" stroke="${esc(s.color)}" stroke-width="${thickness}"`
        + ` stroke-dasharray="${n(len)} ${n(circ - len)}" stroke-dashoffset="${n(-offset)}"`
        + ` transform="rotate(-90 ${c} ${c})"><title>${esc(s.label)}: ${n(v / total * 100)}%</title></circle>`,
      );
      offset += len;
    }
  }
  if (center) {
    parts.push(`<text x="${c}" y="${c - (sub ? 2 : -6)}" text-anchor="middle" class="ch-center">${esc(center)}</text>`);
    if (sub) parts.push(`<text x="${c}" y="${c + 18}" text-anchor="middle" class="ch-sub">${esc(sub)}</text>`);
  }
  return svg(size, size, title, parts.join(''));
}

/**
 * Horizontal bars with an optional goal marker per bar — the shape a "protein
 * 92 / 140 g" row wants. Values above goal are clamped for width but the label
 * still reports the true number.
 *
 * @param {Object} p
 * @param {{label:string, value:number, goal?:number, color:string, text?:string}[]} p.bars
 * @param {number} [p.width=320] @param {number} [p.rowHeight=26] @param {string} [p.title]
 */
export function barRows({ bars, width = 320, rowHeight = 26, title = 'Bars' }) {
  const labelW = Math.min(110, Math.round(width * 0.3));
  const valueW = 76;
  const trackX = labelW + 8;
  const trackW = Math.max(20, width - labelW - valueW - 16);
  const parts = [];
  bars.forEach((b, i) => {
    const y = i * rowHeight;
    const max = b.goal && b.goal > 0 ? b.goal : Math.max(1, ...bars.map((x) => x.value || 0));
    const frac = Math.max(0, Math.min(1, (b.value || 0) / max));
    parts.push(
      `<text x="0" y="${y + rowHeight / 2 + 4}" class="ch-label">${esc(b.label)}</text>`
      + `<rect x="${trackX}" y="${y + 6}" width="${trackW}" height="${rowHeight - 14}" rx="${(rowHeight - 14) / 2}" class="ch-track"/>`
      + `<rect x="${trackX}" y="${y + 6}" width="${n(trackW * frac)}" height="${rowHeight - 14}" rx="${(rowHeight - 14) / 2}" fill="${esc(b.color)}"/>`
      + (b.goal > 0 && (b.value || 0) > b.goal
        ? `<rect x="${trackX + trackW - 2}" y="${y + 4}" width="3" height="${rowHeight - 10}" class="ch-over"/>` : '')
      + `<text x="${width}" y="${y + rowHeight / 2 + 4}" text-anchor="end" class="ch-value">${esc(b.text ?? n(b.value))}</text>`,
    );
  });
  return svg(width, Math.max(rowHeight, bars.length * rowHeight), title, parts.join(''));
}

/**
 * Vertical stacked columns over a category axis — a week of calories split by
 * meal, or macros per day. Columns scale to the tallest total (or `max`), and a
 * dashed goal line is drawn when given.
 *
 * @param {Object} p
 * @param {{label:string, segments:{value:number,color:string,label?:string}[]}[]} p.columns
 * @param {number} [p.width=340] @param {number} [p.height=160]
 * @param {number} [p.goal] @param {number} [p.max] @param {string} [p.title]
 */
export function stackedColumns({ columns, width = 340, height = 160, goal, max, title = 'Columns' }) {
  const padB = 18, padT = 6;
  const plotH = height - padB - padT;
  const totals = columns.map((c) => c.segments.reduce((s, x) => s + Math.max(0, x.value || 0), 0));
  const top = max ?? Math.max(1, ...totals, goal ?? 0);
  const slot = width / Math.max(1, columns.length);
  const barW = Math.min(28, slot * 0.62);
  const parts = [];
  if (goal > 0) {
    const gy = padT + plotH - goal / top * plotH;
    parts.push(`<line x1="0" y1="${n(gy)}" x2="${width}" y2="${n(gy)}" class="ch-goal-line"/>`);
  }
  columns.forEach((col, i) => {
    const cx = i * slot + slot / 2;
    let y = padT + plotH;
    for (const seg of col.segments) {
      const v = Math.max(0, seg.value || 0);
      if (v <= 0) continue;
      const h = v / top * plotH;
      y -= h;
      parts.push(`<rect x="${n(cx - barW / 2)}" y="${n(y)}" width="${n(barW)}" height="${n(h)}" fill="${esc(seg.color)}">`
        + `<title>${esc(seg.label ?? col.label)}: ${n(v)}</title></rect>`);
    }
    parts.push(`<text x="${n(cx)}" y="${height - 5}" text-anchor="middle" class="ch-axis">${esc(col.label)}</text>`);
  });
  return svg(width, height, title, parts.join(''));
}

/**
 * Line chart for a measurement over time (weight, calories per day). Gaps are
 * allowed: points with a null value break the line instead of interpolating a
 * weight nobody stepped on the scale for.
 *
 * @param {Object} p
 * @param {{label:string, value:number|null}[]} p.points
 * @param {number} [p.width=340] @param {number} [p.height=150]
 * @param {string} [p.color='#4f8ef7'] @param {number} [p.goal] @param {string} [p.title]
 * @param {boolean} [p.area=true]
 */
export function lineChart({ points, width = 340, height = 150, color = '#4f8ef7', goal, title = 'Trend', area = true }) {
  const padL = 34, padB = 18, padT = 8, padR = 4;
  const plotW = width - padL - padR;
  const plotH = height - padB - padT;
  const values = points.filter((p) => Number.isFinite(p.value)).map((p) => p.value);
  if (!values.length) return svg(width, height, title, `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="ch-axis">no data yet</text>`);
  // The axis always makes room for the goal, so a goal weight stays visible
  // even when it is far from anything logged yet — that gap is the point of
  // the chart.
  let lo = Math.min(...values, goal ?? Infinity);
  let hi = Math.max(...values, goal ?? -Infinity);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  const x = (i) => padL + (points.length === 1 ? plotW / 2 : i / (points.length - 1) * plotW);
  const y = (v) => padT + plotH - (v - lo) / (hi - lo) * plotH;

  const segments = [];
  let cur = [];
  points.forEach((p, i) => {
    if (Number.isFinite(p.value)) cur.push(`${n(x(i))},${n(y(p.value))}`);
    else if (cur.length) { segments.push(cur); cur = []; }
  });
  if (cur.length) segments.push(cur);

  const parts = [
    `<text x="0" y="${padT + 8}" class="ch-axis">${n(hi)}</text>`,
    `<text x="0" y="${padT + plotH}" class="ch-axis">${n(lo)}</text>`,
  ];
  if (goal > 0) {
    parts.push(`<line x1="${padL}" y1="${n(y(goal))}" x2="${width - padR}" y2="${n(y(goal))}" class="ch-goal-line"/>`);
  }
  if (area && segments.length === 1 && segments[0].length > 1) {
    const first = segments[0][0].split(',')[0];
    const last = segments[0][segments[0].length - 1].split(',')[0];
    parts.push(`<polygon points="${first},${n(padT + plotH)} ${segments[0].join(' ')} ${last},${n(padT + plotH)}" fill="${esc(color)}" opacity="0.14"/>`);
  }
  for (const seg of segments) {
    if (seg.length === 1) parts.push(`<circle cx="${seg[0].split(',')[0]}" cy="${seg[0].split(',')[1]}" r="3.5" fill="${esc(color)}"/>`);
    else parts.push(`<polyline points="${seg.join(' ')}" fill="none" stroke="${esc(color)}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  points.forEach((p, i) => {
    if (!Number.isFinite(p.value)) return;
    parts.push(`<circle cx="${n(x(i))}" cy="${n(y(p.value))}" r="2.6" fill="${esc(color)}"><title>${esc(p.label)}: ${n(p.value)}</title></circle>`);
  });
  const step = Math.ceil(points.length / 6);
  points.forEach((p, i) => {
    if (i % step) return;
    parts.push(`<text x="${n(x(i))}" y="${height - 5}" text-anchor="middle" class="ch-axis">${esc(p.label)}</text>`);
  });
  return svg(width, height, title, parts.join(''));
}

/** A single progress ring, for "calories remaining". */
export function ring({ value, goal, size = 120, thickness = 12, color = '#34a86c', over = '#e05d7b', center, sub, title = 'Progress' }) {
  const frac = goal > 0 ? Math.min(1, Math.max(0, value / goal)) : 0;
  const isOver = goal > 0 && value > goal;
  return donut({
    slices: [
      { label: title, value: frac, color: isOver ? over : color },
      { label: 'remaining', value: 1 - frac, color: '#8882' },
    ],
    size, thickness, center, sub, title,
  });
}

function svg(w, h, title, body) {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${esc(title)}"`
    + ` xmlns="http://www.w3.org/2000/svg"><title>${esc(title)}</title>${body}</svg>`;
}
