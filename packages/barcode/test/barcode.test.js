import { describe, it, expect } from 'vitest';
import { checkDigit, isValidBarcode, toEan13, encode, decodeRow, decodeImage, toImage } from '../src/index.js';

/** Real codes (check digits verified against the GTIN rule). */
const NUTELLA = '3017624010701';
const COCA_COLA = '5449000000996';
const UPC_A = '036000291452';   // Nabisco, classic UPC-A test code
const EAN_8 = '96385074';

const rowFrom = (img, y) => {
  const row = new Uint8Array(img.width);
  for (let x = 0; x < img.width; x++) row[x] = img.data[(y * img.width + x) * 4];
  return row;
};

describe('check digits', () => {
  it('computes the GTIN check digit', () => {
    expect(checkDigit('301762401070')).toBe(1);
    expect(checkDigit('544900000099')).toBe(6);
    expect(checkDigit('03600029145')).toBe(2);
    expect(checkDigit('9638507')).toBe(4);
  });

  it('validates real codes and rejects tampered ones', () => {
    for (const code of [NUTELLA, COCA_COLA, UPC_A, EAN_8]) expect(isValidBarcode(code), code).toBe(true);
    expect(isValidBarcode('3017624010702')).toBe(false);
    expect(isValidBarcode('301762401070')).toBe(false); // 12 digits, wrong check
    expect(isValidBarcode('abcdefghijklm')).toBe(false);
    expect(isValidBarcode('12345')).toBe(false);
    expect(isValidBarcode('')).toBe(false);
  });

  it('normalises UPC-A to EAN-13 by prefixing a zero', () => {
    expect(toEan13(UPC_A)).toBe(`0${UPC_A}`);
    expect(toEan13(NUTELLA)).toBe(NUTELLA);
    expect(isValidBarcode(toEan13(UPC_A))).toBe(true);
  });
});

describe('encoding', () => {
  it('produces 95 modules for EAN-13 with the standard guards', () => {
    const m = encode(NUTELLA);
    expect(m).toHaveLength(95);
    expect(m.slice(0, 3)).toBe('101');
    expect(m.slice(45, 50)).toBe('01010');
    expect(m.slice(-3)).toBe('101');
  });

  it('produces 67 modules for EAN-8', () => {
    expect(encode(EAN_8)).toHaveLength(67);
  });

  it('encodes UPC-A as its EAN-13 equivalent', () => {
    expect(encode(UPC_A)).toBe(encode(toEan13(UPC_A)));
  });

  it('uses the parity pattern of the first digit', () => {
    // First digit 0 means all six left symbols come from set A, which always
    // starts with a light module and ends with a bar.
    const zero = encode('0123456789012');
    for (let i = 0; i < 6; i++) {
      const sym = zero.slice(3 + i * 7, 10 + i * 7);
      expect(sym[0]).toBe('0');
      expect(sym.at(-1)).toBe('1');
    }
  });

  it('refuses invalid input', () => {
    expect(() => encode('3017624010702')).toThrow(/invalid/);
    expect(() => encode('123')).toThrow();
  });
});

describe('scanline decoding', () => {
  it('round-trips every supported format', () => {
    for (const code of [NUTELLA, COCA_COLA, EAN_8]) {
      const img = toImage(code);
      expect(decodeImage(img)?.code, code).toBe(code);
    }
  });

  it('reads UPC-A back as its 13-digit form', () => {
    const hit = decodeImage(toImage(UPC_A));
    expect(hit.code).toBe(toEan13(UPC_A));
    expect(hit.format).toBe('UPC-A');
  });

  it('labels EAN-13 and EAN-8 formats', () => {
    expect(decodeImage(toImage(NUTELLA)).format).toBe('EAN-13');
    expect(decodeImage(toImage(EAN_8)).format).toBe('EAN-8');
  });

  it('decodes at different module scales', () => {
    for (const moduleWidth of [2, 3, 5, 9]) {
      expect(decodeImage(toImage(NUTELLA, { moduleWidth }))?.code, `mw=${moduleWidth}`).toBe(NUTELLA);
    }
  });

  it('decodes a code held upside down', () => {
    const img = toImage(COCA_COLA, { moduleWidth: 4 });
    const flipped = { ...img, data: new Uint8ClampedArray(img.data) };
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const src = (y * img.width + (img.width - 1 - x)) * 4;
        const dst = (y * img.width + x) * 4;
        for (let c = 0; c < 4; c++) flipped.data[dst + c] = img.data[src + c];
      }
    }
    expect(decodeImage(flipped)?.code).toBe(COCA_COLA);
  });

  it('decodes a single row directly', () => {
    const img = toImage(NUTELLA, { moduleWidth: 4 });
    expect(decodeRow(rowFrom(img, 10), img.width)?.code).toBe(NUTELLA);
  });

  it('survives a dim, low-contrast frame', () => {
    const img = toImage(NUTELLA, { moduleWidth: 4 });
    const dim = { ...img, data: new Uint8ClampedArray(img.data) };
    for (let i = 0; i < dim.data.length; i += 4) {
      for (let c = 0; c < 3; c++) dim.data[i + c] = 70 + dim.data[i + c] * 0.4; // 70..172
    }
    expect(decodeImage(dim)?.code).toBe(NUTELLA);
  });

  it('finds a code that only occupies part of the frame', () => {
    const bar = toImage(COCA_COLA, { moduleWidth: 3, height: 30, quiet: 12 });
    const W = bar.width + 60, H = 120;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const offX = 30, offY = 45;
    for (let y = 0; y < bar.height; y++) {
      for (let x = 0; x < bar.width; x++) {
        const src = (y * bar.width + x) * 4;
        const dst = ((y + offY) * W + x + offX) * 4;
        for (let c = 0; c < 4; c++) data[dst + c] = bar.data[src + c];
      }
    }
    expect(decodeImage({ data, width: W, height: H })?.code).toBe(COCA_COLA);
  });

  it('returns null rather than guessing', () => {
    const blank = { data: new Uint8ClampedArray(200 * 40 * 4).fill(255), width: 200, height: 40 };
    expect(decodeImage(blank)).toBeNull();
    const noise = { data: new Uint8ClampedArray(200 * 40 * 4), width: 200, height: 40 };
    for (let i = 0; i < noise.data.length; i++) noise.data[i] = (i * 37) % 256;
    expect(decodeImage(noise)).toBeNull();
    // Stripes that are not a valid symbology must not produce a code.
    const stripes = { data: new Uint8ClampedArray(300 * 20 * 4).fill(255), width: 300, height: 20 };
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 300; x++) {
        if (Math.floor(x / 7) % 2) continue;
        const i = (y * 300 + x) * 4;
        stripes.data[i] = stripes.data[i + 1] = stripes.data[i + 2] = 0;
      }
    }
    expect(decodeImage(stripes)).toBeNull();
  });

  it('decodes 200 arbitrary valid codes', () => {
    let decoded = 0;
    for (let i = 0; i < 200; i++) {
      const payload = String(100000000000 + i * 4931).slice(0, 12);
      const code = payload + checkDigit(payload);
      const hit = decodeImage(toImage(code, { moduleWidth: 3 }));
      if (hit?.code === code) decoded++;
    }
    expect(decoded).toBe(200);
  });
});
