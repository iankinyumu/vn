-- Funding RPC surface (docs/REAL_FUNDING_DESIGN.md §4, §9).
--
-- Customer RPCs derive the user from auth.uid() and never take an account, mode,
-- KES amount, rate or status. Service RPCs (funding_svc_*) are executable by
-- service_role only; the Edge Functions use them to relay provider facts, and the
-- state machine here decides what those facts mean. Only funding_svc_record_status
-- (the server's own STK Push Query of the checkout id returned by the synchronous
-- STK Push response) or a two-person staff decision citing a matching provider
-- statement item can credit a payment, and either one credits only when the
-- customer limits and the projected treasury coverage still hold.

-- ---------------------------------------------------------------- helpers

create or replace function funding.policy() returns funding.deposit_policy_versions
language plpgsql stable security definer set search_path = '' as $$
declare pol funding.deposit_policy_versions;
begin
    select * into pol from funding.deposit_policy_versions order by version desc limit 1;
    if pol.version is null or pol.max_usd_per_deposit is null or pol.max_usd_rolling_24h is null or pol.max_deposits_rolling_24h is null then
        raise exception 'deposit_policy_unavailable';
    end if;
    return pol;
end;
$$;

-- A CBK rate for day D stays usable until the end of D (Nairobi, UTC+3, no DST)
-- plus the policy age, so Friday's rate covers the weekend.
create or replace function funding.rate_is_stale(p_rate_date date, p_max_age_hours integer) returns boolean
language sql stable set search_path = '' as $$
    select ((p_rate_date + 1)::timestamp - interval '3 hours') at time zone 'UTC' + make_interval(hours => p_max_age_hours) < now();
$$;

create or replace function funding.current_rate() returns funding.fx_rate_versions
language sql stable security definer set search_path = '' as $$
    select * from funding.fx_rate_versions order by version desc limit 1;
$$;

create or replace function funding.nairobi_date(p_at timestamptz) returns date
language sql stable set search_path = '' as $$ select (p_at at time zone 'UTC' + interval '3 hours')::date $$;

create or replace function funding.status_message(p_state text, p_environment text) returns text
language sql immutable set search_path = '' as $$
    select case p_state
        when 'INITIATING' then 'Check your phone and enter your M-Pesa PIN to approve the payment.'
        when 'PENDING' then 'Check your phone and enter your M-Pesa PIN to approve the payment.'
        when 'UNKNOWN' then 'We are confirming this payment with M-Pesa. This can take a few minutes.'
        when 'VERIFYING' then 'We are confirming this payment with M-Pesa. This can take a few minutes.'
        when 'CONFIRMED' then case when p_environment = 'SANDBOX'
            then 'Sandbox payment confirmed. The USD amount was added to your non-spendable sandbox test balance.'
            else 'Payment confirmed. The USD amount was added to your balance.' end
        when 'FAILED' then 'The payment did not complete. If M-Pesa shows a charge, contact support with your M-Pesa receipt.'
        when 'REJECTED' then 'M-Pesa could not start this payment. No money was taken.'
        when 'EXPIRED' then 'This payment needs a manual check. Contact support if M-Pesa shows a charge.'
        when 'MANUAL_REVIEW' then 'This payment needs a manual check. Contact support if M-Pesa shows a charge.'
        when 'REVERSED' then 'This payment was reversed.'
        else 'Payment status unavailable.' end;
$$;

create or replace function funding.sha256_hex(p_value text) returns text
language sql immutable set search_path = '' as $$ select encode(pg_catalog.sha256(convert_to(p_value, 'UTF8')), 'hex') $$;

