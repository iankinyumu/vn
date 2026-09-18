-- ==============================================================================
-- SMARTPROFITBINARY LIVE ADMIN & OPERATIONS MIGRATION SCRIPT
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard/project/cdaxvkpmgqjfukbtrzys/sql)
-- Safe to run repeatedly (fully idempotent).
-- ==============================================================================

-- 1. Schema & Foundation
create schema if not exists admin_private;
revoke all on schema admin_private from public, anon, authenticated;

create table if not exists admin_private.access_lock (
    singleton boolean primary key default true check (singleton),
    revision bigint not null default 0
);
insert into admin_private.access_lock(singleton) values (true) on conflict do nothing;

create table if not exists public.staff_roles (
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

create table if not exists public.admin_audit_events (
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
create index if not exists admin_audit_events_created_idx on public.admin_audit_events(created_at desc, id desc);
alter table public.admin_audit_events enable row level security;
revoke all on public.admin_audit_events from public, anon, authenticated, service_role;

create or replace function admin_private.reject_audit_edit() returns trigger
language plpgsql set search_path = '' as $$
begin
    raise exception 'audit_immutable';
end;
$$;

drop trigger if exists admin_audit_immutable on public.admin_audit_events;
create trigger admin_audit_immutable before update or delete on public.admin_audit_events
for each row execute function admin_private.reject_audit_edit();

-- 2. Role capabilities definition
create or replace function admin_private.role_capabilities(p_role text) returns text[]
language sql immutable set search_path = '' as $$
    select case p_role
        when 'support_agent' then array[
            'staff.enter',
            'support.read_assigned',
            'support.reply',
            'support.note',
            'support.transition'
        ]
        when 'administrator' then array[
            'staff.enter',
            'support.read_all',
            'support.reply',
            'support.note',
            'support.transition',
            'support.assign',
            'support.close',
            'customers.read',
            'restrictions.manage',
            'trading.read_demo',
            'markets.manage',
            'operations.read'
        ]
        when 'owner' then array[
            'staff.enter',
            'support.read_all',
            'support.reply',
            'support.note',
            'support.transition',
            'support.assign',
            'support.close',
            'customers.read',
            'restrictions.manage',
            'trading.read_demo',
            'markets.manage',
            'operations.read',
            'staff.manage',
            'audit.read'
        ]
        else array[]::text[] end;
$$;

-- 3. Staff verification helpers
create or replace function admin_private.require_staff(p_capability text, p_fresh boolean default false)
returns table (user_id uuid, role text, version bigint)
language plpgsql security definer set search_path = '' as $$
declare
    v_user_id uuid := auth.uid();
    v_role text;
    v_active boolean;
    v_version bigint;
    v_claims jsonb := auth.jwt();
    v_aal text := coalesce(v_claims->>'aal', 'aal1');
    v_amr jsonb := coalesce(v_claims->'amr', '[]'::jsonb);
    v_verified_at bigint := 0;
    v_item jsonb;
begin
    if v_user_id is null then raise exception 'unauthenticated'; end if;
    select s.role, s.active, s.version into v_role, v_active, v_version from public.staff_roles s where s.user_id = v_user_id;
    if v_role is null or not v_active then raise exception 'forbidden'; end if;
    if not (p_capability = any(admin_private.role_capabilities(v_role))) then raise exception 'forbidden'; end if;

    for v_item in select * from jsonb_array_elements(v_amr) loop
        if v_item->>'method' = 'totp' then
            v_verified_at := greatest(v_verified_at, (v_item->>'timestamp')::bigint);
        end if;
    end loop;

    if v_aal <> 'aal2' or v_verified_at = 0 then raise exception 'mfa_required'; end if;
    if p_fresh and (extract(epoch from now())::bigint - v_verified_at) > 300 then raise exception 'reauthentication_required'; end if;

    return query select v_user_id, v_role, v_version;
end;
$$;

create or replace function public.get_staff_context() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_user_id uuid := auth.uid();
    v_role text;
    v_active boolean;
    v_version bigint;
    v_claims jsonb := auth.jwt();
    v_aal text := coalesce(v_claims->>'aal', 'aal1');
    v_amr jsonb := coalesce(v_claims->'amr', '[]'::jsonb);
    v_verified_at bigint := 0;
    v_item jsonb;
begin
    if v_user_id is null then return jsonb_build_object('role', null, 'required_step', 'sign_in'); end if;
    select s.role, s.active, s.version into v_role, v_active, v_version from public.staff_roles s where s.user_id = v_user_id;
    if v_role is null or not v_active then return jsonb_build_object('role', null, 'required_step', 'denied'); end if;

    for v_item in select * from jsonb_array_elements(v_amr) loop
        if v_item->>'method' = 'totp' then
            v_verified_at := greatest(v_verified_at, (v_item->>'timestamp')::bigint);
        end if;
    end loop;

    if v_aal <> 'aal2' or v_verified_at = 0 then
        return jsonb_build_object('user_id', v_user_id, 'role', v_role, 'version', v_version, 'capabilities', array[]::text[], 'required_step', 'mfa');
    end if;

    return jsonb_build_object(
        'user_id', v_user_id,
        'role', v_role,
        'version', v_version,
        'capabilities', admin_private.role_capabilities(v_role),
        'required_step', null
    );
end;
$$;
grant execute on function public.get_staff_context() to authenticated;

-- 4. Customer restrictions & Market Controls Tables
create table if not exists public.account_restrictions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete restrict,
    restriction_type text not null check (restriction_type in ('restrict_demo_trading', 'disable_ticket_creation', 'suspend_account')),
    status text not null check (status in ('active', 'lifted')) default 'active',
    reason text not null check (char_length(reason) between 3 and 500),
    applied_by uuid not null references auth.users(id) on delete restrict,
    lifted_by uuid references auth.users(id) on delete restrict,
    lift_reason text check (lift_reason is null or char_length(lift_reason) between 3 and 500),
    applied_at timestamptz not null default now(),
    lifted_at timestamptz
);
create index if not exists account_restrictions_user_idx on public.account_restrictions(user_id, status);
alter table public.account_restrictions enable row level security;
revoke all on public.account_restrictions from public, anon, authenticated;

create table if not exists public.market_symbol_controls (
    symbol text primary key,
    trading_status text not null check (trading_status in ('active', 'paused')) default 'active',
    pause_reason text check (pause_reason is null or char_length(pause_reason) between 3 and 500),
    updated_by uuid references auth.users(id) on delete restrict,
    updated_at timestamptz not null default now()
);
alter table public.market_symbol_controls enable row level security;
revoke all on public.market_symbol_controls from public, anon, authenticated;

insert into public.market_symbol_controls (symbol, trading_status)
values ('BTCUSDT', 'active'), ('ETHUSDT', 'active')
on conflict (symbol) do nothing;

-- 5. Operational Admin RPCs
create or replace function public.get_platform_overview()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_open bigint := 0;
    v_unassigned bigint := 0;
    v_waiting bigint := 0;
    v_customers bigint := 0;
    v_restrictions bigint := 0;
    v_orders_today bigint := 0;
    v_staff bigint := 0;
    v_stale_count bigint := 0;
    v_market_status text := 'healthy';
begin
    perform * from admin_private.require_staff('operations.read');

    select count(*) filter (where status in ('open', 'in_progress', 'waiting_for_customer')),
           count(*) filter (where status = 'open' and assignee_id is null),
           count(*) filter (where status = 'waiting_for_customer')
    into v_open, v_unassigned, v_waiting
    from public.support_tickets;

    select count(*) into v_customers from auth.users;
    select count(*) into v_restrictions from public.account_restrictions where status = 'active';

    select count(*) into v_orders_today
    from public.demo_orders
    where submitted_at >= date_trunc('day', now());

    select count(*) into v_staff from public.staff_roles where active = true;

    select count(*) into v_stale_count
    from public.market_snapshots
    where received_at < now() - interval '5 minutes';

    if v_stale_count > 0 then v_market_status := 'degraded'; end if;

    return jsonb_build_object(
        'open_tickets', coalesce(v_open, 0),
        'unassigned_tickets', coalesce(v_unassigned, 0),
        'waiting_tickets', coalesce(v_waiting, 0),
        'total_customers', coalesce(v_customers, 0),
        'active_restrictions', coalesce(v_restrictions, 0),
        'orders_today', coalesce(v_orders_today, 0),
        'active_staff', coalesce(v_staff, 0),
        'market_health', v_market_status,
        'timestamp', now()
    );
end;
$$;
grant execute on function public.get_platform_overview() to authenticated;

create or replace function public.list_admin_customers(p_search text default null, p_limit int default 50)
returns table (
    user_id uuid,
    email text,
    display_name text,
    created_at timestamptz,
    email_confirmed boolean,
    open_tickets_count bigint,
    active_restrictions_count bigint
) language plpgsql security definer set search_path = '' as $$
begin
    perform * from admin_private.require_staff('customers.read');
    return query
    select
        u.id as user_id,
        u.email::text,
        coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)) as display_name,
        u.created_at,
        u.email_confirmed_at is not null as email_confirmed,
        count(distinct t.id) filter (where t.status in ('open', 'in_progress', 'waiting_for_customer')) as open_tickets_count,
        count(distinct r.id) filter (where r.status = 'active') as active_restrictions_count
    from auth.users u
    left join public.support_tickets t on t.customer_id = u.id
    left join public.account_restrictions r on r.user_id = u.id
    where p_search is null or p_search = '' or u.email ilike ('%' || p_search || '%') or (u.raw_user_meta_data->>'display_name') ilike ('%' || p_search || '%') or u.id::text = p_search
    group by u.id, u.email, u.raw_user_meta_data, u.created_at, u.email_confirmed_at
    order by u.created_at desc
    limit least(p_limit, 100);
