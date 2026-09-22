import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const migrationDir = path.resolve('supabase/migrations');

async function expectParityFailure(name, source, expected) {
    const filename = path.join(migrationDir, name);
    await writeFile(filename, source, 'utf8');
    try {
        await assert.rejects(execFileAsync(process.execPath, ['scripts/check-parity.mjs']), (error) => {
            assert.match(`${error.stdout}\n${error.stderr}`, expected);
            return true;
        });
    } finally {
        await rm(filename, { force: true });
    }
}

test('parity checker rejects an undeclared execution_mode branch in an engine migration', async () => {
    await expectParityFailure('99999999999999_engine_parity_probe.sql', `
create or replace function public.engine_parity_probe() returns void language plpgsql as $$
begin
  if execution_mode = 'DEMO' then null; end if;
end;
$$;`, /undeclared execution_mode branch in public\.engine_parity_probe/);
});

test('parity checker rejects engine objects outside engine-named migrations', async () => {
    await expectParityFailure('99999999999998_parity_probe.sql', 'create table public.engine_naming_probe(id integer);', /engine object must be defined in a \*_engine_\*\.sql migration/);
});
