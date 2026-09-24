# Fable execution prompt: Phase 3 gate, Phase 4 audit, Phase 5 copy

You are the implementer. Codex is supervising and will audit your diff and evidence. Read `indices build.md` in full, especially section 0, account-type architecture, restrictions, and Phases 3–5. Treat this document as an execution brief, not as evidence that a phase is complete.

## Current repository state

- Work is on `feat/restore-customer-ui`. Commit `a12e80b` already added a Phase 4 Contracts/Engine console and `20260920530000_engine_admin_operations.sql`. Audit and repair it; do not rebuild it from scratch.
- `PHASE3_CUSTOMER_DATA_HANDOFF.md` records a Phase 3 customer-data recovery task. Commit `9e924cd` addressed startup and controls, and `ae3274a` addressed the pgcrypto schema, but there is no verified signed-in browser report proving live ticks and customer data now work. Local tests are evidence for code behavior, not deployment.
- The working tree contains user work in `assets/css/trade.css`, `assets/js/charts.js`, `assets/js/trade.js`, `pages/trade.html`, `tests/trade-feed.test.mjs`, and untracked plan/test/config files. Preserve all of it. Inspect `TRADE_UI_PLAN.md` before touching Trade. Do not discard, overwrite, or commit unrelated user changes.
- `pages/blog.html` and `pages/blog-single.html` are currently tiny generic placeholders. Other public copy, `assets/js/faq.js`, the shared footer in `assets/js/shell.js`, and `README.md` already contain digit-index wording; edit only where inaccurate or incomplete.
- In this Windows environment, call `npm.cmd`, since PowerShell blocks `npm.ps1`. The supervisor's `npm.cmd test` run reached `scripts/test-engine-postgres.mjs` and stopped at `uv_os_get_passwd` with `ERR_SYSTEM_ERROR: ENOMEM`. Diagnose the local harness separately; do not label that a product test failure or a pass.
- The supervisor separately ran `node --test tests/admin-ui.test.mjs tests/trade-feed.test.mjs tests/dashboard-ui.test.mjs`: 44 passed, 0 failed. This is focused local evidence only.

## Gate 1: establish Phase 3 status

Compare current code with every Phase 3 acceptance criterion and `PHASE3_CUSTOMER_DATA_HANDOFF.md`. Run `npm.cmd run check:parity`, the focused Phase 3 tests, and `npm.cmd test`. If the embedded PostgreSQL harness fails for an environment reason, record the exact failure and run the remaining relevant tests separately. Fix any proven code regression and show a regression test where useful.

If an authorized, usable signed-in Practice browser/deployment is available, verify Dashboard and Trade end to end: account and index selectors populate from server configuration, the active server balance and enabled Even/Odd controls appear, ticks advance across two observations, chart and digit data update, quote/Buy use the selected type, stale ticks disable Buy, account and index switches clear prior values, and dashboard market data survives an account RPC failure. Capture sanitized Console/Network evidence and before/after screenshots. Also verify fairness across an epoch boundary. Never expose credentials or account IDs in the report.

If no such environment is available, state exactly what remains unverified. If Phase 3 code is incomplete or fails its acceptance tests, repair it before the later phases. If only live deployment verification is unavailable, continue local Phase 4/5 work but keep the live gate explicitly open. Do not claim Phase 3 is fully done from jsdom tests or migration files alone.

## Phase 4: audit the existing implementation and close gaps

Check `pages/admin.html`, `assets/js/admin-operations.js`, related migrations, and `tests/admin-ui.test.mjs` / `tests/admin-permissions.test.mjs` against every Phase 4 requirement in `indices build.md`. Verify:

1. Contracts filters for Practice/Real/All, account, index, state and date; detail shows entry and settlement ticks/digits, payout, policy version, ledger transaction IDs and events.
2. Engine shows per-index status, lag, last tick and digit quality; pause/resume requires a reason; current policy/history and publish validation work; exposure, epoch commitment/reveal, stuck contracts and Owner-only void are present.
3. Overview uses engine health and contracts today split by account type. No active admin script calls dropped crypto RPCs.
4. Capability gating works for `contracts.read`, `contracts.void`, `engine.read`, `engine.manage`, and all four restriction capabilities. Server RPC authorization, fresh re-authentication where required, and audit rows back every state-changing action.
5. Customer restrictions form and listing correctly handle type, scope, severity, params, expiry, reason and lifting rights. Inline `aria-live` status replaces browser alerts/prompts.

Document evidence for each item. Fix concrete defects with minimal changes and meaningful regression tests. Use a new timestamped `*_engine_*.sql` migration for any engine database correction; never edit an applied migration. Keep the parity check green. If existing Phase 4 behavior is correct, leave it alone and report that it passed audit.

## Phase 5: finish the customer-facing copy pass

Review `pages/index.html`, `about.html`, `faq.html`, `contact.html`, `404.html`, `blog.html`, `blog-single.html`, page titles/descriptions, `assets/js/faq.js`, `assets/js/shell.js`, and `README.md` against Phase 5. Write three short factual guides, reachable from the blog listing: (1) how digit contracts settle, (2) the house margin and payout formula/rounding, (3) how to verify fairness and what the proof cannot establish. Choose a simple static-page structure compatible with the existing vanilla JS site; all links and titles must work. Avoid inventing performance figures or live data.

Ensure the FAQ clearly states the published/default margin, independent outcomes, and that Practice funds are virtual and cannot be withdrawn. Match the engine policy and `docs/ENGINE_SPEC.md`; distinguish configurable values from currently published values. Remove copy implying Real funding is currently available. Search active customer-facing HTML, JavaScript copy, metadata, navigation and shared footers for leftover crypto product language, outcome-prediction claims, earnings/profit promises, guarantees and testimonials. Factual use of “profit” in a quote or payout explanation is allowed; promotional claims are not. Check rendered desktop and mobile pages, navigation, FAQ behavior, links and basic accessibility.

Update `README.md` only where its architecture, setup, testing, modules or engine documentation is stale. Add focused tests for behavior or content that could regress, such as guide links and required FAQ statements; avoid tests that merely mirror static markup.

## Constraints and delivery

Follow section 0 of `indices build.md`: production-ready behavior, Practice only, no fake ticks/balances, no remote side effects, no reading `.env.local`, no secret output, no applied-migration edits, no removed tests, no `alert()`/`prompt()`, and no force push. Do not connect to Supabase or deploy without separate authorization. Keep unrelated working-tree changes intact. Commit completed work in coherent phase-specific commits only after checking what is staged; never sweep user changes into a commit.

Report to Codex: Phase 3 gate result with evidence and live verification limit; Phase 4 requirement-by-requirement audit and fixes; Phase 5 pages/copy changed; exact migration and file list; test commands, counts and failures; commit hashes; browser captures; remaining deployment steps or blockers. End with a manual QA checklist for customer Dashboard/Trade/fairness, admin roles and restrictions, and all public guides. Stop and identify any requirement that cannot be completed correctly rather than faking it.
