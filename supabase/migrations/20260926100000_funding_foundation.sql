-- Real-mode funding foundation: Daraja STK Push, sandbox only (docs/REAL_FUNDING_DESIGN.md).
--
-- Customer money is denominated in USD; M-Pesa cash is KES. Every deposit is
-- priced from an immutable CBK reference-rate version and a quote that locks the
-- USD amount, the whole-shilling KES amount and the rounding between them.
--
-- Sandbox credits go to a separate, non-spendable USD ledger in this schema. No
-- row here is read by the engine and nothing here can reach public.ledger_*, so
-- a sandbox payment cannot fund a trading wallet. Production payments are refused
-- by every function in this release.

create schema if not exists funding;
revoke all on schema funding from public;

insert into public.platform_modules(module_key, enabled, reason) values
    ('daraja_sandbox', false, 'Daraja sandbox deposits are limited to owner-listed testers'),
    ('daraja_production', false, 'Production M-Pesa payments require a separate Owner-approved release')
on conflict (module_key) do nothing;

create or replace function funding.reject_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'funding_record_immutable'; end;
$$;

-- Deposit limits are versioned policy. Every limit is enforced server-side on the
-- locked USD amounts; max_kes is the provider's per-transaction ceiling and stays
-- a second, independent hard limit. The latest version applies, and a missing
-- version fails closed (deposit_policy_unavailable).
create table funding.deposit_policy_versions (
    version integer primary key,
    min_usd numeric(18,2) not null check (min_usd > 0),
    max_usd_per_deposit numeric(18,2) not null,
    max_usd_rolling_24h numeric(18,2) not null,
    max_deposits_rolling_24h integer not null check (max_deposits_rolling_24h between 1 and 100),
    max_kes integer not null check (max_kes > 0 and max_kes <= 250000),
    quote_ttl_seconds integer not null check (quote_ttl_seconds between 30 and 3600),
    rate_max_age_hours integer not null check (rate_max_age_hours between 1 and 168),
    spread_bp integer not null check (spread_bp = 0),
    stress_bp integer not null check (stress_bp between 0 and 10000),
    alert_coverage_bp integer not null,
    pause_coverage_bp integer not null,
    incident_coverage_bp integer not null,
    treasury_max_age_hours integer not null check (treasury_max_age_hours between 1 and 168),
    published_at timestamptz not null default now(),
    check (max_usd_per_deposit >= min_usd and max_usd_rolling_24h >= max_usd_per_deposit),
    check (alert_coverage_bp > pause_coverage_bp and pause_coverage_bp > incident_coverage_bp and incident_coverage_bp > 0)
);
-- v1: USD 5.00 minimum, USD 500 per deposit, at most USD 1,000 and three
-- successful deposits per customer per rolling 24 hours, KES 250,000 ceiling.
insert into funding.deposit_policy_versions values (1, 5.00, 500.00, 1000.00, 3, 250000, 300, 72, 0, 1000, 12000, 11000, 10000, 24, now());

create table funding.fx_rate_versions (
    version bigint generated always as identity primary key,
    pair text not null default 'USD/KES' check (pair = 'USD/KES'),
    kes_per_usd numeric(12,4) not null check (kes_per_usd between 50 and 500),
    rate_date date not null,
    source text not null check (source = 'CBK'),
    source_reference text not null check (char_length(source_reference) between 3 and 300),
    published_at timestamptz not null default now(),
    published_by uuid references auth.users(id),
    note text not null check (char_length(note) between 3 and 500)
);
insert into funding.fx_rate_versions(kes_per_usd, rate_date, source, source_reference, note)
values (129.62, date '2026-09-25', 'CBK', 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'Initial reference rate set by the execution plan');

create table funding.sandbox_testers (
    user_id uuid primary key references auth.users(id),
    enabled boolean not null,
    changed_at timestamptz not null default now(),
    changed_by uuid not null references auth.users(id),
    reason text not null
);

create table funding.deposit_quotes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id),
    environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
    policy_version integer not null references funding.deposit_policy_versions(version),
    rate_version bigint not null references funding.fx_rate_versions(version),
    kes_per_usd numeric(12,4) not null,
    rate_date date not null,
    usd_amount numeric(18,2) not null check (usd_amount > 0),
    kes_due integer not null check (kes_due > 0),
    kes_rounding numeric(18,6) not null check (kes_rounding >= 0 and kes_rounding < 1),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    check (kes_due = ceil(usd_amount * kes_per_usd)),
    check (kes_rounding = kes_due - usd_amount * kes_per_usd),
    check (expires_at > created_at)
);