end;
$$;
grant execute on function public.list_admin_customers(text, int) to authenticated;

create or replace function public.get_admin_customer_detail(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_user record;
    v_balances jsonb := '[]'::jsonb;
    v_restrictions jsonb := '[]'::jsonb;
    v_tickets jsonb := '[]'::jsonb;
begin
    perform * from admin_private.require_staff('customers.read');
    select id, email, created_at, email_confirmed_at, raw_user_meta_data into v_user
    from auth.users where id = p_user_id;
    if v_user.id is null then raise exception 'not_found'; end if;

    select coalesce(jsonb_agg(jsonb_build_object('asset', asset, 'free', free, 'locked', locked, 'updated_at', updated_at)), '[]'::jsonb)
    into v_balances
    from public.demo_wallets where user_id = p_user_id;

    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'restriction_type', restriction_type, 'reason', reason, 'status', status, 'applied_at', applied_at, 'lifted_at', lifted_at)), '[]'::jsonb)
    into v_restrictions
    from public.account_restrictions where user_id = p_user_id;

    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'reference', reference, 'subject', subject, 'status', status, 'created_at', created_at)), '[]'::jsonb)
    into v_tickets
    from public.support_tickets where customer_id = p_user_id order by created_at desc limit 10;

    return jsonb_build_object(
        'user_id', v_user.id,
        'email', v_user.email,
        'display_name', coalesce(v_user.raw_user_meta_data->>'display_name', split_part(v_user.email, '@', 1)),
        'created_at', v_user.created_at,
        'email_confirmed', v_user.email_confirmed_at is not null,
        'balances', v_balances,
        'restrictions', v_restrictions,
        'recent_tickets', v_tickets
    );
