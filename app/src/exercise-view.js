/**
 * Exercise logging: cardio by time, strength by time with sets and reps, and
 * custom activities for anything the table has never heard of.
 *
 * Calories are estimated from MET values and body mass, and can always be
 * overwritten with a watch's number. The estimate shown updates as the form is
 * filled, because a number that appears only after saving cannot be sanity
 * checked.
 */
import { ACTIVITIES, searchActivities, activity, makeExerciseEntry, kcalBurnedNet } from '@nutrilens/exercise-db';
import { el, fill, fmt, openSheet, closeSheet, toast, emit } from './ui.js';
import { saveExercise, deleteExercise } from './db.js';
import { getProfile } from './goals.js';

/**
 * @param {{date:string, existing?:object}} p
 */
export function openExerciseSheet({ date, existing }) {
  const profile = getProfile();
  const state = {
    activityId: existing?.activityId ?? null,
    name: existing?.name ?? '',
    met: existing?.met ?? null,
    minutes: existing?.minutes ?? 30,
    sets: existing?.sets ?? null,
    reps: existing?.reps ?? null,
    weightLiftedKg: existing?.weightLiftedKg ?? null,
    kcalOverride: existing?.kcalSource === 'manual' ? existing.kcal : null,
    custom: existing ? !existing.activityId : false,
  };

  const estimate = el('div.detail-summary');
  const picked = el('div.picked-activity');
  const searchBox = el('input', { type: 'search', placeholder: 'Search activities…', autocomplete: 'off', id: 'ex-search' });
  const results = el('div.food-results.compact');
  const minutes = el('input', {
    type: 'number', min: '1', max: '600', step: '5', value: String(state.minutes), id: 'ex-minutes',
    oninput: (e) => { state.minutes = Math.max(1, Number(e.target.value) || 0); update(); },
  });
  const kcalInput = el('input', {
    type: 'number', min: '0', step: '5', placeholder: 'auto', id: 'ex-kcal',
    value: state.kcalOverride != null ? String(state.kcalOverride) : '',
    oninput: (e) => { const v = Number(e.target.value); state.kcalOverride = v > 0 ? v : null; update(); },
  });
  const strength = el('div.row3.strength-fields', null,
    el('label', null, 'Sets', el('input', {
      type: 'number', min: '1', step: '1', value: state.sets ?? '', oninput: (e) => { state.sets = Number(e.target.value) || null; },
    })),
    el('label', null, 'Reps', el('input', {
      type: 'number', min: '1', step: '1', value: state.reps ?? '', oninput: (e) => { state.reps = Number(e.target.value) || null; },
    })),
    el('label', null, 'Weight (kg)', el('input', {
      type: 'number', min: '0', step: '2.5', value: state.weightLiftedKg ?? '', oninput: (e) => { state.weightLiftedKg = Number(e.target.value) || null; },
    })));

  const customName = el('input', { type: 'text', placeholder: 'Activity name', value: state.name, oninput: (e) => { state.name = e.target.value; } });
  const customMet = el('input', {
    type: 'number', min: '1', max: '20', step: '0.5', placeholder: 'MET', value: state.met ?? '',
    oninput: (e) => { state.met = Number(e.target.value) || null; update(); },
  });

  function chosen() {
    if (state.custom) return state.name && state.met > 0 ? { name: state.name, met: state.met, type: 'cardio' } : null;
    return state.activityId ? activity(state.activityId) : null;
  }

  function update() {
    const a = chosen();
    strength.hidden = !(a && a.type === 'strength');
    fill(picked, a
      ? el('div.chip.selected', null, `${a.name} · ${a.met} MET`,
        el('button.chip-x', { title: 'Change', onclick: () => { state.activityId = null; state.custom = false; update(); } }, '✕'))
      : el('p.muted.tiny', null, 'Pick an activity below, or add a custom one.'));
    const kcal = a ? (state.kcalOverride ?? kcalBurnedNet({ met: a.met, minutes: state.minutes, weightKg: profile.weightKg })) : 0;
    fill(estimate,
      el('div.ds-kcal', null, el('b', { id: 'ex-estimate' }, fmt.kcal(kcal)), ' kcal'),
      el('div.muted', null, a
        ? `${state.minutes} min · ${profile.weightKg} kg · ${state.kcalOverride != null ? 'your figure' : 'MET estimate, net of rest'}`
        : 'no activity chosen'));
  }

  function renderResults(list) {
    fill(results, list.map((a) => el('button.food-row', {
      dataset: { activity: a.id },
      onclick: () => { state.activityId = a.id; state.custom = false; searchBox.value = ''; renderResults(popular()); update(); },
    },
    el('span.fr-main', null, el('b', null, a.name), el('span.muted', null, `${a.met} MET · ${a.type}`)),
    el('span.fr-kcal', null, `${fmt.kcal(kcalBurnedNet({ met: a.met, minutes: state.minutes, weightKg: profile.weightKg }))} kcal`))));
  }
  const popular = () => ACTIVITIES.filter((a) => ['walk', 'run-10', 'cycle-moderate', 'weights-moderate', 'hiit', 'yoga', 'swim-laps', 'football'].includes(a.id));
  searchBox.oninput = () => {
    const q = searchBox.value.trim();
    renderResults(q ? searchActivities(q, 12) : popular());
  };
  renderResults(popular());
  update();

  const save = async () => {
    const a = chosen();
    if (!a) { toast('Choose an activity first'); return; }
    const entry = makeExerciseEntry({
      date, activityId: state.custom ? null : state.activityId,
      name: a.name, met: a.met, minutes: state.minutes, weightKg: profile.weightKg,
      sets: state.sets, reps: state.reps, weightLiftedKg: state.weightLiftedKg,
      kcalOverride: state.kcalOverride ?? undefined, ts: existing?.ts ?? Date.now(),
    });
    await saveExercise(existing?.id ? { ...entry, id: existing.id } : entry);
    emit('diary', { date });
    toast(`${entry.name} logged`);
    closeSheet({ all: true });
  };

  openSheet({
    title: existing ? 'Edit exercise' : 'Log exercise',
    body: el('div.stack', null,
      picked,
      el('div.row2', null,
        el('label', { for: 'ex-minutes' }, 'Minutes', minutes),
        el('label', { for: 'ex-kcal' }, 'Calories (optional)', kcalInput)),
      strength,
      estimate,
      el('button.primary.wide', { onclick: save }, existing ? 'Save changes' : 'Add to diary'),
      existing && el('button.wide.danger', {
        onclick: async () => { await deleteExercise(existing.id); emit('diary', { date }); closeSheet({ all: true }); },
      }, 'Delete entry'),
      el('hr'),
      searchBox,
      results,
      el('details', null,
        el('summary', null, 'Custom activity'),
        el('div.row2', null,
          el('label', null, 'Name', customName),
          el('label', null, 'MET', customMet)),
        el('button.wide', {
          onclick: () => {
            if (!customName.value.trim() || !(Number(customMet.value) > 0)) { toast('Name and MET are both needed'); return; }
            state.custom = true;
            state.name = customName.value.trim();
            state.met = Number(customMet.value);
            update();
          },
        }, 'Use this activity'),
        el('p.muted.tiny', null, 'MET is how many times harder than sitting still: walking ≈ 3.5, running ≈ 10.'))),
  });
}
