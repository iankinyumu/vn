import assert from 'node:assert/strict';
import test from 'node:test';
import { claimsFor, createTestDatabase } from './helpers/test-db.mjs';

const requiredItems = {
    seed_custody: true,
    funding_reconciliation: true,
    real_policy: true,
    step_up_authentication: true,
    conformance_parity: true,
    owner_signoff: true,
};
const evidence = Object.fromEntries(Object.keys(requiredItems).map((key, index) => [key, `PR-${index + 100}`]));

async function as(db, name) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor(name))]);
    await db.exec('set role authenticated');
}

test('the Real gate remains owner-only and validates immutable checklist evidence', async () => {
    const db = await createTestDatabase();
    try {
        await as(db, 'administrator');
        await assert.rejects(db.query("select public.enable_real_accounts('v1',$1,$2)", [JSON.stringify(evidence), 'Owner authorization and evidence are recorded']), /forbidden/);

        await db.exec('reset role');
        await db.query('insert into public.real_readiness_checklists(version,published_at,items,published_by) values($1,now(),$2,$3)', ['v1', JSON.stringify(requiredItems), claimsFor('ian').sub]);
        await assert.rejects(db.query("update public.real_readiness_checklists set items='{}'::jsonb where version='v1'"), /real_checklist_immutable/);

        await as(db, 'ian');
        await assert.rejects(db.query("select public.enable_real_accounts('wrong',$1,$2)", [JSON.stringify(evidence), 'Owner authorization and evidence are recorded']), /checklist_outdated/);
        await assert.rejects(db.query("select public.enable_real_accounts('v1',$1,$2)", [JSON.stringify({ ...evidence, owner_signoff: 'unverified' }), 'Owner authorization and evidence are recorded']), /evidence_incomplete/);
        await db.query("select public.enable_real_accounts('v1',$1,$2)", [JSON.stringify(evidence), 'Owner authorization and evidence are recorded']);

        await db.exec('reset role');
        const enabled = await db.query("select enabled from public.platform_modules where module_key='real_accounts'");
        assert.equal(enabled.rows[0].enabled, true);
        const audit = await db.query("select after_state from public.admin_audit_events where action='platform.enable_real'");
        assert.equal(audit.rows.length, 1);
        assert.equal(audit.rows[0].after_state.checklist_version, 'v1');
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});
