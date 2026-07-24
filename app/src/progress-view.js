/**
 * The Progress screen: weight over time against the goal, calories per day, and
 * body measurements.
 *
 * Charts plot only what was actually recorded — a missing weigh-in leaves a gap
 * rather than a straight line between two weeks. Interpolating body weight is
 * how a tracker ends up lying to someone about a plateau.
 */
import { dateRange, shiftDate, normalizeEntry, dayTotals } from '@nutrilens/diary';
import { lineChart, barRows } from '@nutrilens/charts';
import { $, el, fill, fmt, openSheet, closeSheet, toast, emit, on } from './ui.js';
import { listMeasurements, setMeasurement, getMeasurement, listMealsBetween, dateKey, getDay, setDay } from './db.js';
import { getProfile, setProfile, dailyGoal, weightProgress } from './goals.js';

const RANGES = [[30, '30 days'], [90, '90 days'], [365, 'Year']];
const state = { days: 30 };

export const MEASURES = [
  ['weightKg', 'Weight', 'kg'],
  ['waistCm', 'Waist', 'cm'],
  ['hipsCm', 'Hips', 'cm'],
  ['chestCm', 'Chest', 'cm'],
  ['armCm', 'Arm', 'cm'],
  ['bodyFatPct', 'Body fat', '%'],
];

export async function renderProgress() {
  const profile = getProfile();
  const goal = dailyGoal(profile);
  const measurements = await listMeasurements();
  const byDate = new Map(measurements.map((m) => [m.date, m]));
  const range = dateRange(dateKey(), state.days);
  const entries = (await listMealsBetween(range[0], dateKey())).map(normalizeEntry);

  const kcalByDate = new Map();
  for (const e of entries) kcalByDate.set(e.date, (kcalByDate.get(e.date) ?? 0) + (e.kcal ?? 0));

  const progress = weightProgress(profile);
  const weightPoints = range.map((d) => ({ label: shortLabel(d), value: byDate.get(d)?.weightKg ?? null }));
  const kcalPoints = range.map((d) => ({ label: shortLabel(d), value: kcalByDate.has(d) ? kcalByDate.get(d) : null }));
  const latest = [...measurements].filter((m) => m.weightKg > 0).sort((a, b) => a.date.localeCompare(b.date)).at(-1);

  fill($('progress-root'),
    el('h2', null, 'Progress'),
    el('div.seg.range-seg', { role: 'group', 'aria-label': 'Range' }, RANGES.map(([days, label]) => el('button', {
      class: days === state.days ? 'active' : null,
      onclick: () => { state.days = days; renderProgress(); },
    }, label))),

    el('div.card', null,
      el('div.card-head', null,
        el('h3', null, 'Weight'),
        el('button.link', { id: 'log-weight', onclick: () => openWeightSheet() }, 'Log weight')),
      el('div.chart-wrap', { id: 'weight-chart', html: lineChart({
        points: weightPoints, width: 340, height: 170, color: '#4f8ef7',
        goal: profile.goalWeightKg ?? undefined, title: 'Weight trend',
      }) }),
      progress
        ? el('div.stack', null,
          el('div', { html: barRows({
            bars: [{ label: 'To goal', value: progress.doneKg, goal: progress.totalKg, color: '#34a86c', text: `${progress.doneKg} / ${progress.totalKg} kg` }],
            width: 320, title: 'Progress to goal weight',
          }) }),
          el('p.muted', { id: 'weight-summary' },
            `Started ${progress.startWeightKg} kg · now ${progress.weightKg} kg · goal ${progress.goalWeightKg} kg`
            + (progress.remainingKg > 0 ? ` · ${progress.remainingKg} kg to go` : ' · goal reached 🎉')))
        : el('p.muted', null, 'Set a starting and goal weight in Settings to track progress toward it.'),
      latest && el('p.muted.tiny', null, `Last weigh-in ${fmt.date(latest.date)}`)),

    el('div.card', null,
      el('div.card-head', null, el('h3', null, 'Calories per day'), el('span.tag', null, `goal ${fmt.kcal(goal.kcal)}`)),
      el('div.chart-wrap', { id: 'kcal-chart', html: lineChart({
        points: kcalPoints, width: 340, height: 170, color: '#34a86c',
        goal: goal.kcal, title: 'Calories per day', area: false,
      }) }),
      el('p.muted.tiny', null, `${kcalPoints.filter((p) => p.value != null).length} of ${state.days} days logged`)),

    el('div.card', null,
      el('div.card-head', null, el('h3', null, 'Measurements'),
        el('button.link', { onclick: () => openMeasureSheet() }, 'Add')),
      measurementTable(measurements)));
}

