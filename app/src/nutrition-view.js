/**
 * The Nutrition screen: Calories, Macros and Nutrients, each for a day or a week.
 *
 *   Calories  where the day's energy came from, meal by meal
 *   Macros    the split by energy, and grams against goal
 *   Nutrients every tracked nutrient against its target
 *
 * Week view answers the question a single day cannot: whether the average is
 * where you want it. Averages are over days that have entries — dividing a
 * week's sodium by seven when you logged three days would flatter you.
 */
import { dayTotals, macroEnergy, normalizeEntry, dateRange, shiftDate, SLOTS, SLOT_LABEL } from '@nutrilens/diary';
import { donut, barRows, stackedColumns } from '@nutrilens/charts';
import { $, el, fill, fmt, MACRO_COLORS, SLOT_COLORS, on } from './ui.js';
import { listMealsByDate, listMealsBetween, dateKey } from './db.js';
import { getProfile, dailyGoal, nutrientGoal } from './goals.js';
import { nutrientMeta } from './foods.js';
import { nutrientGoalTable } from './nutrients-ui.js';
import { diaryDate } from './today.js';

const state = { tab: 'calories', span: 'day' };

const TABS = [['calories', 'Calories'], ['macros', 'Macros'], ['nutrients', 'Nutrients']];

export async function renderNutrition() {
  const date = diaryDate();
  const profile = getProfile();
  const goal = dailyGoal(profile);

  const dayEntries = (await listMealsByDate(date)).map(normalizeEntry);
  const week = dateRange(date, 7);
  const weekEntries = (await listMealsBetween(week[0], date)).map(normalizeEntry);

  const head = el('div.nutri-head', null,
    el('div.tabs', { role: 'tablist' }, TABS.map(([id, label]) => el('button.tab', {
      role: 'tab', dataset: { tab: id }, class: id === state.tab ? 'tab active' : 'tab',
      'aria-selected': id === state.tab,
      onclick: () => { state.tab = id; renderNutrition(); },
    }, label))),
    el('div.seg', { role: 'group', 'aria-label': 'Time span' },
      ['day', 'week'].map((s) => el('button', {
        class: s === state.span ? 'active' : null, dataset: { span: s },
        onclick: () => { state.span = s; renderNutrition(); },
      }, s === 'day' ? 'Day' : 'Week'))));

  const body = state.tab === 'calories' ? caloriesTab({ date, dayEntries, weekEntries, week, goal })
    : state.tab === 'macros' ? macrosTab({ dayEntries, weekEntries, week, goal })
      : nutrientsTab({ dayEntries, weekEntries, profile });

  fill($('nutrition-root'),
    el('h2', null, state.span === 'day' ? `Nutrition · ${date === dateKey() ? 'Today' : fmt.date(date)}` : `Nutrition · 7 days to ${fmt.date(date)}`),
    head, body);
}

// ---------------------------------------------------------------------------
function caloriesTab({ dayEntries, weekEntries, week, goal }) {
  if (state.span === 'day') {
    const totals = dayTotals(dayEntries);
    const slices = SLOTS.map((slot, i) => ({
      label: SLOT_LABEL[slot].replace(/^\W+\s*/, ''),
      value: totals.bySlot[slot].kcal,
      color: SLOT_COLORS[i],
    }));
    const logged = totals.kcal;
    return el('div.stack', null,
      el('div.card', null,
        el('div.chart-wrap', { id: 'cal-pie', html: donut({
          slices, size: 190, thickness: 30, title: 'Calories by meal',
          center: fmt.kcal(logged), sub: `of ${fmt.kcal(goal.kcal)} kcal`,
        }) }),
        el('div.legend', null, slices.map((s) => el('div.legend-row', null,
          el('span.swatch', { style: `background:${s.color}` }),
          el('span', null, s.label),
          el('span.muted', null, `${fmt.kcal(s.value)} kcal · ${logged ? Math.round(s.value / logged * 100) : 0}%`))))),
      el('div.card', null,
        el('div.card-head', null, el('h3', null, 'Against goal')),
        el('div', { html: barRows({
          bars: [{ label: 'Calories', value: logged, goal: goal.kcal, color: logged > goal.kcal ? '#e05d7b' : '#34a86c', text: `${fmt.kcal(logged)} / ${fmt.kcal(goal.kcal)}` }],
          width: 320, title: 'Calories against goal',
        }) })));
  }

  const byDate = groupByDate(weekEntries);
  const columns = week.map((d) => ({
    label: fmt.dayShort(d),
    segments: SLOTS.map((slot, i) => ({
      label: `${SLOT_LABEL[slot].replace(/^\W+\s*/, '')} ${fmt.date(d)}`,
      value: dayTotals(byDate.get(d) ?? []).bySlot[slot].kcal,
      color: SLOT_COLORS[i],
    })),
  }));
  const daysLogged = week.filter((d) => (byDate.get(d) ?? []).length).length;
  const weekKcal = weekEntries.reduce((s, e) => s + (e.kcal ?? 0), 0);
  return el('div.stack', null,
    el('div.card', null,
      el('div.card-head', null, el('h3', null, 'Calories per day'), el('span.tag', null, `goal ${fmt.kcal(goal.kcal)}`)),
      el('div.chart-wrap', { id: 'cal-week', html: stackedColumns({ columns, width: 340, height: 170, goal: goal.kcal, title: 'Calories per day this week' }) }),
      el('div.legend', null, SLOTS.map((slot, i) => el('div.legend-row', null,
        el('span.swatch', { style: `background:${SLOT_COLORS[i]}` }),
        el('span', null, SLOT_LABEL[slot].replace(/^\W+\s*/, '')))))),
    el('div.card.stat-row', null,
      stat('Total', `${fmt.kcal(weekKcal)} kcal`),
      stat('Average / logged day', daysLogged ? `${fmt.kcal(weekKcal / daysLogged)} kcal` : '—'),
      stat('Days logged', `${daysLogged} / 7`)));
}

