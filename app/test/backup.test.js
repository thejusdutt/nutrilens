import { describe, expect, it } from 'vitest';
import { buildBackup, parseBackup, STORE_NAMES } from '../src/backup.js';

const stores = () => Object.fromEntries(STORE_NAMES.map((name) => [name, []]));

describe('full backup format', () => {
  it('round-trips records, preferences and Blob thumbnails', async () => {
    const data = stores();
    data.history.push({
      id: 7, date: '2026-08-11', foodName: 'Dosa',
      thumb: new Blob([new Uint8Array([1, 2, 3, 255])], { type: 'image/jpeg' }),
    });
    data.products.push({ barcode: '0123456789012', name: 'Yoghurt' });

    const envelope = await buildBackup(data, { theme: 'dark', onlineBarcodeLookup: 'false' }, 3);
    const restored = parseBackup(JSON.stringify(envelope), 3);

    expect(restored.preferences.theme).toBe('dark');
    expect(restored.preferences.onlineBarcodeLookup).toBe('false');
    expect(restored.stores.products[0].barcode).toBe('0123456789012');
    expect(restored.stores.history[0].thumb).toBeInstanceOf(Blob);
    expect(restored.stores.history[0].thumb.type).toBe('image/jpeg');
    expect([...new Uint8Array(await restored.stores.history[0].thumb.arrayBuffer())]).toEqual([1, 2, 3, 255]);
  });

  it('rejects incompatible database versions before restore', async () => {
    const envelope = await buildBackup(stores(), {}, 2);
    expect(() => parseBackup(JSON.stringify(envelope), 3)).toThrow(/not compatible/);
  });

  it('rejects missing stores and records without their primary key', async () => {
    const missing = await buildBackup(stores(), {}, 3);
    delete missing.stores.products;
    expect(() => parseBackup(JSON.stringify(missing), 3)).toThrow(/products.*missing/);

    const invalid = stores();
    invalid.history.push({ date: '2026-08-11' });
    await expect(buildBackup(invalid, {}, 3)).rejects.toThrow(/without id/);
  });
});
