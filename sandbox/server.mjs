import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSandboxDatabase, identities, claimsFor } from './database.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rpc = {
    get_staff_context: [],
    list_admin_audit: ['p_before_time', 'p_before_id'],
    change_staff_role: ['p_user_id', 'p_role', 'p_active', 'p_expected_version', 'p_reason', 'p_request_id'],
    list_support_tickets: ['p_staff','p_status','p_subject','p_reference','p_assignee','p_unassigned','p_before_time','p_before_id'],
    get_support_ticket: ['p_ticket_id','p_staff','p_before_sequence'],
    list_support_activity: ['p_ticket_id','p_before_time','p_before_id'],
    get_support_summary: [], list_support_assignees: [],
    submit_support_ticket: ['p_id','p_first_name','p_last_name','p_email','p_phone','p_subject','p_message','p_consent'],
    send_support_reply: ['p_ticket_id','p_body','p_expected_version','p_request_id','p_staff','p_status'],
    add_support_note: ['p_ticket_id','p_body','p_expected_version','p_request_id','p_escalate'],
    assign_support_ticket: ['p_ticket_id','p_assignee','p_expected_version','p_request_id','p_reason'],
    change_support_status: ['p_ticket_id','p_status','p_body','p_reason','p_expected_version','p_request_id'],
    mark_support_read: ['p_ticket_id','p_sequence','p_staff']
    mark_support_read: ['p_ticket_id','p_sequence','p_staff'],
    apply_account_restriction: ['p_user_id', 'p_restriction_type', 'p_reason'],
    lift_account_restriction: ['p_restriction_id', 'p_reason'],
    list_admin_customers: ['p_search', 'p_limit'],
    get_admin_customer_detail: ['p_user_id'],
    list_admin_demo_orders: ['p_user_id', 'p_symbol', 'p_state', 'p_limit'],
    get_admin_demo_order_detail: ['p_order_id'],
    list_admin_market_health: [],
    set_symbol_trading_status: ['p_symbol', 'p_trading_status', 'p_reason'],
    list_staff_members: [],
    get_platform_overview: []
};
export async function startSandbox({ port = 4173 } = {}) {
    const db = await createSandboxDatabase();
    const sessions = new Map();
    let queue = Promise.resolve();
    // A single embedded connection MUST serialize whole transactions, not individual SQL calls.
    function transaction(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'");
        const base = `http://127.0.0.1:${server.address().port}`;
        const send = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (req.headers.host !== new URL(base).host) { send({ error: { message: 'invalid_host' } }, 403); return; }
        try {
            const url = new URL(req.url, base);
            if (url.pathname.startsWith('/sandbox-api/')) {
                if (req.method !== 'POST' || req.headers.origin !== base || req.headers['content-type'] !== 'application/json') {
                    send({ error: { message: 'forbidden_origin' } }, 403); return;
                }
                let body = '';
                for await (const chunk of req) { body += chunk; if (body.length > 16000) throw new Error('validation_failed'); }
                const input = JSON.parse(body || '{}');
                const token = /(?:^|; )sandbox_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
                let session = sessions.get(token);
                const sessionView = () => session ? { user: identities[session.identity] } : null;
                const operation = url.pathname.slice('/sandbox-api/'.length);
                if (operation === 'signin') {
                    if (!Object.hasOwn(identities, input.identity)) throw new Error('validation_failed');
                    const id = randomUUID();
                    if (token) sessions.delete(token);
                    session = { identity: input.identity, aal: 'aal1', enrolled: true };
                    sessions.set(id, session);
                    res.setHeader('Set-Cookie', `sandbox_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
                    send({ data: { session: sessionView() } }); return;
                }
                if (operation === 'session') { send({ data: { session: sessionView() } }); return; }
                if (operation === 'signout') { sessions.delete(token); res.setHeader('Set-Cookie', 'sandbox_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/'); send({}); return; }
                if (!session) throw new Error('unauthenticated');
                if (operation === 'factors') { send({ data: { totp: [{ id: 'sandbox-factor', friendly_name: 'Sandbox authenticator' }] } }); return; }
                if (operation === 'enroll') { send({ data: { id: 'sandbox-factor', totp: { secret: 'SANDBOX-NOT-A-REAL-SECRET' } } }); return; }
                if (operation === 'verify') {
                    if (input.code !== '123456' || input.factorId !== 'sandbox-factor') throw new Error('validation_failed');
                    session.aal = 'aal2'; session.verifiedAt = Math.floor(Date.now() / 1000); send({ data: {} }); return;
                }
                if (operation !== 'rpc' || !Object.hasOwn(rpc, input.name)) throw new Error('not_found');
                const parameters = rpc[input.name].filter(key => Object.hasOwn(input.payload || {},key));
                const args = parameters.map(key => input.payload[key]);
                const data = await transaction(async () => {
                    await db.exec('begin');
                    try {
                        const claims = claimsFor(session.identity, session.aal);
                        if (session.verifiedAt) claims.amr = [{ method: 'totp', timestamp: session.verifiedAt }];
                        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
                        await db.exec('set local role authenticated');
                        const placeholders = parameters.map((name, i) => `${name} => $${i + 1}`).join(',');
                        const rows = (await db.query(`select * from public.${input.name}(${placeholders})`, args)).rows;
                        await db.exec('commit');
                        return input.name === 'list_admin_audit' ? rows : rows[0]?.[input.name];
                    } catch (error) { await db.exec('rollback'); throw error; }
                });
                send({ data }); return;
            }
            if (req.method !== 'GET') { send({ error: { message: 'not_found' } }, 404); return; }
            let pathname = url.pathname;
            if (pathname === '/' || pathname === '/sandbox/') pathname = '/sandbox/index.html';
            if (pathname === '/assets/js/auth.js') pathname = '/sandbox/auth.js';
            // No generic repository file serving, env files, production config, symlinks or remote requests.
            const allowed = /^\/(?:pages\/(?:admin|support)\.html|assets\/(?:js\/(?:admin|support-workspace|customer-support|support-ui)\.js|css\/(?:admin|support)\.css)|sandbox\/(?:index\.html|index\.js|auth\.js))$/;
            const allowed = /^\/(?:pages\/(?:admin|support)\.html|assets\/(?:js\/(?:admin|admin-operations|support-workspace|customer-support|support-ui)\.js|css\/(?:admin|support)\.css)|sandbox\/(?:index\.html|index\.js|auth\.js))$/;
            if (!allowed.test(pathname)) { send({ error: { message: 'not_found' } }, 404); return; }
            const filename = path.join(root, pathname);
            const stat = await fs.lstat(filename);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not_found');
            const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
            res.writeHead(200, { 'Content-Type': types[path.extname(filename)] }); res.end(await fs.readFile(filename));
        } catch (error) {
            const safe = /^(unauthenticated|forbidden|mfa_required|reauthentication_required|validation_failed|invalid_transition|conflict|rate_limited|support_rate_limit|not_found|self_role_change_forbidden|last_owner_required|verified_identity_required)$/.test(error.message);
            send({ error: { message: safe ? error.message : 'temporarily_unavailable' } }, 400);
        }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await queue; await db.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const sandbox = await startSandbox();
    console.log(`Synthetic-data sandbox: ${sandbox.url}/sandbox/ (no live connections)`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await sandbox.close(); process.exit(0); });
}
