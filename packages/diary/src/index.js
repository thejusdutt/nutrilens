/**
 * @nutrilens/diary
 *
 * The arithmetic and bookkeeping of a food diary, independent of storage and UI.
 *
 * A diary entry is logged the way people describe food — "2 × 1 slice (107 g)" —
 * so every entry carries a serving label, the gram weight of one serving and a
 * serving count. Grams are derived, never the source of truth, which is what
 * makes "change the serving size" and "change the count" behave like a real
 * food tracker instead of a gram calculator.
 *
 * @typedef {Object} DiaryEntry
 * @property {number} [id]              Storage key.
 * @property {string} date              Local calendar day, "YYYY-MM-DD".
 * @property {string} slot              'breakfast' | 'lunch' | 'dinner' | 'snacks'
 * @property {string} [foodId]          Database food id (absent for quick-adds).
 * @property {string} foodName
 * @property {string} [brand]
 * @property {string} servingLabel      e.g. "1 slice", "100 g", "1 cup"
 * @property {number} servingGrams      Grams in ONE serving.
 * @property {number} servings          How many servings were eaten.
 * @property {number} grams             servingGrams × servings (derived).
 * @property {number} kcal              Rounded calories for the whole entry.
 * @property {Record<string, number>} nutrients  Absolute amounts for the whole entry.
 * @property {string} [source]          'photo' | 'search' | 'quick' | 'barcode' | 'meal' | 'recipe'
 * @property {number} ts                Epoch ms, used for recency.
 * @property {Blob|null} [thumb]
 */

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks'];
export const SLOT_LABEL = { breakfast: '🌅 Breakfast', lunch: '☀️ Lunch', dinner: '🌙 Dinner', snacks: '🍿 Snacks' };

/** Calories per gram of each energy-bearing macro (Atwater). */
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

/** 7700 kcal ≈ 1 kg of body mass — the constant behind every projection here. */
export const KCAL_PER_KG = 7700;

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Total grams for a serving choice. Kept as a function because every screen
 * that edits servings must agree with the number stored on the entry.
 */
export const totalGrams = (servingGrams, servings) => round2(servingGrams * servings);

/**
 * Build a diary entry from a food, a serving choice and a nutrient table.
 *
 * @param {Object} p
 * @param {string} [p.foodId]
 * @param {string} p.foodName
 * @param {string} [p.brand]
 * @param {string} p.date
 * @param {string} p.slot
 * @param {string} p.servingLabel
 * @param {number} p.servingGrams
 * @param {number} [p.servings=1]
 * @param {Record<string,{value:number}>|Record<string,number>} p.nutrients Per-entry amounts.
 * @param {string} [p.source]
 * @param {Blob|null} [p.thumb]
 * @param {number} p.ts
 * @returns {DiaryEntry}
 */
export function makeEntry({
  foodId, foodName, brand, date, slot, servingLabel, servingGrams,
  servings = 1, nutrients, source = 'search', thumb = null, ts,
}) {
  const flat = {};
  for (const [k, v] of Object.entries(nutrients ?? {})) {
    const value = typeof v === 'number' ? v : v?.value;
    if (Number.isFinite(value)) flat[k] = round2(value);
  }
  return {
    date, slot, foodId, foodName, brand,
    servingLabel, servingGrams: round2(servingGrams), servings,
    grams: totalGrams(servingGrams, servings),
    kcal: Math.round(flat.kcal ?? 0),
    nutrients: flat,
    source, thumb, ts,
  };
}

/**
 * Bring any stored entry up to the serving-aware shape. Entries written before
 * servings existed only recorded grams; treating those as "N g × 1" keeps the
 * edit screens usable without a migration that could corrupt real history.
 * @param {DiaryEntry} e
 * @returns {DiaryEntry}
 */
export function normalizeEntry(e) {
  if (e.servingGrams > 0 && e.servings > 0 && e.servingLabel) return e;
  const grams = e.grams ?? 0;
  return {
    ...e,
    servingLabel: e.servingLabel ?? (grams ? `${Math.round(grams)} g` : 'serving'),
    servingGrams: grams || 1,
    servings: 1,
    grams,
  };
}

/**
 * Rescale an entry to a new serving choice. Nutrients scale from the entry's
 * own amounts, so this works even for foods that are no longer in the database
 * (a deleted custom food, a barcode product from a previous session).
 * @param {DiaryEntry} entry
 * @param {{servingLabel?:string, servingGrams?:number, servings?:number}} change
 * @returns {DiaryEntry}
 */
