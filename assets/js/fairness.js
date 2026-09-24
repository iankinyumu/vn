(function () {
    const encoder = new TextEncoder();
    // get_ticks_since returns at most PAGE_SIZE rows per call; get_epoch_proofs at most 500 epochs.
    const PAGE_SIZE = 500;
    const MAX_RANGE = 5000;
    const DEFAULT_RANGE = 20;
    const failures = Object.freeze({ account_not_available: 'This account cannot verify fairness right now.', access_restricted: 'Access to this account is restricted.', index_not_available: 'This index is unavailable.' });
    const bytes = (hex) => Uint8Array.from(hex.match(/../g) || [], (item) => parseInt(item, 16));
    const hex = (buffer) => Array.from(new Uint8Array(buffer), (item) => item.toString(16).padStart(2, '0')).join('');
    const errorCode = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];
    async function digest(value) { return hex(await window.crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value)); }
    async function signer(seed) {
        const key = await window.crypto.subtle.importKey('raw', bytes(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return async (mode, index, tick) => { for (let counter = 0; ; counter++) { const block = new Uint8Array(await window.crypto.subtle.sign('HMAC', key, encoder.encode(`digit|${mode}|${index}|${tick}|${counter}`))); for (const value of block) if (value < 250) return value % 10; } };
    }
    async function digit(seed, mode, index, tick) { return (await signer(seed))(mode, index, tick); }

    /* Verifies ticks from..to of one index. Each tick belongs to the epoch whose
       [starts_at, ends_at) contains its scheduled_at, and is checked against that
       epoch's own revealed seed, matched by tick_no. Ticks of an unrevealed epoch
       are pending, never mismatches. Every revealed epoch's seed is checked
       against its published commitment. */
    async function verify({ proofs, ticks, mode, index, from, to }) {
        const byTick = new Map();
        for (const tick of ticks) { const number = Number(tick.tick_no); if (number >= from && number <= to) byTick.set(number, tick); }
        const epochs = proofs.map((proof) => ({ proof, starts: Date.parse(proof.starts_at), ends: Date.parse(proof.ends_at), ticks: [] }));
        const result = { from, to, verified: 0, mismatches: 0, mismatchedTicks: [], pending: 0, missing: 0, unassigned: 0, commitmentFailures: 0, epochs: [] };
        for (let number = from; number <= to; number++) {
            const tick = byTick.get(number);
            if (!tick) { result.missing++; continue; }
            const at = Date.parse(tick.scheduled_at);
            const epoch = epochs.find((item) => at >= item.starts && at < item.ends);
            if (epoch) epoch.ticks.push(tick); else result.unassigned++;
        }
        for (const epoch of epochs.filter((item) => item.ticks.length).sort((a, b) => a.starts - b.starts)) {
            const summary = { id: epoch.proof.id, starts_at: epoch.proof.starts_at, ends_at: epoch.proof.ends_at, ticks: epoch.ticks.length, revealed: Boolean(epoch.proof.revealed_seed), commitmentMatches: null, verified: 0, mismatches: 0 };
            result.epochs.push(summary);
            if (!summary.revealed) { result.pending += epoch.ticks.length; continue; }
            summary.commitmentMatches = await digest(bytes(epoch.proof.revealed_seed)) === epoch.proof.seed_commitment;
            if (!summary.commitmentMatches) result.commitmentFailures++;
            const expected = await signer(epoch.proof.revealed_seed);
            for (const tick of epoch.ticks) {
                if (Number(tick.digit) === await expected(mode, index, Number(tick.tick_no))) summary.verified++;
                else { summary.mismatches++; result.mismatchedTicks.push(Number(tick.tick_no)); }
            }
            result.verified += summary.verified;
            result.mismatches += summary.mismatches;
        }
        return result;
    }

    function describe(result) {
        const commitments = result.epochs.filter((epoch) => epoch.revealed);
        const parts = [`Ticks ${result.from}–${result.to}: ${result.verified} verified, ${result.mismatches} mismatches`];
        if (result.pending) parts.push(`${result.pending} not yet verifiable (epoch not revealed yet)`);
        if (result.missing) parts.push(`${result.missing} not available (purged or not yet published)`);
        if (result.unassigned) parts.push(`${result.unassigned} without a published epoch`);
        const commitmentText = commitments.length ? `Commitments: ${commitments.length - result.commitmentFailures} of ${commitments.length} revealed epochs match.` : 'No revealed epoch covers this range yet.';
        return `${parts.join('; ')}. ${commitmentText}${result.mismatchedTicks.length ? ` Mismatched ticks: ${result.mismatchedTicks.join(', ')}.` : ''}`;
    }
    function epochItem(epoch) {
        const item = document.createElement('li');
        const status = !epoch.revealed ? 'not revealed yet, not yet verifiable' : `commitment ${epoch.commitmentMatches ? 'matches' : 'does not match'}, ${epoch.verified} verified, ${epoch.mismatches} mismatches`;
        item.textContent = `Epoch ${epoch.starts_at.slice(0, 10)} (${epoch.ticks} ticks): ${status}.`;
        return item;
    }

    async function start() {
        const { client, config } = await window.initAccountSwitcher();
        const form = document.querySelector('[data-fairness-form]');
        const output = document.querySelector('[data-fairness-result]');
        const list = document.querySelector('[data-fairness-epochs]');
        const fail = (error) => { const message = failures[errorCode(error)]; output.textContent = message || 'Verification could not run. Please try again.'; if (!message) console.error(error); };
        async function rpc(name, args) { const { data, error } = await client.rpc(name, args); if (error) throw error; return data || []; }
        async function defaultRange() {
            const index = form.index.value;
            const latest = await rpc('get_recent_ticks', { p_index: index, p_limit: 1 });
            if (index !== form.index.value) return;
            const newest = Number(latest[0]?.tick_no || 0);
            form.from.value = Math.max(1, newest - DEFAULT_RANGE + 1);
            form.to.value = Math.max(1, newest);
        }
        for (const item of config.indices || []) form.index.add(new Option(item.display_name || item.code, item.code));
        form.index.addEventListener('change', () => defaultRange().catch(fail));
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const account = window.smartProfitAccount.get();
            const index = form.index.value;
            const from = Number(form.from.value), to = Number(form.to.value);
            list?.replaceChildren();
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) { output.textContent = 'Enter a first tick of at least 1 and a last tick that is not before it.'; return; }
            if (to - from + 1 > MAX_RANGE) { output.textContent = `Verify at most ${MAX_RANGE} ticks at a time.`; return; }
            output.textContent = 'Verifying…';
            try {
                const ticks = [];
                for (let after = from - 1; after < to;) {
                    const page = await rpc('get_ticks_since', { p_index: index, p_after_tick_no: after, p_limit: PAGE_SIZE });
                    ticks.push(...page);
                    if (page.length < PAGE_SIZE) break;
                    after = Number(page[page.length - 1].tick_no);
                }
                const proofs = await rpc('get_epoch_proofs', { p_account_id: account.accountId, p_index: index, p_limit: 500 });
                const result = await verify({ proofs, ticks, mode: account.mode, index, from, to });
                output.textContent = describe(result);
                list?.replaceChildren(...result.epochs.map(epochItem));
            } catch (error) { fail(error); }
        });
        document.addEventListener('smartprofit:account-changed', () => { output.textContent = ''; list?.replaceChildren(); });
        document.addEventListener('smartprofit:account-changed', () => { window.refreshRestrictionBanner?.().catch?.(console.error); });
        await window.refreshRestrictionBanner?.().catch?.(console.error);
        await defaultRange();
    }
    window.smartProfitFairness = { digit, verify, digest, describe };
    window.addEventListener('DOMContentLoaded', () => start().catch((error) => { console.error(error); const output = document.querySelector('[data-fairness-result]'); if (output) output.textContent = 'The verifier could not load. Please reload the page.'; }));
})();
