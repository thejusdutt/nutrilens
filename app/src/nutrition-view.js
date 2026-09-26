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
import { dayTotals, macroEnergy, normalizeEntry, dateRange, shiftDate, SLOTS } from '@nutrilens/diary';
import { donut, barRows, stackedColumns } from '@nutrilens/charts';
import { $, el, fill, fmt, EU, MACRO_COLORS, SLOT_COLORS, cssVar, on } from './ui.js';
import { listMealsByDate, listMealsBetween, dateKey } from './db.js';
import { getProfile, dailyGoal, nutrientGoal, SLOT_LABEL, shownCarbs, carbsLabel } from './goals.js';
import { nutrientMeta } from './foods.js';
import { nutrientGoalTable } from './nutrients-ui.js';
import { diaryDate } from './today.js';

const state = { tab: 'calories', span: 'day', rank: 'kcal' };

const TABS = [['calories', 'Calories'], ['macros', 'Macros'], ['nutrients', 'Nutrients'], ['foods', 'Foods']];

export async function renderNutrition() {
  const date = diaryDate();
  const profile = getProfile();
  const goal = dailyGoal(profile, date);

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
      }, s === 'day' ? 'Day' : 'Week'))),
    el('button.link', {
      id: 'btn-print-report',
      onclick: () => printReport({ date, profile, entries: state.span === 'day' ? dayEntries : weekEntries, days: state.span === 'day' ? [date] : week }),
    }, 'Print report'));

  const body = state.tab === 'calories' ? caloriesTab({ date, dayEntries, weekEntries, week, goal })
    : state.tab === 'macros' ? macrosTab({ dayEntries, weekEntries, week, goal })
      : state.tab === 'nutrients' ? nutrientsTab({ dayEntries, weekEntries, profile })
        : foodsTab({ entries: state.span === 'day' ? dayEntries : weekEntries });

  fill($('nutrition-root'),
    el('h2', null, state.span === 'day' ? `Nutrition · ${date === dateKey() ? 'Today' : fmt.date(date)}` : `Nutrition · 7 days to ${fmt.date(date)}`),
    head, body);
}

