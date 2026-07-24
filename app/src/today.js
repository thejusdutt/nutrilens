/**
 * The Today screen: the diary itself, and the first thing the app opens on.
 *
 * Layout follows what a food tracker's home screen has to answer, in order:
 *   how many days in a row have I logged · how many calories are left ·
 *   how are my macros · what have I eaten, by meal · water, exercise, steps ·
 *   notes · am I done for today (and what does that mean for my weight).
 */
import {
  dayTotals, remaining, macroEnergy, streak, shiftDate, weightProjection,
  normalizeEntry, SLOTS, SLOT_LABEL,
} from '@nutrilens/diary';
import { exerciseKcal, exerciseMinutes } from '@nutrilens/exercise-db';
import { donut, barRows } from '@nutrilens/charts';
import {
  $, el, fill, fmt, show, toast, openSheet, closeSheet, emit, on,
  MACRO_COLORS, SLOT_COLORS,
} from './ui.js';
import {
  listMealsByDate, getDay, setDay, deleteMeal, dateKey, loggedDates,
  listExerciseByDate, saveMeal, listMealsBetween, deleteExercise, setMeasurement,
} from './db.js';
import { getProfile, dailyGoal, setProfile, suggestSlot } from './goals.js';
import { openLogFood, openFoodDetail, openQuickAdd, openMealBuilder } from './logfood.js';
import { openExerciseSheet } from './exercise-view.js';
import { openBarcodeScanner } from './barcode-scan.js';
import { openWeightSheet } from './progress-view.js';

let current = dateKey();

export const diaryDate = () => current;
export const setDiaryDate = (d) => { current = d; };

/** Rebuild the whole screen for `current`. */
export async function renderToday() {
  const date = current;
  const [entriesRaw, day, exercise, logged] = await Promise.all([
    listMealsByDate(date), getDay(date), listExerciseByDate(date), loggedDates(),
  ]);
  const entries = entriesRaw.map(normalizeEntry);
  const profile = getProfile();
  const goal = dailyGoal(profile);
  const totals = dayTotals(entries);
  const burned = exerciseKcal(exercise) + (day.exerciseKcal || 0);
  const credited = profile.creditExercise ? burned : 0;
  const rem = remaining({ goalKcal: goal.kcal, foodKcal: totals.kcal, exerciseKcal: credited });
  const st = streak(logged, dateKey());

  fill($('today-root'),
    dateNav(date),
    streakChip(st),
    caloriesCard(rem, totals, goal),
    macrosCard(totals, goal),
    ...SLOTS.map((slot) => mealSection(slot, entries.filter((e) => (SLOTS.includes(e.slot) ? e.slot : 'snacks') === slot), date)),
    exerciseSection(exercise, day, burned, date),
    habitsCard(day, profile),
    notesCard(day),
    completeCard({ date, day, goal, totals, credited, profile, entries }),
  );
}

// ---------------------------------------------------------------------------
function dateNav(date) {
  const label = date === dateKey() ? 'Today'
    : date === shiftDate(dateKey(), -1) ? 'Yesterday'
      : date === shiftDate(dateKey(), 1) ? 'Tomorrow' : fmt.date(date);
  return el('div.diary-date-nav', null,
    el('button.icon-btn', { 'aria-label': 'Previous day', onclick: () => go(-1) }, '‹'),
    el('h2', { id: 'diary-date' }, label),
    el('button.icon-btn', { 'aria-label': 'Next day', onclick: () => go(1) }, '›'),
    date !== dateKey() && el('button.link', { onclick: () => { current = dateKey(); renderToday(); } }, 'Jump to today'));
}
const go = (days) => { current = shiftDate(current, days); renderToday(); };

function streakChip({ days, atRisk }) {
  if (!days) {
    return el('div.streak-chip.new', { id: 'streak-chip' }, '🔥 Log a food to start a streak');
  }
  return el('div.streak-chip', { id: 'streak-chip', class: atRisk ? 'streak-chip at-risk' : 'streak-chip' },
    `🔥 ${days}-day streak`,
    atRisk && el('span.muted', null, ' · log today to keep it'));
}

