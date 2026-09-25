Continue "indices build.md" on a new branch feat/digit-indices-phase3-fixes from main. Phase 3 was merged with three blocking bugs, and Phase 4 has not been started. Do Part A first and commit it, then Part B. Section 0 of the brief still applies in full: production-grade code only, no stubs, no remote side effects, never read .env.local, never edit an applied migration (new *_engine_* migrations only, parity check green), npm test green, do not delete tests to pass. Every new or changed test must FAIL against the current main code and pass after your fix; show me that.

PART A. Phase 3 fixes

A1. Live ticks (assets/js/trade.js). The database sends ticks with realtime.send(..., private = true), but the client calls client.channel(topic) with no private flag and never calls setAuth. Per the Supabase Realtime docs, private broadcasts only reach channels created with { config: { private: true } } after await client.realtime.setAuth(). Fix that (use client.removeChannel on cleanup). The event name is 'tick'. Also add a polling fallback: whenever the channel is not SUBSCRIBED, poll get_ticks_since once per index interval so the feed and the Buy button recover without a page reload.

A2. Initial load and gap handling. get_ticks_since(after 0) returns the OLDEST 500 ticks. Load instead: get_recent_ticks(index, 1) to find the latest tick_no N, then page get_ticks_since(N-1000, 500) until caught up (get_recent_ticks and get_ticks_since cap at 500 rows per call). Keep at most 1000 ticks in memory. In the broadcast handler: tick_no === last+1 -> append; tick_no > last+1 -> reconcile through get_ticks_since (loop while a page returns 500); tick_no <= last -> ignore. No gaps, no duplicates.

A3. Fairness verifier (assets/js/fairness.js). It currently uses the newest revealed epoch's seed for every tick and compares by array position, which will report false mismatches on honest data. Fix: map each tick to its epoch by scheduled_at within [starts_at, ends_at) from get_epoch_proofs; verify each epoch's ticks with that epoch's seed; match ticks by tick_no, never by position; check the commitment (sha256(seed) === seed_commitment) per epoch; report ticks whose epoch is not yet revealed as "not yet verifiable" instead of counting them as mismatches. Default the range to the latest 20 ticks of the chosen index. Tests: a range spanning two epochs gives 0 mismatches on honest data; a tampered digit gives exactly 1; an unrevealed epoch gives "not yet verifiable"; the known-answer vectors in docs/ENGINE_SPEC.md still pass.

A4. Dashboard stats. Wins, Losses and Net result are computed from only the last 20 contracts but labelled as if they were lifetime. Add a new migration (*_engine_account_stats.sql) with a server-side aggregate over ALL settled contracts of the account (wins, losses, voids, open count, net result in USD 2dp). It must verify account ownership and status the same way get_account_summary does, be security definer with search_path = '', revoke from public and anon, grant to authenticated, and contain no execution_mode branch. Use it in dashboard.js. Add a Postgres test that seeds contracts of every state and checks the numbers.

A5. Contract change events. engine_contracts is not in the supabase_realtime publication, so the postgres_changes subscription in trade.js never fires. Add it in an idempotent *_engine_* migration (DO block checking pg_publication_tables). Keep RLS as the only filter.

A6. Cleanup.
- git rm -r .restore (old crypto-era pages; they stay in history) and confirm nothing references it.
- Replace window['cryp' + 'to'] in trade.js and fairness.js with plain window.crypto. Update the grep-gate test to allow exactly window.crypto / crypto.subtle / crypto.randomUUID through an explicit, narrow allowlist in the test, not by splitting strings.
- In account-switcher.js set the select's value to the Practice account on init.
- Replace "Astra Digit Indices" in README.md with SmartProfit and make the README accurate.

Commit Part A. Report what you could not verify without a live Supabase (Realtime delivery in particular) instead of claiming it works.

PART B. Phase 4: operations (admin console)
The Trading and Markets tabs in pages/admin.html and assets/js/admin-operations.js still call RPCs that Phase 1 dropped (list_admin_demo_orders, get_admin_demo_order_detail, set_symbol_trading_status, list_admin_market_health), so they are broken today. Replace them per brief Phase 4:

B1. Contracts tab (capability contracts.read): filters for account type (Practice / Real / All), account, index, state and date, using list_admin_contracts(execution_mode, state, limit); detail view via get_admin_contract_detail (entry/settle ticks, digits, payout, policy version, ledger transaction ids, events).

B2. Engine tab (capabilities engine.read / engine.manage): per-index status, lag, last tick, digit-quality status (get_admin_engine_health); pause/resume with mandatory reason (set_index_trading_status); current policy plus version history and a publish form showing server validation errors (publish_engine_policy); exposure view (get_admin_engine_exposure); epochs with commitments and reveal status; stuck contracts list; manual void, Owner only, reason of at least 10 characters (void_contract). If a listing RPC the UI needs (epochs, policy history) does not exist, add it in a new *_engine_* migration with require_staff and keep check:parity green.

B3. Overview: the "Market Feed" card becomes "Engine" (engine_health) and "orders today" becomes "contracts today", split by account type.

B4. Gate every tab and button with engine.read, engine.manage, contracts.read, contracts.void and the four restriction capabilities. The server stays the authority. Every state-changing action is audited and appears in the Audit tab.

B5. Customers tab: replace the single restrict-trading form with the graded form (type, scope, severity, params, expiry, reason), showing only the choices the staff member's capabilities allow. List restrictions with type/scope/severity/expiry, and lift only what the capabilities allow. No alert() or prompt(); inline forms with aria-live status. If this was already done, verify it against the Restrictions section and say so.

Tests: extend tests/admin-ui.test.mjs and tests/admin-permissions.test.mjs for capability gating per role, no call to any dropped RPC (grep the JS), void visible to Owner only, and restriction choices per role.

REPORT
Per part: commit hash, npm test output summary, decisions you made where the brief left room, anything you stopped on instead of guessing, and anything not verified live. End with a manual QA checklist for the browser: trade flow with live ticks, reload keeps the chart current, fairness verify across an epoch boundary, dashboard totals, admin Contracts and Engine tabs per role.