export function rescaleEntry(entry, change) {
  const e = normalizeEntry(entry);
  const servingGrams = change.servingGrams ?? e.servingGrams;
  const servings = change.servings ?? e.servings;
  const grams = totalGrams(servingGrams, servings);
  const factor = e.grams > 0 ? grams / e.grams : 0;
  const nutrients = {};
  for (const [k, v] of Object.entries(e.nutrients ?? {})) nutrients[k] = round2(v * factor);
  return {
    ...e,
    servingLabel: change.servingLabel ?? e.servingLabel,
    servingGrams: round2(servingGrams),
    servings,
    grams,
    kcal: Math.round(nutrients.kcal ?? 0),
    nutrients,
  };
}

/**
 * Sum entries into one nutrient table plus a per-slot breakdown.
 * @param {DiaryEntry[]} entries
 * @returns {{kcal:number, nutrients:Record<string,number>, bySlot:Record<string,{kcal:number,count:number}>}}
 */
export function dayTotals(entries) {
  const nutrients = {};
  const bySlot = Object.fromEntries(SLOTS.map((s) => [s, { kcal: 0, count: 0 }]));
  let kcal = 0;
  for (const raw of entries) {
    const e = normalizeEntry(raw);
    kcal += e.kcal ?? 0;
    const slot = SLOTS.includes(e.slot) ? e.slot : 'snacks';
    bySlot[slot].kcal += e.kcal ?? 0;
    bySlot[slot].count++;
    for (const [k, v] of Object.entries(e.nutrients ?? {})) nutrients[k] = round2((nutrients[k] ?? 0) + v);
  }
  return { kcal: Math.round(kcal), nutrients, bySlot };
}

/**
 * Calories remaining, the way a food tracker states it:
 *   Goal − Food + Exercise = Remaining
 * @param {{goalKcal:number, foodKcal:number, exerciseKcal?:number}} p
 */
export function remaining({ goalKcal, foodKcal, exerciseKcal = 0 }) {
  const left = Math.round(goalKcal - foodKcal + exerciseKcal);
  return { goalKcal: Math.round(goalKcal), foodKcal: Math.round(foodKcal), exerciseKcal: Math.round(exerciseKcal), left, over: left < 0 };
}

/**
 * Share of energy contributed by each macro — the macro pie.
 * Percentages come from macro calories, not grams, and are normalised to the
 * macro total (not to the label's calories) so the slices always add to 100%.
 * @param {Record<string, number>} nutrients Absolute grams per macro.
 */
export function macroEnergy(nutrients = {}) {
  const kcalOf = Object.fromEntries(Object.entries(KCAL_PER_G)
    .map(([k, perG]) => [k, (nutrients[k] ?? 0) * perG]));
  const total = Object.values(kcalOf).reduce((s, v) => s + v, 0);
  const pct = Object.fromEntries(Object.keys(kcalOf)
    .map((k) => [k, total > 0 ? kcalOf[k] / total * 100 : 0]));
  return { kcal: kcalOf, total, pct };
}

/**
 * Consecutive days ending today on which at least one food was logged.
 * Today not being logged yet must not break a streak mid-morning, so a streak
 * that reaches yesterday still counts (and shows as "at risk").
 * @param {Iterable<string>} loggedDates  Date keys with ≥1 entry.
 * @param {string} today  Today's date key.
 * @returns {{days:number, atRisk:boolean}}
 */
export function streak(loggedDates, today) {
  const set = new Set(loggedDates);
  const atRisk = !set.has(today);
  let days = 0;
  for (let cursor = atRisk ? shiftDate(today, -1) : today; set.has(cursor); cursor = shiftDate(cursor, -1)) days++;
  return { days, atRisk: atRisk && days > 0 };
}

/** Shift a "YYYY-MM-DD" key by whole days, staying in local calendar terms. */
export function shiftDate(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days, 12);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** The `n` date keys ending at `end`, oldest first. */
export function dateRange(end, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDate(end, -i));
  return out;
}

/**
 * "If every day were like today…" — the projection a diary shows when you
 * finish logging. Net intake is food minus exercise; the gap to maintenance
 * over `weeks` becomes a weight change at 7700 kcal per kg.
 * @param {{tdee:number, foodKcal:number, exerciseKcal?:number, weightKg:number, weeks?:number}} p
 */
