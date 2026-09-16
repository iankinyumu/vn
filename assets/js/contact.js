/* Support requests are persisted only through the authenticated database RPC. */
document.addEventListener('DOMContentLoaded', async () => {
    const el = (id) => document.getElementById(id);
    const form = el('contactForm'), fields = el('contactFields'), submit = el('contactSubmit');
    const refresh = el('refreshRequests'), history = el('requestHistory');
    let client, user, pending = false, requestId = null, authVersion = 0;
    const topics = { general: 'General inquiry', account: 'Account help', deposit: 'Deposit help', withdrawal: 'Withdrawal help', trading: 'Trading support', security: 'Security concern', bug: 'Bug report', partnership: 'Business inquiry', other: 'Other' };
    const states = { open: 'Received', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
    function status(message, kind = 'danger') {
        const box = el('contactStatus');
        box.hidden = false;
        box.className = `alert alert-${kind}`;
        box.textContent = message;
        box.focus();
    }
    async function loadHistory() {
        if (!user) return;
        const version = authVersion;
        refresh.disabled = true;
        history.textContent = 'Loading requests...';
        try {
            const { data, error } = await client.from('support_requests')
                .select('ticket_number,subject,status,created_at').eq('user_id', user.id)
                .order('created_at', { ascending: false }).limit(20);
            if (error) throw error;
            if (version !== authVersion) return;
            history.replaceChildren();
            if (!data.length) history.textContent = 'You have not submitted any requests yet.';
            for (const request of data) {
                const item = document.createElement('article');
                item.className = 'support-request';
                const heading = document.createElement('h3');
                heading.className = 'h6';
                heading.textContent = `SP-${request.ticket_number} · ${topics[request.subject] || 'Support request'}`;
                const detail = document.createElement('p');
                detail.textContent = `${states[request.status] || 'Received'} · ${new Date(request.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
                item.append(heading, detail);
                history.append(item);
            }
        } catch (_) {
            if (version !== authVersion) return;
            history.textContent = 'Unable to load requests. Try refreshing. This does not affect requests already saved.';
        } finally { if (version === authVersion) refresh.disabled = !user; }
    }
    // Preserve the idempotency key for retries after uncertain network results.
    form.addEventListener('input', () => { requestId = null; });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (pending || !user) return;
        for (const id of ['firstName', 'lastName', 'email', 'phone', 'message']) el(id).value = el(id).value.trim();
        if (!form.reportValidity()) return;
        const phone = el('phone').value;
        if (phone && !/^\+?[0-9 ()\-.]{7,32}$/.test(phone)) {
            status('Enter a valid phone number or leave the phone field empty.');
            el('phone').focus();
            return;
        }
        pending = true;
        const version = authVersion;
        fields.disabled = true;
        submit.textContent = 'Saving request...';
        try {
            requestId ||= crypto.randomUUID();
            const { data, error } = await client.rpc('submit_support_ticket', {
                p_id: requestId, p_first_name: el('firstName').value,
                p_last_name: el('lastName').value, p_email: el('email').value,
                p_phone: phone, p_subject: el('subject').value,
                p_message: el('message').value, p_consent: el('consent').checked
            });
            if (version !== authVersion) return;
            if (error) throw error;
            if (data?.id !== requestId || !/^SP-\d+$/.test(data.reference)) throw new Error('Missing confirmation');
            status(`Request ${data.reference} received.`, 'success');
            form.reset();
            el('email').value = user.email || '';
            requestId = null;
            await loadHistory();
        } catch (error) {
            if (version !== authVersion) return;
            status(error.message?.includes('support_rate_limit')
                ? 'You have submitted 5 requests in the last hour. Please wait before sending another.'
                : 'We could not confirm your request. Your message is still here. Retry without editing to avoid a duplicate, or refresh your request history.');
        } finally {
            pending = false;
            fields.disabled = !user;
            submit.textContent = 'Send request';
        }
    });
    refresh.addEventListener('click', loadHistory);
    function updateSession(nextUser) {
        const changed = user?.id !== nextUser?.id;
        user = nextUser;
        if (changed) {
            authVersion++;
            requestId = null;
            form.reset();
            el('contactStatus').hidden = true;
            el('email').value = user?.email || '';
        }
        el('contactLogin').hidden = !!user;
        el('contactLogout').hidden = !user;
        el('guestAccountHelp').hidden = !!user;
        el('signedInAccountHelp').hidden = !user;
        el('accountAccessStatus').textContent = user ? `Signed in as ${user.email}. You can send and track requests.` : 'You are not signed in.';
        el('contactSession').textContent = user ? 'You are signed in. How can we help?' : 'Sign in to send a support request.';
        fields.disabled = !user || pending;
        refresh.disabled = !user;
        if (!user) history.textContent = 'Your requests will appear here after you sign in.';
        else if (changed) void loadHistory();
    }
    try {
        client = await window.getSupabaseClient();
        // Defer database calls outside the Auth callback to avoid holding its lock.
        client.auth.onAuthStateChange((_event, session) => {
            setTimeout(() => updateSession(session?.user || null), 0);
        });
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        updateSession(data.session?.user || null);
    } catch (_) {
        el('contactSession').textContent = 'Support is unavailable because your session could not be checked. Reload to try again.';
        el('accountAccessStatus').textContent = 'Unable to check your sign-in status. Please reload.';
        history.textContent = 'Unable to load your requests until your session is checked.';
    }
});
