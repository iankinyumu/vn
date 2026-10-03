import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
if (dirname(output) !== root || (existsSync(output) && lstatSync(output).isSymbolicLink())) {
    throw new Error('The static output directory is outside the repository or is a symbolic link.');
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output);
cpSync(resolve(root, 'pages'), output, { recursive: true });
// Only what the site serves: no source art, working files, notes or stray test pages. The mascot
// PNGs at the top of assets/img are originals (pages use the WebP copies); vendor licences stay.
const assetsRoot = resolve(root, 'assets');
const notServed = (source) => {
    const path = source.slice(assetsRoot.length).replace(/\\/g, '/');
    if (/^\/layered-asset(\/|$)/.test(path)) return true;
    if (/^\/img\/[^/]+\.png$/i.test(path)) return true;
    if (/\.(ora|psd|kra|xcf|ai|sketch|fig|map|bak|tmp|log)$/i.test(path)) return true;
    if (/\.(md|txt)$/i.test(path) && !/^\/vendor\//.test(path)) return true;
    return /(^|\/)\./.test(path);
};
cpSync(assetsRoot, resolve(output, 'assets'), { recursive: true, filter: (source) => !notServed(source) });
// The fairness page imports the same standalone verifier the CLI uses; test fixtures stay out.
cpSync(resolve(root, 'verifier/v3'), resolve(output, 'verifier/v3'), { recursive: true, filter: (source) => !/[\\/]fixtures([\\/]|$)/.test(source) });

if (!existsSync(resolve(output, 'index.html')) || !existsSync(resolve(output, 'assets/js/supabase-config.js'))) {
    throw new Error('The static site is missing its home page or browser configuration.');
}

console.log(`Built ${readdirSync(resolve(root, 'pages')).filter((name) => name.endsWith('.html')).length} pages with shared assets in dist/.`);