function caloriesCard(rem, totals, goal) {
  const eaten = Math.min(totals.kcal, goal.kcal);
  const slices = [
    { label: 'Food', value: eaten, color: rem.over ? '#e05d7b' : '#34a86c' },
    { label: 'Remaining', value: Math.max(0, goal.kcal - totals.kcal), color: 'rgba(130,130,150,.25)' },
  ];
  return el('div.card.cal-card', { id: 'calories-card', role: 'button', tabindex: '0', onclick: () => show('nutrition'), onkeydown: enterKey(() => show('nutrition')) },
    el('div.cal-ring', {
      html: donut({
        slices, size: 132, thickness: 14, title: 'Calories',
        center: fmt.kcal(rem.left), sub: rem.over ? 'over' : 'remaining',
      }),
    }),
    el('div.cal-math', null,
      mathCell('rem-goal', goal.kcal, 'Goal'),
      el('span.op', null, '−'),
      mathCell('rem-food', rem.foodKcal, 'Food'),
      el('span.op', null, '+'),
      mathCell('rem-exercise', rem.exerciseKcal, 'Exercise'),
      el('span.op', null, '='),
      el('div', { class: rem.over ? 'rem-result over' : 'rem-result' },
        el('b', { id: 'rem-left' }, rem.left.toLocaleString()), el('span', null, 'Remaining'))));
}
const mathCell = (id, value, label) => el('div', null, el('b', { id }, Math.round(value).toLocaleString()), el('span', null, label));
const enterKey = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

function macrosCard(totals, goal) {
  const energy = macroEnergy(totals.nutrients);
  const bars = ['carbs', 'protein', 'fat'].map((k) => ({
    label: k[0].toUpperCase() + k.slice(1),
    value: totals.nutrients[k] ?? 0,
    goal: goal.macros[k],
    color: MACRO_COLORS[k],
    text: `${Math.round(totals.nutrients[k] ?? 0)} / ${goal.macros[k]} g`,
  }));
  return el('div.card.macro-card', { id: 'macros-card', role: 'button', tabindex: '0',
    onclick: () => show('nutrition'), onkeydown: enterKey(() => show('nutrition')) },
  el('div.card-head', null, el('h3', null, 'Macros'),
    el('span.tag', null, energy.total > 0
      ? `C ${Math.round(energy.pct.carbs)}% · P ${Math.round(energy.pct.protein)}% · F ${Math.round(energy.pct.fat)}%`
      : 'nothing logged yet')),
  el('div.macro-split', null,
    el('div.macro-donut', { html: donut({
      slices: [
        { label: 'Carbs', value: energy.kcal.carbs, color: MACRO_COLORS.carbs },
        { label: 'Protein', value: energy.kcal.protein, color: MACRO_COLORS.protein },
        { label: 'Fat', value: energy.kcal.fat, color: MACRO_COLORS.fat },
      ],
      size: 104, thickness: 16, title: 'Macro split',
    }) }),
    el('div.macro-bars', { id: 'day-macros', html: barRows({ bars, width: 300, title: 'Macros against goal' }) })));
}

// ---------------------------------------------------------------------------
function mealSection(slot, entries, date) {
  const kcal = entries.reduce((s, e) => s + (e.kcal ?? 0), 0);
  return el('div.card.meal-section', { dataset: { slot } },
    el('div.meal-section-head', null,
      el('h3', null, SLOT_LABEL[slot]),
      el('span.kcal', null, kcal ? `${fmt.kcal(kcal)} kcal` : ''),
      el('button.icon-btn.small', {
        'aria-label': `More options for ${slot}`, title: 'Meal options',
        onclick: () => openMealMenu(slot, entries, date),
      }, '⋯')),
    entries.map((e) => entryRow(e, date)),
    el('button.meal-log', { dataset: { slot }, onclick: () => openLogFood({ date, slot, onPhoto: () => show('home') }) },
      `＋ Log ${slot}`));
}

function entryRow(entry, date) {
  return el('div.diary-entry', { dataset: { id: String(entry.id) } },
    el('button.de-name', {
      onclick: () => openFoodDetail({
        foodId: entry.foodId, entry, entryId: entry.id, date: entry.date, slot: entry.slot,
        servingLabel: entry.servingLabel, servingGrams: entry.servingGrams, servings: entry.servings,
      }),
    },
    el('b', null, entry.foodName),
    el('span', null, [
      `${fmt.servings(entry.servings)} × ${entry.servingLabel}`,
      entry.brand,
      `P ${Math.round(entry.nutrients?.protein ?? 0)} · C ${Math.round(entry.nutrients?.carbs ?? 0)} · F ${Math.round(entry.nutrients?.fat ?? 0)} g`,
    ].filter(Boolean).join(' · '))),
    el('span.de-kcal', null, `${fmt.kcal(entry.kcal)} kcal`),
    el('button.de-del', {
      title: 'Remove', 'aria-label': `Remove ${entry.foodName}`,
      onclick: async () => { await deleteMeal(entry.id); emit('diary', { date }); toast('Entry removed'); },
    }, '✕'));
}

