// Renders every mapped icon in Microsoft Edge from the live Google Fonts request. A real icon is one
// square glyph; a name Google does not know falls back to its letters and comes out wide.
//   node scripts/check-icons.mjs
import { chromium } from 'playwright-core';
import { EDGE } from '../tests/helpers/browser-app.mjs';
import { ICON_FONT_URL, ICON_NAMES } from './icon-map.mjs';

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
try {
    const page = await browser.newPage();
    await page.setContent(`<link rel="stylesheet" href="${ICON_FONT_URL}"><style>i{font:24px 'Material Symbols Outlined';font-style:normal;display:inline-block;white-space:nowrap;font-feature-settings:'liga'}i::before{content:attr(data-icon)}</style>
        ${ICON_NAMES.map((name) => `<i data-icon="${name}"></i>`).join('')}`);
    await page.evaluate(() => document.fonts.ready);
    const widths = await page.evaluate(() => [...document.querySelectorAll('i')].map((node) => [node.dataset.icon, node.getBoundingClientRect().width]));
    const bad = widths.filter(([, width]) => width > 30);
    console.log(`${widths.length} icons checked; ${bad.length} not served:`, bad.map(([name]) => name).join(', ') || 'none');
    if (bad.length) process.exitCode = 1;
} finally { await browser.close(); }