// ---------------------------------------------------------------------------
function caloriesTab({ dayEntries, weekEntries, week, goal }) {
  if (state.span === 'day') {
    const totals = dayTotals(dayEntries);
    const slices = SLOTS.map((slot, i) => ({
      label: SLOT_LABEL[slot],
      value: totals.bySlot[slot].kcal,
      color: SLOT_COLORS[i],
    }));
    const logged = totals.kcal;
    return el('div.stack', null,
      el('div.card', null,
        el('div.chart-wrap', { id: 'cal-pie', html: donut({
          slices, size: 190, thickness: 30, title: 'Calories by meal',
          center: fmt.kcal(logged), sub: `of ${fmt.energy(goal.kcal)}`,
        }) }),
        el('div.legend', null, slices.map((s) => el('div.legend-row', null,
          el('span.swatch', { style: `background:${s.color}` }),
          el('span', null, s.label),
          el('span.muted', null, `${fmt.energy(s.value)} · ${logged ? Math.round(s.value / logged * 100) : 0}%`))))),
      el('div.card', null,
        el('div.card-head', null, el('h3', null, 'Against goal')),
        el('div', { html: barRows({
          bars: [{ label: 'Calories', value: logged, goal: goal.kcal, color: cssVar(logged > goal.kcal ? '--alert' : '--m-fiber'), text: `${fmt.kcal(logged)} / ${fmt.kcal(goal.kcal)}` }],
          width: 320, title: 'Calories against goal',
        }) })));
  }

  const byDate = groupByDate(weekEntries);
  const columns = week.map((d) => ({
    label: fmt.dayShort(d),
    segments: SLOTS.map((slot, i) => ({
      label: `${SLOT_LABEL[slot]} ${fmt.date(d)}`,
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
        el('span', null, SLOT_LABEL[slot]))))),
    el('div.card.stat-row', null,
      stat('Total', `${fmt.energy(weekKcal)}`),
      stat('Average / logged day', daysLogged ? `${fmt.energy(weekKcal / daysLogged)}` : '—'),
      stat('Days logged', `${daysLogged} / 7`)));
}

// ---------------------------------------------------------------------------
function macrosTab({ dayEntries, weekEntries, week, goal }) {
  if (state.span === 'day') {
    const totals = dayTotals(dayEntries);
    const energy = macroEnergy(totals.nutrients);
    const shown = (k) => (k === 'carbs' ? shownCarbs(totals.nutrients) : totals.nutrients[k] ?? 0);
    const bars = ['carbs', 'protein', 'fat', 'fiber', 'sugars'].filter((k) => goal.macros[k] || totals.nutrients[k])
      .map((k) => ({
        label: k === 'carbs' ? carbsLabel() : k[0].toUpperCase() + k.slice(1),
        value: shown(k),
        goal: goal.macros[k] ?? null,
        color: MACRO_COLORS[k],
        text: goal.macros[k] ? `${Math.round(shown(k))} / ${goal.macros[k]} g` : `${Math.round(shown(k))} g`,
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
    el('p.muted.tiny', null,
      'Calories and macros use the goals you set in Settings, and so does any nutrient '
      + 'you gave your own goal there. The rest use the FDA Daily Value.'));
}

// ---------------------------------------------------------------------------
/**
 * Food analysis: which foods brought the most of one nutrient. Grouped by food
 * name across the span, because the same food logged on three days is one
 * habit, not three.
 */
const RANK_KEYS = [['kcal', 'Calories'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'],
  ['satFat', 'Saturated fat'], ['sugars', 'Sugars'], ['fiber', 'Fibre'], ['sodium', 'Sodium']];
function foodsTab({ entries }) {
  const meta = nutrientMeta();
  const key = state.rank;
  const amount = (e) => (key === 'kcal' ? e.kcal ?? 0 : e.nutrients?.[key] ?? 0);
  const byFood = new Map();
  for (const e of entries) {
    const cur = byFood.get(e.foodName) ?? { name: e.foodName, value: 0, times: 0 };
    cur.value += amount(e);
    cur.times += 1;
    byFood.set(e.foodName, cur);
  }
  const total = [...byFood.values()].reduce((s, f) => s + f.value, 0);
  const top = [...byFood.values()].filter((f) => f.value > 0).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)).slice(0, 8);
  const unit = key === 'kcal' ? EU() : meta[key]?.unit ?? 'g';
  const show = (v) => (key === 'kcal' ? fmt.kcal(v) : fmt.g(v));
  return el('div.stack', null,
    el('div.card', null,
      el('div.card-head', null, el('h3', null, 'Top foods'),
        el('select', {
          id: 'rank-by', 'aria-label': 'Rank foods by',
          onchange: (e) => { state.rank = e.target.value; renderNutrition(); },
        }, RANK_KEYS.map(([k, label]) => el('option', { value: k, selected: k === key }, label)))),
      top.length
        ? el('ol.top-foods', { id: 'top-foods' }, top.map((f) => el('li', null,
          el('b', null, f.name),
          el('span.muted', null, `${show(f.value)} ${unit} · ${total ? Math.round(f.value / total * 100) : 0}%${f.times > 1 ? ` · ${f.times}×` : ''}`))))
        : el('p.muted', null, 'Nothing logged in this span.')));
}

/**
 * A printable report of the span on screen: every meal, the day's totals and
 * the goal. Built into #print-root and printed with the rest of the page
 * hidden, so it works offline and needs no PDF library.
 */
function printReport({ date, profile, entries, days }) {
  let rootEl = document.getElementById('print-root');
  if (!rootEl) { rootEl = el('div', { id: 'print-root' }); document.body.append(rootEl); }
  const byDate = groupByDate(entries);
  const cols = ['kcal', 'protein', 'carbs', 'fat'];
  const head = ['Meal', 'Food', 'Amount', EU(), 'Protein (g)', 'Carbs (g)', 'Fat (g)'];
  const cell = (e, k) => (k === 'kcal' ? fmt.kcal(e.kcal) : fmt.g(e.nutrients?.[k] ?? 0));
  fill(rootEl,
    el('h1', null, `NutriLens report · ${days.length === 1 ? fmt.date(days[0]) : `${fmt.date(days[0])} – ${fmt.date(days.at(-1))}`}`),
    days.map((d) => {
      const list = byDate.get(d) ?? [];
      const t = dayTotals(list);
      const goal = dailyGoal(profile, d);
      return el('section', { dataset: { date: d } },
        el('h2', null, `${fmt.date(d)} — ${fmt.energy(t.kcal)} of ${fmt.energy(goal.kcal)}`),
        list.length
          ? el('table', null,
            el('thead', null, el('tr', null, head.map((h, i) => el('th', { class: i > 2 ? 'num' : null }, h)))),
            el('tbody', null,
              list.map((e) => el('tr', null,
                el('td', null, SLOT_LABEL[e.slot]), el('td', null, e.foodName),
                el('td', null, e.servingGrams ? `${fmt.servings(e.servings)} × ${e.servingLabel}` : e.servingLabel),
                cols.map((k) => el('td.num', null, cell(e, k))))),
              el('tr.total', null, el('td', null, 'Total'), el('td'), el('td'),
                cols.map((k) => el('td.num', null, k === 'kcal' ? fmt.kcal(t.kcal) : fmt.g(t.nutrients[k] ?? 0))))))
          : el('p', null, 'Nothing logged.'));
    }),
    el('p', null, `Printed ${fmt.date(date)} from NutriLens, offline.`));
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  window.print();
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