/** Per-meal tools: copy from another day, copy to another day, clear. */
function openMealMenu(slot, entries, date) {
  const dateInput = el('input', { type: 'date', value: shiftDate(date, -1) });
  const targetInput = el('input', { type: 'date', value: shiftDate(date, 1) });
  const targetSlot = el('select', null, SLOTS.map((s) => el('option', { value: s, selected: s === slot }, SLOT_LABEL[s])));

  openSheet({
    title: SLOT_LABEL[slot],
    body: el('div.stack', null,
      el('h4', null, 'Copy food from another day'),
      el('div.row2', null, dateInput, el('button', { id: 'copy-from-day',
        onclick: async () => {
          const source = (await listMealsByDate(dateInput.value)).map(normalizeEntry).filter((e) => e.slot === slot);
          if (!source.length) { toast('Nothing logged in that meal'); return; }
          for (const e of source) await saveMeal({ ...e, id: undefined, date, ts: Date.now() });
          emit('diary', { date });
          toast(`${source.length} items copied`);
          closeSheet();
        },
      }, 'Copy here')),
      el('h4', null, 'Copy this meal to another day'),
      el('div.row3', null, targetInput, targetSlot, el('button', { id: 'copy-to-day',
        onclick: async () => {
          if (!entries.length) { toast('This meal is empty'); return; }
          for (const e of entries) await saveMeal({ ...e, id: undefined, date: targetInput.value, slot: targetSlot.value, ts: Date.now() });
          emit('diary', { date });
          toast(`Copied to ${fmt.date(targetInput.value)}`);
          closeSheet();
        },
      }, 'Copy to that day')),
      el('h4', null, 'Save as a meal'),
      el('button.wide', {
        onclick: () => {
          if (!entries.length) { toast('This meal is empty'); return; }
          closeSheet();
          openMealBuilder({
            kind: 'meal',
            seedItems: entries.map((e) => ({ id: e.foodId, name: e.foodName, grams: e.grams, nutrients: e.nutrients })),
          });
        },
      }, `Save ${slot} as a reusable meal`),
      entries.length > 0 && el('button.wide.danger', {
        onclick: async () => {
          for (const e of entries) await deleteMeal(e.id);
          emit('diary', { date });
          toast(`${slot} cleared`);
          closeSheet();
        },
      }, `Clear ${slot} (${entries.length} items)`)),
  });
}

// ---------------------------------------------------------------------------
function exerciseSection(exercise, day, burned, date) {
  return el('div.card.meal-section', { id: 'exercise-section' },
    el('div.meal-section-head', null,
      el('h3', null, '🏃 Exercise'),
      el('span.kcal', null, burned ? `${fmt.kcal(burned)} kcal · ${exerciseMinutes(exercise)} min` : '')),
    exercise.map((e) => el('div.diary-entry', null,
      el('button.de-name', { onclick: () => openExerciseSheet({ date, existing: e }) },
        el('b', null, e.name),
        el('span', null, [`${e.minutes} min`, e.sets ? `${e.sets}×${e.reps}` : null, e.kcalSource === 'manual' ? 'manual' : `${e.met} MET`].filter(Boolean).join(' · '))),
      el('span.de-kcal', null, `${fmt.kcal(e.kcal)} kcal`),
      el('button.de-del', {
        title: 'Remove', onclick: async () => {
          await deleteExercise(e.id);
          emit('diary', { date });
        },
      }, '✕'))),
    el('button.meal-log', { onclick: () => openExerciseSheet({ date }) }, '＋ Log exercise'));
}

function habitsCard(day, profile) {
  const glasses = day.water || 0;
  return el('div.card.habits', null,
    el('div.card-head', null, el('h3', null, 'Healthy habits')),
    el('div.habit-row', null,
      el('span.habit-label', null, '💧 Water'),
      el('span.habit-value', { id: 'water-count' }, `${glasses} / ${profile.waterGoal}`),
      el('span.muted', null, 'glasses'),
      el('div.habit-actions', null,
        el('button.icon-btn', { id: 'water-minus', 'aria-label': 'One glass less', onclick: () => bumpWater(day, -1) }, '−'),
        el('button.icon-btn', { id: 'water-plus', 'aria-label': 'One glass more', onclick: () => bumpWater(day, 1) }, '+'))),
    el('div.water-track', null, Array.from({ length: profile.waterGoal }, (_, i) => el('span', { class: i < glasses ? 'drop full' : 'drop' }))),
    el('div.habit-row', null,
      el('span.habit-label', null, '👣 Steps'),
      el('input.habit-input', {
        id: 'steps-input', type: 'number', min: '0', step: '100', value: String(day.steps || 0),
        'aria-label': 'Steps today',
        onchange: async (e) => { await setDay({ ...day, steps: Math.max(0, Number(e.target.value) || 0) }); emit('day', { date: day.date }); },
      }),
      el('span.muted', null, `/ ${profile.stepGoal.toLocaleString()}`)),
    el('div.habit-row', null,
      el('span.habit-label', null, '⚖️ Weight'),
      el('input.habit-input', {
        id: 'weight-kg', type: 'number', min: '20', max: '400', step: '0.1',
        value: day.weightKg ?? '', placeholder: '—', 'aria-label': 'Weight today (kg)',
        onchange: async (e) => {
          const weightKg = e.target.value ? Number(e.target.value) : null;
          await setDay({ ...day, weightKg });
          if (weightKg) await setMeasurement({ date: day.date, weightKg });
          // Today's weigh-in is also the number every goal is computed from.
          if (weightKg && day.date === dateKey()) setProfile({ weightKg });
          emit('day', { date: day.date });
          emit('profile');
        },
      }),
      el('span.muted', null, 'kg')));
}

