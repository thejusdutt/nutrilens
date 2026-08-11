/** Versioned, JSON-safe backup format for all user-owned NutriLens data. */
export const BACKUP_FORMAT = 'nutrilens-backup';
export const BACKUP_VERSION = 1;
export const STORE_NAMES = ['history', 'day', 'foods', 'meals', 'exercise', 'measurements', 'products'];
export const PREFERENCE_KEYS = ['theme', 'plateCm', 'profile', 'onlineBarcodeLookup'];

const KEY_FIELDS = {
  history: 'id', day: 'date', foods: 'id', meals: 'id', exercise: 'id',
  measurements: 'date', products: 'barcode',
};
const BLOB_MARKER = '__nutrilensBlob';

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encodeValue(value) {
  if (value instanceof Blob) {
    return { [BLOB_MARKER]: true, type: value.type, data: bytesToBase64(new Uint8Array(await value.arrayBuffer())) };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeValue));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodeValue(item)]));
    return Object.fromEntries(entries);
  }
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    if (value[BLOB_MARKER] === true) {
      if (typeof value.data !== 'string' || typeof value.type !== 'string') throw new Error('Backup contains an invalid file');
      return new Blob([base64ToBytes(value.data)], { type: value.type });
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item)]));
  }
  return value;
}

function validateStores(stores) {
  if (!stores || typeof stores !== 'object' || Array.isArray(stores)) throw new Error('Backup has no data stores');
  for (const name of STORE_NAMES) {
    const rows = stores[name];
    if (!Array.isArray(rows)) throw new Error(`Backup store “${name}” is missing`);
    const key = KEY_FIELDS[name];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Backup store “${name}” contains an invalid record`);
      const value = row[key];
      const valid = key === 'id' ? Number.isFinite(value) : typeof value === 'string' && value.length > 0;
      if (!valid) throw new Error(`Backup store “${name}” contains a record without ${key}`);
    }
  }
}

/** Build a JSON-serializable backup envelope, including Blob thumbnails. */
export async function buildBackup(stores, preferences, dbVersion) {
  validateStores(stores);
  const encoded = {};
  for (const name of STORE_NAMES) encoded[name] = await encodeValue(stores[name]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    dbVersion,
    createdAt: new Date().toISOString(),
    stores: encoded,
    preferences: Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, preferences[key] ?? null])),
  };
}

/** Parse and fully validate a backup before any local data is changed. */
export function parseBackup(text, expectedDbVersion) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error('This is not valid JSON'); }
  if (envelope?.format !== BACKUP_FORMAT || envelope?.version !== BACKUP_VERSION) {
    throw new Error('This is not a supported NutriLens backup');
  }
  if (envelope.dbVersion !== expectedDbVersion) {
    throw new Error(`Backup database version ${envelope.dbVersion} is not compatible with version ${expectedDbVersion}`);
  }
  validateStores(envelope.stores);
  if (!envelope.preferences || typeof envelope.preferences !== 'object' || Array.isArray(envelope.preferences)) {
    throw new Error('Backup preferences are missing');
  }
  const preferences = {};
  for (const key of PREFERENCE_KEYS) {
    const value = envelope.preferences[key];
    if (value != null && typeof value !== 'string') throw new Error(`Backup preference “${key}” is invalid`);
    preferences[key] = value ?? null;
  }
  const stores = Object.fromEntries(STORE_NAMES.map((name) => [name, envelope.stores[name].map(decodeValue)]));
  return { stores, preferences, createdAt: envelope.createdAt ?? null };
}
