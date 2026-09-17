import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { seedAccess, claimsFor, identities } from '../../sandbox/database.mjs';

test('two independent PostgreSQL sessions cannot remove the last ownership path', { timeout: 120000 }, async () => {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const sandboxRoot = path.resolve('.sandbox');
    await fs.mkdir(sandboxRoot, { recursive: true });
    const databaseDir = await fs.mkdtemp(path.join(sandboxRoot, 'postgres-'));
    const cluster = new EmbeddedPostgres({ databaseDir, port, user: 'postgres', password: randomUUID(), persistent: true,
        postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
    const connections = [];
    let started = false;
    try {
        await cluster.initialise(); await cluster.start(); started = true;
        async function connect() { const client = cluster.getPgClient(); await client.connect(); connections.push(client); return client; }
        const operator = await connect();
        await seedAccess({ exec: sql => operator.query(sql), query: (sql, args) => operator.query(sql, args) });
        const a = await connect(), b = await connect();
        async function begin(client, name, isolation = 'read committed') {
            await client.query(`begin isolation level ${isolation}`);
            await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claimsFor(name))]);
            await client.query('set local role authenticated');
        }
        async function demote(client, target, version) {
            return client.query('select public.change_staff_role($1,$2,true,$3,$4,$5)', [identities[target].id, 'administrator', version, 'Synthetic concurrency test', randomUUID()]);
        }
        async function waitForLock(client) {
            for (let attempt = 0; attempt < 100; attempt++) {
                const result = await operator.query("select wait_event_type from pg_stat_activity where pid=$1", [client.processID]);
                if (result.rows[0]?.wait_event_type === 'Lock') return;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Second session did not wait on the owner lock');
        }
        // A rollback lets B proceed, but never produces zero owners.
        await begin(a, 'owner'); await demote(a, 'owner2', 1);
        await begin(b, 'owner2');
        const rollbackRace = demote(b, 'owner', 1).then(value => ({ value }), error => ({ error }));
        await waitForLock(b); await a.query('rollback');
        assert.ok((await rollbackRace).value); await b.query('rollback');

        // A stale repeatable-read snapshot must fail, even if it saw two owners earlier.
        await begin(a, 'owner'); await demote(a, 'owner2', 1);
        await begin(b, 'owner2', 'repeatable read');
        const snapshotRace = demote(b, 'owner', 1).then(value => ({ value }), error => ({ error }));
        await waitForLock(b); await a.query('commit');
        assert.equal((await snapshotRace).error?.code, '40001'); await b.query('rollback');

        // Restore B through the normal owner workflow for the read-committed scenario.
        await begin(a, 'owner');
        await a.query('select public.change_staff_role($1,$2,true,2,$3,$4)', [identities.owner2.id, 'owner', 'Restore synthetic owner', randomUUID()]);
        await a.query('commit');
        await begin(a, 'owner'); await demote(a, 'owner2', 3);
        await begin(b, 'owner2');
        const committedRace = demote(b, 'owner', 1).then(value => ({ value }), error => ({ error }));
        await waitForLock(b); await a.query('commit');
        assert.match((await committedRace).error?.message || '', /forbidden/); await b.query('rollback');
        assert.equal((await operator.query("select count(*)::int as count from public.staff_roles where active and role='owner'")).rows[0].count, 1);
        console.log('Verified actual lock waiting, rollback, post-commit authorization, and repeatable-read serialization.');

        for(const name of ['20260916120000_support_requests.sql','20260916130000_friendly_ticket_references.sql','20260917110000_support_workflow.sql']){
            await operator.query((await fs.readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
        }
        const ticket=randomUUID();
        await begin(b,'customer');
        await b.query("select public.submit_support_ticket($1,'Test','Customer','test@example.test','','account','Synthetic concurrency inquiry',true)",[ticket]);await b.query('commit');
        await begin(a,'owner');await a.query('select public.assign_support_ticket($1,$2,1,$3)',[ticket,identities.agent.id,randomUUID()]);await a.query('commit');
        // A reply already holding the access gate finishes before revocation can commit.
        await begin(b,'agent');await b.query("select public.send_support_reply($1,'Reply before revocation',2,$2,true)",[ticket,randomUUID()]);
        await begin(a,'owner');
        const revoke=a.query("select public.change_staff_role($1,'support_agent',false,1,'Sandbox revocation race',$2)",[identities.agent.id,randomUUID()]).then(value=>({value}),error=>({error}));
        await waitForLock(a);await b.query('commit');assert.ok((await revoke).value);await a.query('commit');
        const state=(await operator.query('select assignee_id,public_sequence,version from public.support_requests where id=$1',[ticket])).rows[0];
        assert.equal(state.assignee_id,null);assert.equal(Number(state.public_sequence),1);
        await begin(b,'agent');await assert.rejects(b.query('select public.get_support_ticket($1,true)',[ticket]),/forbidden/);await b.query('rollback');
        // Reassignment wins the ticket lock; the former agent's waiting reply must then fail.
        await begin(a,'owner');await a.query("select public.change_staff_role($1,'support_agent',true,2,'Restore sandbox agent',$2)",[identities.agent.id,randomUUID()]);
        await a.query('select public.assign_support_ticket($1,$2,$3,$4)',[ticket,identities.agent.id,state.version,randomUUID()]);await a.query('commit');
        const version=Number(state.version)+1;
        await begin(a,'owner');await a.query('select public.assign_support_ticket($1,$2,$3,$4)',[ticket,identities.agent2.id,version,randomUUID()]);
        await begin(b,'agent');const denied=b.query("select public.send_support_reply($1,'Stale agent reply',$2,$3,true)",[ticket,version,randomUUID()]).then(value=>({value}),error=>({error}));
        await waitForLock(b);await a.query('commit');assert.match((await denied).error?.message||'',/not_found/);await b.query('rollback');
        console.log('Verified reply/revocation and reassignment/reply races with independent PostgreSQL sessions.');
    } finally {
        await Promise.allSettled(connections.map(client => client.end()));
        if (started) await cluster.stop();
        // Keep the synthetic cluster in ignored .sandbox for diagnosis; no recursive deletion.
    }
});
