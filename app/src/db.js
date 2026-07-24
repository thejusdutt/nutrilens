/**
 * IndexedDB layer.
 *
 * Stores (v3):
 *   history       diary food entries          key: id++      indexes: ts, date
 *   day           per-day record              key: date      (water, notes, completed…)
 *   foods         user-created foods          key: id++      index: name
 *   meals         saved meals and recipes     key: id++      index: kind
 *   exercise      exercise diary entries      key: id++      index: date
 *   measurements  weight and body measures    key: [date]    index: date
 *   products      barcode lookups, cached     key: barcode
 *
 * Everything is per-device and never leaves it. Reads are cheap enough to keep
 * the whole diary in memory for a day at a time; nothing here caches beyond a
 * single shared connection.
 */
const DB_NAME = 'nutrilens';
const DB_VERSION = 3;

// One connection, opened once. Re-opening per call (as this module used to do)
// leaks connections and blocks future version upgrades.
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = (name, opts) => (db.objectStoreNames.contains(name)
        ? req.transaction.objectStore(name)
        : db.createObjectStore(name, opts));
      const index = (s, name, keyPath) => { if (!s.indexNames.contains(name)) s.createIndex(name, keyPath); };

      const history = store('history', { keyPath: 'id', autoIncrement: true });
      index(history, 'ts', 'ts');
      index(history, 'date', 'date');

      store('day', { keyPath: 'date' });

      const foods = store('foods', { keyPath: 'id', autoIncrement: true });
      index(foods, 'name', 'name');

      const meals = store('meals', { keyPath: 'id', autoIncrement: true });
      index(meals, 'kind', 'kind');

      const exercise = store('exercise', { keyPath: 'id', autoIncrement: true });
      index(exercise, 'date', 'date');

      const measurements = store('measurements', { keyPath: 'date' });
      index(measurements, 'date', 'date');

      store('products', { keyPath: 'barcode' });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

/**
 * Run `fn` inside one transaction and resolve with its request result.
 *
 * The IDBRequest is unwrapped by type, not by truthiness: a `get()` that finds
 * nothing has `result === undefined`, and `request.result ?? request` would then
 * hand back the request object itself — a truthy value that reads as a cache hit
 * and spreads into an empty record.
 */
async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const out = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const all = (storeName, query, indexName) => tx(storeName, 'readonly', (s) => (indexName ? s.index(indexName) : s).getAll(query));

/**
 * Insert or update, letting the store generate the key for new records.
 *
 * `add()` with an `id` property that is present but undefined is a DataError,
 * not an auto-increment: the key path resolves to a value, and undefined is not
 * a valid key. Callers pass `{ id: existing?.id, ... }` all over the place, so
 * the undefined case is stripped here rather than at every call site.
 */
function putOrAdd(storeName, rec) {
  const hasKey = Number.isFinite(rec?.id);
  const { id, ...rest } = rec ?? {};
  return tx(storeName, 'readwrite', (s) => (hasKey ? s.put(rec) : s.add(rest)));
}

/** Local calendar date key, e.g. "2026-07-24". */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Diary entries
// ---------------------------------------------------------------------------
export const saveMeal = (entry) => putOrAdd('history', entry);
export const deleteMeal = (id) => tx('history', 'readwrite', (s) => s.delete(id));
export const getMeal = (id) => tx('history', 'readonly', (s) => s.get(id));

export async function updateMeal(id, patch) {
  const current = await getMeal(id);
  if (!current) return null;
  const next = { ...current, ...patch, id };
  await tx('history', 'readwrite', (s) => s.put(next));
  return next;
}

/** Newest entries first. */
export async function listMeals(limit = 100) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const idx = db.transaction('history', 'readonly').objectStore('history').index('ts');
    const out = [];
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (cur && out.length < limit) { out.push(cur.value); cur.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Entries for one calendar day, straight off the `date` index — no scan, no cap,
 * so a diary two years deep still opens every day correctly.
 */
export const listMealsByDate = (date) => all('history', date, 'date');

/** Entries across a date range (inclusive), for weekly views and charts. */
export const listMealsBetween = (from, to) => all('history', IDBKeyRange.bound(from, to), 'date');

/** Every date that has at least one entry — the input to a logging streak. */
export async function loggedDates() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const idx = db.transaction('history', 'readonly').objectStore('history').index('date');
    const out = new Set();
    const req = idx.openKeyCursor(null, 'prevunique');
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { out.add(cur.key); cur.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Per-day record: water, notes, diary completion
// ---------------------------------------------------------------------------
const EMPTY_DAY = { water: 0, exerciseKcal: 0, weightKg: null, note: '', completed: false, steps: 0 };

export async function getDay(date) {
  const rec = await tx('day', 'readonly', (s) => s.get(date));
  return { date, ...EMPTY_DAY, ...(rec ?? {}) };
}
export const setDay = (rec) => tx('day', 'readwrite', (s) => s.put(rec));
export const listDaysBetween = (from, to) => all('day', IDBKeyRange.bound(from, to));

// ---------------------------------------------------------------------------
// My Foods
// ---------------------------------------------------------------------------
export const listCustomFoods = () => all('foods');
export const saveCustomFood = (food) => putOrAdd('foods', food);
export const deleteCustomFood = (id) => tx('foods', 'readwrite', (s) => s.delete(id));

// ---------------------------------------------------------------------------
// Saved meals and recipes (kind: 'meal' | 'recipe')
// ---------------------------------------------------------------------------
export const listSavedMeals = () => all('meals');
export const saveSavedMeal = (meal) => putOrAdd('meals', meal);
export const deleteSavedMeal = (id) => tx('meals', 'readwrite', (s) => s.delete(id));

// ---------------------------------------------------------------------------
// Exercise
// ---------------------------------------------------------------------------
export const listExerciseByDate = (date) => all('exercise', date, 'date');
export const listExerciseBetween = (from, to) => all('exercise', IDBKeyRange.bound(from, to), 'date');
export const saveExercise = (entry) => putOrAdd('exercise', entry);
export const deleteExercise = (id) => tx('exercise', 'readwrite', (s) => s.delete(id));

// ---------------------------------------------------------------------------
// Measurements (weight, waist, …) — one record per day
// ---------------------------------------------------------------------------
export const listMeasurements = () => all('measurements');
export const setMeasurement = (rec) => tx('measurements', 'readwrite', (s) => s.put(rec));
export const getMeasurement = (date) => tx('measurements', 'readonly', (s) => s.get(date));

// ---------------------------------------------------------------------------
// Barcode product cache — a scanned product stays usable offline forever
// ---------------------------------------------------------------------------
export const getProduct = (barcode) => tx('products', 'readonly', (s) => s.get(barcode));
export const putProduct = (product) => tx('products', 'readwrite', (s) => s.put(product));
export const listProducts = () => all('products');
