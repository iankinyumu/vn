// Generates the flat 2D plush characters (assets/img/characters/*.svg) from the owner's
// 3D mascot art: same silhouettes, colours, faces and accessories, drawn as vectors.
// Each character gets an animated file (blink, breathe, accessory sway) and a "-still"
// file for dense grids. Animation lives inside the SVG and stops under reduced motion.
// Run: node scripts/generate-characters.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '..', 'assets/img/characters');
const INK = '#1b1b1b';
const SOFT = 'stroke-linejoin="round" stroke-linecap="round"';

// ---- Bodies (viewBox 0 0 200 200; the character sits on y ~180) ----------------------
const roundPoly = (points, color, width = 26) => `<polygon points="${points.map((p) => p.join(',')).join(' ')}" fill="${color}" stroke="${color}" stroke-width="${width}" ${SOFT}/>`;
const starPoints = (cx, cy, outer, inner) => Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? inner : outer, a = (Math.PI / 5) * i - Math.PI / 2;
    return [+(cx + r * Math.cos(a)).toFixed(1), +(cy + r * Math.sin(a)).toFixed(1)];
});
const bodies = {
    star: (c) => roundPoly(starPoints(100, 114, 84, 46), c, 28),
    square: (c) => `<rect x="34" y="44" width="132" height="128" rx="40" fill="${c}"/>`,
    cloud: (c) => [[58, 118, 36], [100, 98, 46], [142, 118, 36], [78, 140, 34], [122, 140, 34], [100, 128, 40]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`).join(''),
    oval: (c) => `<ellipse cx="100" cy="112" rx="68" ry="60" fill="${c}" transform="rotate(-8 100 112)"/>`,
    ball: (c) => `<ellipse cx="100" cy="110" rx="70" ry="66" fill="${c}"/>`,
    diamond: (c) => `<rect x="44" y="52" width="112" height="112" rx="30" fill="${c}" transform="rotate(45 100 108)"/>`,
    heart: (c) => `<path d="M100 172C46 136 26 104 40 72 52 46 88 44 100 70 112 44 148 46 160 72 174 104 154 136 100 172Z" fill="${c}" stroke="${c}" stroke-width="16" ${SOFT}/>`,
    drop: (c) => `<path d="M100 34C128 72 166 100 166 134 166 168 136 180 100 180 64 180 34 168 34 134 34 100 72 72 100 34Z" fill="${c}" stroke="${c}" stroke-width="10" ${SOFT}/>`,
    pear: (c) => `<path d="M100 32C124 32 128 70 140 92 160 112 170 134 166 154 160 178 130 182 100 182 70 182 40 178 34 154 30 134 40 112 60 92 72 70 76 32 100 32Z" fill="${c}"/>`,
    clover: (c) => `${[[70, 82], [130, 82], [70, 136], [130, 136]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="40" fill="${c}"/>`).join('')}<rect x="60" y="72" width="80" height="74" fill="${c}"/>`,
    triangle: (c) => roundPoly([[100, 52], [168, 162], [32, 162]], c, 34),
};
const highlight = (x, y, rx, ry) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#fff" opacity=".22"/>`;

// ---- Faces --------------------------------------------------------------------------------
const dot = (x, y) => `<ellipse cx="${x}" cy="${y}" rx="6.5" ry="9" fill="${INK}"/><circle cx="${x + 2}" cy="${y - 3.5}" r="2" fill="#fff"/>`;
const closed = (x, y) => `<path d="M${x - 10} ${y}q10 8 20 0" fill="none" stroke="${INK}" stroke-width="5" ${SOFT}/>`;
const wink = (x, y) => `<path d="M${x - 9} ${y + 2}q9 -9 18 0" fill="none" stroke="${INK}" stroke-width="5" ${SOFT}/>`;
const sleepy = (x, y) => `<path d="M${x - 11} ${y}q11 3 22 0" fill="none" stroke="${INK}" stroke-width="6" ${SOFT}/>`;
const eyes = (kind, y, gap = 17, cx = 100) => {
    const [l, r] = [cx - gap, cx + gap];
    if (kind === 'dots') return `<g class="blink">${dot(l, y)}${dot(r, y)}</g>`;
    if (kind === 'closed') return `${closed(l, y)}${closed(r, y)}`;
    if (kind === 'sleepy') return `${sleepy(l, y)}${sleepy(r, y)}`;
    if (kind === 'wink') return `<g class="blink">${dot(l, y)}</g>${wink(r, y)}`;
    return '';
};
const smile = (x, y, w = 14) => `<path d="M${x - w} ${y}q${w} 10 ${w * 2} 0" fill="none" stroke="${INK}" stroke-width="5" ${SOFT}/>`;

// ---- Accessories ------------------------------------------------------------------------
const headphones = (left, right, top, cupY, cupH = 46) => `<path d="M${left + 12} ${cupY + 6}C${left + 4} ${top}, ${right - 4} ${top}, ${right - 12} ${cupY + 6}" fill="none" stroke="${INK}" stroke-width="11" ${SOFT}/>`
    + `<rect x="${left - 6}" y="${cupY}" width="28" height="${cupH}" rx="12" fill="${INK}"/><rect x="${right - 22}" y="${cupY}" width="28" height="${cupH}" rx="12" fill="${INK}"/>`
    + `<rect x="${left - 1}" y="${cupY + 8}" width="8" height="${cupH - 16}" rx="4" fill="#3a3a3a"/><rect x="${right - 7}" y="${cupY + 8}" width="8" height="${cupH - 16}" rx="4" fill="#3a3a3a"/>`;
const sunglasses = (y, gap = 22, r = 15) => `<path d="M${100 - gap - r} ${y - 2}L${100 - gap - r - 22} ${y - 8}M${100 + gap + r} ${y - 2}L${100 + gap + r + 22} ${y - 8}" stroke="${INK}" stroke-width="3" ${SOFT}/>`
    + `<path d="M${100 - gap + r - 2} ${y - 3}q${gap - r + 2} -6 ${2 * (gap - r) + 4} 0" fill="none" stroke="${INK}" stroke-width="3.5"/>`
    + `<circle cx="${100 - gap}" cy="${y}" r="${r}" fill="${INK}"/><circle cx="${100 + gap}" cy="${y}" r="${r}" fill="${INK}"/>`
    + `<circle cx="${100 - gap - 5}" cy="${y - 5}" r="3" fill="#fff" opacity=".35"/><circle cx="${100 + gap - 5}" cy="${y - 5}" r="3" fill="#fff" opacity=".35"/>`;
const readingGlasses = (y) => `<g fill="none" stroke="${INK}" stroke-width="3.5"><circle cx="78" cy="${y}" r="17"/><circle cx="122" cy="${y}" r="17"/><path d="M95 ${y - 2}q5 -5 10 0M61 ${y - 3}l-20 -6M139 ${y - 3}l20 -6" ${SOFT}/></g>`;
const beret = (x, y, w = 62, tilt = -14) => `<g class="sway" transform="rotate(${tilt} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="${w}" ry="${w * 0.42}" fill="${INK}"/><ellipse cx="${x}" cy="${y - 4}" rx="${w * 0.8}" ry="${w * 0.24}" fill="#2c2c2c"/><circle cx="${x - w * 0.35}" cy="${y - w * 0.42}" r="9" fill="${INK}"/></g>`;
const crown = () => `<g class="sway" transform="rotate(-14 66 44)"><path d="M46 52l4-26 12 14 8-18 8 18 12-14 4 26z" fill="#e6b33c" stroke="#c8941f" stroke-width="2" ${SOFT}/><circle cx="50" cy="25" r="4" fill="#f2c95a"/><circle cx="70" cy="21" r="4" fill="#f2c95a"/><circle cx="90" cy="25" r="4" fill="#f2c95a"/></g>`;
const pencil = () => `<g class="sway" transform="rotate(-38 78 52)"><rect x="50" y="45" width="62" height="14" rx="2" fill="#3b3d42"/><rect x="40" y="45" width="12" height="14" fill="#c9cbd0"/><rect x="30" y="45" width="12" height="14" rx="5" fill="#f19aa7"/><path d="M112 45l18 7-18 7z" fill="#e8c38c"/><path d="M124 49.7l6 2.3-6 2.3z" fill="#2a2a2a"/></g>`;
const scarf = () => `<path d="M40 122q60 22 120 0l2 26q-62 24-124 0z" fill="${INK}"/><g class="sway"><path d="M136 136l18 0 6 46-20 2z" fill="#2a2a2a"/><path d="M142 176l16 0M141 182l18 0" stroke="#555" stroke-width="2"/></g>`;
const strapPouch = () => `<path d="M36 118L144 150" stroke="${INK}" stroke-width="9" ${SOFT}/><g class="sway"><rect x="108" y="132" width="52" height="34" rx="12" fill="${INK}" transform="rotate(-24 134 149)"/><rect x="116" y="140" width="22" height="6" rx="3" fill="#3a3a3a" transform="rotate(-24 127 143)"/></g>`;
const bucketHat = () => `<g class="sway" transform="rotate(10 112 60)"><ellipse cx="112" cy="72" rx="74" ry="16" fill="${INK}"/><path d="M68 70q4-44 46-44 40 0 42 44z" fill="#262626"/><path d="M70 64q42 8 84 0" stroke="#3d3d3d" stroke-width="3" fill="none"/></g>`;
const daisy = () => `<g class="sway" transform="translate(70 72)">${Array.from({ length: 7 }, (_, i) => `<ellipse cx="0" cy="-13" rx="7" ry="12" fill="#fbf8f0" stroke="#e7e1d2" stroke-width="1" transform="rotate(${i * (360 / 7)})"/>`).join('')}<circle r="7" fill="#f2c14e"/></g>`;
const whistle = () => `<path d="M40 122q60 30 120 0" fill="none" stroke="#2b2b2b" stroke-width="4" ${SOFT}/><g class="sway"><path d="M100 136v8" stroke="#8d9198" stroke-width="3"/><rect x="88" y="144" width="24" height="30" rx="8" fill="#c3c7cd" stroke="#9a9fa6" stroke-width="2"/><rect x="95" y="158" width="10" height="5" rx="2" fill="#5d6168"/></g>`;
const belt = () => `<rect x="30" y="122" width="140" height="20" rx="6" fill="${INK}"/><rect x="88" y="118" width="24" height="28" rx="5" fill="#3a3a3a" stroke="#555" stroke-width="2"/><rect x="95" y="126" width="10" height="12" rx="2" fill="${INK}"/>`;
const pearls = () => Array.from({ length: 15 }, (_, i) => { const t = i / 14, x = 34 + t * 132, y = 140 + Math.sin(t * Math.PI) * 18; return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#f7f2e7" stroke="#d9cfbb" stroke-width="1.2"/>`; }).join('');
const camera = () => `<path d="M58 92L92 140M142 92L108 140" stroke="${INK}" stroke-width="6" ${SOFT}/><g class="sway"><rect x="76" y="132" width="48" height="34" rx="7" fill="#262626"/><rect x="84" y="127" width="14" height="7" rx="2" fill="#262626"/><circle cx="100" cy="149" r="11" fill="#111" stroke="#555" stroke-width="3"/><circle cx="97" cy="146" r="3" fill="#fff" opacity=".4"/></g>`;
const bandana = () => `<path d="M64 92q36 -8 72 0l4 16q-40 -8 -80 0z" fill="${INK}"/><g class="sway" transform="translate(62 98)"><path d="M0 0l-34 -20 6 22z" fill="#262626"/><path d="M0 2l-30 14 4 -20z" fill="${INK}"/></g>`;
const binoculars = () => `<g class="sway"><rect x="74" y="136" width="22" height="32" rx="7" fill="#262626"/><rect x="104" y="136" width="22" height="32" rx="7" fill="#262626"/><rect x="92" y="144" width="16" height="10" rx="3" fill="#1a1a1a"/><circle cx="85" cy="166" r="7" fill="#111" stroke="#4a4a4a" stroke-width="2"/><circle cx="115" cy="166" r="7" fill="#111" stroke="#4a4a4a" stroke-width="2"/></g>`;
const bow = () => `<g class="sway" transform="rotate(16 150 50)"><path d="M150 50l-30 -18q-8 18 0 34z" fill="#f4ecd8" stroke="#ddd2b8" stroke-width="2" ${SOFT}/><path d="M150 50l30 -18q8 18 0 34z" fill="#f4ecd8" stroke="#ddd2b8" stroke-width="2" ${SOFT}/><path d="M146 54l-8 26M154 54l10 24" stroke="#ddd2b8" stroke-width="5" ${SOFT}/><circle cx="150" cy="50" r="8" fill="#efe5cd" stroke="#ddd2b8" stroke-width="2"/></g>`;

// ---- The cast (ids match assets/js/avatars.js) -----------------------------------------
const CAST = {
    'blue-star': { body: 'star', color: '#8cc4f4', glow: [78, 90, 22, 14], face: (sleep) => eyes(sleep ? 'closed' : 'closed', 118, 16), extra: headphones(40, 160, 30, 92, 40) },
    'burgundy-cube': { body: 'square', color: '#8e1733', glow: [74, 72, 24, 12], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 104, 20), extra: crown() },
    'cloud-pencil': { body: 'cloud', color: '#f5e6a0', glow: [86, 86, 24, 12], face: (sleep) => eyes(sleep ? 'closed' : 'closed', 118, 22), extra: pencil() },
    'coral-sunglasses': { body: 'oval', color: '#ef6f6c', glow: [74, 80, 22, 12], face: (sleep) => sunglasses(104, 22, 14), extra: '' },
    'forest-headphones': { body: 'ball', color: '#1f6b3b', glow: [76, 76, 22, 13], face: (sleep) => eyes(sleep ? 'closed' : 'closed', 104, 22) + smile(100, 126, 14), extra: headphones(22, 178, 10, 82, 52) },
    'golden-diamond': { body: 'diamond', color: '#f4cd56', glow: [84, 72, 20, 12], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 106, 22) + readingGlasses(106), extra: '' },
    'green-cloud-beret': { body: 'cloud', color: '#a7d889', glow: [80, 104, 20, 10], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 124, 18, 108), extra: beret(92, 70, 58, -12) },
    'ivory-heart': { body: 'heart', color: '#f2e9d5', glow: [66, 72, 18, 10], face: (sleep) => sunglasses(100, 24, 14), extra: '' },
    'lavender-beret': { body: 'drop', color: '#b8a1ea', glow: [80, 104, 18, 12], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 124, 17, 104), extra: beret(86, 70, 52, -16) },
    'lilac-pear': { body: 'pear', color: '#b39be6', glow: [84, 70, 14, 12], face: (sleep) => eyes(sleep ? 'closed' : 'closed', 100, 18), extra: scarf() },
    'orange-clover': { body: 'clover', color: '#e5612b', glow: [64, 70, 18, 10], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 100, 18), extra: strapPouch() },
    'peach-bucket-hat': { body: 'heart', color: '#f5b69a', glow: [70, 96, 16, 10], face: (sleep) => eyes(sleep ? 'closed' : 'sleepy', 118, 22), extra: bucketHat() },
    'peach-daisy': { body: 'drop', color: '#f3a78d', glow: [84, 100, 16, 12], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 128, 17, 110), extra: daisy() },
    'peach-whistle': { body: 'drop', color: '#f6ae8e', glow: [84, 92, 16, 12], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 110, 17), extra: whistle() },
    'rose-belt': { body: 'ball', color: '#f199ad', glow: [76, 76, 22, 12], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 98, 18), extra: belt() },
    'rose-pearls': { body: 'ball', color: '#f6a7bc', glow: [76, 76, 22, 12], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 104, 18), extra: pearls() },
    'sage-camera': { body: 'diamond', color: '#8ebd79', glow: [84, 72, 18, 11], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 100, 16), extra: camera() },
    'turquoise-bandana': { body: 'triangle', color: '#4fd0c4', glow: [90, 104, 14, 9], face: (sleep) => eyes(sleep ? 'closed' : 'dots', 134, 16), extra: bandana() },
    'violet-binoculars': { body: 'heart', color: '#a67bef', glow: [66, 72, 18, 10], face: (sleep) => eyes(sleep ? 'closed' : 'wink', 104, 22), extra: binoculars() },
    'violet-bow': { body: 'heart', color: '#ae89ef', glow: [66, 72, 18, 10], face: (sleep) => eyes(sleep ? 'closed' : 'wink', 108, 22), extra: bow() },
};

