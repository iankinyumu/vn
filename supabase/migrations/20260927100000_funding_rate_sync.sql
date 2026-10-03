-- Automatic CBK reference-rate import.
--
-- A scheduled call (funding-reconcile {"action":"rate_sync"}) reads the CBK
-- homepage's USD mean and its "Posted On" date and hands them to
-- funding_svc_record_rate_observation, which decides:
--   * older than, or the same as, the current rate: UNCHANGED (no new version);
--   * a newer business date within 1.5% of the current rate: PUBLISHED as a new
--     CBK rate version with no human publisher (published_by null) and an
--     operator audit row;
--   * a larger move, or a different figure for the current rate's date:
--     PENDING_APPROVAL until an owner approves or rejects it in the console;
--   * implausible figures or dates: INVALID; a page that could not be read: FAILED.
-- Each distinct (rate_date, kes_per_usd) is decided once; hourly repeats only
-- bump last_seen_at. Owners keep funding_publish_rate for manual publishing.

create table funding.fx_rate_observations (
    id bigint generated always as identity primary key,
    observed_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    seen_count integer not null default 1 check (seen_count > 0),
    kes_per_usd numeric(12,4),
    rate_date date,
    source_reference text not null check (char_length(source_reference) between 3 and 300),
    outcome text not null check (outcome in ('PUBLISHED', 'UNCHANGED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'INVALID', 'FAILED')),
    detail text check (char_length(detail) <= 300),
    change_bp integer,
    rate_version bigint references funding.fx_rate_versions(version),
    decided_by uuid references auth.users(id),
    decided_at timestamptz,
    decision_reason text check (char_length(decision_reason) <= 500),
    check ((outcome = 'FAILED') = (kes_per_usd is null))
);
create unique index fx_rate_observations_figure_idx on funding.fx_rate_observations(rate_date, kes_per_usd) where kes_per_usd is not null;
create index fx_rate_observations_recent_idx on funding.fx_rate_observations(observed_at desc);
alter table funding.fx_rate_observations enable row level security;
revoke all on funding.fx_rate_observations from public, anon, authenticated, service_role;

create or replace function funding.operator_audit(p_action text, p_reason text, p_after jsonb) returns void
language sql security definer set search_path = '' as $$
    insert into public.admin_audit_events(actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state)
    values (null, 'operator', p_action, 'funding', public.gen_random_uuid(), public.gen_random_uuid(), p_reason, p_after);
$$;

-- Service entry point for the scheduled import. p_failure is set (and the
-- figures are null) when the page could not be fetched or parsed.
create or replace function public.funding_svc_record_rate_observation(p_kes_per_usd numeric, p_rate_date date, p_source_reference text, p_failure text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    cur funding.fx_rate_versions;
    o funding.fx_rate_observations;
    v_source text := left(coalesce(nullif(btrim(p_source_reference), ''), 'https://www.centralbank.go.ke/'), 300);
    v_rate numeric;
    v_change_bp integer;
    v_version bigint;
    -- Automatic publication band: 150 basis points (1.5%) from the current rate.
    c_band_bp constant integer := 150;
begin
    if p_failure is not null then
        insert into funding.fx_rate_observations(source_reference, outcome, detail) values (v_source, 'FAILED', left(p_failure, 300)) returning * into o;
        return jsonb_build_object('observation_id', o.id, 'outcome', o.outcome, 'detail', o.detail);
    end if;
    perform pg_advisory_xact_lock(hashtextextended('funding-rate-sync', 0));
    v_rate := round(p_kes_per_usd, 4);
    if v_rate is null or v_rate not between 50 and 500 or p_rate_date is null
       or p_rate_date > funding.nairobi_date(now()) or p_rate_date < funding.nairobi_date(now()) - 14 then
        insert into funding.fx_rate_observations(kes_per_usd, rate_date, source_reference, outcome, detail)
        values (coalesce(v_rate, 0), p_rate_date, v_source, 'INVALID', 'rate outside 50-500 or date not within the last 14 days')
        on conflict (rate_date, kes_per_usd) where kes_per_usd is not null do update set last_seen_at = now(), seen_count = funding.fx_rate_observations.seen_count + 1
        returning * into o;
        return jsonb_build_object('observation_id', o.id, 'outcome', o.outcome);
    end if;
    select * into o from funding.fx_rate_observations where rate_date = p_rate_date and kes_per_usd = v_rate;
    if found then
        update funding.fx_rate_observations set last_seen_at = now(), seen_count = seen_count + 1 where id = o.id returning * into o;
        return jsonb_build_object('observation_id', o.id, 'outcome', o.outcome, 'repeat', true);
    end if;
    cur := funding.current_rate();
    v_change_bp := case when cur.kes_per_usd is null then null else round(abs(v_rate - cur.kes_per_usd) / cur.kes_per_usd * 10000)::integer end;
    if cur.version is not null and (p_rate_date < cur.rate_date or (p_rate_date = cur.rate_date and v_rate = cur.kes_per_usd)) then
        insert into funding.fx_rate_observations(kes_per_usd, rate_date, source_reference, outcome, change_bp, rate_version)
        values (v_rate, p_rate_date, v_source, 'UNCHANGED', v_change_bp, cur.version) returning * into o;
        return jsonb_build_object('observation_id', o.id, 'outcome', o.outcome);
    end if;
    if cur.version is null or p_rate_date = cur.rate_date or v_change_bp > c_band_bp then
        insert into funding.fx_rate_observations(kes_per_usd, rate_date, source_reference, outcome, change_bp, detail)
        values (v_rate, p_rate_date, v_source, 'PENDING_APPROVAL', v_change_bp,
                case when p_rate_date = cur.rate_date then 'a different figure for the current rate date' else 'move larger than the automatic band' end)
        returning * into o;
        perform funding.operator_audit('funding.rate_pending', 'Automatic CBK import held for owner approval',
            jsonb_build_object('observation_id', o.id, 'kes_per_usd', v_rate, 'rate_date', p_rate_date, 'change_bp', v_change_bp));
        return jsonb_build_object('observation_id', o.id, 'outcome', o.outcome, 'change_bp', v_change_bp);
    end if;
    insert into funding.fx_rate_versions(kes_per_usd, rate_date, source, source_reference, published_by, note)
    values (v_rate, p_rate_date, 'CBK', v_source, null, 'Automatic CBK import (homepage, posted ' || p_rate_date || ')')
    returning version into v_version;
    insert into funding.fx_rate_observations(kes_per_usd, rate_date, source_reference, outcome, change_bp, rate_version)
    values (v_rate, p_rate_date, v_source, 'PUBLISHED', v_change_bp, v_version) returning * into o;
    perform funding.operator_audit('funding.rate_publish', 'Automatic CBK import within the 1.5% band',
        jsonb_build_object('version', v_version, 'kes_per_usd', v_rate, 'rate_date', p_rate_date, 'change_bp', v_change_bp, 'observation_id', o.id));
    return jsonb_build_object('observation_id', o.id, 'outcome', o.outcome, 'version', v_version, 'change_bp', v_change_bp);
end;
$$;

-- An owner approves (publishes) or rejects an observation held for approval.
-- Approval is refused if a rate with a later date was published meanwhile.
create or replace function public.funding_decide_rate_observation(p_observation bigint, p_approve boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o funding.fx_rate_observations; cur funding.fx_rate_versions; v_version bigint;
begin
    perform admin_private.require_staff('funding.manage', true);
    perform funding.require_reason(p_reason);
    if p_approve is null then raise exception 'validation_failed'; end if;
    perform pg_advisory_xact_lock(hashtextextended('funding-rate-sync', 0));
    select * into o from funding.fx_rate_observations where id = p_observation for update;
    if not found then raise exception 'not_found'; end if;
    if o.outcome <> 'PENDING_APPROVAL' then raise exception 'conflict'; end if;
    if p_approve then
        cur := funding.current_rate();
        if cur.version is not null and o.rate_date < cur.rate_date then raise exception 'conflict'; end if;
        insert into funding.fx_rate_versions(kes_per_usd, rate_date, source, source_reference, published_by, note)
        values (o.kes_per_usd, o.rate_date, 'CBK', o.source_reference, auth.uid(), 'Automatic CBK import approved: ' || left(btrim(p_reason), 400))
        returning version into v_version;
    end if;
    update funding.fx_rate_observations
       set outcome = case when p_approve then 'APPROVED' else 'REJECTED' end, rate_version = v_version,
           decided_by = auth.uid(), decided_at = now(), decision_reason = btrim(p_reason)
     where id = o.id returning * into o;
    perform funding.audit(case when p_approve then 'funding.rate_approve' else 'funding.rate_reject' end, null, p_reason,
        jsonb_build_object('observation_id', o.id, 'kes_per_usd', o.kes_per_usd, 'rate_date', o.rate_date, 'version', v_version));
    return jsonb_build_object('observation_id', o.id, 'outcome', o.outcome, 'version', v_version);
end;
$$;

-- What the console shows: the latest observations and those awaiting approval.
create or replace function public.funding_rate_sync_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('funding.read');
    return jsonb_build_object(
        'band_bp', 150,
        'last', (select to_jsonb(x) from (select id, observed_at, last_seen_at, seen_count, kes_per_usd, rate_date, outcome, detail, change_bp, rate_version
                  from funding.fx_rate_observations order by last_seen_at desc limit 1) x),
        'last_success_at', (select max(last_seen_at) from funding.fx_rate_observations where outcome <> 'FAILED'),
        'pending', coalesce((select jsonb_agg(to_jsonb(x) order by x.rate_date desc) from (select id, observed_at, kes_per_usd, rate_date, change_bp, detail
                  from funding.fx_rate_observations where outcome = 'PENDING_APPROVAL') x), '[]'::jsonb),
        'recent', coalesce((select jsonb_agg(to_jsonb(x) order by x.last_seen_at desc) from (select id, observed_at, last_seen_at, seen_count, kes_per_usd, rate_date, outcome, detail, change_bp, rate_version
                  from funding.fx_rate_observations order by last_seen_at desc limit 10) x), '[]'::jsonb));
end;
$$;

revoke all on function funding.operator_audit(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.funding_svc_record_rate_observation(numeric, date, text, text) from public, anon, authenticated, service_role;
grant execute on function public.funding_svc_record_rate_observation(numeric, date, text, text) to service_role;
revoke all on function public.funding_decide_rate_observation(bigint, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.funding_decide_rate_observation(bigint, boolean, text) to authenticated;
revoke all on function public.funding_rate_sync_status() from public, anon, authenticated, service_role;
grant execute on function public.funding_rate_sync_status() to authenticated;
