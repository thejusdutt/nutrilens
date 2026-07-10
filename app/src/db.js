/** Minimal IndexedDB wrapper for meal history. */
const DB_NAME = 'nutrilens';
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('history', mode);
    const store = t.objectStore('history');
    const out = fn(store);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

/**
 * @param {{foodId:string, foodName:string, grams:number, kcal:number, nutrients:object, thumb:Blob, ts:number}} entry
 */
export async function saveMeal(entry) {
  const db = await open();
  return tx(db, 'readwrite', (s) => s.add(entry));
}

export async function listMeals(limit = 100) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('history', 'readonly');
    const idx = t.objectStore('history').index('ts');
    const out = [];
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (cur && out.length < limit) { out.push(cur.value); cur.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMeal(id) {
  const db = await open();
  return tx(db, 'readwrite', (s) => s.delete(id));
}