end;
$$;
grant execute on function public.get_admin_customer_detail(uuid) to authenticated;

create or replace function public.apply_account_restriction(p_user_id uuid, p_restriction_type text, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
    v_staff record;
    v_id uuid;
begin
    select * into v_staff from admin_private.require_staff('restrictions.manage');
    if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'not_found'; end if;
    if p_reason is null or char_length(trim(p_reason)) < 3 or char_length(p_reason) > 500 then raise exception 'validation_failed'; end if;

    insert into public.account_restrictions (user_id, restriction_type, status, reason, applied_by, applied_at)
    values (p_user_id, p_restriction_type, 'active', trim(p_reason), v_staff.user_id, now())
    returning id into v_id;

    insert into public.admin_audit_events (actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state)
    values (v_staff.user_id, 'staff', 'apply_restriction', 'customer', p_user_id, gen_random_uuid(), trim(p_reason), jsonb_build_object('restriction_id', v_id, 'type', p_restriction_type));

    return v_id;
end;
$$;
grant execute on function public.apply_account_restriction(uuid, text, text) to authenticated;

create or replace function public.lift_account_restriction(p_restriction_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
    v_staff record;
    v_restr record;
begin
    select * into v_staff from admin_private.require_staff('restrictions.manage');
    select * into v_restr from public.account_restrictions where id = p_restriction_id;
    if v_restr.id is null then raise exception 'not_found'; end if;
    if v_restr.status = 'lifted' then return true; end if;
    if p_reason is null or char_length(trim(p_reason)) < 3 or char_length(p_reason) > 500 then raise exception 'validation_failed'; end if;

    update public.account_restrictions
    set status = 'lifted', lifted_by = v_staff.user_id, lift_reason = trim(p_reason), lifted_at = now()
    where id = p_restriction_id;

    insert into public.admin_audit_events (actor_id, actor_type, action, target_type, target_id, correlation_id, reason, before_state, after_state)
    values (v_staff.user_id, 'staff', 'lift_restriction', 'customer', v_restr.user_id, gen_random_uuid(), trim(p_reason), jsonb_build_object('id', v_restr.id, 'status', 'active'), jsonb_build_object('id', v_restr.id, 'status', 'lifted'));

    return true;
end;
$$;
grant execute on function public.lift_account_restriction(uuid, text) to authenticated;

create or replace function public.list_admin_demo_orders(p_user_id uuid default null, p_symbol text default null, p_state text default null, p_limit int default 50)
returns table (
    order_id uuid,
    user_id uuid,
    customer_email text,
    symbol text,
    side text,
    order_type text,
    quantity numeric,
    price numeric,
    status text,
    filled_quantity numeric,
    submitted_at timestamptz
) language plpgsql security definer set search_path = '' as $$
begin
    perform * from admin_private.require_staff('trading.read_demo');
    return query
    select
        o.id as order_id,
        o.user_id,
        u.email::text as customer_email,
        o.symbol,
        o.side,
        o.order_type,
        o.quantity,
        o.price,
        o.status,
        o.filled_quantity,
        o.submitted_at
    from public.demo_orders o
    join auth.users u on u.id = o.user_id
    where (p_user_id is null or o.user_id = p_user_id)
      and (p_symbol is null or p_symbol = '' or o.symbol = p_symbol)
      and (p_state is null or p_state = '' or o.status = p_state)
    order by o.submitted_at desc
    limit least(p_limit, 100);
end;
$$;
grant execute on function public.list_admin_demo_orders(uuid, text, text, int) to authenticated;

create or replace function public.get_admin_demo_order_detail(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_order record;
    v_fills jsonb := '[]'::jsonb;
begin
    perform * from admin_private.require_staff('trading.read_demo');
    select o.*, u.email as customer_email into v_order
    from public.demo_orders o join auth.users u on u.id = o.user_id
    where o.id = p_order_id;
    if v_order.id is null then raise exception 'not_found'; end if;

    select coalesce(jsonb_agg(jsonb_build_object('fill_id', f.id, 'quantity', f.quantity, 'price', f.price, 'fee', f.fee, 'fee_asset', f.fee_asset, 'executed_at', f.executed_at)), '[]'::jsonb)
    into v_fills
    from public.demo_order_fills f where f.order_id = p_order_id;

    return jsonb_build_object(
        'order_id', v_order.id,
        'user_id', v_order.user_id,
        'customer_email', v_order.customer_email,
        'symbol', v_order.symbol,
        'side', v_order.side,
        'order_type', v_order.order_type,
        'quantity', v_order.quantity,
        'price', v_order.price,
        'status', v_order.status,
        'filled_quantity', v_order.filled_quantity,
        'submitted_at', v_order.submitted_at,
        'fills', v_fills
    );
end;
$$;
grant execute on function public.get_admin_demo_order_detail(uuid) to authenticated;

create or replace function public.list_admin_market_health()
returns table (
    symbol text,
    bid_price numeric,
    ask_price numeric,
    received_at timestamptz,
    seconds_ago int,
    trading_status text,
    is_stale boolean
) language plpgsql security definer set search_path = '' as $$
begin
    perform * from admin_private.require_staff('markets.manage');
    return query
    select distinct on (c.symbol)
        c.symbol,
        s.bid_price,
        s.ask_price,
        s.received_at,
        coalesce(extract(epoch from (now() - s.received_at))::int, 999999) as seconds_ago,
        c.trading_status,
        coalesce(s.received_at < now() - interval '60 seconds', true) as is_stale
    from public.market_symbol_controls c
    left join public.market_snapshots s on s.symbol = c.symbol
    order by c.symbol, s.received_at desc nulls last;
end;
$$;
grant execute on function public.list_admin_market_health() to authenticated;

create or replace function public.set_symbol_trading_status(p_symbol text, p_trading_status text, p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
    v_staff record;
    v_old text;
begin
    select * into v_staff from admin_private.require_staff('markets.manage');
    if p_trading_status not in ('active', 'paused') then raise exception 'validation_failed'; end if;
    if p_reason is null or char_length(trim(p_reason)) < 3 or char_length(p_reason) > 500 then raise exception 'validation_failed'; end if;

    select trading_status into v_old from public.market_symbol_controls where symbol = p_symbol;
    if v_old is null then raise exception 'not_found'; end if;
    if v_old = p_trading_status then return true; end if;

    update public.market_symbol_controls
    set trading_status = p_trading_status, pause_reason = case when p_trading_status = 'paused' then trim(p_reason) else null end, updated_by = v_staff.user_id, updated_at = now()
    where symbol = p_symbol;

    insert into public.admin_audit_events (actor_id, actor_type, action, target_type, target_id, correlation_id, reason, before_state, after_state)
    values (v_staff.user_id, 'staff', 'set_market_status', 'market', gen_random_uuid(), gen_random_uuid(), trim(p_reason), jsonb_build_object('symbol', p_symbol, 'status', v_old), jsonb_build_object('symbol', p_symbol, 'status', p_trading_status));

    return true;
end;
$$;
grant execute on function public.set_symbol_trading_status(text, text, text) to authenticated;

create or replace function public.list_staff_members()
returns table (
    user_id uuid,
    email text,
    role text,
    active boolean,
    version bigint,
    granted_by uuid,
    updated_at timestamptz
) language plpgsql security definer set search_path = '' as $$
begin
    perform * from admin_private.require_staff('staff.manage');
    return query
    select s.user_id, u.email::text, s.role, s.active, s.version, s.granted_by, s.updated_at
    from public.staff_roles s
    join auth.users u on u.id = s.user_id
    order by s.created_at asc;
end;
$$;
grant execute on function public.list_staff_members() to authenticated;

create or replace function public.list_admin_audit(p_before_time timestamptz default null, p_before_id uuid default null)
returns setof public.admin_audit_events language plpgsql security definer set search_path = '' as $$
begin
    perform * from admin_private.require_staff('audit.read');
    return query
    select * from public.admin_audit_events a
    where (p_before_time is null or (a.created_at, a.id) < (p_before_time, p_before_id))
    order by a.created_at desc, a.id desc
    limit 25;
end;
$$;
grant execute on function public.list_admin_audit(timestamptz, uuid) to authenticated;

-- ==============================================================================
-- BOOTSTRAP INSTRUCTIONS FOR LIVE SUPABASE OWNER
-- Replace the email below with your signed-up Supabase account email!
-- ==============================================================================
do $$
declare
    v_user_id uuid;
    v_owner_email text := 'ianwanjiru001@gmail.com'; -- Set to ianwanjiru001@gmail.com
begin
    select id into v_user_id from auth.users where email = v_owner_email;
    if v_user_id is not null then
        insert into public.staff_roles (user_id, role, active, version, granted_by, created_at, updated_at)
        values (v_user_id, 'owner', true, 1, v_user_id, now(), now())
        on conflict (user_id) do update set
            role = 'owner',
            active = true,
            updated_at = now();
        raise notice 'User % successfully bootstrapped as live Platform Owner!', v_owner_email;
    else
        raise notice 'User % not found in auth.users yet. Sign up first with %, then run this block!', v_owner_email, v_owner_email;
    end if;
end;
$$;

