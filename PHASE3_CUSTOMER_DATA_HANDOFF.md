# Phase 3 customer data recovery — execution handoff

## Objective and roles

Fable executes the repair. Codex reviews the finished diff and test evidence when the user returns. Restore real Practice account and index data on the customer Dashboard and Trade pages, satisfying **through Phase 3** of [indices build.md](indices build.md).

**Latest user reproduction:** Dashboard and Trade display no customer data/content. On Trade, the account/mode selector and index selector are empty and do not work. The contract-family headings (Even/Odd, Matches/Differ, Over/Under) do not switch the contract; none of the contract choices works. Treat this as a startup/configuration failure across customer pages until browser evidence proves otherwise, then repair each control. These symptoms supersede the earlier, less specific report that pages merely lacked useful data.

Keep the current SmartProfit branding, mode tokens, and the in-progress trade layout. The trade UI redesign is currently uncommitted in `pages/trade.html` and `assets/css/trade.css`; `prompt.md` is also untracked. Inspect and preserve those changes. Do not touch Phase 4/5, Real funding, or unrelated admin work unless a demonstrated Phase 3 dependency requires it.

Follow section 0 of the brief: no fabricated chart data or placeholder balances, no browser-authoritative values, no editing applied migrations, no secrets in logs, and no remote side effects without the user's separate authorization. Do not read `.env.local`. Use new `*_engine_*.sql` migrations if a database fix is proven necessary. Do not remove tests to make a run pass.

## What is already present in the repository

- `assets/js/account-switcher.js` calls `enroll_practice_account`, `get_engine_config`, and `list_my_accounts`, then selects the active DEMO account. Both pages rely on this succeeding before their own loading starts.
- `assets/js/dashboard.js` requests `get_account_summary`, `get_account_stats`, and `list_my_contracts`. It separately requests recent ticks for the index chart and table.
- `assets/js/trade.js` builds selectors from `get_engine_config`, loads recent ticks, subscribes to a private tick channel, polls when needed, quotes through `engine_quote_contract`, and buys through `engine_buy_contract`.
- `supabase/README.md` requires the three engine cron jobs, private `ticks:demo:*` Broadcast, and `engine_contracts` in the Realtime publication. Their presence in migration files does not prove that the deployment has applied them or that jobs are running.
- Local tests previously passed for the account switcher, dashboard UI, fairness UI, trade feed, and admin UI (41 focused tests). Those tests use isolated fixtures and do not prove the deployed browser receives data.

## Findings to investigate and fix

### 1. Customer startup/configuration is the first blocker to isolate

Both pages populate the account selector through `initAccountSwitcher()`; Trade additionally populates its index and type selectors from `get_engine_config()`. If the shared initialization fails, these controls stay empty and neither page can load its account-bound data. The code dynamically fills the index/type selectors, so empty controls are a strong sign that startup did not finish, the config payload is empty/malformed, or a script/config request failed; confirm which using evidence.

On both pages, verify script and CSS requests, Supabase client/session initialization, and the results of `enroll_practice_account`, `get_engine_config`, and `list_my_accounts`. Confirm the response contains an active DEMO account, the five configured indices, and launch-enabled types from the published policy. Check that the selector options are inserted, visible, enabled, and retain their values after render. Inspect Console, Network and computed layout for a runtime exception, failed dependency/config request, hidden/covered element, or redirect. Do not assume the account selector itself is a visual-only issue.

Trade's three contract-family headings in `pages/trade.html` are currently plain `span` elements, not buttons or selectors. The user expects to choose among supported types. Replace them with accessible working controls wired to the existing contract form/type state; list only types enabled by the live policy and show the required barrier control for a selected type. Test keyboard and pointer selection and confirm that the quote and Buy request use the selected type. Do not imply that disabled types can be traded.

### 2. Dashboard market loading is coupled to account RPC success

In `assets/js/dashboard.js`, `start()` awaits `render()` before calling `refreshMarket()` and scheduling updates. `render()` throws if **any** of four account RPCs fails. Thus a failure in `get_account_stats` or contract history can prevent the chart and index table from loading even if tick RPCs work. The page only shows a generic “Unable to load account data.” status.

Verify this in a browser and add a regression case: make one account RPC fail while `get_engine_config` and tick reads succeed; index facts, chart, and table must still render. Show a precise account-data error without hiding functioning market data. Keep account data bound to the active account and discard late responses after switching.

### 3. The shared startup chain can leave both pages empty

If `assets/js/auth.js` cannot load `supabase-config.js` or the Supabase browser library, if the session is invalid, or if any of the three account-switcher RPCs fails, both pages stop before their own data renders. Distinguish these cases using browser console and Network evidence. Record RPC name, HTTP status, SQL error code/message, and the visible page state, with tokens and keys redacted. Do not guess that the chart canvas or CSS is the root cause.