create table funding.payments (
    id uuid primary key default gen_random_uuid(),
    quote_id uuid not null unique references funding.deposit_quotes(id),
    user_id uuid not null references auth.users(id),
    environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
    usd_amount numeric(18,2) not null check (usd_amount > 0),
    kes_due integer not null check (kes_due > 0),
    idempotency_key text not null check (char_length(idempotency_key) between 8 and 100),
    shortcode text not null check (shortcode ~ '^[0-9]{5,8}$'),
    state text not null check (state in ('INITIATING', 'PENDING', 'UNKNOWN', 'VERIFYING', 'CONFIRMED', 'FAILED', 'REJECTED', 'EXPIRED', 'MANUAL_REVIEW', 'REVERSED')),
    state_reason text,
    attention_reason text,
    callback_token_hash text not null unique check (callback_token_hash ~ '^[0-9a-f]{64}$'),
    phone_masked text not null,
    phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
    account_reference text not null unique check (account_reference ~ '^[A-Z0-9]{1,12}$'),
    merchant_request_id text,
    -- Written only from the synchronous STK Push response, together with
    -- initiated_at. A callback never sets it: a callback for a payment without it
    -- keeps its claimed id in callback_checkout_request_id and goes to review.
    checkout_request_id text unique,
    callback_checkout_request_id text,
    mpesa_receipt text unique,
    receipt_pending boolean not null default false,
    callback_result_code integer,
    callback_amount numeric(18,2),
    provider_result_code text,
    provider_result_desc text,
    credit_transaction_id uuid,
    -- When the provider confirmed the money: STK Query 0 on the bound checkout, or
    -- an approved statement item. Money received is never resolved as FAILED.
    provider_confirmed_at timestamptz,
    statement_item_id bigint unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    initiated_at timestamptz,
    finalized_at timestamptz,
    unique (user_id, idempotency_key),
    check ((checkout_request_id is null) = (initiated_at is null))
);
create index payments_user_created_idx on funding.payments(user_id, created_at desc);
create index payments_open_idx on funding.payments(state, created_at) where state in ('INITIATING', 'PENDING', 'UNKNOWN', 'VERIFYING');

create table funding.payment_state_events (
    id bigint generated always as identity primary key,
    payment_id uuid not null references funding.payments(id),
    from_state text,
    to_state text not null,
    cause text not null,
    actor_id uuid,
    created_at timestamptz not null default now()
);