export function weightProjection({ tdee, foodKcal, exerciseKcal = 0, weightKg, weeks = 5 }) {
  const net = foodKcal - exerciseKcal;
  const dailyDelta = net - tdee;              // >0 gains, <0 loses
  const days = weeks * 7;
  const changeKg = dailyDelta * days / KCAL_PER_KG;
  return {
    weeks,
    dailyDelta: Math.round(dailyDelta),
    changeKg: Math.round(changeKg * 10) / 10,
    weightKg: Math.round((weightKg + changeKg) * 10) / 10,
    direction: changeKg < -0.05 ? 'lose' : changeKg > 0.05 ? 'gain' : 'maintain',
  };
}

/**
 * Foods logged most often, for a "Frequent" tab. Ties break toward the most
 * recently eaten so the list tracks current habits.
 * @param {DiaryEntry[]} entries
 * @param {{limit?:number, slot?:string}} [opts]
 */
export function rankFrequent(entries, { limit = 20, slot } = {}) {
  const byFood = new Map();
  for (const raw of entries) {
    const e = normalizeEntry(raw);
    if (slot && e.slot !== slot) continue;
    const key = e.foodId ?? `name:${e.foodName}`;
    const cur = byFood.get(key);
    if (cur) { cur.count++; cur.ts = Math.max(cur.ts, e.ts ?? 0); if ((e.ts ?? 0) >= cur.ts) cur.entry = e; }
    else byFood.set(key, { key, count: 1, ts: e.ts ?? 0, entry: e });
  }
  return [...byFood.values()]
    .sort((a, b) => b.count - a.count || b.ts - a.ts)
    .slice(0, limit);
}

/** Most recently logged foods, one row per distinct food. */
export function rankRecent(entries, { limit = 20, slot } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of [...entries].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))) {
    const e = normalizeEntry(raw);
    if (slot && e.slot !== slot) continue;
    const key = e.foodId ?? `name:${e.foodName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, ts: e.ts ?? 0, entry: e });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Per-serving nutrition for a saved meal or recipe.
 * A saved meal is eaten as a whole (servings = 1); a recipe divides into
 * `servings` portions, which is the only difference between the two.
 * @param {{items:Array<{grams:number, nutrients:Record<string,number>}>, servings?:number}} recipe
 */
export function perServing({ items, servings = 1 }) {
  const n = Math.max(1, servings);
  const nutrients = {};
  let grams = 0;
  for (const it of items) {
    grams += it.grams ?? 0;
    for (const [k, v] of Object.entries(it.nutrients ?? {})) nutrients[k] = (nutrients[k] ?? 0) + v;
  }
  const per = {};
  for (const [k, v] of Object.entries(nutrients)) per[k] = round2(v / n);
  return { servings: n, grams: round2(grams / n), totalGrams: round2(grams), nutrients: per };
}

/**
 * Diary export. One row per entry with the columns a printable report needs,
 * plus a totals row per day — CSV because it opens everywhere offline.
 * @param {DiaryEntry[]} entries
 * @param {Record<string,{name:string,unit:string}>} nutrientMeta
 * @param {string[]} [columns] Nutrient keys to include.
 */
export function toCSV(entries, nutrientMeta, columns = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'sodium']) {
  const head = ['Date', 'Meal', 'Food', 'Brand', 'Serving', 'Servings', 'Grams',
    ...columns.map((k) => `${nutrientMeta[k]?.name ?? k}${nutrientMeta[k]?.unit ? ` (${nutrientMeta[k].unit})` : ''}`)];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = [head.map(esc).join(',')];
  const byDate = new Map();
  for (const raw of [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.ts ?? 0) - (b.ts ?? 0))) {
    const e = normalizeEntry(raw);
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  for (const [date, dayEntries] of byDate) {
    for (const e of dayEntries) {
      rows.push([date, e.slot, e.foodName, e.brand ?? '', e.servingLabel, e.servings, e.grams,
        ...columns.map((k) => (k === 'kcal' ? e.kcal : (e.nutrients?.[k] ?? 0)))].map(esc).join(','));
    }
    const t = dayTotals(dayEntries);
    rows.push([date, 'TOTAL', '', '', '', '', Math.round(dayEntries.reduce((s, e) => s + e.grams, 0)),
      ...columns.map((k) => (k === 'kcal' ? t.kcal : Math.round((t.nutrients[k] ?? 0) * 10) / 10))].map(esc).join(','));
  }
  return rows.join('\n');
}
