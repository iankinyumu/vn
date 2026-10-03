// Fake backend (source text for addInitScript) for the trade page and shell browser checks:
// a live 2-second tick stream, a Practice account with policy limits, quotes and purchases.
export const tradeFake = ({ overview = { available: false }, balance = 10000, enabled = ['EVEN', 'ODD', 'MATCH', 'DIFFER', 'OVER', 'UNDER'] } = {}) => `
    window.__BAL__ = ${JSON.stringify(balance)};
    window.__CONTRACTS__ = [];
    window.__FAKE__ = { rpc: {
        get_engine_config: { real_enabled: false, enabled_contract_types: ${JSON.stringify(enabled)},
            indices: [{ code: 'SPI10', display_name: 'SP Index 10', interval_ms: 2000, decimals: 3 }, { code: 'SPI25', display_name: 'SP Index 25', interval_ms: 2000, decimals: 3 }],
            accounts: [{ id: 'acc-demo', execution_mode: 'DEMO', currency: 'USD', status: 'ACTIVE', limits: { min_stake: 0.35, max_stake: 500 } }] },
        enroll_practice_account: 'acc-demo',
        list_my_accounts: [{ id: 'acc-demo', execution_mode: 'DEMO', currency: 'USD', status: 'ACTIVE' }, { id: 'acc-real', execution_mode: 'REAL', currency: 'USD', status: 'ACTIVE' }],
        get_account_summary: () => ({ available: window.__BAL__, currency: 'USD' }),
        get_recent_ticks: { __liveTicks: { origin: 0 } },
        get_ticks_since: { __liveTicks: { origin: 0 } },
        list_my_contracts: () => window.__CONTRACTS__,
        get_engine_v3_status: [],
        get_my_active_restrictions: [],
        funding_sandbox_overview: () => (${JSON.stringify(overview)}),
        funding_my_payments: [],
        engine_quote_contract: (args) => {
            const wins = { EVEN: 5, ODD: 5, MATCH: 1, DIFFER: 9, OVER: 9 - args.p_barrier, UNDER: args.p_barrier }[args.p_type];
            const payout = Math.floor(args.p_stake * 0.965 * 10 / wins * 100) / 100;
            if (payout - args.p_stake < args.p_stake * 0.01) return { __error: 'profit_too_low' };
            return { payout: payout.toFixed(2), profit: (payout - args.p_stake).toFixed(2), win_probability: wins / 10 };
        },
        engine_buy_contract: (args) => {
            window.__BAL__ -= args.p_stake;
            const now = Math.floor(Date.now() / 2000);
            const contract = { id: 'c-' + window.__CONTRACTS__.length, index_code: args.p_index, contract_type: args.p_type, barrier: args.p_barrier, stake: String(args.p_stake), payout: '0.68', entry_tick_no: now + 1, settle_tick_no: now + args.p_tick_count, state: 'OPEN', exit_digit: null, created_at: new Date().toISOString() };
            window.__CONTRACTS__.unshift(contract);
            return { id: contract.id, entry_tick_no: contract.entry_tick_no, settle_tick_no: contract.settle_tick_no };
        },
    } };
`;
