-- Per-tester sandbox phone numbers.
--
-- The Daraja sandbox test MSISDN never answers a prompt (every push ends 1037),
-- so a success or a cancellation needs a phone a tester holds. The global
-- funding.sandbox_msisdns list is immutable and visible to every tester, so a
-- tester's own number lives here instead: bound to that tester only, switched
-- off rather than deleted, at most two enabled per tester, and entered by the
-- tester (the number is never in a migration or the repository). A payment may
-- push only to a global test number or to one of the paying tester's own numbers.

create table funding.sandbox_tester_msisdns (
    user_id uuid not null references funding.sandbox_testers(user_id),
    msisdn text not null check (msisdn ~ '^254(7|1)[0-9]{8}$'),
    enabled boolean not null,
    changed_at timestamptz not null default now(),
    primary key (user_id, msisdn)
);
alter table funding.sandbox_tester_msisdns enable row level security;
revoke all on funding.sandbox_tester_msisdns from public, anon, authenticated, service_role;

-- The caller adds or switches off one of their own numbers. Only an enabled
-- tester may do so while the sandbox module is on. The audit keeps the masked
-- number only.
create or replace function public.funding_set_my_sandbox_msisdn(p_msisdn text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_msisdn text := btrim(coalesce(p_msisdn, ''));
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    perform funding.assert_environment_open('SANDBOX', v_user);
    if v_msisdn ~ '^0(7|1)[0-9]{8}$' then v_msisdn := '254' || substr(v_msisdn, 2); end if;
    if v_msisdn !~ '^254(7|1)[0-9]{8}$' or p_enabled is null then raise exception 'phone_invalid'; end if;
    perform pg_advisory_xact_lock(hashtextextended('funding-user-' || v_user::text, 0));
    if p_enabled and (select count(*) from funding.sandbox_tester_msisdns where user_id = v_user and enabled and msisdn <> v_msisdn) >= 2 then
        raise exception 'too_many_numbers';
    end if;
    insert into funding.sandbox_tester_msisdns(user_id, msisdn, enabled) values (v_user, v_msisdn, p_enabled)
    on conflict (user_id, msisdn) do update set enabled = excluded.enabled, changed_at = now();
    perform funding.audit('funding.sandbox_tester_msisdn', v_user, 'Sandbox tester phone number change',
        jsonb_build_object('msisdn_masked', left(v_msisdn, 4) || '*****' || right(v_msisdn, 3), 'enabled', p_enabled));
    return jsonb_build_object('msisdn', v_msisdn, 'enabled', p_enabled);
end;
$$;

create or replace function public.funding_sandbox_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); pol funding.deposit_policy_versions; r funding.fx_rate_versions;
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    if not public.module_enabled('daraja_sandbox') or not exists (select 1 from funding.sandbox_testers where user_id = v_user and enabled) then
        return jsonb_build_object('available', false);
    end if;
    pol := funding.policy(); r := funding.current_rate();
    return jsonb_build_object('available', true, 'environment', 'SANDBOX', 'label', 'Daraja Sandbox - test funds only',
        'test_balance_usd', (select coalesce(sum(amount), 0) from funding.usd_ledger_entries where account_code = 'CUSTOMER_TEST_BALANCE' and user_id = v_user),
        'spendable', false, 'min_usd', pol.min_usd, 'max_usd_per_deposit', pol.max_usd_per_deposit,
        'max_usd_rolling_24h', pol.max_usd_rolling_24h, 'max_deposits_rolling_24h', pol.max_deposits_rolling_24h,
        'quote_ttl_seconds', pol.quote_ttl_seconds, 'kes_per_usd', r.kes_per_usd, 'rate_date', r.rate_date,
        'rate_stale', funding.rate_is_stale(r.rate_date, pol.rate_max_age_hours),
        'test_msisdns', coalesce((select jsonb_agg(msisdn order by msisdn) from funding.sandbox_msisdns), '[]'::jsonb),
        'my_msisdns', coalesce((select jsonb_agg(msisdn order by msisdn) from funding.sandbox_tester_msisdns
            where user_id = v_user and enabled), '[]'::jsonb));
end;
$$;


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
    if q.environment = 'SANDBOX' and not exists (select 1 from funding.sandbox_msisdns where msisdn = p_phone)
       and not exists (select 1 from funding.sandbox_tester_msisdns where user_id = p_user and msisdn = p_phone and enabled) then
        raise exception 'phone_not_allowed';
    end if;
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


revoke all on function public.funding_set_my_sandbox_msisdn(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.funding_set_my_sandbox_msisdn(text, boolean) to authenticated;
revoke all on function public.funding_sandbox_overview() from public, anon, authenticated, service_role;
grant execute on function public.funding_sandbox_overview() to authenticated;
revoke all on function public.funding_svc_begin_payment(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.funding_svc_begin_payment(uuid, uuid, text, text, text, text) to service_role;
