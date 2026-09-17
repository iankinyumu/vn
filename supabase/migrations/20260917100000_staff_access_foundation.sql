-- Phase 1. Additive access foundation; existing customer and trading policies are unchanged.
create schema if not exists admin_private;
revoke all on schema admin_private from public, anon, authenticated;

create table admin_private.access_lock (
    singleton boolean primary key default true check (singleton),
    revision bigint not null default 0
);
insert into admin_private.access_lock(singleton) values (true);

create table public.staff_roles (
    user_id uuid primary key references auth.users(id) on delete restrict,
    role text not null check (role in ('support_agent', 'administrator', 'owner')),
    active boolean not null default true,
    version bigint not null default 1 check (version > 0),
    granted_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
alter table public.staff_roles enable row level security;
revoke all on public.staff_roles from public, anon, authenticated, service_role;

-- UUIDs intentionally have no Auth FK: audit evidence survives account removal.
create table public.admin_audit_events (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    actor_id uuid,
    actor_type text not null check (actor_type in ('staff', 'operator')),
    action text not null,
    target_type text not null,
    target_id uuid not null,
    correlation_id uuid not null,
    reason text not null check (char_length(reason) between 3 and 500),
    before_state jsonb,
    after_state jsonb,
    unique (actor_id, correlation_id)
);
create index admin_audit_events_created_idx on public.admin_audit_events(created_at desc, id desc);
alter table public.admin_audit_events enable row level security;
revoke all on public.admin_audit_events from public, anon, authenticated, service_role;

create function admin_private.reject_audit_edit() returns trigger
language plpgsql set search_path = '' as $$
begin
    raise exception 'audit_immutable';
end;
$$;
create trigger admin_audit_immutable before update or delete on public.admin_audit_events
for each row execute function admin_private.reject_audit_edit();

create function admin_private.role_capabilities(p_role text) returns text[]
language sql immutable set search_path = '' as $$
    select case p_role
        when 'support_agent' then array['staff.enter', 'support.read_assigned', 'support.reply', 'support.note', 'support.transition']
        when 'administrator' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close']
        when 'owner' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'staff.manage', 'audit.read']
        else array[]::text[] end;
$$;

create function admin_private.require_staff(p_capability text, p_fresh boolean default false)
returns public.staff_roles language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_verified numeric;
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    select * into v_staff from public.staff_roles where user_id = auth.uid() and active;
    if not found then raise exception 'forbidden'; end if;
    if (auth.jwt()->>'aal') is distinct from 'aal2' then raise exception 'mfa_required'; end if;
    if not (p_capability = any(admin_private.role_capabilities(v_staff.role))) then
        raise exception 'forbidden';
    end if;
    if p_fresh then
        -- Token refresh time is NOT authentication time. Only a real TOTP verification qualifies.
        select max((entry->>'timestamp')::numeric) into v_verified
        from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]'::jsonb)) entry
        where entry->>'method' = 'totp' and (entry->>'timestamp') ~ '^[0-9]+$';
        if v_verified is null or v_verified < extract(epoch from now()) - 600
           or v_verified > extract(epoch from now()) then raise exception 'reauthentication_required'; end if;
    end if;
    return v_staff;
end;
$$;

create function public.get_staff_context() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_staff public.staff_roles;
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    select * into v_staff from public.staff_roles where user_id = auth.uid() and active;
    if not found then raise exception 'forbidden'; end if;
    return jsonb_build_object('user_id', v_staff.user_id, 'role', v_staff.role,
        'version', v_staff.version,
        'required_step', case when (auth.jwt()->>'aal') is distinct from 'aal2' then 'mfa' else null end,
        'capabilities', case when (auth.jwt()->>'aal') = 'aal2'
            then to_jsonb(admin_private.role_capabilities(v_staff.role)) else '[]'::jsonb end);
end;
$$;

