import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { randomUUID } = await import('node:' + 'cryp' + 'to');
import { createTestDatabase, identities, claimsFor } from './helpers/test-db.mjs';

const MIGRATION = 'supabase/migrations/20261003100000_notifications.sql';

test('notifications: customers read only their own inbox, staff sends are scoped and audited, announcements reach their audience', async (t) => {
    const db = await createTestDatabase();
    await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
    async function as(name, aal = 'aal2') {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor(name, aal))]);
        await db.exec('set role authenticated');
    }
    const inbox = () => scalar('select public.list_my_notifications() as result');
    const send = (user, { title = 'About your deposit', body = 'We have checked your payment.', link = null, ticket = null, reason = 'Customer follow-up', key = randomUUID() } = {}) =>
        scalar('select public.staff_send_notification($1,$2,$3,$4,$5,$6,$7) as result', [identities[user].id, title, body, link, ticket, reason, key]);
    const publish = ({ title = 'Maintenance tonight', body = 'Trading pauses from 02:00 to 02:15 EAT.', severity = 'info', audience = 'all', starts = null, ends = null, key = randomUUID() } = {}) =>
        scalar('select public.staff_publish_announcement($1,$2,$3,$4,$5,$6,$7,$8,$9) as result', [title, body, null, severity, audience, starts, ends, 'Planned maintenance', key]);
    const ticket = randomUUID();
    try {
        // customer holds a Real account as well as Practice; customer2 has Practice only.
        await db.exec('reset role');
        for (const name of ['customer', 'customer2']) await db.query('insert into public.profiles(id) values($1) on conflict do nothing', [identities[name].id]);
        await db.query("insert into public.trading_accounts(user_id, execution_mode) values($1,'DEMO'),($1,'REAL'),($2,'DEMO') on conflict do nothing", [identities.customer.id, identities.customer2.id]);

        await t.test('clients cannot write notifications or announcements directly', async () => {
            await as('customer');
            await assert.rejects(db.query("insert into public.notifications(user_id, category, title) values($1,'system','Fake')", [identities.customer.id]), /permission denied/);
            await assert.rejects(db.query("insert into public.announcements(id, title, body, created_by) values(gen_random_uuid(),'Fake','Fake',$1)", [identities.customer.id]), /permission denied/);
            await assert.rejects(db.query('update public.notifications set read_at = now()'), /permission denied/);
            await assert.rejects(send('customer2'), /forbidden/);
            await assert.rejects(publish(), /forbidden/);
        });

        await t.test('a support agent may only write about a ticket assigned to them', async () => {
            await as('customer', 'aal1');
            await scalar('select public.submit_support_ticket($1,$2,$3,$4,$5,$6,$7,true) as result', [ticket, 'Synthetic', 'Customer', 'contact@example.test', '', 'deposit', 'My synthetic deposit has not arrived yet.']);
            await as('agent');
            await assert.rejects(send('customer'), /forbidden/, 'an agent wrote without a ticket');
            await assert.rejects(send('customer', { ticket }), /forbidden/, 'an agent wrote about an unassigned ticket');
            await as('administrator');
            await scalar('select public.assign_support_ticket($1,$2,$3,$4) as result', [ticket, identities.agent.id, 1, randomUUID()]);
            await as('agent');
            await assert.rejects(send('customer2', { ticket }), /not_found/, 'a ticket was used to write to someone else');
            const key = randomUUID();
            const sent = await send('customer', { ticket, key });
            assert.equal(sent.duplicate, false);
            assert.deepEqual(await send('customer', { ticket, key }), { id: sent.id, duplicate: true }, 'a retried send delivered twice');
            await assert.rejects(send('customer', { ticket, link: 'https://evil.example/' }), /validation_failed/);
            await assert.rejects(send('customer', { ticket, title: '' }), /validation_failed/);
            await as('agent2');
            await assert.rejects(send('customer', { ticket }), /forbidden/);
        });

        await t.test('a staff reply on a ticket tells the customer; internal notes do not', async () => {
            await as('agent');
            const version = (await scalar('select public.get_support_ticket($1,true) as result', [ticket])).ticket.version;
            await scalar('select public.add_support_note($1,$2,$3,$4) as result', [ticket, 'Internal: check the M-Pesa receipt.', version, randomUUID()]);
            const next = (await scalar('select public.get_support_ticket($1,true) as result', [ticket])).ticket.version;
            await scalar('select public.send_support_reply($1,$2,$3,$4,true) as result', [ticket, 'Your deposit was credited this morning.', next, randomUUID()]);
            await as('customer');
            const { notifications, unread } = await inbox();
            assert.equal(notifications.length, 2);
            const reply = notifications.find((item) => item.title.startsWith('Support replied on SP-'));
            assert.ok(reply, 'the staff reply was not delivered');
            assert.equal(reply.body, 'Your deposit was credited this morning.');
            assert.equal(reply.link, 'support.html');
            assert.equal(reply.from_staff, true);
            assert.ok(!notifications.some((item) => item.body.includes('Internal')), 'an internal note reached the customer');
            assert.equal(unread, 2);
            await as('customer2');
            assert.equal((await inbox()).notifications.length, 0, 'another customer saw the inbox');
            assert.equal((await db.query('select count(*)::int n from public.notifications')).rows[0].n, 0, 'RLS let another customer read rows');
        });

        await t.test('announcements reach their audience, honour schedules and can be withdrawn', async () => {
            await as('administrator', 'aal1');
            await assert.rejects(publish(), /mfa_required|reauthentication_required/);
            await as('agent');
            await assert.rejects(publish(), /forbidden/, 'a support agent broadcast');
            await as('administrator');
            assert.equal(await scalar("select public.staff_announcement_audience_count('real') as result"), 1);
            const all = await publish();
            const real = await publish({ title: 'Real accounts: new limits', audience: 'real', severity: 'important' });
            await publish({ title: 'Later', starts: new Date(Date.now() + 3_600_000).toISOString() });
            const key = randomUUID();
            await publish({ key });
            assert.equal((await publish({ key })).duplicate, true, 'a retried publish created a second announcement');
            await assert.rejects(publish({ ends: new Date(Date.now() - 1000).toISOString() }), /validation_failed/);

            await as('customer2');
            let titles = (await inbox()).announcements.map((item) => item.title);
            assert.ok(titles.includes('Maintenance tonight') && !titles.includes('Real accounts: new limits') && !titles.includes('Later'), titles.join(', '));
            await as('customer');
            const before = await inbox();
            titles = before.announcements.map((item) => item.title);
            assert.ok(titles.includes('Real accounts: new limits') && !titles.includes('Later'));
            assert.equal(before.unread, 2 + before.announcements.length);
            assert.equal(await scalar('select public.mark_notifications_read(null,$1) as result', [[real.id]]), 1 + before.announcements.length);
            assert.equal(await scalar('select public.mark_notifications_read(null,null,true) as result'), 0);
            assert.ok((await inbox()).announcements.every((item) => item.read));

            await as('administrator');
            await scalar('select public.staff_withdraw_announcement($1,$2) as result', [all.id, 'Maintenance cancelled']);
            const listed = await scalar('select public.staff_list_announcements() as result');
            assert.equal(listed.find((item) => item.id === all.id).state, 'withdrawn');
            assert.equal(listed.find((item) => item.id === real.id).reads, 1);
            assert.equal(listed.find((item) => item.title === 'Later').state, 'scheduled');
            await as('customer');
            assert.ok(!(await inbox()).announcements.some((item) => item.id === all.id), 'a withdrawn announcement still showed');
        });

        await t.test('deposit outcomes and restriction changes reach the customer once, without the staff reason', async () => {
            // The shared test database stops before the funding migrations: a stand-in payments table
            // with the columns the producer reads is enough to attach and exercise its trigger.
            await db.exec('reset role');
            await db.exec(`create schema if not exists funding;
                create table funding.payments(id uuid primary key, user_id uuid not null, environment text not null, usd_amount numeric(18,2) not null, state text not null);`);
            await db.exec(fs.readFileSync('supabase/migrations/20261003110000_notification_producers.sql', 'utf8'));
            const payment = randomUUID();
            await db.query("insert into funding.payments values($1,$2,'SANDBOX',10,'PENDING')", [payment, identities.customer2.id]);
            await db.query("update funding.payments set state = 'VERIFYING' where id = $1", [payment]);
            await db.query("update funding.payments set state = 'CONFIRMED' where id = $1", [payment]);
            await db.query("update funding.payments set state = 'CONFIRMED' where id = $1", [payment]);

            await as('administrator');
            const applied = await scalar("select public.apply_account_restriction($1,'TRADING','REAL','LIMITED',$2,null,'Secret internal reason') as result", [identities.customer2.id, JSON.stringify({ max_stake: 5 })]);
            const restrictionId = applied?.id || applied;
            await scalar('select public.lift_account_restriction($1,$2) as result', [restrictionId, 'Reviewed and cleared']);

            await as('customer2');
            const { notifications } = await inbox();
            assert.deepEqual(notifications.map((item) => item.title).sort(), ['A limit on your account', 'A restriction was lifted', 'Deposit confirmed']);
            const deposit = notifications.find((item) => item.title === 'Deposit confirmed');
            assert.equal(deposit.body, '$10.00 was added to your Real sandbox test balance. Test funds cannot be withdrawn.');
            assert.equal(deposit.category, 'funding');
            const limit = notifications.find((item) => item.title === 'A limit on your account');
            assert.equal(limit.body, 'This applies to trading on Real accounts. Contact support if you have questions.');
            assert.ok(!JSON.stringify(notifications).includes('Secret internal reason'), 'the staff reason reached the customer');
        });

        await t.test('every staff send and broadcast is audited', async () => {
            await db.exec('reset role');
            const actions = (await db.query("select action, count(*)::int n from public.admin_audit_events where action like 'notification.%' or action like 'announcement.%' group by action order by action")).rows;
            assert.deepEqual(actions, [{ action: 'announcement.publish', n: 4 }, { action: 'announcement.withdraw', n: 1 }, { action: 'notification.send', n: 1 }]);
        });
    } finally { await db.close(); }
});
