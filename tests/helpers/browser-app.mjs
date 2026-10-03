// Shared harness for real-browser checks of the signed-in pages in Microsoft Edge.
// It builds dist/, serves it on 127.0.0.1, replaces the supabase-js CDN bundle
// with tests/browser/fake-supabase.js and stubs third-party CDNs, so nothing
// reaches a real backend. Set BROWSER_EVIDENCE=1 to write screenshots to
// docs/browser-checks/.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

export const ROOT = resolve(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'dist');
export const EVIDENCE = process.env.BROWSER_EVIDENCE === '1' ? join(ROOT, 'docs', 'browser-checks') : null;
export const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

export async function startApp() {
    execFileSync(process.execPath, ['scripts/build-static.mjs'], { cwd: ROOT });
    const server = createServer((req, res) => {
        const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
        const file = join(DIST, path || 'index.html');
        if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const browser = await chromium.launch({ executablePath: EDGE, headless: true });
    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        browser,
        async close() { await browser.close(); server.close(); },
    };
}

// Opens a page with the fake backend. `fake` is source text evaluated before any page script: it must set window.__FAKE__.
export async function openApp(app, path, { fake, viewport = { width: 1366, height: 860 }, routes = [] } = {}) {
    const context = await app.browser.newContext({ viewport, reducedMotion: 'reduce' });
    const errors = [];
    await context.addInitScript(() => { window.SMARTPROFIT_TEST_CDN = true; });
    // A returning visitor who allowed preference storage, so the cookie banner stays out of the way.
    await context.addInitScript(() => { try { if (!localStorage.getItem('smartprofit:consent')) localStorage.setItem('smartprofit:consent', JSON.stringify({ v: 1, preferences: true, at: '2026-10-03T00:00:00.000Z' })); } catch (_) { /* opaque origin */ } });
    await context.route('**/@supabase/supabase-js@*/dist/umd/supabase.js', (route) => route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(ROOT, 'tests/browser/fake-supabase.js'), 'utf8') }));
    await context.route(/^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.fulfill({ status: 200, body: '' }));
    for (const [pattern, handler] of routes) await context.route(pattern, handler);
    await context.addInitScript({ content: fake });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    // The CDN is stubbed with empty bodies, so Subresource Integrity rightly blocks them; that is the only error ignored.
    const stubbedCdn = (text) => text.includes("Failed to find a valid digest in the 'integrity' attribute for resource 'https://cdnjs.cloudflare.com/");
    page.on('console', (message) => { if (message.type() === 'error' && !stubbedCdn(message.text())) errors.push(`console: ${message.text()}`); });
    await page.goto(`${app.base}/${path}`);
    return { page, context, errors };
}

export const shot = async (page, name) => { if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `${name}.png`) }); };