The account switcher currently throws on failure; the dashboard maps startup failure to one generic line, and Trade calls `report()` with an opaque reference for unknown failures. Make startup failures visible and actionable to the customer without exposing server internals. Confirm that a new signed-in user is enrolled once and sees a Practice account.

### 4. Empty configuration and absent ticks need honest states

`trade.js` assumes an index option exists when `subscribe()` reads `index.selectedOptions[0].dataset.interval`. An empty `config.indices` can therefore fail during startup. An empty `enabled_contract_types` also leaves no usable contract choice. Handle both explicitly: explain the unavailable service, keep Buy disabled, and recover when valid data returns. Do not insert invented indices or enabled types.

If the configuration has indices but `get_recent_ticks` returns no ticks, determine whether the scheduler has not run, is failing, or the RPC is denied. Show a clear “No ticks published yet” or feed-unavailable state rather than a blank canvas presented as live. Confirm `tick_no` advances across two observations; a successful empty RPC alone is not sufficient.

### 5. Phase 3 trade-page gaps

The brief requires the active **Practice balance on the Trade page**. The current page only says “Practice funds”; it has no balance value or summary request. Add the server-sourced balance with a clear “Practice mode · virtual funds” label, refresh it after purchase and account changes, and never carry the previous account's value across a switch.

The trade-page heading lists Even/Odd, Matches/Differ, and Over/Under as if all are available, while the initial policy enables Even/Odd only. Make these labels reflect `config.enabled_contract_types` or present unavailable families unambiguously. Do not expose a buy action for a disabled type. Preserve the current layout's spacing and non-overlapping sections.

### 6. Dashboard empty-history presentation

Open contracts already have a “No open contracts” row, but the latest-20-contracts table can be empty without an explanation. Render an honest empty state for a new Practice account. Keep balance and lifetime stats visible as zero when the server returns zero, while distinguishing a failed request from a genuine zero.

## Diagnostic sequence

1. Reproduce the exact symptoms on both actual customer pages using a signed-in Practice account. First determine whether the header account switcher populates. On Trade, inspect whether index/type data RPCs ran and returned values, then capture why each selector is empty. Capture sanitized screenshots, Console errors, and Network responses for `enroll_practice_account`, `get_engine_config`, `list_my_accounts`, `get_account_summary`, `get_account_stats`, `list_my_contracts`, `get_recent_ticks`, and `get_ticks_since`. Note whether both pages fail at the same RPC or at different stages.
2. Check the loaded `auth.js`, `supabase-config.js`, account-switcher, and page scripts and their order. Verify the returned config contains five DEMO indices and launch-enabled types appropriate to the published policy. Verify the selected Practice account ID and active mode are consistent; redact IDs in the report. Confirm the Trade family controls actually select a supported type and update the quote, rather than only changing their visual active state.
3. If requests succeed but ticks are absent or stale, use the deployment checklist in `supabase/README.md` to identify missing migrations, jobs, publication, or Realtime authorization. Report any required remote repair as a concrete proposed action. Do not quietly push migrations, run cron manually, change policy, or change database flags.
4. Fix proven frontend failures in the smallest coherent change, with explicit loading, empty, stale, and error states. Keep the feed's private authorization, paging, reconciliation, polling fallback, and stale Buy lockout intact.
5. Add regression tests for each confirmed cause and the Phase 3 UI gaps above. Test failed account RPC with working market data; empty config; no ticks; balance refresh and account switching; new-account empty history. Ensure each new test fails against the pre-fix code.

## Acceptance criteria

- A newly enrolled Practice user sees the actual server balance, index list, enabled contract types, and an understandable empty-contract state on the dashboard.
- The Practice/account selector, Trade index selector, and contract-type controls all populate, are usable, and select valid live configuration. Contract-family selection changes the actual form state and quote.
- With published ticks, the dashboard chart, latest ticks, and index table show real values and update; the Trade chart, price, digit strip, and frequencies show the selected index's real values.
- A failure in one dashboard account RPC does not suppress independent market data. Both pages visibly distinguish loading, no data yet, stale feed, and request failure.
- Trade shows the active server-sourced Practice balance. Quote and Buy use only enabled contract types. Buy remains disabled when the feed is stale.
- Reload and index/account changes do not show stale values from another account or index. No fake numbers are used.
- `npm run check:parity`, focused Phase 3 tests, and `npm test` pass where the local PostgreSQL environment supports them. If the embedded PostgreSQL harness fails for an environment reason, give the exact failure and run the remaining tests separately.

## Report back for Codex audit

Provide: confirmed root cause(s) with sanitized request/response evidence; exact files and migrations changed; before/after browser captures for Dashboard and Trade; test commands and pass/fail counts; any deployment action still needed; and anything unverified live. Do not claim that local jsdom tests establish live tick delivery.
