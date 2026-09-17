import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSandboxDatabase, identities, claimsFor } from '../sandbox/database.mjs';

test('complete support workflow runs on synthetic PostgreSQL records with scoped permissions', async t => {
    const db = await createSandboxDatabase();
    const ticket = randomUUID();
    const secondTicket = randomUUID();
    let version = 1;
    const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
    async function as(name, aal = 'aal2') {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor(name, aal))]);
        await db.exec('set role authenticated');
    }
    const detail = (staff = true, id = ticket) => scalar('select public.get_support_ticket($1,$2) as result', [id,staff]);
    const inbox = (staff = true) => scalar('select public.list_support_tickets($1) as result',[staff]);
    const reply = (body, staff = true, status = null, key = randomUUID(), expected = version) => scalar('select public.send_support_reply($1,$2,$3,$4,$5,$6) as result',[ticket,body,expected,key,staff,status]);
    const assign = (name, expected = version) => scalar('select public.assign_support_ticket($1,$2,$3,$4) as result',[ticket,identities[name]?.id || null,expected,randomUUID()]);
    const transition = (status, body = '', reason = 'Synthetic handling reason') => scalar('select public.change_support_status($1,$2,$3,$4,$5,$6) as result',[ticket,status,body,reason,version,randomUUID()]);
    try {
        await t.test('legacy creation preserves reference and projects the original message exactly once', async () => {
            await as('customer','aal1');
            const created = await scalar('select public.submit_support_ticket($1,$2,$3,$4,$5,$6,$7,true) as result',
                [ticket,'Synthetic','Customer','contact@example.test','','account','This is a synthetic customer inquiry.']);
            assert.equal(created.reference,'SP-1001');
            const row = await detail(false);
            assert.equal(row.messages.length,1);
            assert.equal(row.messages[0].sequence,0);
            assert.equal(row.ticket.reference,created.reference);
            assert.equal(row.ticket.unread,true);
            assert.equal(row.contact,undefined);
            assert.equal(row.ticket.assignee_id,undefined);
            await as('customer2');
            await scalar('select public.submit_support_ticket($1,$2,$3,$4,$5,$6,$7,true) as result',
                [secondTicket,'Other','Customer','other@example.test','','general','Another synthetic inquiry for isolation tests.']);
            await assert.rejects(detail(false),/not_found/);
            assert.equal((await inbox(false)).items.length,1);
        });
        await t.test('MFA, shared intake, assignment and cross-agent access are enforced', async () => {
            await as('administrator','aal1'); await assert.rejects(inbox(),/mfa_required/);
            await as('agent'); assert.equal((await inbox()).items.length,0);
            await assert.rejects(detail(),/not_found/);
            await assert.rejects(assign('agent'),/not_found|forbidden/);
            await as('administrator'); assert.equal((await inbox()).items.length,2);
            version=(await assign('agent')).version;
            await as('agent'); assert.equal((await inbox()).items.length,1);
            assert.equal((await detail()).contact.email,'contact@example.test');
            await assert.rejects(assign('agent2'),/forbidden/);
            await as('agent2'); await assert.rejects(detail(),/not_found/);
        });
        await t.test('public reply plus waiting status is atomic and retries deduplicate', async () => {
            await as('agent');
            const key=randomUUID(), old=version;
            const result=await reply('Please describe the issue.','true' === 'true','waiting_for_customer',key);
            version=result.version;
            assert.deepEqual(await reply('Please describe the issue.',true,'waiting_for_customer',key,old),result);
            await assert.rejects(reply('Changed retry.',true,'waiting_for_customer',key,old),/conflict/);
            assert.equal((await detail()).messages.length,2);
            await assert.rejects(reply('Stale update',true,null,randomUUID(),old),/conflict/);
        });
        await t.test('notes and escalation are private, including direct table queries', async () => {
            version=(await scalar('select public.add_support_note($1,$2,$3,$4,true) as result',[ticket,'PRIVATE NOTE: escalation evidence',version,randomUUID()])).version;
            assert.equal((await detail()).ticket.escalated,true);
            const activity=await scalar('select public.list_support_activity($1) as result',[ticket]);
            assert.match(JSON.stringify(activity),/PRIVATE NOTE/);
            await as('customer');
            assert.doesNotMatch(JSON.stringify(await detail(false)),/PRIVATE NOTE|escalation evidence|assignee_id/);
            await assert.rejects(db.query('select * from public.support_internal_notes'),/permission denied/);
            await assert.rejects(db.query('select assignee_id from public.support_requests'),/permission denied/);
            await assert.rejects(db.query('select * from public.list_support_activity($1)',[ticket]),/forbidden/);
            assert.equal((await db.query('select message from public.support_requests')).rows.length,1);
        });
        await t.test('customer replies advance waiting state and read markers are per viewer', async () => {
            const loaded=await detail(false);
            await db.query('select public.mark_support_read($1,$2,false)',[ticket,loaded.ticket.public_sequence]);
            assert.equal((await detail(false)).ticket.unread,false);
            version=(await reply('Here are the requested details.',false)).version;
            assert.equal((await detail(false)).ticket.status,'in_progress');
            assert.equal((await detail(false)).ticket.unread,true);
            await assert.rejects(db.query('select public.mark_support_read($1,999,false)',[ticket]),/validation_failed/);
            await as('agent'); assert.equal((await detail()).ticket.unread,true);
        });
        await t.test('resolution requires a public explanation; customer reopening and closure follow the lifecycle', async () => {
            await assert.rejects(transition('resolved'),/validation_failed/);
            version=(await transition('resolved','Your issue is resolved.')).version;
            await as('customer'); await assert.rejects(reply('Reply without explicit reopening',false),/invalid_transition/);
            version=(await reply('The issue has returned.',false,'in_progress')).version;
            await as('agent'); version=(await transition('resolved','We have addressed the follow-up.')).version;
            await assert.rejects(transition('closed'),/forbidden/);
            await as('administrator'); version=(await transition('closed')).version;
            await as('customer'); await assert.rejects(reply('Attempt a closed reply',false),/invalid_transition/);
            await as('agent'); await assert.rejects(transition('in_progress'),/forbidden/);
            await as('administrator'); version=(await transition('in_progress')).version;
        });
        await t.test('reassignment and role revocation remove access and unassign work with history', async () => {
            version=(await assign('agent2')).version;
            await as('agent'); await assert.rejects(detail(),/not_found/);
            await as('agent2'); assert.equal((await detail()).ticket.assignee_id,identities.agent2.id);
            await as('owner');
            await db.query('select public.change_staff_role($1,$2,false,1,$3,$4)',[identities.agent2.id,'support_agent','Synthetic staff revocation',randomUUID()]);
            const state=await detail(); version=state.ticket.version; assert.equal(state.ticket.assignee_id,null);
            assert.match(JSON.stringify(await scalar('select public.list_support_activity($1) as result',[ticket])),/Staff eligibility changed/);
            await as('agent2'); await assert.rejects(detail(),/forbidden/);
        });
        await t.test('failed audit insert rolls back message, ticket version and retry receipt', async () => {
            await db.exec(`reset role; create function admin_private.fail_support_audit() returns trigger language plpgsql as $$ begin raise exception 'synthetic_audit_failure'; end $$;
                create trigger fail_support_audit before insert on public.admin_audit_events for each row execute function admin_private.fail_support_audit();`);
            await as('owner'); const before=await detail(), key=randomUUID();
            await assert.rejects(reply('Must roll back',true,null,key),/synthetic_audit_failure/);
            const after=await detail(); assert.equal(after.ticket.version,before.ticket.version); assert.equal(after.messages.length,before.messages.length);
            await db.exec('reset role; drop trigger fail_support_audit on public.admin_audit_events');
            assert.equal((await db.query('select * from admin_private.support_receipts where request_id=$1',[key])).rows.length,0);
        });
        await t.test('inbox filters stay scoped and all direct mutations are denied', async () => {
            await as('customer2');
            const result=await scalar("select public.list_support_tickets(false,null,null,'SP-1001') as result"); assert.equal(result.items.length,0);
            await as('owner');
            for(const table of ['support_messages','support_internal_notes','support_events','support_read_markers','support_requests']) {
                await assert.rejects(db.query(`delete from public.${table}`),/permission denied/);
            }
            const summary=await scalar('select public.get_support_summary() as result');
            assert.equal(summary.timezone,'UTC'); assert.ok(summary.received>=1);
        });
    } finally { await db.close(); }
});
