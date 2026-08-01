'use strict';
// Generates public/login-art.svg — a dot-matrix globe under a starfield.
// White shapes on transparency: the panel uses it as a CSS mask, so the alpha
// here becomes the shading and the colour comes from CSS.

const fs = require('fs');

const W = 600;
const H = 720;

// deterministic PRNG so regenerating doesn't reshuffle the stars
let seed = 20260731;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const parts = [];

/* ----------------------------------------------------------------- stars */
for (let i = 0; i < 130; i++) {
  const x = rnd() * W;
  // bias upward — the globe owns the bottom third
  const y = rnd() * rnd() * H * 0.92;
  const r = 0.7 + rnd() * 1.5;
  const o = (0.3 + rnd() * 0.68).toFixed(2);
  parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" opacity="${o}"/>`);
}

/* ------------------------------------------------------------ dot globe */
const CX = W / 2;
const CY = 620;      // pushed down so the sphere is cropped by the panel edge
const R = 265;
const TILT = (-18 * Math.PI) / 180;   // spin the pole slightly for a nicer read

const LAT_STEP = 6;                    // degrees
for (let lat = -88; lat <= 88; lat += LAT_STEP) {
  const latR = (lat * Math.PI) / 180;
  // keep dot spacing roughly even by thinning rows near the poles
  const count = Math.max(6, Math.round(64 * Math.cos(latR)));
  for (let i = 0; i < count; i++) {
    const lon = (i / count) * Math.PI * 2;

    // sphere -> world, then tilt around the x axis
    let x = Math.cos(latR) * Math.cos(lon);
    let y = Math.sin(latR);
    let z = Math.cos(latR) * Math.sin(lon);
    const y2 = y * Math.cos(TILT) - z * Math.sin(TILT);
    const z2 = y * Math.sin(TILT) + z * Math.cos(TILT);
    y = y2;
    z = z2;

    if (z < 0) continue;              // back hemisphere

    const px = CX + x * R;
    const py = CY - y * R;
    if (py > H + 4) continue;         // below the crop

    // depth shading: dots near the limb fade out
    const depth = Math.pow(z, 0.55);
    const r = (0.8 + depth * 1.3).toFixed(2);
    const o = (0.24 + depth * 0.76).toFixed(2);
    parts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r}" opacity="${o}"/>`);
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<g fill="#fff">
${parts.join('\n')}
</g>
</svg>
`;

fs.writeFileSync(require('path').join(__dirname, '..', 'public', 'login-art.svg'), svg);
console.log('shapes:', parts.length, 'bytes:', svg.length);