const shortLabel = (key) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function measurementTable(measurements) {
  const recent = [...measurements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  if (!recent.length) return el('p.muted', null, 'Nothing recorded yet.');
  const cols = MEASURES.filter(([key]) => recent.some((m) => m[key] != null));
  return el('table.nutrient-table.measure-table', null,
    el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Date'),
      cols.map(([, label, unit]) => el('th', { scope: 'col' }, `${label} (${unit})`)))),
    el('tbody', null, recent.map((m) => el('tr', null,
      el('th', { scope: 'row' }, fmt.date(m.date)),
      cols.map(([key]) => el('td', null, m[key] != null ? String(m[key]) : '—'))))));
}

/** Log today's weight — the one measurement people take often. */
export function openWeightSheet() {
  const profile = getProfile();
  const input = el('input', {
    type: 'number', min: '20', max: '400', step: '0.1', id: 'weight-input',
    value: String(profile.weightKg ?? ''), inputmode: 'decimal',
  });
  const dateInput = el('input', { type: 'date', value: dateKey(), id: 'weight-date' });
  const save = async () => {
    const weightKg = Number(input.value);
    if (!(weightKg > 0)) { toast('Enter a weight'); return; }
    const date = dateInput.value || dateKey();
    await setMeasurement({ ...(await currentMeasure(date)), date, weightKg });
    const day = await getDay(date);
    await setDay({ ...day, weightKg });
    // The profile weight drives BMR, so today's weigh-in updates the goal.
    if (date === dateKey()) setProfile({ weightKg, startWeightKg: profile.startWeightKg ?? weightKg });
    emit('day', { date });
    emit('profile');
    toast('Weight logged');
    closeSheet({ all: true });
    if (!$('view-progress').hidden) renderProgress();
  };
  openSheet({
    title: 'Log weight',
    body: el('div.stack', null,
      el('label', { for: 'weight-input' }, 'Weight (kg)'), input,
      el('label', { for: 'weight-date' }, 'Date'), dateInput,
      el('button.primary.wide', { onclick: save }, 'Save')),
  });
}

/** Body measurements — waist and hips move when the scale refuses to. */
export function openMeasureSheet() {
  const dateInput = el('input', { type: 'date', value: dateKey() });
  const inputs = Object.fromEntries(MEASURES.map(([key, , unit]) => [key, el('input', {
    type: 'number', min: '0', step: '0.1', inputmode: 'decimal', placeholder: unit,
  })]));
  const save = async () => {
    const date = dateInput.value || dateKey();
    const rec = { ...(await currentMeasure(date)), date };
    let any = false;
    for (const [key] of MEASURES) {
      const v = Number(inputs[key].value);
      if (v > 0) { rec[key] = v; any = true; }
    }
    if (!any) { toast('Enter at least one measurement'); return; }
    await setMeasurement(rec);
    if (rec.weightKg && date === dateKey()) setProfile({ weightKg: rec.weightKg });
    emit('profile');
    toast('Measurements saved');
    closeSheet({ all: true });
    if (!$('view-progress').hidden) renderProgress();
  };
  openSheet({
    title: 'Add measurements',
    body: el('div.stack', null,
      el('label', null, 'Date', dateInput),
      el('div.label-grid', null, MEASURES.map(([key, label, unit]) => el('label', null, `${label} (${unit})`, inputs[key]))),
      el('button.primary.wide', { onclick: save }, 'Save')),
  });
}

const currentMeasure = async (date) => (await getMeasurement(date)) ?? {};

on('profile', () => { if (!$('view-progress').hidden) renderProgress(); });
on('day', () => { if (!$('view-progress').hidden) renderProgress(); });
