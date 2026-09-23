import fs from 'node:fs/promises';
import path from 'node:path';

const migrationDir = path.resolve('supabase/migrations');
const files = (await fs.readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
const engineFiles = files.filter((file) => /_engine_.*\.sql$/i.test(file));
const allow = new Set(['public.engine_buy_contract', 'public.engine_quote_contract', 'public.engine_tick_exposure', 'public.enroll_practice_account', 'public.reset_practice_balance', 'public.enable_real_accounts']);
const createFunction = /create\s+or\s+replace\s+function\s+([\w.]+)\s*\([^)]*\)[\s\S]*?language\s+plpgsql[\s\S]*?as\s+\$\$([\s\S]*?)\$\$/gi;
let failed = false;

for (const file of files) {
    const source = await fs.readFile(path.join(migrationDir, file), 'utf8');
    if (!/_engine_.*\.sql$/i.test(file) && /create\s+(?:or\s+replace\s+)?(?:table|function|schema)\s+(?:public\.engine_|engine_private\b)|engine_private\./i.test(source)) {
        console.error(`${file}: engine object must be defined in a *_engine_*.sql migration`);
        failed = true;
    }
}

for (const file of engineFiles) {
    const source = await fs.readFile(path.join(migrationDir, file), 'utf8');
    let match;
    let found = 0;
    while ((match = createFunction.exec(source))) {
        found++;
        const [, name, body] = match;
        if (!/^public\.engine_|^public\.(enroll_practice_account|reset_practice_balance|enable_real_accounts)$/.test(name) || allow.has(name)) continue;
        const conditional = /(?:^|\n)\s*if\s+[^;\r\n]*\bexecution_mode\b|(?:^|\n)\s*case\s+[^;\r\n]*\bexecution_mode\b/i.exec(body);
        if (conditional) {
            const line = body.slice(0, conditional.index).split(/\r?\n/).length;
            console.error(`${file}:${line}: undeclared execution_mode branch in ${name}`);
            failed = true;
        }
    }
    if (/create\s+or\s+replace\s+function[\s\S]*?language\s+plpgsql/i.test(source) && found === 0) {
        console.error(`${file}: unable to reliably extract PL/pgSQL function body`);
        failed = true;
    }
}
if (failed) process.exit(1);