// Blink and sway start at different moments per character, so a page never moves in unison.
const STYLE = (i) => `<style>
.breathe{transform-box:fill-box;transform-origin:50% 100%;animation:breathe 4.2s ease-in-out ${-(i % 7) * 0.6}s infinite}
.blink{transform-box:fill-box;transform-origin:50% 50%;animation:blink ${5 + (i % 4)}s ease-in-out ${(i % 5) * 0.7}s infinite}
.sway{transform-box:fill-box;transform-origin:50% 0;animation:sway 3.6s ease-in-out ${-(i % 6) * 0.5}s infinite}
@keyframes breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.02,.975)}}
@keyframes blink{0%,94%,100%{transform:scaleY(1)}96.5%{transform:scaleY(.1)}}
@keyframes sway{0%,100%{rotate:-4deg}50%{rotate:4deg}}
@media (prefers-reduced-motion:reduce){.breathe,.blink,.sway{animation:none}}
</style>`;

const zzz = `<g fill="#9e9e9e" font-family="Arial, sans-serif" font-weight="700"><text x="150" y="40" font-size="22">z</text><text x="168" y="22" font-size="16">z</text></g>`;
const draw = (id, { body, color, glow, face, extra }, sleep = false) => `<g class="breathe">${bodies[body](color)}${highlight(...glow)}${face(sleep)}${extra}</g>${sleep ? zzz : ""}`;
const svg = (id, inner, animated, i, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><title>${title}</title>${animated ? STYLE(i) : ''}${inner}</svg>\n`;
const titleOf = (id) => id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

mkdirSync(OUT, { recursive: true });
Object.entries(CAST).forEach(([id, spec], i) => {
    writeFileSync(`${OUT}/${id}.svg`, svg(id, draw(id, spec), true, i, titleOf(id)));
    writeFileSync(`${OUT}/${id}-still.svg`, svg(id, draw(id, spec), false, i, titleOf(id)));
    // Asleep: eyes closed and a quiet z z, with no blink or sway (the trade companion uses it when the feed is not live).
    writeFileSync(`${OUT}/${id}-asleep.svg`, svg(id, draw(id, spec, true), false, i, `${titleOf(id)} asleep`));
});

// The home page trio: forest headphones, ivory heart, green cloud with beret.
const trio = ['forest-headphones', 'ivory-heart', 'green-cloud-beret'].map((id, n) => `<g transform="translate(${n * 210} 0)">${draw(id, CAST[id])}</g>`).join('');
writeFileSync(`${OUT}/trio.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 200" width="620" height="200"><title>Three plush characters</title>${STYLE(2)}${trio}</svg>\n`);
console.log(`Wrote ${Object.keys(CAST).length * 3 + 1} SVGs to ${OUT}`);