-- Deliberately outside the API's public schema. Only a trusted SQL operator may bootstrap.
create function admin_private.bootstrap_owner(p_user_id uuid, p_verified_email text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
        raise exception 'validation_failed';
    end if;
    -- Row update serializes access changes and produces a serialization failure for stale
    -- repeatable-read transactions rather than allowing an old owner-count snapshot.
    update admin_private.access_lock set revision = revision + 1 where singleton;
    if exists(select 1 from public.staff_roles) or exists(
        select 1 from public.admin_audit_events where action = 'staff.bootstrap') then
        raise exception 'bootstrap_already_completed';
    end if;
    if not exists(select 1 from auth.users where id = p_user_id
        and email_confirmed_at is not null and lower(email) = lower(btrim(p_verified_email))) then
        raise exception 'verified_identity_required';
    end if;
    insert into public.staff_roles(user_id, role) values (p_user_id, 'owner');
    insert into public.admin_audit_events(actor_type, action, target_type, target_id, correlation_id, reason, after_state)
    values ('operator', 'staff.bootstrap', 'staff', p_user_id, gen_random_uuid(), btrim(p_reason),
        jsonb_build_object('role', 'owner', 'active', true, 'version', 1));
end;
$$;

create function public.change_staff_role(p_user_id uuid, p_role text, p_active boolean,
    p_expected_version bigint, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_actor public.staff_roles;
    v_old public.staff_roles;
    v_new public.staff_roles;
    v_prior public.admin_audit_events;
begin
    -- Reject unauthorized callers before allowing them to contend on the shared writer lock.
    perform admin_private.require_staff('staff.manage', true);
    -- All access writers must take this same lock before rechecking current authority.
    update admin_private.access_lock set revision = revision + 1 where singleton;
    v_actor := admin_private.require_staff('staff.manage', true);
    if p_user_id = v_actor.user_id then raise exception 'self_role_change_forbidden'; end if;
    if p_user_id is null or p_role is null or p_role not in ('support_agent','administrator','owner')
       or p_active is null or p_request_id is null or p_expected_version is null or p_expected_version < 0
       or p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
        raise exception 'validation_failed';
    end if;
    select * into v_prior from public.admin_audit_events
        where actor_id = v_actor.user_id and correlation_id = p_request_id;
    if found then
        if v_prior.action <> 'staff.role_change' or v_prior.target_id <> p_user_id
           or v_prior.after_state->>'role' <> p_role or (v_prior.after_state->>'active')::boolean <> p_active
           or (v_prior.after_state->>'version')::bigint <> p_expected_version + 1
           or v_prior.reason <> btrim(p_reason) then raise exception 'conflict'; end if;
        return v_prior.after_state;
    end if;
    if (select count(*) from public.admin_audit_events where actor_id = v_actor.user_id
        and action = 'staff.role_change' and created_at > now() - interval '1 hour') >= 30 then
        raise exception 'rate_limited';
    end if;
    select * into v_old from public.staff_roles where user_id = p_user_id;
    if coalesce(v_old.version, 0) <> p_expected_version then raise exception 'conflict'; end if;
    if not exists(select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then
        raise exception 'verified_identity_required';
    end if;
    if v_old.active and v_old.role = 'owner' and (not p_active or p_role <> 'owner')
       and (select count(*) from public.staff_roles where active and role = 'owner') <= 1 then
        raise exception 'last_owner_required';
    end if;
    insert into public.staff_roles(user_id, role, active, granted_by)
    values (p_user_id, p_role, p_active, v_actor.user_id)
    on conflict(user_id) do update set role = excluded.role, active = excluded.active,
        version = public.staff_roles.version + 1, granted_by = excluded.granted_by, updated_at = now()
    returning * into v_new;
    insert into public.admin_audit_events(actor_id, actor_type, action, target_type, target_id,
        correlation_id, reason, before_state, after_state)
    values (v_actor.user_id, 'staff', 'staff.role_change', 'staff', p_user_id, p_request_id, btrim(p_reason),
        case when v_old.user_id is null then null else jsonb_build_object('role', v_old.role, 'active', v_old.active, 'version', v_old.version) end,
        jsonb_build_object('role', v_new.role, 'active', v_new.active, 'version', v_new.version));
    return jsonb_build_object('role', v_new.role, 'active', v_new.active, 'version', v_new.version);
end;
$$;

create function public.list_admin_audit(p_before_time timestamptz default null, p_before_id uuid default null)
returns setof public.admin_audit_events language plpgsql security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('audit.read');
    if (p_before_time is null) <> (p_before_id is null) then raise exception 'validation_failed'; end if;
    return query select * from public.admin_audit_events
        where p_before_time is null or (created_at, id) < (p_before_time, p_before_id)
        order by created_at desc, id desc limit 50;
end;
$$;

revoke all on all tables in schema admin_private from public, anon, authenticated, service_role;
revoke all on all functions in schema admin_private from public, anon, authenticated, service_role;
revoke all on function public.get_staff_context() from public, anon, service_role;
revoke all on function public.change_staff_role(uuid,text,boolean,bigint,text,uuid) from public, anon, service_role;
revoke all on function public.list_admin_audit(timestamptz,uuid) from public, anon, service_role;
grant execute on function public.get_staff_context() to authenticated;
grant execute on function public.change_staff_role(uuid,text,boolean,bigint,text,uuid) to authenticated;
grant execute on function public.list_admin_audit(timestamptz,uuid) to authenticated;
