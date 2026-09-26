/* Daraja sandbox deposit page (docs/REAL_FUNDING_DESIGN.md §9).
 *
 * Test funds only. The server decides everything that matters: whether this
 * user is an allowlisted tester (funding_sandbox_overview), the locked KES
 * amount, rate, rounding and expiry (funding_create_deposit_quote), the push
 * (Edge Function funding-deposit) and the payment state (funding_my_payments).
 * A confirmed amount lands only in the separate, non-spendable sandbox test
 * balance, which this page never presents as a trading balance.
 */
(function () {
    const find = (selector) => document.querySelector(selector);
    const text = (selector, value) => { const node = find(selector); if (node) node.textContent = value; };
    const usd = (value) => Number(value).toFixed(2);
    const kes = (value) => `KES ${Number(value).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
    const mask = (msisdn) => `${msisdn.slice(0, 4)}*****${msisdn.slice(-3)}`;

    const STATES = Object.freeze({
        INITIATING: ['Pending', 'pending'], PENDING: ['Pending', 'pending'], VERIFYING: ['Pending', 'pending'], UNKNOWN: ['Pending', 'pending'],
        CONFIRMED: ['Confirmed', 'ok'], FAILED: ['Failed', 'bad'], REJECTED: ['Failed', 'bad'], EXPIRED: ['Expired', 'review'],
        MANUAL_REVIEW: ['Manual review', 'review'], REVERSED: ['Reversed', 'bad'],
    });
    const PENDING = new Set(['INITIATING', 'PENDING', 'VERIFYING', 'UNKNOWN']);
    const ERRORS = Object.freeze({
        amount_below_minimum: 'The minimum sandbox deposit is USD 5.00.',
        amount_above_maximum: 'The maximum sandbox deposit is USD 500.00.',
        amount_invalid: 'Enter an amount with at most two decimal places.',
        deposit_limit_reached: 'This deposit would exceed the sandbox limit for the last 24 hours.',
        rate_stale: 'The reference rate is out of date, so quotes are paused.',
        rate_unavailable: 'The reference rate is unavailable, so quotes are paused.',
        sandbox_not_enabled: 'Sandbox deposits are not available on this account.',
    });

    let client = null;
    let overview = null;
    let quote = null;
    let expiryTimer = null;
    let pollTimer = null;

    function codeOf(error) {
        const message = String(error?.message || '');
        return Object.keys(ERRORS).find((code) => message.includes(code)) || null;
    }

    function stateBadge(state) {
        const [label, tone] = STATES[state] || [state, 'pending'];
        const badge = document.createElement('span');
        badge.className = 'sandbox-state';
        badge.dataset.tone = tone;
        badge.textContent = label;
        return badge;
    }

    function renderHistory(payments) {
        const body = find('[data-sandbox-history]');
        if (!payments.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 5;
            cell.textContent = 'No sandbox deposits yet.';
            row.append(cell);
            body.replaceChildren(row);
            return;
        }
        body.replaceChildren(...payments.map((payment) => {
            const row = document.createElement('tr');
            const cells = [new Date(payment.created_at).toLocaleString(), usd(payment.usd_amount), kes(payment.kes_due), null,
                payment.receipt_verified ? payment.mpesa_receipt : 'Not yet verified'];
            cells.forEach((value) => {
                const cell = document.createElement('td');
                if (value === null) cell.append(stateBadge(payment.state)); else cell.textContent = value;
                row.append(cell);
            });
            return row;
        }));
    }

    async function refresh() {
        const [{ data: fresh, error: overviewError }, { data: payments, error: paymentsError }] = await Promise.all([
            client.rpc('funding_sandbox_overview'), client.rpc('funding_my_payments'),
        ]);
        if (overviewError) throw overviewError;
        if (paymentsError) throw paymentsError;
        overview = fresh;
        if (overview.available) {
            text('[data-sandbox-balance]', usd(overview.test_balance_usd));
            renderHistory(payments || []);
        }
        return payments || [];
    }

    function showPayment(payment) {
        find('[data-sandbox-payment]').hidden = false;
        const [label, tone] = STATES[payment.state] || [payment.state, 'pending'];
        const badge = find('[data-payment-state]');
        badge.dataset.tone = tone;
        badge.textContent = label;
        text('[data-payment-message]', payment.status_message || '');
    }

    function clearQuote() {
        quote = null;
        clearInterval(expiryTimer);
        find('[data-sandbox-quote]').hidden = true;
    }

    function showQuote(q) {
        quote = q;
        find('[data-sandbox-quote]').hidden = false;
        text('[data-quote-usd]', `USD ${usd(q.usd_amount)}`);
        text('[data-quote-kes]', kes(q.kes_due));
        text('[data-quote-rate]', `KES ${Number(q.kes_per_usd).toFixed(2)} per USD (${q.rate_source || 'CBK'}, ${q.rate_date})`);
        text('[data-quote-rounding]', kes(q.kes_rounding));
        const send = find('[data-sandbox-send]');
        send.disabled = false;
        const tick = () => {
            const left = Math.max(0, Math.floor((new Date(q.expires_at).getTime() - Date.now()) / 1000));
            text('[data-quote-expiry]', left > 0 ? `in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'expired: request a new quote');
            if (left <= 0) { send.disabled = true; clearInterval(expiryTimer); }
        };
        clearInterval(expiryTimer);
        tick();
        expiryTimer = setInterval(tick, 1000);
    }

    async function requestQuote(event) {
        event.preventDefault();
        const amount = find('[data-sandbox-amount]').value.trim();
        const status = find('[data-sandbox-status]');
        clearQuote();
        if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) < 5 || Number(amount) > 500) {
            status.textContent = 'Enter an amount from USD 5.00 to USD 500.00 with at most two decimal places.';
            return;
        }
        status.textContent = 'Requesting a quote…';
        const { data, error } = await client.rpc('funding_create_deposit_quote', { p_usd_amount: Number(amount) });
        if (error) { status.textContent = ERRORS[codeOf(error)] || 'A quote could not be created. Please try again.'; return; }
        status.textContent = 'Review the quote, then send the sandbox prompt.';
        // One idempotency key per quote: a repeated click for the same quote never pushes twice.
        showQuote({ ...data, idempotencyKey: `sandbox-${data.quote_id}` });
    }

    async function sendPrompt() {
        if (!quote) return;
        const status = find('[data-sandbox-status]');
        const send = find('[data-sandbox-send]');
        send.disabled = true;
        status.textContent = 'Sending the sandbox M-Pesa prompt…';
        const config = window.SMARTPROFIT_SUPABASE_CONFIG;
        const { data: { session } } = await client.auth.getSession();
        let body = null;
        let ok = false;
        try {
            const response = await fetch(`${config.url}/functions/v1/funding-deposit`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${session?.access_token || ''}`, apikey: config.publishableKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ quote_id: quote.quote_id, phone: find('[data-sandbox-phone]').value, idempotency_key: quote.idempotencyKey }),
            });
            ok = response.ok;
            body = await response.json().catch(() => null);
        } catch (_) {
            body = null;
        }
        if (!ok) {
            const reference = body?.request_id ? ` (reference ${body.request_id})` : '';
            status.textContent = `${body?.error?.message || 'The sandbox prompt could not be sent. Please try again.'}${reference}`;
            send.disabled = false;
            return;
        }
        clearQuote();
        status.textContent = 'Sandbox prompt sent.';
        showPayment(body);
        poll(body.payment_id, Date.now());
    }

    function poll(paymentId, startedAt) {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(async () => {
            try {
                const payments = await refresh();
                const payment = payments.find((item) => item.payment_id === paymentId);
                if (payment) showPayment(payment);
                if (payment && PENDING.has(payment.state) && Date.now() - startedAt < 10 * 60 * 1000) poll(paymentId, startedAt);
            } catch (error) {
                console.error(error);
                poll(paymentId, startedAt);
            }
        }, 4000);
    }

    async function start() {
        if (typeof window.getSupabaseClient !== 'function') return;
        client = await window.getSupabaseClient();
        await refresh();
        const status = find('[data-sandbox-status]');
        if (!overview?.available) {
            find('[data-sandbox-unavailable]').hidden = false;
            status.textContent = '';
            return;
        }
        find('[data-sandbox-available]').hidden = false;
        status.textContent = overview.rate_stale ? ERRORS.rate_stale : '';
        text('[data-sandbox-limits]', `From USD ${usd(overview.min_usd)} to USD ${usd(overview.max_usd_per_deposit)} per deposit; at most USD ${usd(overview.max_usd_rolling_24h)} and ${overview.max_deposits_rolling_24h} deposits in 24 hours.`);
        const phone = find('[data-sandbox-phone]');
        phone.replaceChildren(...(overview.test_msisdns || []).map((msisdn) => Object.assign(document.createElement('option'), { value: msisdn, textContent: `${mask(msisdn)} (sandbox test number)` })));
        find('[data-sandbox-quote-form]').addEventListener('submit', (event) => requestQuote(event).catch((error) => { console.error(error); status.textContent = 'A quote could not be created. Please try again.'; }));
        find('[data-sandbox-send]').addEventListener('click', () => sendPrompt().catch((error) => { console.error(error); status.textContent = 'The sandbox prompt could not be sent. Please try again.'; }));
    }

    window.addEventListener('DOMContentLoaded', () => start().catch((error) => {
        console.error(error);
        text('[data-sandbox-status]', 'Sandbox deposits are temporarily unavailable.');
    }));
})();