async function bumpWater(day, delta) {
  await setDay({ ...day, water: Math.max(0, (day.water || 0) + delta) });
  emit('day', { date: day.date });
}

function notesCard(day) {
  return el('details.card.notes', { open: !!day.note },
    el('summary', null, '📝 Notes'),
    el('textarea', {
      id: 'day-note', rows: '3', placeholder: 'How did today go?', value: day.note ?? '',
      onchange: async (e) => { await setDay({ ...day, note: e.target.value }); toast('Note saved'); },
    }));
}

/**
 * "Complete this entry" — the ritual that closes a day, with the five-week
 * projection that makes today's number mean something.
 */
function completeCard({ date, day, goal, totals, credited, profile, entries }) {
  const projection = weightProjection({
    tdee: goal.tdee, foodKcal: totals.kcal, exerciseKcal: credited,
    weightKg: profile.weightKg, weeks: 5,
  });
  const canComplete = entries.length > 0;
  return el('div.card.complete-card', null,
    day.completed
      ? el('div.stack', null,
        el('p.done', null, `✓ Diary completed for ${date === dateKey() ? 'today' : fmt.date(date)}`),
        el('p.projection', { id: 'projection' }, projectionText(projection)),
        el('button.wide', { onclick: async () => { await setDay({ ...day, completed: false }); emit('day', { date }); } }, 'Reopen day'))
      : el('div.stack', null,
        el('button.primary.wide', {
          id: 'btn-complete', disabled: !canComplete,
          onclick: async () => {
            await setDay({ ...day, completed: true });
            emit('day', { date });
            toast('Nice work — day complete');
          },
        }, canComplete ? 'Complete this entry' : 'Log a food to complete the day'),
        canComplete && el('p.muted.tiny', null, 'See what today would mean in five weeks.')));
}

const projectionText = (p) => (p.direction === 'maintain'
  ? 'If every day were like today, your weight would stay about the same.'
  : `If every day were like today, you would ${p.direction} ${Math.abs(p.changeKg)} kg in ${p.weeks} weeks — about ${p.weightKg} kg.`);

// ---------------------------------------------------------------------------
/** The ＋ button: every way into the diary, in one place. */
export function openAddMenu({ onPhoto }) {
  const date = current;
  // The meal defaults to whatever fits the clock, the same guess the meal
  // sections make — nobody logging lunch at 13:00 should have to say so.
  const slot = suggestSlot();
  openSheet({
    title: 'Add to diary',
    body: el('div.add-menu', null,
      el('button', { id: 'add-search', onclick: () => { closeSheet(); openLogFood({ date, slot, onPhoto }); } }, '🔎 Search foods'),
      el('button', { id: 'add-photo', onclick: () => { closeSheet(); onPhoto?.(); } }, '📷 Scan a meal photo'),
      el('button', { id: 'add-barcode', onclick: () => { closeSheet(); openBarcodeScanner({ date, slot }); } }, '🏷️ Scan a barcode'),
      el('button', { id: 'add-quick', onclick: () => { closeSheet(); openQuickAdd({ date, slot }); } }, '⚡ Quick add calories'),
      el('button', { id: 'add-exercise', onclick: () => { closeSheet(); openExerciseSheet({ date }); } }, '🏃 Log exercise'),
      el('button', { id: 'add-weight', onclick: () => { closeSheet(); openWeightSheet(); } }, '⚖️ Log weight')),
  });
}

/** Weekly averages, used by the Nutrition and Progress screens. */
export async function weekSummary(endDate = current, days = 7) {
  const from = shiftDate(endDate, -(days - 1));
  const entries = (await listMealsBetween(from, endDate)).map(normalizeEntry);
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  return { from, to: endDate, byDate };
}

on('diary', () => { if (!$('view-diary').hidden) renderToday(); });
on('day', () => { if (!$('view-diary').hidden) renderToday(); });
on('profile', () => { if (!$('view-diary').hidden) renderToday(); });
