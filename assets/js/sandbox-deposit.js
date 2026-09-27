/* Real mode account page while Real is in Daraja sandbox testing
 * (docs/REAL_FUNDING_DESIGN.md §9). It shows the non-spendable test balance and
 * the deposit history; deposits themselves are made in the funding sheet
 * (deposit-sheet.js). The server decides who may see any of it.
 */
(function () {
    const find = (selector) => document.querySelector(selector);
    const usd = (value) => Number(value).toFixed(2);
    const kes = (value) => `KES ${Number(value).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
    const STATES = Object.freeze({
        INITIATING: ['Pending', 'pending'], PENDING: ['Pending', 'pending'], VERIFYING: ['Pending', 'pending'], UNKNOWN: ['Pending', 'pending'],
        CONFIRMED: ['Confirmed', 'ok'], FAILED: ['Failed', 'bad'], REJECTED: ['Failed', 'bad'], EXPIRED: ['Expired', 'review'],
        MANUAL_REVIEW: ['Manual review', 'review'], REVERSED: ['Reversed', 'bad'],
    });

    let client = null;

    function stateBadge(state) {
        const [label, tone] = STATES[state] || [state, 'pending'];
        const badge = document.createElement('span');
        badge.className = 'real-state';
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
            cell.className = 'real-empty';
            cell.textContent = 'No deposits yet.';
            row.append(cell);
            body.replaceChildren(row);
            return;
        }
        body.replaceChildren(...payments.map((payment) => {
            const row = document.createElement('tr');
            const cells = [new Date(payment.created_at).toLocaleString(), usd(payment.usd_amount), kes(payment.kes_due), null,
                payment.receipt_verified ? payment.mpesa_receipt : '—'];
            cells.forEach((value) => {
                const cell = document.createElement('td');
                if (value === null) cell.append(stateBadge(payment.state)); else cell.textContent = value;
                row.append(cell);
            });
            return row;
        }));
    }

    async function refresh() {
        const [{ data: overview, error: overviewError }, { data: payments, error: paymentsError }] = await Promise.all([
            client.rpc('funding_sandbox_overview'), client.rpc('funding_my_payments'),
        ]);
        if (overviewError) throw overviewError;
        if (paymentsError) throw paymentsError;
        if (overview?.available) {
            find('[data-sandbox-balance]').textContent = usd(overview.test_balance_usd);
            renderHistory(payments || []);
        }
        return overview;
    }

    async function start() {
        if (typeof window.getSupabaseClient !== 'function') return;
        client = await window.getSupabaseClient();
        const overview = await refresh();
        // For a tester the mode switch shows this page as Real, with Practice one choice away.
        window.initAccountSwitcher?.({ realSandbox: overview?.available === true }).catch(() => {});
        if (!overview?.available) { find('[data-sandbox-unavailable]').hidden = false; return; }
        find('[data-sandbox-available]').hidden = false;
        document.addEventListener('smartprofit:deposit-updated', () => refresh().catch((error) => console.error(error)));
    }

    window.addEventListener('DOMContentLoaded', () => start().catch((error) => {
        console.error(error);
        find('[data-sandbox-status]').textContent = 'Your Real account could not be loaded. Reload the page to try again.';
    }).finally(() => window.smartProfitLoader?.pageReady()));
})();
