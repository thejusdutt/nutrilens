/** Generate PWA icons (SVG source → PNGs via sharp). */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'app/public/icons');
mkdirSync(dir, { recursive: true });

const svg = (pad = 0) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 96}" fill="#101418"/>
  <g transform="translate(256 256) scale(${1 - pad}) translate(-256 -256)">
    <circle cx="256" cy="256" r="170" fill="none" stroke="#34c467" stroke-width="26"/>
    <circle cx="256" cy="256" r="104" fill="none" stroke="#34c467" stroke-width="16" opacity=".55"/>
    <path d="M256 190a66 66 0 1 0 .5 132" fill="none" stroke="#e8ecf0" stroke-width="26" stroke-linecap="round"/>
    <circle cx="360" cy="152" r="34" fill="#34c467"/>
    <path d="M360 130c8-18 26-26 26-26s2 20-8 34c-6 8-18 10-18 10z" fill="#101418"/>
  </g>
</svg>`;

writeFileSync(join(dir, 'icon.svg'), svg());
for (const size of [192, 512]) {
  await sharp(Buffer.from(svg())).resize(size, size).png().toFile(join(dir, `icon-${size}.png`));
}
await sharp(Buffer.from(svg(0.18))).resize(512, 512).png().toFile(join(dir, 'icon-512-maskable.png'));
console.log('icons written to app/public/icons');
