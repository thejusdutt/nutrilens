/** IndexedDB layer: food diary entries + per-day records (water, exercise, weight). */
const DB_NAME = 'nutrilens';
const DB_VERSION = 2;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts', 'ts');
        store.createIndex('date', 'date');
      } else {
        req.transaction.objectStore('history').createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('day')) {
        db.createObjectStore('day', { keyPath: 'date' }); // { date, water, exerciseKcal, weightKg }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

/** Local calendar date key, e.g. "2026-07-11". */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param {{foodId, foodName, grams, kcal, nutrients, thumb?, ts, date, slot}} entry
 * slot: 'breakfast' | 'lunch' | 'dinner' | 'snacks'
 */
export async function saveMeal(entry) {
  const db = await open();
  return tx(db, 'history', 'readwrite', (s) => s.add(entry));
}

export async function updateMeal(id, patch) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('history', 'readwrite');
    const s = t.objectStore('history');
    const get = s.get(id);
    get.onsuccess = () => { s.put({ ...get.result, ...patch }); };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

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

/** All diary entries for one calendar date (legacy entries resolved via ts). */
export async function listMealsByDate(date) {
  const all = await listMeals(2000);
  return all.filter((m) => (m.date ?? dateKey(new Date(m.ts))) === date);
}

export async function deleteMeal(id) {
  const db = await open();
  return tx(db, 'history', 'readwrite', (s) => s.delete(id));
}

/** Per-day record: water glasses, exercise kcal, morning weight. */
export async function getDay(date) {
  const db = await open();
  const rec = await new Promise((resolve, reject) => {
    const req = db.transaction('day', 'readonly').objectStore('day').get(date);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return rec ?? { date, water: 0, exerciseKcal: 0, weightKg: null };
}

export async function setDay(rec) {
  const db = await open();
  return tx(db, 'day', 'readwrite', (s) => s.put(rec));
}
