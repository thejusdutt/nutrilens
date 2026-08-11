import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const token = (source, name) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(source)?.[1];

const light = /:root\s*\{([^}]+)\}/.exec(css)?.[1] ?? '';
const dark = /:root\[data-theme="dark"\]\s*\{([^}]+)\}/.exec(css)?.[1] ?? '';

const channel = (value) => {
  const n = value / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
};

function luminance(hex) {
  const rgb = hex.match(/[0-9a-f]{2}/gi).map((part) => channel(parseInt(part, 16)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(a, b) {
  const [bright, dim] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + 0.05) / (dim + 0.05);
}

describe('muted ink contrast', () => {
  it.each([
    ['light paper', light, 'ink-3', 'paper'],
    ['light surface', light, 'ink-3', 'surface'],
    ['light secondary surface', light, 'ink-3', 'surface-2'],
    ['dark paper', dark, 'ink-3', 'paper'],
    ['dark surface', dark, 'ink-3', 'surface'],
    ['dark secondary surface', dark, 'ink-3', 'surface-2'],
  ])('%s remains at least 4.5:1', (_name, source, foreground, background) => {
    expect(contrast(token(source, foreground), token(source, background))).toBeGreaterThanOrEqual(4.5);
  });
});