-- Provider facts, minimized: no raw payload, only its digest and the fields the
-- state machine needs. A replay lands on the same dedupe_key and is counted.
create table funding.provider_events (
    id uuid primary key default gen_random_uuid(),
    payment_id uuid references funding.payments(id),
    environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
    source text not null check (source in ('INITIATION', 'CALLBACK', 'STATUS_QUERY')),
    dedupe_key text not null unique,
    checkout_request_id text,
    merchant_request_id text,
    result_code text,
    result_desc text,
    amount numeric(18,2),
    receipt text,
    phone_masked text,
    payload_sha256 text,
    verdict text not null check (verdict in ('APPLIED', 'DUPLICATE', 'LATE', 'CONFLICT', 'MISMATCH', 'UNBOUND', 'INFORMATIONAL')),
    duplicate_count integer not null default 0,
    received_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create table funding.usd_ledger_transactions (
    id uuid primary key default gen_random_uuid(),
    environment text not null check (environment = 'SANDBOX'),
    payment_id uuid not null references funding.payments(id),
    idempotency_key text not null unique,
    description text not null,
    created_at timestamptz not null default now()
);

create table funding.usd_ledger_entries (
    id bigint generated always as identity primary key,
    transaction_id uuid not null references funding.usd_ledger_transactions(id),
    environment text not null check (environment = 'SANDBOX'),
    account_code text not null check (account_code in ('CUSTOMER_TEST_BALANCE', 'DEPOSIT_CLEARING')),
    user_id uuid references auth.users(id),
    amount numeric(18,2) not null check (amount <> 0),
    created_at timestamptz not null default now(),
    check ((account_code = 'CUSTOMER_TEST_BALANCE') = (user_id is not null))
);
create index usd_ledger_entries_user_idx on funding.usd_ledger_entries(user_id) where user_id is not null;

create or replace function funding.assert_usd_transaction_balanced() returns trigger language plpgsql set search_path = '' as $$
begin
    if exists (select 1 from funding.usd_ledger_entries where transaction_id = new.transaction_id having sum(amount) <> 0) then
        raise exception 'funding_ledger_unbalanced';
    end if;
    return null;
end;
$$;
create constraint trigger usd_ledger_entries_balanced after insert on funding.usd_ledger_entries
    deferrable initially deferred for each row execute function funding.assert_usd_transaction_balanced();

-- KES cash side. RECEIPT is the shillings collected, booked when the provider
-- confirms the money even if the USD credit is then held; ROUNDING is the named
-- rounding account (kes_due minus the exact USD value); REVERSAL is the
-- compensating entry.
create table funding.kes_clearing_entries (
    id bigint generated always as identity primary key,
    environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
    payment_id uuid not null references funding.payments(id),
    kind text not null check (kind in ('RECEIPT', 'ROUNDING', 'REVERSAL')),
    kes_amount numeric(18,6) not null,
    business_date date not null,
    created_at timestamptz not null default now(),
    unique (payment_id, kind)
);

create table funding.treasury_snapshots (
    id bigint generated always as identity primary key,
    environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
    kes_liquid_reserve numeric(18,2) not null check (kes_liquid_reserve >= 0),
    recorded_at timestamptz not null default now(),
    recorded_by uuid not null references auth.users(id),
    note text not null check (char_length(note) between 3 and 500)
);

-- One line of a provider statement (M-Pesa org portal or bank), recorded by
-- finance with a digest of the downloaded file. A manual confirmation must cite
-- one, and it must bind to the payment: the exact KES amount, the shortcode, the
-- account reference and/or phone, and a transaction time inside the payment's
-- window. Sandbox may use SANDBOX_SIMULATED evidence; production accepts only
-- PROVIDER_DOWNLOAD.
create table funding.provider_statement_items (
    id bigint generated always as identity primary key,
    environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
    receipt text not null check (receipt ~ '^[A-Z0-9]{6,20}$'),
    kes_amount numeric(18,2) not null check (kes_amount > 0),
    shortcode text not null check (shortcode ~ '^[0-9]{5,8}$'),
    transaction_at timestamptz not null,
    business_date date not null,
    account_reference text check (account_reference ~ '^[A-Z0-9]{1,12}$'),
    phone_hash text check (phone_hash ~ '^[0-9a-f]{64}$'),
    phone_masked text,
    evidence_kind text not null check (evidence_kind in ('PROVIDER_DOWNLOAD', 'SANDBOX_SIMULATED')),
    evidence_reference text not null check (char_length(evidence_reference) between 3 and 300),
    evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_by uuid not null references auth.users(id),
    recorded_at timestamptz not null default now(),
    note text not null check (char_length(note) between 10 and 500),
    unique (environment, receipt),
    check (account_reference is not null or phone_hash is not null),
    check (environment = 'SANDBOX' or evidence_kind = 'PROVIDER_DOWNLOAD')
);
alter table funding.payments add constraint payments_statement_item_fk foreign key (statement_item_id) references funding.provider_statement_items(id);

-- Every financial staff decision is two-person: one owner requests, a different
-- owner approves. The check constraint is the last line of that rule. A manual
-- confirmation also cites a statement item, and whoever recorded that item may
-- neither request nor approve it (funding_request_action, funding_approve_action).
create table funding.staff_actions (
    id uuid primary key default gen_random_uuid(),
    payment_id uuid not null references funding.payments(id),
    kind text not null check (kind in ('REVERSE', 'RESOLVE_CONFIRMED', 'RESOLVE_FAILED')),
    statement_item_id bigint references funding.provider_statement_items(id),
    requested_by uuid not null references auth.users(id),
    requested_at timestamptz not null default now(),
    request_reason text not null check (char_length(request_reason) between 10 and 500),
    approved_by uuid references auth.users(id),
    approved_at timestamptz,
    approval_reason text,
    check (approved_by is null or approved_by <> requested_by),
    check ((kind = 'RESOLVE_CONFIRMED') = (statement_item_id is not null))
);
create unique index staff_actions_one_open_per_payment on funding.staff_actions(payment_id) where approved_by is null;

-- A day's statement summary for the merchant account: opening balance, gross
-- receipts, reversals and refunds, provider fees, net settlement moved to the
-- bank, and closing balance. Reconciliation rolls it forward and compares it
-- with the booked KES. evidence_kind separates a downloaded provider statement
-- from simulated sandbox figures.
create table funding.statement_totals (
    id bigint generated always as identity primary key,
    environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
    business_date date not null,
    kes_opening_balance numeric(18,2) not null,
    kes_gross numeric(18,2) not null check (kes_gross >= 0),
    kes_reversals numeric(18,2) not null check (kes_reversals >= 0),
    kes_fees numeric(18,2) not null check (kes_fees >= 0),
    kes_net_settlement numeric(18,2) not null check (kes_net_settlement >= 0),
    kes_closing_balance numeric(18,2) not null,
    evidence_kind text not null check (evidence_kind in ('PROVIDER_DOWNLOAD', 'SANDBOX_SIMULATED')),
    evidence_reference text not null check (char_length(evidence_reference) between 3 and 300),
    evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_by uuid not null references auth.users(id),
    recorded_at timestamptz not null default now(),
    reason text not null,
    check (environment = 'SANDBOX' or evidence_kind = 'PROVIDER_DOWNLOAD')
);

create table funding.reconciliation_runs (
    id uuid primary key default gen_random_uuid(),
    environment text not null check (environment in ('SANDBOX', 'PRODUCTION')),
    business_date date not null,
    run_at timestamptz not null default now(),
    status text not null check (status in ('MATCHED', 'DIFFERENCES')),
    summary jsonb not null,
    differences jsonb not null
);

create table funding.reconciliation_resolutions (
    id bigint generated always as identity primary key,
    run_id uuid not null unique references funding.reconciliation_runs(id),
    resolved_by uuid not null references auth.users(id),
    resolved_at timestamptz not null default now(),
    reason text not null check (char_length(reason) between 10 and 500)
);

do $$
declare t text;
begin
    foreach t in array array['deposit_policy_versions', 'fx_rate_versions', 'deposit_quotes', 'payment_state_events',
        'usd_ledger_transactions', 'usd_ledger_entries', 'kes_clearing_entries', 'treasury_snapshots',
        'provider_statement_items', 'statement_totals', 'reconciliation_runs', 'reconciliation_resolutions'] loop
        execute format('create trigger %I before update or delete on funding.%I for each row execute function funding.reject_mutation()', t || '_immutable', t);
    end loop;
end $$;

-- Payments, provider events and staff actions change state only through the
-- definer functions; nothing may delete them.
create trigger payments_no_delete before delete on funding.payments for each row execute function funding.reject_mutation();
create trigger provider_events_no_delete before delete on funding.provider_events for each row execute function funding.reject_mutation();
create trigger staff_actions_no_delete before delete on funding.staff_actions for each row execute function funding.reject_mutation();

do $$
declare t text;
begin
    for t in select tablename from pg_tables where schemaname = 'funding' loop
        execute format('alter table funding.%I enable row level security', t);
        execute format('revoke all on funding.%I from public, anon, authenticated, service_role', t);
    end loop;
end $$;

-- Capability registry: funding.read for owner and administrator, funding.manage
-- for owner only. The rest is unchanged from 20260920530000.
create or replace function admin_private.role_capabilities(p_role text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_role
    when 'support_agent' then array['staff.enter', 'support.read_assigned', 'support.reply', 'support.note', 'support.transition', 'customers.restrict.notice']
    when 'administrator' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'customers.read', 'operations.read', 'engine.read', 'engine.manage', 'contracts.read', 'customers.restrict.notice', 'customers.restrict.limit', 'customers.restrict.block', 'funding.read']
    when 'owner' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'customers.read', 'operations.read', 'staff.manage', 'audit.read', 'engine.read', 'engine.manage', 'contracts.read', 'contracts.void', 'platform.enable_real', 'customers.restrict.notice', 'customers.restrict.limit', 'customers.restrict.block', 'customers.restrict.block_severe', 'funding.read', 'funding.manage']
    else array[]::text[] end;
$$;
