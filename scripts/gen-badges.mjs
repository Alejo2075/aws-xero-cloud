#!/usr/bin/env node
// Generates the README badges in the style of the logo (brushed silver label, red neon value, jagged edges).
// Static, dependency-free SVGs: no external badge service is contacted when the README is viewed.
// Usage: node scripts/gen-badges.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'docs', 'assets', 'badges');
const BADGES = [
  ['license', 'LICENSE', 'APACHE-2.0'],
  ['status', 'STATUS', 'V0.1 PRE-RELEASE'],
  ['node', 'NODE', '>= 24'],
  ['execution', 'EXECUTION', 'LOCAL CONTAINERS'],
  ['aws', 'AWS', 'OPT-IN'],
  ['runtimes', 'RUNTIMES', 'NODE.JS · PYTHON'],
  ['typescript', 'TYPESCRIPT', 'STRICT'],
];

const H = 28;
const CHAR = 7.6; // approximate advance of 11px bold sans caps
const PAD = 11;
const SLANT = 6; // jagged, skewed edges like the logo lettering
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svg(label, value) {
  const lw = Math.round(label.length * CHAR + PAD * 2);
  const vw = Math.round(value.length * CHAR + PAD * 2);
  const w = lw + vw;
  const lt = lw - PAD * 2; // fixed text widths: layout stays identical whatever font the viewer substitutes
  const vt = vw - PAD * 2;
  const fit = (n) => `textLength="${n}" lengthAdjust="spacingAndGlyphs"`;
  const title = esc(`${label.toLowerCase()}: ${value.toLowerCase()}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="${title}">
  <title>${title}</title>
  <defs>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f4f4"/><stop offset=".45" stop-color="#a9a9a9"/><stop offset=".55" stop-color="#7d7d7d"/><stop offset="1" stop-color="#cfcfcf"/>
    </linearGradient>
    <linearGradient id="red" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff3b3b"/><stop offset=".5" stop-color="#c40000"/><stop offset="1" stop-color="#6e0000"/>
    </linearGradient>
    <filter id="glow" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <g filter="url(#glow)">
    <polygon points="${SLANT},1 ${lw + SLANT / 2},1 ${lw - SLANT / 2},${H - 1} 1,${H - 1}" fill="url(#silver)" stroke="#ff2a2a" stroke-width="1"/>
    <polygon points="${lw + SLANT / 2},1 ${w - 1},1 ${w - SLANT},${H - 1} ${lw - SLANT / 2},${H - 1}" fill="url(#red)" stroke="#ff2a2a" stroke-width="1"/>
  </g>
  <g font-family="Impact,'Arial Black','DejaVu Sans',Verdana,sans-serif" font-weight="800" font-size="11" letter-spacing=".6" text-anchor="middle">
    <text x="${lw / 2 + 1}" y="18.5" ${fit(lt)} fill="#fff" opacity=".55">${esc(label)}</text>
    <text x="${lw / 2}" y="17.5" ${fit(lt)} fill="#15060a">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="18.5" ${fit(vt)} fill="#2a0000" opacity=".8">${esc(value)}</text>
    <text x="${lw + vw / 2}" y="17.5" ${fit(vt)} fill="#ffffff">${esc(value)}</text>
  </g>
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
for (const [file, label, value] of BADGES) writeFileSync(join(OUT, `${file}.svg`), svg(label, value));
console.log(`wrote ${BADGES.length} badges to ${OUT}`);
