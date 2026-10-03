-- Owner direction (2026-09-27): the automatic SANDBOX treasury refresh runs once
-- a day. The snapshot freshness limit is 24 hours, so a daily job must refresh
-- on every run: the 20-hour "still fresh" skip is replaced by "at most one
-- automatic snapshot per Nairobi day". Everything else is unchanged from
-- 20260927110000: SANDBOX only, only from an owner figure at most 30 days old.

create or replace function public.funding_svc_carry_forward_treasury(p_environment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare today funding.treasury_snapshots; base funding.treasury_snapshots; v_id bigint;
    c_owner_max_age constant interval := interval '30 days';
begin
    if p_environment = 'PRODUCTION' then raise exception 'production_requires_real_evidence'; end if;
    if p_environment is distinct from 'SANDBOX' then raise exception 'validation_failed'; end if;
    perform pg_advisory_xact_lock(hashtextextended('funding-treasury-SANDBOX', 0));
    select * into today from funding.treasury_snapshots
     where environment = 'SANDBOX' and carried_from is not null and funding.nairobi_date(recorded_at) = funding.nairobi_date(now())
     order by recorded_at desc, id desc limit 1;
    if today.id is not null then
        return jsonb_build_object('outcome', 'ALREADY_REFRESHED_TODAY', 'snapshot_id', today.id, 'recorded_at', today.recorded_at);
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

revoke all on function public.funding_svc_carry_forward_treasury(text) from public, anon, authenticated, service_role;
grant execute on function public.funding_svc_carry_forward_treasury(text) to service_role;
