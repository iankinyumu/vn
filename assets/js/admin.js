/* The access context controls presentation only. Every RPC checks current authority. */
document.addEventListener('DOMContentLoaded', async () => {
    const el = (id) => document.getElementById(id);
    let client, session, context, timer, subscription;
    let generation = 0;
    let factorId = null;
    let mfaBusy = false;
    let auditBusy = false;
    let cursor = null;
    const roles = { support_agent: 'Support agent', administrator: 'Administrator', owner: 'Owner' };

    function clear() {
        window.supportWorkspace?.clear();
        window.adminOperations?.clear();
        generation++;
        clearTimeout(timer);
        context = null;
        factorId = null;
        mfaBusy = false;
        auditBusy = false;
        cursor = null;
        for (const id of ['adminWorkspace', 'adminMfa', 'adminSignIn', 'auditOpen', 'auditPanel', 'auditMore', 'mfaSetup', 'mfaEnroll']) el(id).hidden = true;
        for (const id of ['adminIdentity', 'mfaStatus', 'auditStatus']) el(id).textContent = '';
        el('auditEvents').replaceChildren();
        el('mfaFactor').replaceChildren();
        el('mfaSecret').value = '';
        el('mfaQrCode').src = '';
        el('mfaCode').value = '';
        el('mfaVerify').disabled = true;
        for (const id of ['auditOpen', 'auditMore', 'mfaEnroll']) el(id).disabled = false;
        el('adminSignOut').disabled = false;
    }

    function fail(error) {
        const message = error?.message || '';
        clear();
        if (message === 'forbidden') {
            // Signed in, but this account holds no staff role: offer the staff
            // sign-in link and a way out of the non-staff session.
            el('adminStatus').textContent = 'This account does not have staff access.';
            el('adminSignIn').hidden = Boolean(session);
            el('adminSignOut').hidden = !session;
        } else if (message === 'unauthenticated' || error?.code === 'PGRST301') {
            el('adminStatus').textContent = 'Your staff session has expired. Sign in to continue.';
            el('adminSignIn').hidden = false;
        } else if (message === 'auth_unavailable') {
            el('adminStatus').textContent = 'Staff sign-in is unavailable. Reload the page to try again.';
            el('adminSignIn').hidden = false;
        } else {
            el('adminStatus').textContent = 'We could not verify access. Please try again.';
        }
        el('adminRetry').hidden = false;
    }

    async function prepareMfa(epoch) {
        const { data, error } = await client.auth.mfa.listFactors();
        if (epoch !== generation) return;
        if (error) throw error;
        for (const factor of data.totp || []) {
            const option = document.createElement('option');
            option.value = factor.id;
            option.textContent = factor.friendly_name || 'Authenticator';
            el('mfaFactor').append(option);
        }
        factorId = data.totp?.[0]?.id || null;
        el('mfaFactor').hidden = !factorId;
        el('mfaEnroll').hidden = Boolean(factorId);
        el('mfaVerify').disabled = !factorId;
        el('adminMfa').hidden = false;
    }

    async function refresh() {
        clear();
        const epoch = generation;
        el('adminRetry').hidden = true;
        el('adminStatus').textContent = 'Checking your access…';
        try {
            if (!client) {
                // The staff console never uses the customer client. Its session
                // lives under a separate storage key, so a customer sign-in cannot
                // reach this page and a staff sign-out cannot end a customer session.
                if (typeof window.getStaffSupabaseClient !== 'function') throw new Error('auth_unavailable');
                client = await window.getStaffSupabaseClient();
                if (epoch !== generation) return;
                subscription = client.auth.onAuthStateChange((_event, next) => {
                    session = next;
                    clear(); // Immediately discard all old-identity data and pending responses.
                    el('adminSignOut').hidden = !next;
                    el('adminStatus').textContent = next ? 'Checking your access…' : 'Sign in with your staff account to continue.';
                    el('adminSignIn').hidden = Boolean(next);
                    // Do not call Supabase from inside its auth callback lock.
                    timer = setTimeout(refresh, 0);
                }).data?.subscription;
            }
            const { data, error } = await client.auth.getSession();
            if (epoch !== generation) return;
            if (error) throw error;
            session = data.session;
            el('adminSignOut').hidden = !session;
            if (!session) {
                el('adminStatus').textContent = 'Sign in with your staff account to continue.';
                el('adminSignIn').hidden = false;
                return;
            }
            const result = await client.rpc('get_staff_context');
            if (epoch !== generation) return;
            if (result.error) throw result.error;
            if (!result.data || result.data.user_id !== session.user.id || !roles[result.data.role]) throw new Error('invalid_context');
            context = result.data;
            el('adminIdentity').textContent = `${session.user.email || 'Signed-in staff member'} · ${roles[context.role]}`;
            if (context.required_step === 'mfa') {
                el('adminStatus').textContent = 'Complete verification to enter the staff workspace.';
                await prepareMfa(epoch);
                return;
            }
            if (context.required_step || !context.capabilities?.includes('staff.enter')) throw new Error('forbidden');
            el('adminStatus').textContent = 'Your staff access is verified.';
            el('adminWorkspace').hidden = false;
            window.supportWorkspace?.open(client, context);
            window.adminOperations?.init(client, context);
            el('auditOpen').hidden = !context.capabilities.includes('audit.read');
            el('adminRetry').hidden = false;
            // Read-only access recheck; no automatic mutation retries.
            timer = setTimeout(recheck, 60000);
        } catch (error) { if (epoch === generation) fail(error); }
    }

    async function recheck() {
        const epoch = generation;
        try {
            const result = await client.rpc('get_staff_context');
            if (epoch !== generation) return;
            if (result.error) throw result.error;
            if (JSON.stringify(result.data) !== JSON.stringify(context)) { await refresh(); return; }
            timer = setTimeout(recheck, 60000);
        } catch (error) { if (epoch === generation) fail(error); }
    }
    window.addEventListener('staff-access-lost', () => fail({ message: 'forbidden' }));

    el('adminRetry').addEventListener('click', refresh);
    el('mfaFactor').addEventListener('change', () => { factorId = el('mfaFactor').value; });
    el('adminSignOut').addEventListener('click', async () => {
        clear();
        const epoch = generation;
        el('adminSignOut').disabled = true;
        el('adminStatus').textContent = 'Signing out…';
        try {
            const { error } = await client.auth.signOut();
            if (epoch !== generation) return;
            if (error) throw error;
            await refresh();
        } catch (_) {
            if (epoch === generation) el('adminStatus').textContent = 'Sign-out could not be confirmed. Please try again.';
        } finally { if (epoch === generation) el('adminSignOut').disabled = false; }
    });

    el('mfaEnroll').addEventListener('click', async () => {
        if (mfaBusy || !context || context.required_step !== 'mfa') return;
        mfaBusy = true;
        const epoch = generation;
        el('mfaEnroll').disabled = true;
        try {
            const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Staff authenticator ${new Date().toISOString()}` });
            if (epoch !== generation) return;
            if (error) throw error;
            factorId = data.id;
            // Supabase returns a base64 SVG in data.totp.qr_code — use it directly as img src
            el('mfaQrCode').src = data.totp.qr_code;
            el('mfaSecret').value = data.totp.secret;
            el('mfaSetup').hidden = false;
            el('mfaEnroll').hidden = true;
            el('mfaVerify').disabled = false;
            el('mfaStatus').textContent = 'Enter a code from your authenticator to finish setup.';
        } catch (_) {
            if (epoch === generation) el('mfaStatus').textContent = 'Authenticator setup could not be completed. Please try again.';
        } finally { if (epoch === generation) { mfaBusy = false; el('mfaEnroll').disabled = false; } }
    });

    el('mfaForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (mfaBusy || !factorId || !/^[0-9]{6}$/.test(el('mfaCode').value)) return;
        const epoch = generation;
        mfaBusy = true;
        el('mfaVerify').disabled = true;
        try {
            const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code: el('mfaCode').value });
            if (epoch !== generation) return;
            if (error) throw error;
            await refresh();
        } catch (_) {
            if (epoch === generation) el('mfaStatus').textContent = 'Verification failed. Enter a current code and try again.';
        } finally { if (epoch === generation) { mfaBusy = false; el('mfaVerify').disabled = false; } }
    });

    async function loadAudit(more = false) {
        if (auditBusy || !context?.capabilities.includes('audit.read')) return;
        const epoch = generation;
        auditBusy = true;
        el('auditOpen').disabled = true;
        el('auditMore').disabled = true;
        el('auditPanel').hidden = false;
        el('auditStatus').textContent = 'Loading audit events…';
        try {
            const { data, error } = await client.rpc('list_admin_audit', more && cursor ? { p_before_time: cursor.created_at, p_before_id: cursor.id } : {});
            if (epoch !== generation) return;
            if (error) throw error;
            if (!Array.isArray(data)) throw new Error('invalid_response');
            if (!more) el('auditEvents').replaceChildren();
            for (const row of data) {
                const item = document.createElement('li');
                const title = document.createElement('strong');
                title.textContent = `${row.action === 'staff.bootstrap' ? 'Initial owner established' : row.action === 'staff.role_change' ? 'Staff access changed' : 'Administrative action'} · ${new Date(row.created_at).toLocaleString()}`;
                const reason = document.createElement('p');
                reason.textContent = row.reason;
                const details = document.createElement('p');
                details.textContent = `Actor: ${row.actor_type === 'operator' ? 'Server operator' : row.actor_id}. Staff account: ${row.target_id}. Event: ${row.id}.`;
                item.append(title, reason, details);
                el('auditEvents').append(item);
            }
            cursor = data[data.length - 1] || cursor;
            el('auditMore').hidden = data.length < 50;
            el('auditStatus').textContent = data.length ? 'Audit events loaded.' : more ? 'No older events.' : 'No audit events yet.';
        } catch (error) {
            if (epoch !== generation) return;
            if (['forbidden', 'unauthenticated', 'mfa_required'].includes(error?.message)) { fail(error); return; }
            el('auditStatus').textContent = 'Audit events could not be loaded. Use View administrative audit to retry.';
        } finally {
            if (epoch === generation) { auditBusy = false; el('auditOpen').disabled = false; el('auditMore').disabled = false; }
        }
    }
    el('auditOpen').addEventListener('click', () => loadAudit());
    el('auditMore').addEventListener('click', () => loadAudit(true));
    window.addEventListener('pagehide', () => { clear(); subscription?.unsubscribe(); });
    window.addEventListener('pageshow', (event) => { if (event.persisted) { client = null; refresh(); } });
    await refresh();
});
