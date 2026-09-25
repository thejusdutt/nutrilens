/**
 * The app is offline by construction: no code that ships may name another
 * origin. Build-time tools may (they fetch datasets and models); the shipped
 * source may not, so a runtime network call cannot come back unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const shipped = [
  ...walk(join(app, 'src')).filter((p) => /\.(js|css)$/.test(p)),
  join(app, 'index.html'),
  join(app, 'public/sw.js'),
  join(app, 'public/manifest.webmanifest'),
];
// SVG and XHTML namespaces are identifiers, not requests.
const ALLOWED = /^https?:\/\/www\.w3\.org\//;

describe('shipped app makes no network requests', () => {
  it('names no external origin', () => {
    const hits = [];
    for (const file of shipped) {
      for (const m of readFileSync(file, 'utf8').matchAll(/https?:\/\/[^\s'"`)<>]+/g)) {
        if (!ALLOWED.test(m[0])) hits.push(`${relative(app, file)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('fetches only same-origin paths', () => {
    const hits = [];
    for (const file of shipped.filter((f) => f.endsWith('.js'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/fetch\(\s*([^,)]+)/g)) {
        const arg = m[1].trim();
        // A literal must be a root-relative path; anything computed must be
        // built from one (`${url}.p00`, a Request for '/index.html', ...).
        if (/^['"`]/.test(arg) && !/^['"`]\/|^`\$\{url\}/.test(arg)) hits.push(`${relative(app, file)}: fetch(${arg})`);
      }
    }
    expect(hits).toEqual([]);
  });
});
