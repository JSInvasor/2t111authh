'use strict';
// Generates public/chain.svg — a long vertical strand of interlocking links.
// White strokes on transparency: the login backdrop uses it as a CSS mask, so
// the colour comes from CSS and one file serves both themes.
//
// Because a mask only reads alpha, the depth cues have to be baked in as
// per-shape opacity — that is what stops the strand looking like a flat
// ladder of ovals.

const fs = require('fs');
const path = require('path');

const LINKS = 42;      // long enough to overrun a tall viewport
const LINK_L = 58;     // link length along the strand
const SPACING = 37;    // centre-to-centre; the shortfall is the interlock
const FACE_W = 33;     // a link lying face-on
const EDGE_W = 12;     // the next one, twisted 90° — reads as edge-on
const STROKE_FACE = 5;
const STROKE_EDGE = 6; // seen from the side the metal reads thicker
const EDGE_ALPHA = 0.78; // edge-on links sit behind, so they dim slightly

const W = FACE_W + STROKE_FACE * 2 + 6;
const CX = W / 2;
const PAD = LINK_L / 2 + STROKE_FACE;
const H = PAD * 2 + SPACING * (LINKS - 1);

/** Stadium (fully rounded rect) outline centred on (CX, cy). */
function link(cy, w, stroke, alpha) {
  const attrs = [
    `x="${(CX - w / 2).toFixed(1)}"`,
    `y="${(cy - LINK_L / 2).toFixed(1)}"`,
    `width="${w}"`,
    `height="${LINK_L}"`,
    `rx="${(w / 2).toFixed(1)}"`,
    `stroke-width="${stroke}"`,
  ];
  if (alpha < 1) attrs.push(`stroke-opacity="${alpha}"`);
  return `<rect ${attrs.join(' ')}/>`;
}

const parts = [];
for (let i = 0; i < LINKS; i++) {
  const cy = PAD + i * SPACING;
  const face = i % 2 === 0;
  parts.push(
    face
      ? link(cy, FACE_W, STROKE_FACE, 1)
      : link(cy, EDGE_W, STROKE_EDGE, EDGE_ALPHA)
  );
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<g fill="none" stroke="#fff" stroke-linejoin="round">
${parts.join('\n')}
</g>
</svg>
`;

fs.writeFileSync(path.join(__dirname, '..', 'public', 'chain.svg'), svg);
console.log(`links: ${LINKS}  viewBox: ${W}x${H}  aspect-ratio: ${W} / ${H}  bytes: ${svg.length}`);