-- Sandbox is open only with the module on and the user on the tester list.
-- Production is refused outright in this release.
create or replace function funding.assert_environment_open(p_environment text, p_user uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
    if p_environment <> 'SANDBOX' then raise exception 'production_payments_disabled'; end if;
    if not public.module_enabled('daraja_sandbox') then raise exception 'sandbox_not_enabled'; end if;
    if not exists (select 1 from funding.sandbox_testers where user_id = p_user and enabled) then raise exception 'sandbox_not_enabled'; end if;
end;
$$;

create or replace function funding.transition(p_payment uuid, p_to text, p_cause text, p_actor uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_from text; v_allowed text[];
begin
    select state into v_from from funding.payments where id = p_payment for update;
    if v_from is null then raise exception 'payment_not_found'; end if;
    if v_from = p_to then return; end if;
    v_allowed := case v_from
        when 'INITIATING' then array['PENDING', 'REJECTED', 'UNKNOWN', 'VERIFYING', 'MANUAL_REVIEW']
        when 'PENDING' then array['VERIFYING', 'CONFIRMED', 'FAILED', 'MANUAL_REVIEW']
        when 'UNKNOWN' then array['VERIFYING', 'EXPIRED', 'MANUAL_REVIEW']
        when 'VERIFYING' then array['CONFIRMED', 'FAILED', 'MANUAL_REVIEW']
        when 'EXPIRED' then array['MANUAL_REVIEW', 'CONFIRMED', 'FAILED']
        when 'MANUAL_REVIEW' then array['CONFIRMED', 'FAILED']
        when 'FAILED' then array['MANUAL_REVIEW']
        when 'CONFIRMED' then array['REVERSED']
        else array[]::text[] end;
    if not (p_to = any(v_allowed)) then raise exception 'payment_transition_invalid: % -> %', v_from, p_to; end if;
    update funding.payments set state = p_to, state_reason = p_cause, updated_at = now(),
        finalized_at = case when p_to in ('CONFIRMED', 'FAILED', 'REJECTED', 'REVERSED') then now() else finalized_at end
     where id = p_payment;
    insert into funding.payment_state_events(payment_id, from_state, to_state, cause, actor_id) values (p_payment, v_from, p_to, p_cause, p_actor);
end;
$$;

-- The credit and the CONFIRMED transition happen in the caller's transaction, so
-- both land or neither does. The ledger key makes a second call a no-op.
create or replace function funding.post_deposit_credit(p_payment uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p funding.payments; v_tx uuid;
begin
    select * into p from funding.payments where id = p_payment;
    if p.environment <> 'SANDBOX' then raise exception 'production_payments_disabled'; end if;
    select id into v_tx from funding.usd_ledger_transactions where idempotency_key = 'deposit-' || p.id;
    if found then return v_tx; end if;
    insert into funding.usd_ledger_transactions(environment, payment_id, idempotency_key, description)
    values (p.environment, p.id, 'deposit-' || p.id, 'Sandbox M-Pesa deposit (non-spendable test balance)') returning id into v_tx;
    insert into funding.usd_ledger_entries(transaction_id, environment, account_code, user_id, amount) values
        (v_tx, p.environment, 'CUSTOMER_TEST_BALANCE', p.user_id, p.usd_amount),
        (v_tx, p.environment, 'DEPOSIT_CLEARING', null, -p.usd_amount);
    update funding.payments set credit_transaction_id = v_tx, updated_at = now() where id = p.id;
    return v_tx;
end;
$$;

-- KES received for a payment, booked once when the provider confirms the money,
-- whether or not the USD credit can post.
create or replace function funding.book_kes_receipt(p_payment uuid, p_business_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare p funding.payments; q funding.deposit_quotes;
begin
    select * into p from funding.payments where id = p_payment;
    select * into q from funding.deposit_quotes where id = p.quote_id;
    insert into funding.kes_clearing_entries(environment, payment_id, kind, kes_amount, business_date) values
        (p.environment, p.id, 'RECEIPT', p.kes_due, p_business_date),
        (p.environment, p.id, 'ROUNDING', q.kes_rounding, p_business_date)
    on conflict (payment_id, kind) do nothing;
end;
$$;

-- USD liabilities for an environment. Sandbox: the test balances. Production:
-- Real ledger AVAILABLE and RESERVED plus the extra payout of open Real
-- contracts (their stake is already in RESERVED). Withdrawals and refunds do not
-- exist yet and add nothing.
create or replace function funding.liability_usd(p_environment text) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v numeric;
begin
    if p_environment = 'SANDBOX' then
        select coalesce(sum(amount), 0) into v from funding.usd_ledger_entries where account_code = 'CUSTOMER_TEST_BALANCE';
        return v;
    end if;
    select coalesce(sum(e.amount), 0) into v
      from public.ledger_entries e join public.ledger_accounts la on la.id = e.ledger_account_id
      join public.wallets w on w.id = la.wallet_id
     where w.ledger_scope = 'REAL' and la.kind in ('AVAILABLE', 'RESERVED');
    return v + coalesce((select sum(payout - stake) from public.engine_contracts where execution_mode = 'REAL' and state = 'OPEN'), 0);
end;
$$;

-- Deposits that could still become customer money: not final and not credited.
create or replace function funding.open_deposit_usd(p_environment text) returns numeric
language sql stable security definer set search_path = '' as $$
    select coalesce(sum(usd_amount), 0) from funding.payments
     where environment = p_environment and credit_transaction_id is null
       and state in ('INITIATING', 'PENDING', 'UNKNOWN', 'VERIFYING', 'MANUAL_REVIEW', 'EXPIRED');
$$;

-- Coverage of the stressed KES liability by the latest reserve snapshot after
-- adding p_extra_usd of liability, converted at the higher of the current rate
-- and p_floor_rate (the locked quote rate). A zero reserve covers nothing: the
-- first deposit against an empty treasury projects to INCIDENT.
create or replace function funding.coverage(p_environment text, p_extra_usd numeric, p_floor_rate numeric) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pol funding.deposit_policy_versions; r funding.fx_rate_versions; s funding.treasury_snapshots;
    v_liability numeric; v_rate numeric; v_stressed numeric; v_coverage_bp numeric; v_status text;
begin
    pol := funding.policy(); r := funding.current_rate();
    select * into s from funding.treasury_snapshots where environment = p_environment order by recorded_at desc, id desc limit 1;
    v_liability := funding.liability_usd(p_environment) + coalesce(p_extra_usd, 0);
    v_rate := greatest(r.kes_per_usd, coalesce(p_floor_rate, r.kes_per_usd));
    v_stressed := v_liability * v_rate * (10000 + pol.stress_bp) / 10000;
    if r.version is null or s.id is null or s.recorded_at < now() - make_interval(hours => pol.treasury_max_age_hours) then
        v_status := 'UNKNOWN';
    elsif v_stressed <= 0 then
        v_status := 'OK';
    else
        v_coverage_bp := floor(s.kes_liquid_reserve * 10000 / v_stressed);
        v_status := case when v_coverage_bp < pol.incident_coverage_bp then 'INCIDENT'
                         when v_coverage_bp < pol.pause_coverage_bp then 'PAUSED'
                         when v_coverage_bp < pol.alert_coverage_bp then 'ALERT'
                         else 'OK' end;
    end if;
    return jsonb_build_object('environment', p_environment, 'status', v_status, 'coverage_bp', v_coverage_bp,
        'kes_liquid_reserve', s.kes_liquid_reserve, 'snapshot_at', s.recorded_at, 'liability_usd', v_liability,
        'projected_extra_usd', coalesce(p_extra_usd, 0), 'stressed_kes_liability', round(v_stressed, 2),
        'kes_per_usd', v_rate, 'stress_bp', pol.stress_bp);
end;
$$;

create or replace function funding.treasury_status(p_environment text) returns jsonb
language sql stable security definer set search_path = '' as $$ select funding.coverage(p_environment, 0, null) $$;

create or replace function funding.coverage_refusal(p_coverage jsonb) returns text
language sql immutable set search_path = '' as $$
    select case when p_coverage->>'status' = 'UNKNOWN' then 'treasury_unknown'
                when p_coverage->>'status' in ('PAUSED', 'INCIDENT') then 'treasury_paused' end;
$$;

-- Customer limits on locked USD amounts (policy: per deposit, per rolling 24
-- hours, successful deposits per rolling 24 hours) and the provider KES ceiling.
-- A successful deposit is one credited in the last 24 hours. With p_include_open,
-- this customer's payments that could still be credited count as well, so
-- limits hold across concurrent and unresolved payments. Returns the refusal
-- code, or null.
create or replace function funding.limit_refusal(p_user uuid, p_environment text, p_usd numeric, p_kes integer, p_include_open boolean, p_exclude uuid default null)
returns text language plpgsql stable security definer set search_path = '' as $$
declare pol funding.deposit_policy_versions; v_count integer; v_sum numeric;
begin
    pol := funding.policy();
    if p_usd < pol.min_usd then return 'amount_below_minimum'; end if;
    if p_usd > pol.max_usd_per_deposit or p_kes > pol.max_kes then return 'amount_above_maximum'; end if;
    select count(*), coalesce(sum(p.usd_amount), 0) into v_count, v_sum
      from funding.payments p
     where p.user_id = p_user and p.environment = p_environment and p.id is distinct from p_exclude
       and (exists (select 1 from funding.usd_ledger_transactions t
                     where t.idempotency_key = 'deposit-' || p.id and t.created_at > now() - interval '24 hours')
            or (p_include_open and p.credit_transaction_id is null
                and p.state in ('INITIATING', 'PENDING', 'UNKNOWN', 'VERIFYING', 'MANUAL_REVIEW', 'EXPIRED')));
    if v_count + 1 > pol.max_deposits_rolling_24h or v_sum + p_usd > pol.max_usd_rolling_24h then return 'deposit_limit_reached'; end if;
    return null;
end;
$$;

-- The provider has confirmed the money for this payment. KES is booked as
-- received. Then, in this same transaction and under the environment's treasury
-- lock, the customer limits and the projected coverage (current liabilities plus
-- this credit) are checked again immediately before the USD credit posts. If
-- either fails, p_hold parks the paid payment in MANUAL_REVIEW as funded
-- suspense with no USD balance; without p_hold the refusal is raised and the
-- caller's transaction rolls back. Returns the hold reason, or null when credited.
create or replace function funding.confirm_and_credit(p_payment uuid, p_cause text, p_business_date date, p_hold boolean, p_actor uuid default null)
returns text language plpgsql security definer set search_path = '' as $$
declare p funding.payments; q funding.deposit_quotes; v_refusal text;
begin
    select * into p from funding.payments where id = p_payment for update;
    if p.environment <> 'SANDBOX' then raise exception 'production_payments_disabled'; end if;
    perform pg_advisory_xact_lock(hashtextextended('funding-treasury-' || p.environment, 0));
    select * into q from funding.deposit_quotes where id = p.quote_id;
    update funding.payments set provider_confirmed_at = coalesce(provider_confirmed_at, now()), updated_at = now() where id = p.id;
    perform funding.book_kes_receipt(p.id, p_business_date);
    v_refusal := coalesce(funding.limit_refusal(p.user_id, p.environment, p.usd_amount, p.kes_due, false, p.id),
                          funding.coverage_refusal(funding.coverage(p.environment, p.usd_amount, q.kes_per_usd)));
    if v_refusal is not null then
        if not p_hold then raise exception '%', v_refusal; end if;
        update funding.payments set attention_reason = 'funded_suspense_' || v_refusal where id = p.id;
        perform funding.transition(p.id, 'MANUAL_REVIEW', 'funded_suspense_' || v_refusal, p_actor);
        return v_refusal;
    end if;
    perform funding.transition(p.id, 'CONFIRMED', p_cause, p_actor);
    perform funding.post_deposit_credit(p.id);
    return null;
end;
$$;

create or replace function funding.record_event(p_payment uuid, p_environment text, p_source text, p_dedupe text, p_checkout text,
    p_merchant text, p_code text, p_desc text, p_amount numeric, p_receipt text, p_phone_masked text, p_payload_sha256 text, p_verdict text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
    insert into funding.provider_events(payment_id, environment, source, dedupe_key, checkout_request_id, merchant_request_id,
        result_code, result_desc, amount, receipt, phone_masked, payload_sha256, verdict)
    values (p_payment, p_environment, p_source, p_dedupe, p_checkout, p_merchant, p_code, left(p_desc, 200), p_amount, p_receipt, p_phone_masked, p_payload_sha256, p_verdict)
    on conflict (dedupe_key) do update set duplicate_count = funding.provider_events.duplicate_count + 1, last_seen_at = now();
    return (select duplicate_count = 0 from funding.provider_events where dedupe_key = p_dedupe);
end;
$$;

create or replace function funding.payment_view(p funding.payments) returns jsonb
language sql stable set search_path = '' as $$
    select jsonb_build_object('payment_id', p.id, 'environment', p.environment, 'state', p.state,
        'status_message', funding.status_message(p.state, p.environment), 'usd_amount', p.usd_amount, 'kes_due', p.kes_due,
        'phone_masked', p.phone_masked, 'mpesa_receipt', p.mpesa_receipt, 'created_at', p.created_at, 'finalized_at', p.finalized_at);
$$;

-- ---------------------------------------------------------------- customer RPCs

create or replace function public.funding_reference_rate() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r funding.fx_rate_versions; pol funding.deposit_policy_versions;
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    r := funding.current_rate(); pol := funding.policy();
    if r.version is null then raise exception 'rate_unavailable'; end if;
    return jsonb_build_object('pair', r.pair, 'kes_per_usd', r.kes_per_usd, 'rate_date', r.rate_date, 'source', r.source,
        'version', r.version, 'stale', funding.rate_is_stale(r.rate_date, pol.rate_max_age_hours), 'min_usd', pol.min_usd,
        'max_usd_per_deposit', pol.max_usd_per_deposit, 'max_usd_rolling_24h', pol.max_usd_rolling_24h,
        'max_deposits_rolling_24h', pol.max_deposits_rolling_24h, 'policy_version', pol.version,
        'quote_ttl_seconds', pol.quote_ttl_seconds, 'spread_bp', pol.spread_bp);
end;
$$;

create or replace function public.funding_create_deposit_quote(p_usd_amount numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); pol funding.deposit_policy_versions; r funding.fx_rate_versions; q funding.deposit_quotes; v_kes integer; v_refusal text;
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    perform funding.assert_environment_open('SANDBOX', v_user);
    pol := funding.policy(); r := funding.current_rate();
    if p_usd_amount is null or p_usd_amount <> round(p_usd_amount, 2) then raise exception 'amount_invalid'; end if;
    if p_usd_amount < pol.min_usd then raise exception 'amount_below_minimum'; end if;
    if p_usd_amount > pol.max_usd_per_deposit then raise exception 'amount_above_maximum'; end if;
    if r.version is null or r.kes_per_usd is null then raise exception 'rate_unavailable'; end if;
    if funding.rate_is_stale(r.rate_date, pol.rate_max_age_hours) then raise exception 'rate_stale'; end if;
    v_kes := ceil(p_usd_amount * r.kes_per_usd)::integer;
    v_refusal := funding.limit_refusal(v_user, 'SANDBOX', p_usd_amount, v_kes, true);
    if v_refusal is not null then raise exception '%', v_refusal; end if;
    insert into funding.deposit_quotes(user_id, environment, policy_version, rate_version, kes_per_usd, rate_date, usd_amount, kes_due, kes_rounding, expires_at)
    values (v_user, 'SANDBOX', pol.version, r.version, r.kes_per_usd, r.rate_date, p_usd_amount, v_kes, v_kes - p_usd_amount * r.kes_per_usd,
            now() + make_interval(secs => pol.quote_ttl_seconds))
    returning * into q;
    return jsonb_build_object('quote_id', q.id, 'environment', q.environment, 'usd_amount', q.usd_amount, 'kes_due', q.kes_due,
        'kes_per_usd', q.kes_per_usd, 'rate_date', q.rate_date, 'rate_source', r.source, 'rate_version', q.rate_version,
        'expires_at', q.expires_at);
end;
$$;

create or replace function public.funding_my_payments() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    return coalesce((select jsonb_agg(v order by created_at desc)
        from (select funding.payment_view(p) v, p.created_at from funding.payments p
               where p.user_id = auth.uid() order by p.created_at desc limit 50) s), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- service RPCs

-- Consumes a quote. Customer limits count this customer's credited and
-- still-open deposits; the projected coverage counts current liabilities, every
-- open deposit in the environment and this one. The environment's treasury lock
-- serializes concurrent admissions so two deposits cannot each pass against the
-- same headroom.
create or replace function public.funding_svc_begin_payment(p_user uuid, p_quote uuid, p_phone text, p_idempotency_key text, p_callback_token_hash text, p_shortcode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p funding.payments; q funding.deposit_quotes; v_ref text; v_refusal text;
begin
    if p_user is null or p_quote is null then raise exception 'validation_failed'; end if;
    if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then raise exception 'validation_failed'; end if;
    perform pg_advisory_xact_lock(hashtextextended('funding-user-' || p_user::text, 0));
    select * into p from funding.payments where user_id = p_user and idempotency_key = p_idempotency_key;
    if found then
        if p.quote_id <> p_quote then raise exception 'idempotency_key_reused'; end if;
        return funding.payment_view(p) || jsonb_build_object('existing', true, 'account_reference', p.account_reference);
    end if;
    if p_phone is null or p_phone !~ '^254(7|1)[0-9]{8}$' then raise exception 'phone_invalid'; end if;
    if p_callback_token_hash is null or p_callback_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'validation_failed'; end if;
    if p_shortcode is null or p_shortcode !~ '^[0-9]{5,8}$' then raise exception 'validation_failed'; end if;
    select * into q from funding.deposit_quotes where id = p_quote and user_id = p_user;
    if not found then raise exception 'quote_not_found'; end if;
    perform funding.assert_environment_open(q.environment, p_user);
    if q.expires_at <= now() then raise exception 'quote_expired'; end if;
    if exists (select 1 from funding.payments where quote_id = q.id) then raise exception 'quote_used'; end if;
    if exists (select 1 from funding.payments where user_id = p_user and state in ('INITIATING', 'PENDING', 'UNKNOWN', 'VERIFYING')) then
        raise exception 'payment_in_progress';
    end if;
    v_refusal := funding.limit_refusal(p_user, q.environment, q.usd_amount, q.kes_due, true);
    if v_refusal is not null then raise exception '%', v_refusal; end if;
    perform pg_advisory_xact_lock(hashtextextended('funding-treasury-' || q.environment, 0));
    v_refusal := funding.coverage_refusal(funding.coverage(q.environment, funding.open_deposit_usd(q.environment) + q.usd_amount, q.kes_per_usd));
    if v_refusal is not null then raise exception '%', v_refusal; end if;
    v_ref := 'SP' || upper(substr(replace(public.gen_random_uuid()::text, '-', ''), 1, 10));
    insert into funding.payments(quote_id, user_id, environment, usd_amount, kes_due, idempotency_key, shortcode, state, callback_token_hash,
        phone_masked, phone_hash, account_reference)
    values (q.id, p_user, q.environment, q.usd_amount, q.kes_due, p_idempotency_key, p_shortcode, 'INITIATING', p_callback_token_hash,
        left(p_phone, 4) || '*****' || right(p_phone, 3), funding.sha256_hex(p_phone), v_ref)
    returning * into p;
    insert into funding.payment_state_events(payment_id, from_state, to_state, cause) values (p.id, null, 'INITIATING', 'customer_request');
    return funding.payment_view(p) || jsonb_build_object('existing', false, 'account_reference', p.account_reference);
end;
$$;

-- p_outcome: ACCEPTED (ResponseCode 0 with a CheckoutRequestID), REJECTED (Daraja
-- refused the request) or AMBIGUOUS (timeout, 5xx or network failure).
create or replace function public.funding_svc_record_initiation(p_payment uuid, p_outcome text, p_merchant_request_id text,
    p_checkout_request_id text, p_response_code text, p_response_desc text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p funding.payments;
begin
    if p_outcome not in ('ACCEPTED', 'REJECTED', 'AMBIGUOUS') then raise exception 'validation_failed'; end if;
    if p_outcome = 'ACCEPTED' and nullif(btrim(p_checkout_request_id), '') is null then raise exception 'validation_failed'; end if;
    select * into p from funding.payments where id = p_payment for update;
    if not found then raise exception 'payment_not_found'; end if;
    perform funding.record_event(p.id, p.environment, 'INITIATION', 'INITIATION|' || p.id, p_checkout_request_id, p_merchant_request_id,
        p_response_code, p_response_desc, null, null, null, null,
        case when p.state = 'INITIATING' then 'APPLIED' else 'LATE' end);
    if p_outcome = 'ACCEPTED' then
        if p.checkout_request_id is not null and p.checkout_request_id <> p_checkout_request_id then
            update funding.payments set attention_reason = 'initiation_checkout_conflict' where id = p.id;
            perform funding.transition(p.id, 'MANUAL_REVIEW', 'initiation_checkout_conflict');
        else
            update funding.payments set checkout_request_id = p_checkout_request_id, merchant_request_id = coalesce(merchant_request_id, p_merchant_request_id),
                initiated_at = coalesce(initiated_at, now()), updated_at = now() where id = p.id;
            if p.state = 'INITIATING' then perform funding.transition(p.id, 'PENDING', 'provider_accepted'); end if;
        end if;
    elsif p.state = 'INITIATING' then
        update funding.payments set provider_result_code = p_response_code, provider_result_desc = left(p_response_desc, 200) where id = p.id;
        perform funding.transition(p.id, case p_outcome when 'REJECTED' then 'REJECTED' else 'UNKNOWN' end,
            case p_outcome when 'REJECTED' then 'provider_rejected' else 'initiation_outcome_unknown' end);
    end if;
    select * into p from funding.payments where id = p_payment;
    return funding.payment_view(p);
end;
$$;

-- A callback is an untrusted notification. The per-payment URL token only
-- correlates it with a payment; the token travels in a query string and must be
-- assumed observable in provider or platform logs. A callback is recorded and
-- never credits, and it never supplies the checkout id that STK Query verifies:
-- that id comes only from the synchronous STK Push response (initiated_at). For
-- a payment without one (UNKNOWN, abandoned INITIATING, EXPIRED) the callback's
-- claimed checkout id could be another customer's successful payment, and STK
-- Query of that id would prove only that someone paid. Such a callback is
-- recorded as UNBOUND and the payment goes to MANUAL_REVIEW, which needs a
-- matching provider statement item to credit. needs_query tells the Edge
-- Function to query the bound checkout id.
create or replace function public.funding_svc_record_callback(p_token_hash text, p_checkout_request_id text, p_merchant_request_id text,
    p_result_code integer, p_result_desc text, p_amount numeric, p_receipt text, p_phone text, p_payload_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p funding.payments; v_dedupe text; v_first boolean; v_masked text; v_verdict text := 'APPLIED';
begin
    if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('accepted', false); end if;
    select * into p from funding.payments where callback_token_hash = p_token_hash for update;
    if not found then return jsonb_build_object('accepted', false); end if;
    if nullif(btrim(p_checkout_request_id), '') is null or p_result_code is null then
        perform funding.record_event(p.id, p.environment, 'CALLBACK', 'CALLBACK-MALFORMED|' || p.id || '|' || coalesce(p_payload_sha256, ''),
            p_checkout_request_id, p_merchant_request_id, p_result_code::text, p_result_desc, null, null, null, p_payload_sha256, 'MISMATCH');
        return jsonb_build_object('accepted', true, 'payment_id', p.id, 'needs_query', p.initiated_at is not null and p.state in ('PENDING', 'VERIFYING'),
            'checkout_request_id', p.checkout_request_id);
    end if;
    v_masked := case when p_phone ~ '^[0-9]{12}$' then left(p_phone, 4) || '*****' || right(p_phone, 3) end;
    v_dedupe := 'CALLBACK|' || p_checkout_request_id || '|' || p_result_code || '|' || coalesce(p_receipt, '');

    if p.initiated_at is null then
        v_first := funding.record_event(p.id, p.environment, 'CALLBACK', v_dedupe, p_checkout_request_id, p_merchant_request_id, p_result_code::text,
            p_result_desc, p_amount, p_receipt, v_masked, p_payload_sha256, 'UNBOUND');
        if v_first then
            update funding.payments set callback_checkout_request_id = p_checkout_request_id,
                attention_reason = 'callback_without_initiation_checkout', updated_at = now() where id = p.id;
            if p.state in ('INITIATING', 'UNKNOWN', 'EXPIRED') then
                perform funding.transition(p.id, 'MANUAL_REVIEW', 'callback_without_initiation_checkout');
            end if;
        end if;
        return jsonb_build_object('accepted', true, 'payment_id', p.id, 'needs_query', false);
    end if;

    if p.checkout_request_id <> p_checkout_request_id then
        v_first := funding.record_event(p.id, p.environment, 'CALLBACK', v_dedupe, p_checkout_request_id, p_merchant_request_id, p_result_code::text,
            p_result_desc, p_amount, p_receipt, v_masked, p_payload_sha256, 'CONFLICT');
        if p.state in ('INITIATING', 'PENDING', 'UNKNOWN', 'VERIFYING') then
            update funding.payments set attention_reason = 'callback_checkout_conflict' where id = p.id;
            perform funding.transition(p.id, 'MANUAL_REVIEW', 'callback_checkout_conflict');
        end if;
        return jsonb_build_object('accepted', true, 'payment_id', p.id, 'needs_query', false);
    end if;

    if p.state in ('INITIATING', 'PENDING', 'UNKNOWN', 'VERIFYING') then
        if p.callback_result_code is not null and p.callback_result_code <> p_result_code then v_verdict := 'CONFLICT'; end if;
        if p_result_code = 0 and p_amount is distinct from p.kes_due::numeric then v_verdict := 'MISMATCH'; end if;
        -- A claimed receipt already verified for, or already claimed by, another payment.
        if v_verdict = 'APPLIED' and p_result_code = 0 and p_receipt is not null
           and (exists (select 1 from funding.payments where mpesa_receipt = p_receipt and id <> p.id)
                or exists (select 1 from funding.provider_events e where e.receipt = p_receipt and e.source = 'CALLBACK'
                            and e.verdict = 'APPLIED' and e.payment_id <> p.id)) then v_verdict := 'CONFLICT'; end if;
    elsif p.state = 'FAILED' and p_result_code = 0 then v_verdict := 'CONFLICT';
    elsif p.state = 'CONFIRMED' and p_result_code <> 0 then v_verdict := 'CONFLICT';
    else v_verdict := 'LATE';
    end if;

    v_first := funding.record_event(p.id, p.environment, 'CALLBACK', v_dedupe, p_checkout_request_id, p_merchant_request_id, p_result_code::text,
        p_result_desc, p_amount, p_receipt, v_masked, p_payload_sha256, v_verdict);
    if not v_first then
        return jsonb_build_object('accepted', true, 'duplicate', true, 'payment_id', p.id, 'checkout_request_id', p.checkout_request_id,
            'needs_query', p.state in ('PENDING', 'VERIFYING'));
    end if;

    if p.state in ('INITIATING', 'PENDING', 'UNKNOWN', 'VERIFYING') then
        update funding.payments set merchant_request_id = coalesce(merchant_request_id, p_merchant_request_id),
            callback_result_code = case when v_verdict = 'APPLIED' then p_result_code else callback_result_code end,
            callback_amount = case when v_verdict = 'APPLIED' and p_result_code = 0 then p_amount else callback_amount end,
            updated_at = now() where id = p.id;
        if v_verdict = 'APPLIED' then
            perform funding.transition(p.id, 'VERIFYING', 'callback_received');
        else
            update funding.payments set attention_reason = 'callback_' || lower(v_verdict) where id = p.id;
            perform funding.transition(p.id, 'MANUAL_REVIEW', 'callback_' || lower(v_verdict));
        end if;
    elsif v_verdict = 'CONFLICT' then
        update funding.payments set attention_reason = 'late_callback_conflict' where id = p.id;
        if p.state = 'FAILED' then perform funding.transition(p.id, 'MANUAL_REVIEW', 'late_success_after_failure'); end if;
    end if;
    select * into p from funding.payments where id = p.id;
    return jsonb_build_object('accepted', true, 'payment_id', p.id, 'checkout_request_id', p.checkout_request_id,
        'needs_query', p.state = 'VERIFYING');
end;
$$;

-- The server's own STK Push Query result for the checkout id returned by the
-- synchronous STK Push response. p_outcome: RESULT (a final ResultCode),
-- PROCESSING (still being processed) or ERROR (query failed). Only a RESULT of 0
-- whose facts agree with any callback confirms the payment, and the credit then
-- goes through funding.confirm_and_credit (limits and projected coverage).
create or replace function public.funding_svc_record_status(p_payment uuid, p_checkout_request_id text, p_outcome text, p_result_code text, p_result_desc text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p funding.payments; v_verdict text := 'APPLIED'; v_dedupe text;
begin
    if p_outcome not in ('RESULT', 'PROCESSING', 'ERROR') then raise exception 'validation_failed'; end if;
    if p_outcome = 'RESULT' and (p_result_code is null or p_result_code !~ '^[0-9]+$') then raise exception 'validation_failed'; end if;
    select * into p from funding.payments where id = p_payment for update;
    if not found then raise exception 'payment_not_found'; end if;
    if p.initiated_at is null or p.checkout_request_id is null or p.checkout_request_id <> p_checkout_request_id then raise exception 'checkout_mismatch'; end if;
    v_dedupe := case when p_outcome = 'RESULT' then 'STATUS|' || p_checkout_request_id || '|' || p_result_code
                     else 'STATUS-' || p_outcome || '|' || p_checkout_request_id || '|' || to_char(date_trunc('minute', now()) at time zone 'UTC', 'YYYYMMDDHH24MI') end;

    if p.state not in ('PENDING', 'VERIFYING') then
        v_verdict := case when p_outcome = 'RESULT' and ((p.state = 'CONFIRMED' and p_result_code <> '0') or (p.state = 'FAILED' and p_result_code = '0'))
                          then 'CONFLICT' else 'LATE' end;
        perform funding.record_event(p.id, p.environment, 'STATUS_QUERY', v_dedupe, p_checkout_request_id, null, p_result_code, p_result_desc,
            null, null, null, null, v_verdict);
        if v_verdict = 'CONFLICT' then
            update funding.payments set attention_reason = 'status_conflict_after_final' where id = p.id;
            if p.state = 'FAILED' then perform funding.transition(p.id, 'MANUAL_REVIEW', 'late_success_after_failure'); end if;
        end if;
        select * into p from funding.payments where id = p.id;
        return funding.payment_view(p);
    end if;

    if p_outcome <> 'RESULT' then
        perform funding.record_event(p.id, p.environment, 'STATUS_QUERY', v_dedupe, p_checkout_request_id, null, p_result_code, p_result_desc,
            null, null, null, null, 'INFORMATIONAL');
        if p.created_at < now() - interval '24 hours' then
            update funding.payments set attention_reason = 'provider_unresolved_24h' where id = p.id;
            perform funding.transition(p.id, 'MANUAL_REVIEW', 'provider_unresolved_24h');
        end if;
        select * into p from funding.payments where id = p.id;
        return funding.payment_view(p);
    end if;

    perform funding.record_event(p.id, p.environment, 'STATUS_QUERY', v_dedupe, p_checkout_request_id, null, p_result_code, p_result_desc,
        null, null, null, null, 'APPLIED');
    update funding.payments set provider_result_code = p_result_code, provider_result_desc = left(p_result_desc, 200), updated_at = now() where id = p.id;
    if p_result_code = '0' then
        if p.callback_result_code is not null and p.callback_result_code <> 0 then
            update funding.payments set attention_reason = 'status_success_callback_failure' where id = p.id;
            perform funding.transition(p.id, 'MANUAL_REVIEW', 'status_success_callback_failure');
        elsif p.callback_amount is not null and p.callback_amount <> p.kes_due then
            update funding.payments set attention_reason = 'amount_mismatch' where id = p.id;
            perform funding.transition(p.id, 'MANUAL_REVIEW', 'amount_mismatch');
        else
            -- STK Query confirms the checkout's status, not a receipt: the transaction
            -- identity stays unverified until a statement item binds it (BIND_RECEIPT).
            update funding.payments set receipt_pending = (statement_item_id is null) where id = p.id;
            perform funding.confirm_and_credit(p.id, 'provider_status_confirmed', funding.nairobi_date(now()), true);
        end if;
    else
        if p.callback_result_code = 0 then
            update funding.payments set attention_reason = 'status_failure_callback_success' where id = p.id;
            perform funding.transition(p.id, 'MANUAL_REVIEW', 'status_failure_callback_success');
        else
            perform funding.transition(p.id, 'FAILED', 'provider_result_' || p_result_code);
        end if;
    end if;
    select * into p from funding.payments where id = p.id;
    return funding.payment_view(p);
end;
$$;

create or replace function public.funding_svc_open_payments(p_min_age_seconds integer default 60, p_limit integer default 50)
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object('payment_id', id, 'state', state, 'checkout_request_id', checkout_request_id,
        'environment', environment, 'created_at', created_at) order by created_at), '[]'::jsonb)
      from (select * from funding.payments
             where state in ('PENDING', 'VERIFYING') and initiated_at is not null
               and updated_at <= now() - make_interval(secs => greatest(p_min_age_seconds, 0))
             order by created_at limit least(greatest(p_limit, 1), 200)) p;
$$;

-- INITIATING for over 2 minutes means the Edge Function died mid-push: treat it
-- as an ambiguous initiation. UNKNOWN for 24 hours (no callback arrived; one
-- would have moved it to MANUAL_REVIEW) becomes EXPIRED for the operator's
-- statement check. Never re-pushed.
create or replace function public.funding_svc_expire_stale() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_unknown integer := 0; v_expired integer := 0;
begin
    for r in select id from funding.payments where state = 'INITIATING' and created_at < now() - interval '2 minutes' for update skip locked loop
        perform funding.transition(r.id, 'UNKNOWN', 'initiation_abandoned'); v_unknown := v_unknown + 1;
    end loop;
    for r in select id from funding.payments where state = 'UNKNOWN' and created_at < now() - interval '24 hours' for update skip locked loop
        update funding.payments set attention_reason = 'unknown_expired' where id = r.id;
        perform funding.transition(r.id, 'EXPIRED', 'unknown_expired'); v_expired := v_expired + 1;
    end loop;
    return jsonb_build_object('to_unknown', v_unknown, 'expired', v_expired);
end;
$$;

-- Daily reconciliation. USD: every credit and reversal against its payment and
-- the customer balance total. KES: every provider-confirmed payment has exactly
-- its kes_due booked as received, and the day's statement rolls forward
-- (opening + gross - reversals - fees - net settlement = closing), opens at the
-- previous day's close and matches the booked gross and reversals, and every
-- statement item of the day belongs to a payment. A missing statement is itself
-- a difference. Differences stay
-- open until an owner who did not record the statement resolves the run.
create or replace function public.funding_svc_reconcile(p_environment text, p_business_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_diff jsonb := '[]'::jsonb; v_summary jsonb; v_run uuid; v_ledger numeric; v_expected numeric; r record;
    st funding.statement_totals; prev funding.statement_totals; v_gross numeric; v_reversals numeric; v_suspense numeric;
begin
    if p_environment not in ('SANDBOX', 'PRODUCTION') or p_business_date is null then raise exception 'validation_failed'; end if;
    -- 1. Every credited payment has exactly one credit of its locked USD amount.
    for r in select p.id, p.state, p.usd_amount,
                    (select coalesce(sum(e.amount), 0) from funding.usd_ledger_transactions t join funding.usd_ledger_entries e on e.transaction_id = t.id
                      where t.payment_id = p.id and e.account_code = 'CUSTOMER_TEST_BALANCE') ledger,
                    (select count(*) from funding.usd_ledger_transactions t where t.payment_id = p.id) tx_count
               from funding.payments p where p.environment = p_environment loop
        if r.state = 'CONFIRMED' and (r.ledger <> r.usd_amount or r.tx_count <> 1) then
            v_diff := v_diff || jsonb_build_object('kind', 'credit_mismatch', 'payment_id', r.id, 'expected', r.usd_amount, 'ledger', r.ledger);
        elsif r.state = 'REVERSED' and (r.ledger <> 0 or r.tx_count <> 2) then
            v_diff := v_diff || jsonb_build_object('kind', 'reversal_mismatch', 'payment_id', r.id, 'ledger', r.ledger);
        elsif r.state not in ('CONFIRMED', 'REVERSED') and r.tx_count <> 0 then
            v_diff := v_diff || jsonb_build_object('kind', 'uncredited_state_has_ledger', 'payment_id', r.id, 'state', r.state);
        end if;
    end loop;
    -- 2. Customer balances equal confirmed credits minus reversals.
    select coalesce(sum(amount), 0) into v_ledger from funding.usd_ledger_entries where environment = p_environment and account_code = 'CUSTOMER_TEST_BALANCE';
    select coalesce(sum(usd_amount), 0) into v_expected from funding.payments where environment = p_environment and state = 'CONFIRMED';
    if v_ledger <> v_expected then
        v_diff := v_diff || jsonb_build_object('kind', 'balance_total_mismatch', 'ledger', v_ledger, 'expected', v_expected);
    end if;
    -- 3. KES: a provider-confirmed payment has exactly its kes_due booked as received; nothing else has a receipt.
    for r in select p.id, p.kes_due, p.provider_confirmed_at,
                    (select e.kes_amount from funding.kes_clearing_entries e where e.payment_id = p.id and e.kind = 'RECEIPT') receipt
               from funding.payments p where p.environment = p_environment loop
        if r.provider_confirmed_at is not null and r.receipt is distinct from r.kes_due::numeric then
            v_diff := v_diff || jsonb_build_object('kind', 'kes_receipt_mismatch', 'payment_id', r.id, 'kes_due', r.kes_due, 'kes_booked', r.receipt);
        elsif r.provider_confirmed_at is null and r.receipt is not null then
            v_diff := v_diff || jsonb_build_object('kind', 'kes_receipt_without_confirmation', 'payment_id', r.id, 'kes_booked', r.receipt);
        end if;
    end loop;
    select coalesce(sum(kes_amount) filter (where kind = 'RECEIPT'), 0), coalesce(-sum(kes_amount) filter (where kind = 'REVERSAL'), 0)
      into v_gross, v_reversals
      from funding.kes_clearing_entries where environment = p_environment and business_date = p_business_date;
    -- Money received whose USD credit is held (funded suspense): owed to customers, not yet in the USD ledger.
    select coalesce(sum(kes_due), 0) into v_suspense from funding.payments
     where environment = p_environment and provider_confirmed_at is not null and credit_transaction_id is null;
    -- 4. The day's provider statement.
    select * into st from funding.statement_totals where environment = p_environment and business_date = p_business_date order by id desc limit 1;
    if st.id is null then
        v_diff := v_diff || jsonb_build_object('kind', 'statement_missing', 'business_date', p_business_date);
    else
        if st.kes_gross <> v_gross then
            v_diff := v_diff || jsonb_build_object('kind', 'statement_gross_mismatch', 'statement_kes_gross', st.kes_gross, 'kes_booked', v_gross);
        end if;
        if st.kes_reversals <> v_reversals then
            v_diff := v_diff || jsonb_build_object('kind', 'statement_reversals_mismatch', 'statement_kes_reversals', st.kes_reversals, 'kes_booked', v_reversals);
        end if;
        if st.kes_opening_balance + st.kes_gross - st.kes_reversals - st.kes_fees - st.kes_net_settlement <> st.kes_closing_balance then
            v_diff := v_diff || jsonb_build_object('kind', 'statement_rollforward_mismatch',
                'expected_closing', st.kes_opening_balance + st.kes_gross - st.kes_reversals - st.kes_fees - st.kes_net_settlement,
                'statement_closing', st.kes_closing_balance);
        end if;
        select * into prev from funding.statement_totals where environment = p_environment and business_date < p_business_date
         order by business_date desc, id desc limit 1;
        if prev.id is not null and prev.business_date <> p_business_date - 1 then
            v_diff := v_diff || jsonb_build_object('kind', 'statement_gap', 'previous_business_date', prev.business_date);
        elsif prev.id is not null and prev.kes_closing_balance <> st.kes_opening_balance then
            v_diff := v_diff || jsonb_build_object('kind', 'statement_opening_mismatch', 'previous_closing', prev.kes_closing_balance, 'opening', st.kes_opening_balance);
        end if;
    end if;
    -- 5. Every statement item of the day belongs to a payment (bound item, or its receipt): money on the statement is in the books.
    for r in select s.id, s.receipt, s.kes_amount from funding.provider_statement_items s
              where s.environment = p_environment and s.business_date = p_business_date
                and not exists (select 1 from funding.payments p where p.environment = s.environment and (p.statement_item_id = s.id or p.mpesa_receipt = s.receipt)) loop
        v_diff := v_diff || jsonb_build_object('kind', 'statement_item_unmatched', 'statement_item_id', r.id, 'receipt', r.receipt, 'kes_amount', r.kes_amount);
    end loop;
    -- 6. A credit whose transaction identity no statement item has verified keeps the run open.
    for r in select id from funding.payments where environment = p_environment and state = 'CONFIRMED' and receipt_pending loop
        v_diff := v_diff || jsonb_build_object('kind', 'receipt_unverified', 'payment_id', r.id);
    end loop;
    -- 7. Open payments past their window, and payments needing review (including funded suspense).
    for r in select id, state, attention_reason from funding.payments where environment = p_environment
               and ((state in ('INITIATING', 'PENDING', 'VERIFYING') and created_at < now() - interval '30 minutes') or state in ('MANUAL_REVIEW', 'EXPIRED')) loop
        v_diff := v_diff || jsonb_build_object('kind', 'needs_attention', 'payment_id', r.id, 'state', r.state, 'reason', r.attention_reason);
    end loop;
    v_summary := jsonb_build_object('customer_balance_usd', v_ledger, 'confirmed_usd', v_expected,
        'kes', jsonb_build_object('gross_booked', v_gross, 'reversals_booked', v_reversals, 'funded_suspense', v_suspense),
        'statement', case when st.id is null then null else jsonb_build_object('id', st.id, 'evidence_kind', st.evidence_kind,
            'simulated', st.evidence_kind = 'SANDBOX_SIMULATED', 'evidence_reference', st.evidence_reference, 'evidence_sha256', st.evidence_sha256,
            'opening', st.kes_opening_balance, 'gross', st.kes_gross, 'reversals', st.kes_reversals, 'fees', st.kes_fees,
            'net_settlement', st.kes_net_settlement, 'closing', st.kes_closing_balance) end,
        'receipt_pending', (select count(*) from funding.payments where environment = p_environment and state = 'CONFIRMED' and receipt_pending),
        'treasury', funding.treasury_status(p_environment));
    insert into funding.reconciliation_runs(environment, business_date, status, summary, differences)
    values (p_environment, p_business_date, case when jsonb_array_length(v_diff) = 0 then 'MATCHED' else 'DIFFERENCES' end, v_summary, v_diff)
    returning id into v_run;
    return jsonb_build_object('run_id', v_run, 'status', case when jsonb_array_length(v_diff) = 0 then 'MATCHED' else 'DIFFERENCES' end,
        'summary', v_summary, 'differences', v_diff);
end;
$$;

-- ---------------------------------------------------------------- staff RPCs

create or replace function funding.audit(p_action text, p_target uuid, p_reason text, p_after jsonb) returns void
language sql security definer set search_path = '' as $$
    insert into public.admin_audit_events(actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state)
    values (auth.uid(), 'staff', p_action, 'funding', coalesce(p_target, public.gen_random_uuid()), public.gen_random_uuid(), btrim(p_reason), p_after);
$$;

create or replace function funding.require_reason(p_reason text) returns void language plpgsql immutable set search_path = '' as $$
begin if char_length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'validation_failed'; end if; end;
$$;

create or replace function public.funding_publish_rate(p_kes_per_usd numeric, p_rate_date date, p_source_reference text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r funding.fx_rate_versions;
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_reason);
    if p_kes_per_usd is null or p_kes_per_usd <> round(p_kes_per_usd, 4) or p_kes_per_usd not between 50 and 500 then raise exception 'rate_invalid'; end if;
    if p_rate_date is null or p_rate_date > funding.nairobi_date(now()) then raise exception 'rate_invalid'; end if;
    insert into funding.fx_rate_versions(kes_per_usd, rate_date, source, source_reference, published_by, note)
    values (p_kes_per_usd, p_rate_date, 'CBK', btrim(coalesce(p_source_reference, '')), auth.uid(), btrim(p_reason)) returning * into r;
    perform funding.audit('funding.rate_publish', null, p_reason, jsonb_build_object('version', r.version, 'kes_per_usd', r.kes_per_usd, 'rate_date', r.rate_date));
    return jsonb_build_object('version', r.version, 'kes_per_usd', r.kes_per_usd, 'rate_date', r.rate_date);
end;
$$;

create or replace function public.funding_record_treasury_snapshot(p_environment text, p_kes_liquid_reserve numeric, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_note);
    if p_environment not in ('SANDBOX', 'PRODUCTION') or p_kes_liquid_reserve is null or p_kes_liquid_reserve < 0 then raise exception 'validation_failed'; end if;
    insert into funding.treasury_snapshots(environment, kes_liquid_reserve, recorded_by, note) values (p_environment, p_kes_liquid_reserve, auth.uid(), btrim(p_note));
    perform funding.audit('funding.treasury_snapshot', null, p_note, jsonb_build_object('environment', p_environment, 'kes_liquid_reserve', p_kes_liquid_reserve));
    return funding.treasury_status(p_environment);
end;
$$;

create or replace function public.funding_set_sandbox_module(p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_reason);
    update public.platform_modules set enabled = coalesce(p_enabled, false), changed_at = now(), reason = btrim(p_reason) where module_key = 'daraja_sandbox';
    perform funding.audit('funding.sandbox_module', null, p_reason, jsonb_build_object('enabled', coalesce(p_enabled, false)));
end;
$$;

create or replace function public.funding_set_sandbox_tester(p_user uuid, p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_reason);
    if not exists (select 1 from auth.users where id = p_user) then raise exception 'not_found'; end if;
    insert into funding.sandbox_testers(user_id, enabled, changed_by, reason) values (p_user, coalesce(p_enabled, false), auth.uid(), btrim(p_reason))
    on conflict (user_id) do update set enabled = excluded.enabled, changed_at = now(), changed_by = excluded.changed_by, reason = excluded.reason;
    perform funding.audit('funding.sandbox_tester', p_user, p_reason, jsonb_build_object('user_id', p_user, 'enabled', coalesce(p_enabled, false)));
end;
$$;

-- Records one provider statement line as evidence. The phone number, when the
-- statement shows it, is kept only as a hash and a masked form.
create or replace function public.funding_record_statement_item(p_environment text, p_receipt text, p_kes_amount numeric, p_shortcode text,
    p_transaction_at timestamptz, p_account_reference text, p_msisdn text, p_evidence_kind text, p_evidence_reference text,
    p_evidence_sha256 text, p_note text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_note);
    if p_environment not in ('SANDBOX', 'PRODUCTION') or p_transaction_at is null or p_transaction_at > now() + interval '5 minutes'
       or (p_msisdn is not null and p_msisdn !~ '^254(7|1)[0-9]{8}$') or p_kes_amount is null or p_kes_amount <> round(p_kes_amount, 2) then
        raise exception 'validation_failed';
    end if;
    begin
        insert into funding.provider_statement_items(environment, receipt, kes_amount, shortcode, transaction_at, business_date, account_reference,
            phone_hash, phone_masked, evidence_kind, evidence_reference, evidence_sha256, recorded_by, note)
        values (p_environment, p_receipt, p_kes_amount, p_shortcode, p_transaction_at, funding.nairobi_date(p_transaction_at), p_account_reference,
            case when p_msisdn is not null then funding.sha256_hex(p_msisdn) end,
            case when p_msisdn is not null then left(p_msisdn, 4) || '*****' || right(p_msisdn, 3) end,
            p_evidence_kind, btrim(coalesce(p_evidence_reference, '')), p_evidence_sha256, auth.uid(), btrim(p_note))
        returning id into v_id;
    exception
        when unique_violation then raise exception 'statement_item_duplicate';
        when check_violation or not_null_violation then raise exception 'validation_failed';
    end;
    perform funding.audit('funding.statement_item', null, p_note, jsonb_build_object('statement_item_id', v_id, 'environment', p_environment,
        'receipt', p_receipt, 'kes_amount', p_kes_amount, 'evidence_kind', p_evidence_kind, 'evidence_sha256', p_evidence_sha256));
    return v_id;
end;
$$;

-- Why a statement item cannot confirm this payment, or null when it binds: same
-- environment, exact KES, same shortcode, matching account reference and/or phone
-- (at least one is on every item), a transaction inside the payment's window, no
-- item already bound to this payment, and an item and receipt no other payment
-- uses. A callback's claimed receipt plays no part: it is never authoritative.
create or replace function funding.statement_binding_refusal(p funding.payments, s funding.provider_statement_items) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
    if s.id is null then return 'statement_item_not_found'; end if;
    if s.environment <> p.environment then return 'environment'; end if;
    if s.kes_amount <> p.kes_due then return 'kes_amount'; end if;
    if s.shortcode <> p.shortcode then return 'shortcode'; end if;
    if s.account_reference is not null and s.account_reference <> p.account_reference then return 'account_reference'; end if;
    if s.phone_hash is not null and s.phone_hash <> p.phone_hash then return 'phone'; end if;
    if s.transaction_at < p.created_at - interval '10 minutes' or s.transaction_at > p.created_at + interval '24 hours' then return 'transaction_time'; end if;
    if p.statement_item_id is not null then return 'already_bound'; end if;
    if exists (select 1 from funding.payments o where o.id <> p.id and (o.statement_item_id = s.id or o.mpesa_receipt = s.receipt)) then return 'already_used'; end if;
    return null;
end;
$$;

-- RESOLVE_CONFIRMED (a payment in review) and BIND_RECEIPT (a status-confirmed
-- payment whose receipt is still unverified) must cite a provider statement item
-- that binds to the payment, and whoever recorded that item may not request it.
-- RESOLVE_FAILED is refused once the provider has confirmed the money.
create or replace function public.funding_request_action(p_payment uuid, p_kind text, p_reason text, p_statement_item bigint default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare p funding.payments; s funding.provider_statement_items; v_id uuid; v_refusal text;
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_reason);
    if p_kind is null or p_kind not in ('REVERSE', 'RESOLVE_CONFIRMED', 'RESOLVE_FAILED', 'BIND_RECEIPT') then raise exception 'validation_failed'; end if;
    select * into p from funding.payments where id = p_payment for update;
    if not found then raise exception 'payment_not_found'; end if;
    if p_kind = 'REVERSE' and p.state <> 'CONFIRMED' then raise exception 'payment_state_invalid'; end if;
    if p_kind in ('RESOLVE_CONFIRMED', 'RESOLVE_FAILED') and p.state not in ('MANUAL_REVIEW', 'EXPIRED') then raise exception 'payment_state_invalid'; end if;
    if p_kind = 'BIND_RECEIPT' and (p.state <> 'CONFIRMED' or p.statement_item_id is not null) then raise exception 'payment_state_invalid'; end if;
    if p_kind in ('RESOLVE_CONFIRMED', 'BIND_RECEIPT') then
        if p_statement_item is null then raise exception 'statement_evidence_required'; end if;
        select * into s from funding.provider_statement_items where id = p_statement_item;
        v_refusal := funding.statement_binding_refusal(p, s);
        if v_refusal is not null then raise exception 'statement_evidence_invalid: %', v_refusal; end if;
        if s.recorded_by = auth.uid() then raise exception 'independent_reviewer_required'; end if;
    elsif p_statement_item is not null then
        raise exception 'validation_failed';
    end if;
    if p_kind = 'RESOLVE_FAILED' and p.provider_confirmed_at is not null then raise exception 'payment_funds_received'; end if;
    insert into funding.staff_actions(payment_id, kind, statement_item_id, requested_by, request_reason)
    values (p.id, p_kind, p_statement_item, auth.uid(), btrim(p_reason)) returning id into v_id;
    perform funding.audit('funding.action_request', p.id, p_reason, jsonb_build_object('action_id', v_id, 'kind', p_kind, 'statement_item_id', p_statement_item));
    return v_id;
end;
$$;

-- The approver differs from the requester and, for RESOLVE_CONFIRMED, from
-- whoever recorded the statement item. The binding is checked again, the item
-- and its receipt are tied to the payment, and the credit goes through
-- funding.confirm_and_credit without a hold: if the limits or the projected
-- coverage fail, the approval is refused and the payment stays in review.
create or replace function public.funding_approve_action(p_action uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a funding.staff_actions; p funding.payments; s funding.provider_statement_items; v_tx uuid; v_refusal text;
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_reason);
    select * into a from funding.staff_actions where id = p_action for update;
    if not found or a.approved_by is not null then raise exception 'not_found'; end if;
    if a.requested_by = auth.uid() then raise exception 'second_approver_required'; end if;
    select * into p from funding.payments where id = a.payment_id for update;
    update funding.staff_actions set approved_by = auth.uid(), approved_at = now(), approval_reason = btrim(p_reason) where id = a.id;
    if a.kind = 'REVERSE' then
        if p.state <> 'CONFIRMED' then raise exception 'payment_state_invalid'; end if;
        insert into funding.usd_ledger_transactions(environment, payment_id, idempotency_key, description)
        values (p.environment, p.id, 'reversal-' || p.id, 'Reversal of sandbox M-Pesa deposit') returning id into v_tx;
        insert into funding.usd_ledger_entries(transaction_id, environment, account_code, user_id, amount) values
            (v_tx, p.environment, 'CUSTOMER_TEST_BALANCE', p.user_id, -p.usd_amount),
            (v_tx, p.environment, 'DEPOSIT_CLEARING', null, p.usd_amount);
        insert into funding.kes_clearing_entries(environment, payment_id, kind, kes_amount, business_date)
        values (p.environment, p.id, 'REVERSAL', -p.kes_due, funding.nairobi_date(now()));
        perform funding.transition(p.id, 'REVERSED', 'staff_reversal', auth.uid());
    elsif a.kind = 'RESOLVE_CONFIRMED' then
        if p.state not in ('MANUAL_REVIEW', 'EXPIRED') then raise exception 'payment_state_invalid'; end if;
        select * into s from funding.provider_statement_items where id = a.statement_item_id;
        if s.recorded_by = auth.uid() then raise exception 'independent_reviewer_required'; end if;
        v_refusal := funding.statement_binding_refusal(p, s);
        if v_refusal is not null then raise exception 'statement_evidence_invalid: %', v_refusal; end if;
        update funding.payments set statement_item_id = s.id, mpesa_receipt = s.receipt, receipt_pending = false, updated_at = now() where id = p.id;
        perform funding.confirm_and_credit(p.id, 'staff_resolution', s.business_date, false, auth.uid());
    elsif a.kind = 'BIND_RECEIPT' then
        -- Identity only: the money was already credited on the provider's status.
        if p.state <> 'CONFIRMED' then raise exception 'payment_state_invalid'; end if;
        select * into s from funding.provider_statement_items where id = a.statement_item_id;
        if s.recorded_by = auth.uid() then raise exception 'independent_reviewer_required'; end if;
        v_refusal := funding.statement_binding_refusal(p, s);
        if v_refusal is not null then raise exception 'statement_evidence_invalid: %', v_refusal; end if;
        update funding.payments set statement_item_id = s.id, mpesa_receipt = s.receipt, receipt_pending = false, updated_at = now() where id = p.id;
    else
        if p.state not in ('MANUAL_REVIEW', 'EXPIRED') then raise exception 'payment_state_invalid'; end if;
        if p.provider_confirmed_at is not null then raise exception 'payment_funds_received'; end if;
        perform funding.transition(p.id, 'FAILED', 'staff_resolution', auth.uid());
    end if;
    perform funding.audit('funding.action_approve', p.id, p_reason, jsonb_build_object('action_id', a.id, 'kind', a.kind, 'requested_by', a.requested_by,
        'statement_item_id', a.statement_item_id));
    select * into p from funding.payments where id = p.id;
    return funding.payment_view(p);
end;
$$;

create or replace function public.funding_record_statement_total(p_environment text, p_business_date date, p_kes_opening_balance numeric,
    p_kes_gross numeric, p_kes_reversals numeric, p_kes_fees numeric, p_kes_net_settlement numeric, p_kes_closing_balance numeric,
    p_evidence_kind text, p_evidence_reference text, p_evidence_sha256 text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_reason);
    if p_environment not in ('SANDBOX', 'PRODUCTION') or p_business_date is null or p_business_date > funding.nairobi_date(now()) then
        raise exception 'validation_failed';
    end if;
    begin
        insert into funding.statement_totals(environment, business_date, kes_opening_balance, kes_gross, kes_reversals, kes_fees, kes_net_settlement,
            kes_closing_balance, evidence_kind, evidence_reference, evidence_sha256, recorded_by, reason)
        values (p_environment, p_business_date, p_kes_opening_balance, p_kes_gross, p_kes_reversals, p_kes_fees, p_kes_net_settlement,
            p_kes_closing_balance, p_evidence_kind, btrim(coalesce(p_evidence_reference, '')), p_evidence_sha256, auth.uid(), btrim(p_reason));
    exception when check_violation or not_null_violation then raise exception 'validation_failed';
    end;
    perform funding.audit('funding.statement_total', null, p_reason, jsonb_build_object('environment', p_environment, 'business_date', p_business_date,
        'kes_gross', p_kes_gross, 'kes_fees', p_kes_fees, 'kes_closing_balance', p_kes_closing_balance, 'evidence_kind', p_evidence_kind,
        'evidence_sha256', p_evidence_sha256));
end;
$$;

-- The resolver of a reconciliation difference must not be whoever entered the
-- statement totals or statement items for that day.
create or replace function public.funding_resolve_reconciliation(p_run uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare r funding.reconciliation_runs;
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_reason);
    select * into r from funding.reconciliation_runs where id = p_run;
    if not found or r.status <> 'DIFFERENCES' then raise exception 'not_found'; end if;
    if exists (select 1 from funding.statement_totals where environment = r.environment and business_date = r.business_date and recorded_by = auth.uid())
       or exists (select 1 from funding.provider_statement_items where environment = r.environment and business_date = r.business_date and recorded_by = auth.uid()) then
        raise exception 'second_approver_required';
    end if;
    insert into funding.reconciliation_resolutions(run_id, resolved_by, reason) values (r.id, auth.uid(), btrim(p_reason));
    perform funding.audit('funding.reconciliation_resolve', r.id, p_reason, jsonb_build_object('run_id', r.id));
end;
$$;

create or replace function public.funding_staff_overview(p_environment text default 'SANDBOX')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r funding.fx_rate_versions; pol funding.deposit_policy_versions;
begin
    perform admin_private.require_staff('funding.read');
    r := funding.current_rate(); pol := funding.policy();
    return jsonb_build_object(
        'environment', p_environment,
        'sandbox_module', public.module_enabled('daraja_sandbox'),
        'production_module', public.module_enabled('daraja_production'),
        'rate', jsonb_build_object('version', r.version, 'kes_per_usd', r.kes_per_usd, 'rate_date', r.rate_date, 'stale', funding.rate_is_stale(r.rate_date, pol.rate_max_age_hours)),
        'treasury', funding.treasury_status(p_environment),
        'states', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from funding.payments where environment = p_environment group by state) s), '{}'::jsonb),
        'attention', coalesce((select jsonb_agg(jsonb_build_object('payment_id', id, 'state', state, 'reason', attention_reason) order by updated_at desc)
            from (select * from funding.payments where environment = p_environment and (state in ('MANUAL_REVIEW', 'EXPIRED') or attention_reason is not null) order by updated_at desc limit 50) a), '[]'::jsonb),
        'open_actions', coalesce((select jsonb_agg(jsonb_build_object('action_id', id, 'payment_id', payment_id, 'kind', kind, 'requested_by', requested_by, 'requested_at', requested_at))
            from funding.staff_actions where approved_by is null), '[]'::jsonb),
        'last_reconciliation', (select jsonb_build_object('run_id', id, 'business_date', business_date, 'status', status, 'run_at', run_at)
            from funding.reconciliation_runs where environment = p_environment order by run_at desc limit 1));
end;
$$;

-- ---------------------------------------------------------------- grants

do $$
declare f record;
begin
    for f in select p.oid::regprocedure sig, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'funding' or (n.nspname = 'public' and p.proname like 'funding\_%') loop
        execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
        if f.nspname = 'public' and f.proname like 'funding\_svc\_%' then
            execute format('grant execute on function %s to service_role', f.sig);
        elsif f.nspname = 'public' then
            execute format('grant execute on function %s to authenticated', f.sig);
        end if;
    end loop;
end $$;
