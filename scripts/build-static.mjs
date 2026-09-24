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
cpSync(resolve(root, 'assets'), resolve(output, 'assets'), { recursive: true });

if (!existsSync(resolve(output, 'index.html')) || !existsSync(resolve(output, 'assets/js/supabase-config.js'))) {
    throw new Error('The static site is missing its home page or browser configuration.');
}

console.log(`Built ${readdirSync(resolve(root, 'pages')).filter((name) => name.endsWith('.html')).length} pages with shared assets in dist/.`);
