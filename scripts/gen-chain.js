'use strict';
// Generates public/chain.svg — a straight strand of interlocking chain links.
// White strokes on transparency: the login backdrop uses it as a CSS mask, so
// the colour comes from CSS and one file serves both themes.

const fs = require('fs');
const path = require('path');

const LINKS = 16;
const SPACING = 34;   // centre-to-centre; less than LINK_W so links overlap
const LINK_W = 54;
const FACE_H = 32;    // a link lying face-on
const EDGE_H = 15;    // the next one, twisted 90° — reads as edge-on
const STROKE = 5;
const H = 64;
const CY = H / 2;
const PAD = LINK_W / 2 + STROKE;
const W = PAD * 2 + SPACING * (LINKS - 1);

/** Stadium (fully rounded rect) outline centred on (cx, CY). */
function link(cx, h) {
  const w = LINK_W;
  return (
    `<rect x="${(cx - w / 2).toFixed(1)}" y="${(CY - h / 2).toFixed(1)}" ` +
    `width="${w}" height="${h}" rx="${(h / 2).toFixed(1)}"/>`
  );
}

const parts = [];
for (let i = 0; i < LINKS; i++) {
  const cx = PAD + i * SPACING;
  // Alternating face-on / edge-on links is what makes a flat drawing read as
  // a chain rather than a row of ovals.
  parts.push(link(cx, i % 2 === 0 ? FACE_H : EDGE_H));
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<g fill="none" stroke="#fff" stroke-width="${STROKE}">
${parts.join('\n')}
</g>
</svg>
`;

fs.writeFileSync(path.join(__dirname, '..', 'public', 'chain.svg'), svg);
console.log(`links: ${LINKS}  viewBox: ${W}x${H}  bytes: ${svg.length}`);
