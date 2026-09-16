// Generates the PWA icons in public/icons by rendering an inline SVG with
// headless Chromium (playwright-core). Run: `npm run icons`.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/icons');
const EXECUTABLE = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * The icon: a rounded-square gradient background with a big domed screw head
 * and a Phillips cross. `maskable` pushes the artwork into the safe zone
 * (inner 80%) and uses a full-bleed background.
 */
export function iconSvg({ size = 512, maskable = false, radius = 0.22 } = {}) {
  const s = size;
  const r = maskable ? 0 : s * radius;
  const cx = s / 2;
  const cy = s / 2;
  // Screw head radius: maskable icons keep everything inside the central 80%.
  const R = maskable ? s * 0.3 : s * 0.34;
  const shaft = R * 0.18;
  const cross = R * 0.72;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff"/>
      <stop offset="0.55" stop-color="#3b7df0"/>
      <stop offset="1" stop-color="#1c2b5a"/>
    </linearGradient>
    <radialGradient id="dome" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#ffe680"/>
      <stop offset="0.35" stop-color="#f5c518"/>
      <stop offset="0.8" stop-color="#d98d0b"/>
      <stop offset="1" stop-color="#8f5a05"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b8760a"/>
      <stop offset="1" stop-color="#5e3b02"/>
    </linearGradient>
    <linearGradient id="slot" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3a2500"/>
      <stop offset="1" stop-color="#1a1000"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="${s * 0.03}"/>
      <feOffset dx="0" dy="${s * 0.035}" result="o"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="0" y="0" width="${s}" height="${s}" rx="${r}" ry="${r}" fill="url(#bg)"/>
  <!-- soft highlight in the corner -->
  <circle cx="${s * 0.22}" cy="${s * 0.18}" r="${s * 0.5}" fill="url(#glow)"/>
  <!-- little panel behind the screw -->
  <rect x="${cx - R * 1.35}" y="${cy - R * 1.05}" width="${R * 2.7}" height="${R * 2.1}" rx="${R * 0.35}"
        fill="#2ec4d6" opacity="0.95" transform="rotate(-8 ${cx} ${cy})" filter="url(#shadow)"/>
  <rect x="${cx - R * 1.35}" y="${cy - R * 1.05}" width="${R * 2.7}" height="${R * 0.5}" rx="${R * 0.25}"
        fill="#ffffff" opacity="0.18" transform="rotate(-8 ${cx} ${cy})"/>
  <!-- screw head -->
  <g filter="url(#shadow)">
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#rim)"/>
    <circle cx="${cx}" cy="${cy - shaft * 0.35}" r="${R * 0.94}" fill="url(#dome)"/>
  </g>
  <!-- phillips cross -->
  <g transform="translate(${cx} ${cy - shaft * 0.35})">
    <rect x="${-cross / 2}" y="${-shaft / 2}" width="${cross}" height="${shaft}" rx="${shaft * 0.4}" fill="url(#slot)"/>
    <rect x="${-shaft / 2}" y="${-cross / 2}" width="${shaft}" height="${cross}" rx="${shaft * 0.4}" fill="url(#slot)"/>
    <rect x="${-cross / 2 + shaft * 0.15}" y="${-shaft / 2 + shaft * 0.15}" width="${cross - shaft * 0.3}" height="${shaft * 0.25}" rx="${shaft * 0.12}" fill="#000" opacity="0.35"/>
  </g>
  <!-- specular -->
  <ellipse cx="${cx - R * 0.35}" cy="${cy - R * 0.5}" rx="${R * 0.28}" ry="${R * 0.16}" fill="#fff" opacity="0.55" transform="rotate(-30 ${cx - R * 0.35} ${cy - R * 0.5})"/>
</svg>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon-180.png', size: 180, maskable: true },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  try {
    for (const t of TARGETS) {
      const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
      const svg = iconSvg({ size: t.size, maskable: t.maskable });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
      );
      const buf = await page.screenshot({
        type: 'png',
        omitBackground: true,
        clip: { x: 0, y: 0, width: t.size, height: t.size },
      });
      await writeFile(resolve(OUT, t.file), buf);
      await page.close();
      console.log(`wrote public/icons/${t.file} (${t.size}px${t.maskable ? ', maskable' : ''})`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
