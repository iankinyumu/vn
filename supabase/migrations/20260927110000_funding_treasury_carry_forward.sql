-- Automatic SANDBOX treasury snapshot.
--
-- The sandbox float is fictional, so keeping it fresh is bookkeeping, not
-- evidence. funding_svc_carry_forward_treasury('SANDBOX') re-records the latest
-- owner-recorded sandbox reserve when the current snapshot is about to go stale:
--   * only in SANDBOX; PRODUCTION is refused, because a production snapshot must
--     come from real provider or bank evidence;
--   * only from an owner-recorded snapshot at most 30 days old, so a person
--     still confirms the figure at least monthly;
--   * never while the latest snapshot is younger than 20 hours.
-- An automatic row has no recorder and names the owner snapshot it carries.

alter table funding.treasury_snapshots alter column recorded_by drop not null;
alter table funding.treasury_snapshots add column carried_from bigint references funding.treasury_snapshots(id);
alter table funding.treasury_snapshots add constraint treasury_snapshots_origin_check
    check ((recorded_by is null) = (carried_from is not null) and (carried_from is null or environment = 'SANDBOX'));

create or replace function public.funding_svc_carry_forward_treasury(p_environment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare latest funding.treasury_snapshots; base funding.treasury_snapshots; v_id bigint;
    -- Carry forward when the latest snapshot is at least this old (the policy's
    -- freshness limit is 24 hours), and only from an owner figure this recent.
    c_refresh_after constant interval := interval '20 hours';
    c_owner_max_age constant interval := interval '30 days';
begin
    if p_environment = 'PRODUCTION' then raise exception 'production_requires_real_evidence'; end if;
    if p_environment is distinct from 'SANDBOX' then raise exception 'validation_failed'; end if;
    perform pg_advisory_xact_lock(hashtextextended('funding-treasury-SANDBOX', 0));
    select * into latest from funding.treasury_snapshots where environment = 'SANDBOX' order by recorded_at desc, id desc limit 1;
    if latest.id is not null and latest.recorded_at > now() - c_refresh_after then
        return jsonb_build_object('outcome', 'FRESH', 'snapshot_id', latest.id, 'recorded_at', latest.recorded_at);
    end if;
    select * into base from funding.treasury_snapshots where environment = 'SANDBOX' and recorded_by is not null order by recorded_at desc, id desc limit 1;
    if base.id is null or base.recorded_at < now() - c_owner_max_age then
        return jsonb_build_object('outcome', 'OWNER_SNAPSHOT_REQUIRED', 'owner_snapshot_id', base.id, 'owner_recorded_at', base.recorded_at);
    end if;
    insert into funding.treasury_snapshots(environment, kes_liquid_reserve, recorded_by, carried_from, note)
    values ('SANDBOX', base.kes_liquid_reserve, null, base.id,
            'Automatic sandbox carry-forward of owner snapshot ' || base.id || ' recorded ' || to_char(base.recorded_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC')
    returning id into v_id;
    perform funding.operator_audit('funding.treasury_carry_forward', 'Automatic sandbox treasury carry-forward',
        jsonb_build_object('snapshot_id', v_id, 'carried_from', base.id, 'kes_liquid_reserve', base.kes_liquid_reserve));
    return jsonb_build_object('outcome', 'CARRIED_FORWARD', 'snapshot_id', v_id, 'carried_from', base.id, 'kes_liquid_reserve', base.kes_liquid_reserve,
        'owner_confirmation_due', base.recorded_at + c_owner_max_age);
end;
$$;

-- What the console shows about the snapshot chain for one environment.
create or replace function public.funding_treasury_snapshot_status(p_environment text default 'SANDBOX')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare latest funding.treasury_snapshots; base funding.treasury_snapshots;
begin
    perform admin_private.require_staff('funding.read');
    select * into latest from funding.treasury_snapshots where environment = p_environment order by recorded_at desc, id desc limit 1;
    select * into base from funding.treasury_snapshots where environment = p_environment and recorded_by is not null order by recorded_at desc, id desc limit 1;
    return jsonb_build_object(
        'environment', p_environment,
        'automatic', p_environment = 'SANDBOX',
        'latest_id', latest.id, 'latest_recorded_at', latest.recorded_at, 'latest_automatic', latest.carried_from is not null,
        'owner_snapshot_id', base.id, 'owner_recorded_at', base.recorded_at, 'owner_kes_liquid_reserve', base.kes_liquid_reserve,
        'owner_confirmation_due', case when p_environment = 'SANDBOX' then base.recorded_at + interval '30 days' end);
end;
$$;

revoke all on function public.funding_svc_carry_forward_treasury(text) from public, anon, authenticated, service_role;
grant execute on function public.funding_svc_carry_forward_treasury(text) to service_role;
revoke all on function public.funding_treasury_snapshot_status(text) from public, anon, authenticated, service_role;
grant execute on function public.funding_treasury_snapshot_status(text) to authenticated;