// ---------------------------------------------------------------------------
function macrosTab({ dayEntries, weekEntries, week, goal }) {
  if (state.span === 'day') {
    const totals = dayTotals(dayEntries);
    const energy = macroEnergy(totals.nutrients);
    const bars = ['carbs', 'protein', 'fat', 'fiber', 'sugars'].filter((k) => goal.macros[k] || totals.nutrients[k])
      .map((k) => ({
        label: k[0].toUpperCase() + k.slice(1),
        value: totals.nutrients[k] ?? 0,
        goal: goal.macros[k] ?? null,
        color: MACRO_COLORS[k],
        text: goal.macros[k] ? `${Math.round(totals.nutrients[k] ?? 0)} / ${goal.macros[k]} g` : `${Math.round(totals.nutrients[k] ?? 0)} g`,
      }));
    return el('div.stack', null,
      el('div.card', null,
        el('div.chart-wrap', { id: 'macro-pie', html: donut({
          slices: [
            { label: 'Carbs', value: energy.kcal.carbs, color: MACRO_COLORS.carbs },
            { label: 'Protein', value: energy.kcal.protein, color: MACRO_COLORS.protein },
            { label: 'Fat', value: energy.kcal.fat, color: MACRO_COLORS.fat },
          ],
          size: 190, thickness: 30, title: 'Macro split',
          center: `${Math.round(energy.pct.carbs)}/${Math.round(energy.pct.protein)}/${Math.round(energy.pct.fat)}`,
          sub: 'C / P / F %',
        }) }),
        el('div', { html: barRows({ bars, width: 320, title: 'Macros against goal' }) })),
      el('p.muted.tiny', null, 'Percentages are shares of logged calories, so they always add up to 100.'));
  }

  const byDate = groupByDate(weekEntries);
  const columns = week.map((d) => {
    const t = dayTotals(byDate.get(d) ?? []);
    const e = macroEnergy(t.nutrients);
    return {
      label: fmt.dayShort(d),
      segments: [
        { label: `Carbs ${fmt.date(d)}`, value: e.kcal.carbs, color: MACRO_COLORS.carbs },
        { label: `Protein ${fmt.date(d)}`, value: e.kcal.protein, color: MACRO_COLORS.protein },
        { label: `Fat ${fmt.date(d)}`, value: e.kcal.fat, color: MACRO_COLORS.fat },
      ],
    };
  });
  const loggedDays = week.filter((d) => (byDate.get(d) ?? []).length);
  const avg = (k) => (loggedDays.length
    ? loggedDays.reduce((s, d) => s + (dayTotals(byDate.get(d) ?? []).nutrients[k] ?? 0), 0) / loggedDays.length
    : 0);
  return el('div.stack', null,
    el('div.card', null,
      el('div.card-head', null, el('h3', null, 'Macro calories per day')),
      el('div.chart-wrap', { id: 'macro-week', html: stackedColumns({ columns, width: 340, height: 170, title: 'Macro calories per day' }) })),
    el('div.card', null,
      el('div.card-head', null, el('h3', null, 'Daily average'), el('span.tag', null, `${loggedDays.length} days logged`)),
      el('div', { html: barRows({
        bars: ['carbs', 'protein', 'fat'].map((k) => ({
          label: k[0].toUpperCase() + k.slice(1),
          value: avg(k), goal: goal.macros[k], color: MACRO_COLORS[k],
          text: `${Math.round(avg(k))} / ${goal.macros[k]} g`,
        })),
        width: 320, title: 'Average macros against goal',
      }) })));
}

// ---------------------------------------------------------------------------
function nutrientsTab({ dayEntries, weekEntries, profile }) {
  const meta = nutrientMeta();
  const entries = state.span === 'day' ? dayEntries : weekEntries;
  const totals = dayTotals(entries).nutrients;
  const days = state.span === 'day' ? 1 : 7;
  return el('div.stack', null,
    el('div.card', null,
      el('div.card-head', null,
        el('h3', null, state.span === 'day' ? 'Today’s nutrients' : 'This week’s nutrients'),
        el('span.tag', null, state.span === 'day' ? 'vs daily goal' : 'vs 7× daily goal')),
      nutrientGoalTable(totals, meta, (key, m) => nutrientGoal(key, m, profile), { days })),
    el('p.muted.tiny', null, 'Targets are FDA Daily Values unless you set your own in Settings.'));
}

// ---------------------------------------------------------------------------
const stat = (label, value) => el('div.stat', null, el('b', null, value), el('span', null, label));

function groupByDate(entries) {
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  return byDate;
}

on('diary', () => { if (!$('view-nutrition').hidden) renderNutrition(); });
on('profile', () => { if (!$('view-nutrition').hidden) renderNutrition(); });
