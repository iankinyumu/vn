/* Deposit and withdraw sheet, opened from the top bar on every signed-in page
 * (docs/REAL_FUNDING_DESIGN.md §9). The only method is Lipa na M-Pesa.
 *
 * Deposits credit Real mode only; Practice stays strictly virtual. The server
 * decides everything that matters: whether this user may deposit
 * (funding_sandbox_overview), the locked KES amount, rate and expiry
 * (funding_create_deposit_quote), the push (Edge Function funding-deposit) and
 * the payment state (funding_my_payments). While Real mode is in Daraja sandbox
 * testing, a confirmed amount lands in the separate, non-spendable test balance.
 */
(function () {
    'use strict';

    const usd = (value) => Number(value).toFixed(2);
    const kes = (value) => `KES ${Number(value).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
    const mask = (msisdn) => `${msisdn.slice(0, 4)}*****${msisdn.slice(-3)}`;
    const PRESETS = Object.freeze([5, 10, 20, 50, 100, 200, 500]);
    const POLL_MS = 4000;
    const POLL_LIMIT_MS = 10 * 60 * 1000;

    const STATES = Object.freeze({
        INITIATING: ['Waiting for approval', 'pending'], PENDING: ['Waiting for approval', 'pending'], VERIFYING: ['Confirming', 'pending'], UNKNOWN: ['Confirming', 'pending'],
        CONFIRMED: ['Deposit confirmed', 'ok'], FAILED: ['Payment failed', 'bad'], REJECTED: ['Payment failed', 'bad'], EXPIRED: ['Prompt expired', 'review'],
        MANUAL_REVIEW: ['Under review', 'review'], REVERSED: ['Reversed', 'bad'],
    });
    const PENDING = new Set(['INITIATING', 'PENDING', 'VERIFYING', 'UNKNOWN']);
    const ERRORS = Object.freeze({
        amount_below_minimum: 'The amount is below the minimum deposit.',
        amount_above_maximum: 'The amount is above the maximum deposit.',
        amount_invalid: 'Enter an amount with at most two decimal places.',
        deposit_limit_reached: 'This deposit would exceed your limit for the last 24 hours.',
        rate_stale: 'Deposits are paused while the exchange rate updates.',
        rate_unavailable: 'Deposits are paused while the exchange rate updates.',
        sandbox_not_enabled: 'Deposits are not open on this account yet.',
        phone_invalid: 'Enter a Safaricom number such as 0712345678.',
        phone_not_allowed: 'This number cannot receive a prompt.',
        too_many_numbers: 'You can keep two numbers. Remove one first.',
    });
    const codeOf = (error) => { const message = String(error?.message || ''); return Object.keys(ERRORS).find((code) => message.includes(code)) || null; };

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const icon = (name) => { const node = el('i', 'ms'); node.dataset.icon = name; node.setAttribute('aria-hidden', 'true'); return node; };

    const TEMPLATE = `
        <div class="fund-sheet-head">
            <div class="fund-tabs" role="tablist" aria-label="Funding">
                <button type="button" role="tab" id="fundTabDeposit" aria-controls="fundPanelDeposit" data-fund-tab="deposit">Deposit</button>
                <button type="button" role="tab" id="fundTabWithdraw" aria-controls="fundPanelWithdraw" data-fund-tab="withdraw">Withdraw</button>
            </div>
            <button type="button" class="fund-close" data-fund-close aria-label="Close"><i class="ms" data-icon="close" aria-hidden="true"></i></button>
        </div>
        <section class="fund-panel" role="tabpanel" id="fundPanelDeposit" aria-labelledby="fundTabDeposit" data-fund-panel="deposit">
            <div class="fund-method">
                <span class="fund-method-name"><i class="ms" data-icon="smartphone" aria-hidden="true"></i>Lipa na M-Pesa</span>
                <span class="fund-env" data-fund-env hidden></span>
            </div>
            <div class="fund-loading" data-fund-loading></div>
            <p class="fund-empty" data-fund-unavailable hidden>Deposits are not open on this account yet.</p>
            <form class="fund-step" data-fund-step="form" novalidate hidden>
                <label class="fund-label" for="fundPhone">M-Pesa number</label>
                <div class="fund-phone-row">
                    <select id="fundPhone" class="fund-input" data-fund-phone required></select>
                    <button type="button" class="fund-link" data-fund-remove hidden>Remove</button>
                </div>
                <button type="button" class="fund-link" data-fund-add-toggle aria-expanded="false" aria-controls="fundAdd">Add my number</button>
                <div class="fund-add" id="fundAdd" data-fund-add hidden>
                    <div class="fund-add-row">
                        <input type="tel" class="fund-input" inputmode="numeric" autocomplete="tel" placeholder="07XX XXX XXX" aria-label="Safaricom number" data-fund-add-input>
                        <button type="button" class="fund-btn fund-btn-quiet" data-fund-add-save>Add</button>
                    </div>
                    <p class="fund-warning" role="note"><strong>Real money:</strong> a prompt to your own number runs on the live M-Pesa network. Approving it with your PIN charges your real M-Pesa balance, and SmartProfit cannot refund it.</p>
                </div>
                <label class="fund-label" for="fundAmount">Amount (USD)</label>
                <input type="text" id="fundAmount" class="fund-input fund-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" data-fund-amount required>
                <div class="fund-chips" data-fund-chips></div>
                <p class="fund-estimate" data-fund-estimate aria-live="polite"></p>
                <button type="submit" class="fund-btn fund-btn-primary" data-fund-continue>Continue</button>
            </form>
            <div class="fund-step" data-fund-step="review" hidden>
                <dl class="fund-summary">
                    <div><dt>Amount</dt><dd data-quote-usd></dd></div>
                    <div><dt>You pay</dt><dd data-quote-kes></dd></div>
                    <div><dt>Rate</dt><dd data-quote-rate></dd></div>
                    <div><dt>To</dt><dd data-quote-phone></dd></div>
                    <div><dt>Quote expires</dt><dd data-quote-expiry></dd></div>
                </dl>
                <p class="fund-warning" role="alert" data-fund-real-warning hidden></p>
                <div class="fund-actions">
                    <button type="button" class="fund-btn fund-btn-quiet" data-fund-back>Back</button>
                    <button type="button" class="fund-btn fund-btn-primary" data-fund-send>Send M-Pesa prompt</button>
                </div>
            </div>
            <div class="fund-step fund-result" data-fund-step="status" hidden>
                <span class="fund-result-icon" data-payment-icon aria-hidden="true"></span>
                <p class="fund-result-state" data-payment-state></p>
                <p class="fund-result-message" data-payment-message></p>
                <div class="fund-actions">
                    <button type="button" class="fund-btn fund-btn-quiet" data-fund-again>New deposit</button>
                    <button type="button" class="fund-btn fund-btn-primary" data-fund-done>Done</button>
                </div>
            </div>
            <p class="fund-status" role="status" aria-live="polite" data-fund-status></p>
        </section>
        <section class="fund-panel" role="tabpanel" id="fundPanelWithdraw" aria-labelledby="fundTabWithdraw" data-fund-panel="withdraw" hidden>
            <div class="fund-method">
                <span class="fund-method-name"><i class="ms" data-icon="smartphone" aria-hidden="true"></i>Lipa na M-Pesa</span>
            </div>
            <p class="fund-empty" data-fund-withdraw-closed>Withdrawals are not open yet.</p>
        </section>`;

    let dialog = null;
    let client = null;
    let overview = null;
    let quote = null;
    let expiryTimer = null;
    let pollTimer = null;
    let returnFocus = null;
    let loading = null;

    const q = (selector) => dialog.querySelector(selector);
    const setStatus = (message) => { q('[data-fund-status]').textContent = message || ''; };

    function showStep(name) {
        dialog.querySelectorAll('[data-fund-step]').forEach((step) => { step.hidden = step.dataset.fundStep !== name; });
    }

    function selectTab(tab) {
        dialog.querySelectorAll('[data-fund-tab]').forEach((button) => {
            const on = button.dataset.fundTab === tab;
            button.setAttribute('aria-selected', String(on));
            button.tabIndex = on ? 0 : -1;
        });
        dialog.querySelectorAll('[data-fund-panel]').forEach((panel) => { panel.hidden = panel.dataset.fundPanel !== tab; });
    }

    function build() {
        dialog = el('dialog', 'fund-sheet');
        dialog.dataset.fundSheet = '';
        dialog.setAttribute('aria-label', 'Deposit and withdraw');
        dialog.innerHTML = TEMPLATE;
        document.body.append(dialog);
        dialog.addEventListener('close', () => { clearInterval(expiryTimer); returnFocus?.focus?.(); });
        dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
        q('[data-fund-close]').addEventListener('click', close);
        dialog.querySelectorAll('[data-fund-tab]').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.fundTab)));
        q('[role="tablist"]').addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            const next = q('[aria-selected="false"][data-fund-tab]');
            selectTab(next.dataset.fundTab);
            next.focus();
        });
        q('[data-fund-step="form"]').addEventListener('submit', (event) => { event.preventDefault(); requestQuote().catch(fail('A quote could not be created. Please try again.')); });
        q('[data-fund-amount]').addEventListener('input', renderEstimate);
        q('[data-fund-phone]').addEventListener('change', renderPhoneActions);
        q('[data-fund-add-toggle]').addEventListener('click', () => toggleAdd());
        q('[data-fund-add-save]').addEventListener('click', () => addOwnPhone().catch(fail('The number could not be saved. Please try again.')));
        q('[data-fund-add-input]').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addOwnPhone().catch(fail('The number could not be saved. Please try again.')); } });
        q('[data-fund-remove]').addEventListener('click', () => setOwnPhone(q('[data-fund-phone]').value, false).catch(fail('The number could not be removed. Please try again.')));
        q('[data-fund-back]').addEventListener('click', () => { clearQuote(); showStep('form'); setStatus(''); q('[data-fund-amount]').focus(); });
        q('[data-fund-send]').addEventListener('click', () => sendPrompt().catch(fail('The M-Pesa prompt could not be sent. Please try again.')));
        q('[data-fund-again]').addEventListener('click', () => { clearTimeout(pollTimer); showStep('form'); setStatus(''); q('[data-fund-amount]').focus(); });
        q('[data-fund-done]').addEventListener('click', close);
    }

    const fail = (message) => (error) => { console.error('[smartprofit] funding', error); setStatus(message); };

    function close() {
        if (!dialog?.open) return;
        if (typeof dialog.close === 'function') dialog.close(); else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
    }

    function open(tab = 'deposit', trigger = null) {
        if (!dialog) build();
        returnFocus = trigger || document.activeElement;
        selectTab(tab === 'withdraw' ? 'withdraw' : 'deposit');
        if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
        q('[aria-selected="true"][data-fund-tab]').focus();
        if (!overview && !loading) load();
    }

    async function load() {
        const loadingHost = q('[data-fund-loading]');
        loadingHost.hidden = false;
        const loader = window.smartProfitLoader?.mount(loadingHost, { label: 'Loading', overlay: false });
        if (!loader) loadingHost.textContent = 'Loading…';
        q('[data-fund-unavailable]').hidden = true;
        showStep(null);
        loading = (async () => {
            if (!client) client = await window.getSupabaseClient();
            const { data, error } = await client.rpc('funding_sandbox_overview');
            if (error) throw error;
            return data;
        })();
        try {
            overview = await loading;
        } catch (error) {
            overview = null;
            console.error('[smartprofit] funding overview', error);
        } finally {
            loading = null;
        }
        loader?.remove();
        loadingHost.replaceChildren();
        loadingHost.hidden = true;
        if (!overview?.available) {
            q('[data-fund-unavailable]').hidden = false;
            overview = null;
            return;
        }
        const env = q('[data-fund-env]');
        env.hidden = overview.environment !== 'SANDBOX';
        env.textContent = 'Real · sandbox test funds';
        renderPhones();
        renderChips();
        renderEstimate();
        showStep('form');
    }

    function renderPhones() {
        const phone = q('[data-fund-phone]');
        const selected = phone.value;
        const own = overview.my_msisdns || [];
        phone.replaceChildren(
            ...own.map((msisdn) => new Option(`${mask(msisdn)} · your number`, msisdn)),
            ...(overview.test_msisdns || []).map((msisdn) => new Option(`${mask(msisdn)} · sandbox test number`, msisdn)));
        if ([...phone.options].some((option) => option.value === selected)) phone.value = selected;
        renderPhoneActions();
    }

    function isOwn(msisdn) { return (overview?.my_msisdns || []).includes(msisdn); }

    function renderPhoneActions() {
        q('[data-fund-remove]').hidden = !isOwn(q('[data-fund-phone]').value);
    }

    function toggleAdd(force) {
        const panel = q('[data-fund-add]');
        const show = force ?? panel.hidden;
        panel.hidden = !show;
        q('[data-fund-add-toggle]').setAttribute('aria-expanded', String(show));
        if (show) q('[data-fund-add-input]').focus();
    }

    function renderChips() {
        const min = Number(overview.min_usd), max = Number(overview.max_usd_per_deposit);
        const amount = q('[data-fund-amount]');
        q('[data-fund-chips]').replaceChildren(...PRESETS.filter((value) => value >= min && value <= max).map((value) => {
            const chip = el('button', 'fund-chip', `$${value}`);
            chip.type = 'button';
            chip.addEventListener('click', () => { amount.value = String(value); renderEstimate(); amount.focus(); });
            return chip;
        }));
    }

    const validAmount = (text) => /^\d+(\.\d{1,2})?$/.test(text) && Number(text) >= Number(overview.min_usd) && Number(text) <= Number(overview.max_usd_per_deposit);

    function renderEstimate() {
        if (!overview) return;
        const text = q('[data-fund-amount]').value.trim();
        const estimate = q('[data-fund-estimate]');
        const rate = Number(overview.kes_per_usd);
        const limits = `USD ${usd(overview.min_usd)}–${usd(overview.max_usd_per_deposit)}`;
        if (overview.rate_stale || !rate) { estimate.textContent = ERRORS.rate_stale; q('[data-fund-continue]').disabled = true; return; }
        q('[data-fund-continue]').disabled = false;
        dialog.querySelectorAll('.fund-chip').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.textContent === `$${Number(text)}` && text !== '')));
        // An estimate only: the quote locks the exact shilling amount.
        estimate.textContent = validAmount(text) ? `≈ ${kes(Math.ceil(Number(text) * rate - 1e-9))} · ${limits}` : limits;
    }

    async function setOwnPhone(msisdn, enabled) {
        const { data, error } = await client.rpc('funding_set_my_sandbox_msisdn', { p_msisdn: msisdn, p_enabled: enabled });
        if (error) { setStatus(ERRORS[codeOf(error)] || 'The number could not be saved. Please try again.'); return false; }
        const { data: fresh, error: overviewError } = await client.rpc('funding_sandbox_overview');
        if (overviewError) throw overviewError;
        overview = fresh;
        renderPhones();
        if (enabled && data?.msisdn) { q('[data-fund-phone]').value = data.msisdn; renderPhoneActions(); }
        setStatus(enabled ? 'Number added.' : 'Number removed.');
        return true;
    }

    async function addOwnPhone() {
        const input = q('[data-fund-add-input]');
        if (await setOwnPhone(input.value.replace(/[\s+-]/g, ''), true)) { input.value = ''; toggleAdd(false); }
    }

    function clearQuote() {
        quote = null;
        clearInterval(expiryTimer);
    }

    async function requestQuote() {
        const amount = q('[data-fund-amount]').value.trim();
        clearQuote();
        if (!validAmount(amount)) { setStatus(`Enter an amount from USD ${usd(overview.min_usd)} to USD ${usd(overview.max_usd_per_deposit)}.`); q('[data-fund-amount]').focus(); return; }
        if (!q('[data-fund-phone]').value) { setStatus('Choose an M-Pesa number.'); return; }
        const button = q('[data-fund-continue]');
        button.disabled = true;
        setStatus('');
        const { data, error } = await client.rpc('funding_create_deposit_quote', { p_usd_amount: Number(amount) }).finally(() => { button.disabled = false; });
        if (error) { setStatus(ERRORS[codeOf(error)] || 'A quote could not be created. Please try again.'); return; }
        // One idempotency key per quote: a repeated click for the same quote never pushes twice.
        showQuote({ ...data, idempotencyKey: `sandbox-${data.quote_id}` });
    }

    function showQuote(next) {
        quote = next;
        const phone = q('[data-fund-phone]').value;
        q('[data-quote-usd]').textContent = `USD ${usd(next.usd_amount)}`;
        q('[data-quote-kes]').textContent = kes(next.kes_due);
        q('[data-quote-rate]').textContent = `KES ${Number(next.kes_per_usd).toFixed(2)} / USD`;
        q('[data-quote-phone]').textContent = mask(phone);
        // A prompt to the customer's own number runs on the live M-Pesa network: say so with the exact amount before it can be sent.
        const warning = q('[data-fund-real-warning]');
        warning.hidden = !isOwn(phone);
        warning.textContent = warning.hidden ? '' : `Real money: approving this prompt charges ${kes(next.kes_due)} from the real M-Pesa balance of ${mask(phone)}. It goes to Safaricom's sandbox paybill 174379 and cannot be refunded by SmartProfit.`;
        const send = q('[data-fund-send]');
        send.disabled = false;
        const tick = () => {
            const left = Math.max(0, Math.floor((new Date(next.expires_at).getTime() - Date.now()) / 1000));
            q('[data-quote-expiry]').textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Expired';
            if (left <= 0) { send.disabled = true; clearInterval(expiryTimer); setStatus('The quote expired. Go back for a new one.'); }
        };
        clearInterval(expiryTimer);
        tick();
        expiryTimer = setInterval(tick, 1000);
        showStep('review');
        send.focus();
    }

    async function sendPrompt() {
        if (!quote) return;
        const send = q('[data-fund-send]');
        send.disabled = true;
        setStatus('Sending the prompt…');
        const config = window.SMARTPROFIT_SUPABASE_CONFIG;
        const { data: { session } } = await client.auth.getSession();
        let body = null;
        let ok = false;
        try {
            const response = await fetch(`${config.url}/functions/v1/funding-deposit`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${session?.access_token || ''}`, apikey: config.publishableKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ quote_id: quote.quote_id, phone: q('[data-fund-phone]').value, idempotency_key: quote.idempotencyKey }),
            });
            ok = response.ok;
            body = await response.json().catch(() => null);
        } catch (_) {
            body = null;
        }
        if (!ok) {
            const reference = body?.request_id ? ` Reference ${body.request_id}.` : '';
            setStatus(`${body?.error?.message || 'The M-Pesa prompt could not be sent. Please try again.'}${reference}`);
            send.disabled = false;
            return;
        }
        clearQuote();
        setStatus('');
        showPayment(body);
        poll(body.payment_id, Date.now());
    }

    function showPayment(payment) {
        const [label, tone] = STATES[payment.state] || [payment.state, 'pending'];
        const result = q('[data-fund-step="status"]');
        result.dataset.tone = tone;
        q('[data-payment-state]').textContent = label;
        q('[data-payment-message]').textContent = payment.status_message || '';
        q('[data-payment-icon]').replaceChildren(icon(tone === 'ok' ? 'check_circle' : tone === 'bad' ? 'cancel' : tone === 'review' ? 'error' : 'smartphone'));
        q('[data-fund-again]').hidden = PENDING.has(payment.state);
        showStep('status');
        document.dispatchEvent(new CustomEvent('smartprofit:deposit-updated', { detail: { state: payment.state } }));
        if (!PENDING.has(payment.state)) document.dispatchEvent(new Event('smartprofit:balance-changed'));
    }

    function poll(paymentId, startedAt) {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(async () => {
            try {
                const { data, error } = await client.rpc('funding_my_payments');
                if (error) throw error;
                const payment = (data || []).find((item) => item.payment_id === paymentId);
                if (payment) showPayment(payment);
                if ((!payment || PENDING.has(payment.state)) && Date.now() - startedAt < POLL_LIMIT_MS) poll(paymentId, startedAt);
            } catch (error) {
                console.error('[smartprofit] funding poll', error);
                if (Date.now() - startedAt < POLL_LIMIT_MS) poll(paymentId, startedAt);
            }
        }, POLL_MS);
    }

    // Any [data-funding-open] control (the top bar buttons, a page's own button) opens the sheet on its tab.
    document.addEventListener('click', (event) => { const trigger = event.target.closest?.('[data-funding-open]'); if (trigger) open(trigger.dataset.fundingOpen, trigger); });
    document.addEventListener('smartprofit:open-funding', (event) => open(event.detail?.tab, event.detail?.trigger));
    window.smartProfitFunding = Object.freeze({ open, close });
})();
