/**
 * Intermittent fasting: start a fast, see how far through it you are, end it.
 *
 * Kept in localStorage under 'fasting' (backed up with the other preferences):
 * it is one running fast and a short history, read on every diary render, and
 * it has to keep counting across reloads with no network and no server clock.
 * Times are wall-clock timestamps, so a fast survives the app being closed.
 */
import { el, fmt, toast, emit } from './ui.js';

const KEY = 'fasting';
export const PLANS = [[12, '12:12'], [14, '14:10'], [16, '16:8'], [18, '18:6'], [20, '20:4'], [24, '24 h'], [36, '36 h']];

export function getFasting() {
  try {
    return { current: null, history: [], targetH: 16, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch { return { current: null, history: [], targetH: 16 }; }
}
const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));

/** @param {{at?:number, targetH:number}} p */
export function startFast({ at = Date.now(), targetH }) {
  const s = getFasting();
  s.current = { start: at, targetH };
  s.targetH = targetH;
  save(s);
  return s.current;
}

/** Ends the running fast and records it. @returns the finished fast, or null */
export function endFast(at = Date.now()) {
  const s = getFasting();
  if (!s.current) return null;
  const done = { ...s.current, end: Math.max(at, s.current.start) };
  s.history = [done, ...s.history].slice(0, 60);
  s.current = null;
  save(s);
  return done;
}

/** Where a fast stands at `now`. */
export function fastStatus(fast, now = Date.now()) {
  const elapsedMs = Math.max(0, now - fast.start);
  const targetMs = fast.targetH * 3600e3;
  return {
    elapsedMs,
    pct: Math.min(100, (elapsedMs / targetMs) * 100),
    reached: elapsedMs >= targetMs,
    endsAt: fast.start + targetMs,
  };
}

export const hm = (ms) => {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/** The diary card. Re-renders itself each minute while it is on screen. */
export function fastingCard() {
  const card = el('div.card.fasting', { id: 'fasting-card' });
  const draw = () => {
    const s = getFasting();
    card.replaceChildren(...(s.current ? running(s) : idle(s)));
  };
  const running = (s) => {
    const st = fastStatus(s.current);
    return [
      el('div.card-head', null, el('h3', null, 'Fasting'), el('span.tag', null, `${s.current.targetH} h goal`)),
      el('p.fast-elapsed', { id: 'fast-elapsed', role: 'status' }, hm(st.elapsedMs)),
      el('div.fast-track', { 'aria-hidden': 'true' }, el('span', { style: `width:${st.pct.toFixed(1)}%` })),
      el('p.muted.tiny', null, st.reached
        ? `Goal reached at ${fmt.time(st.endsAt)}. End the fast whenever you eat.`
        : `Started ${fmt.time(s.current.start)} · ends ${fmt.time(st.endsAt)}${new Date(st.endsAt).getDate() !== new Date().getDate() ? ' tomorrow' : ''}`),
      el('button.wide', {
        id: 'btn-end-fast',
        onclick: () => {
          const done = endFast();
          toast(`Fast ended after ${hm(done.end - done.start)}`);
          draw();
          emit('day', {});
        },
      }, 'End fast'),
    ];
  };
  const idle = (s) => {
    const plan = el('select', { id: 'fast-plan', 'aria-label': 'Fasting plan' },
      PLANS.map(([h, label]) => el('option', { value: String(h), selected: h === s.targetH }, label)));
    const last = s.history[0];
    return [
      el('div.card-head', null, el('h3', null, 'Fasting')),
      el('div.row2', null, plan,
        el('button.primary', {
          id: 'btn-start-fast',
          onclick: () => { startFast({ targetH: Number(plan.value) }); toast('Fast started'); draw(); },
        }, 'Start fast')),
      last && el('p.muted.tiny', { id: 'fast-last' }, `Last fast ${hm(last.end - last.start)} of ${last.targetH} h`
        + ((last.end - last.start) >= last.targetH * 3600e3 ? ' — goal reached' : '')),
    ];
  };
  draw();
  const timer = setInterval(() => { if (!card.isConnected) clearInterval(timer); else if (getFasting().current) draw(); }, 60000);
  return card;
}
