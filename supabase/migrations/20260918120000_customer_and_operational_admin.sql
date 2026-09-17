-- Migration: 20260918120000_customer_and_operational_admin.sql
-- Phase 3 & Phase 4: Customer Administration, Trading Restrictions, Demo Trading Oversight,
-- Market Controls, Staff Management Extension, and Platform Overview.

-- 1. Expand role capabilities for Administrator and Owner
create or replace function admin_private.role_capabilities(p_role text) returns text[]
language sql immutable set search_path = '' as $$
    select case p_role
        when 'support_agent' then array[
            'staff.enter', 'support.read_assigned', 'support.reply', 'support.note', 'support.transition'
        ]
        when 'administrator' then array[
            'staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition',
            'support.assign', 'support.close', 'customers.read', 'customers.restrict_trading',
            'trading.read_demo', 'markets.manage', 'operations.read'
        ]
        when 'owner' then array[
            'staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition',
            'support.assign', 'support.close', 'customers.read', 'customers.restrict_trading',
            'trading.read_demo', 'markets.manage', 'operations.read', 'staff.manage', 'audit.read'
        ]
        else array[]::text[] end;
$$;

-- 2. Account Restrictions Table
create table if not exists public.account_restrictions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    restriction_type text not null check (restriction_type in ('TRADING')),
    active boolean not null default true,
    reason text not null check (char_length(btrim(reason)) between 3 and 500),
    applied_by uuid not null references public.staff_roles(user_id),
    applied_at timestamptz not null default now(),
    lifted_at timestamptz,
    lifted_by uuid references public.staff_roles(user_id),
    lifted_reason text check (lifted_reason is null or char_length(btrim(lifted_reason)) between 3 and 500)
);

create index if not exists account_restrictions_user_idx on public.account_restrictions(user_id, active);
alter table public.account_restrictions enable row level security;
revoke all on public.account_restrictions from public, anon, authenticated, service_role;

-- 3. Market Symbol Controls Table
create table if not exists public.market_symbol_controls (
    id uuid primary key default gen_random_uuid(),
    symbol text unique not null check (symbol ~ '^[A-Z0-9]{2,20}$'),
    trading_paused boolean not null default false,
    paused_by uuid references public.staff_roles(user_id),
    paused_at timestamptz,
    reason text
);

alter table public.market_symbol_controls enable row level security;
revoke all on public.market_symbol_controls from public, anon, authenticated, service_role;

insert into public.market_symbol_controls(symbol, trading_paused)
values ('BTCUSDT', false), ('ETHUSDT', false)
on conflict (symbol) do nothing;

-- 4. Enforce Trading Restrictions and Market Pauses in submit_demo_order
create or replace function public.submit_demo_order(
  p_client_order_id text, p_symbol text, p_side public.order_side, p_type public.order_type,
  p_quantity numeric, p_limit_price numeric default null, p_stop_price numeric default null,
  p_idempotency_key text default null
) returns public.orders language plpgsql security definer set search_path = public as $$
declare
  v_account uuid;
  v_order public.orders%rowtype;
  v_snapshot public.market_snapshots%rowtype;
  v_base text;
  v_reserve numeric;
  v_asset text;
  v_key text := coalesce(nullif(p_idempotency_key,''), p_client_order_id);
  v_state public.order_state;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  perform public.assert_demo_order_rate_limit();

  -- Enforcement: Check for active TRADING restriction
  if exists (select 1 from public.account_restrictions where user_id = auth.uid() and restriction_type = 'TRADING' and active) then
    raise exception 'trading_restricted';
  end if;

  -- Enforcement: Check if symbol trading is paused
  if exists (select 1 from public.market_symbol_controls where symbol = upper(p_symbol) and trading_paused) then
    raise exception 'symbol_trading_paused';
  end if;

  v_account := public.demo_account_for_user();
  if v_account is null then raise exception 'an active DEMO account is required'; end if;
  perform 1 from public.trading_accounts where id = v_account for update;

  if upper(p_symbol) !~ '^[A-Z0-9]{2,20}USDT$' or p_quantity <= 0 or p_quantity <> trunc(p_quantity,8) then
    raise exception 'invalid symbol or quantity precision';
  end if;
  if (p_type = 'MARKET' and (p_limit_price is not null or p_stop_price is not null))
     or (p_type = 'LIMIT' and (p_limit_price is null or p_stop_price is not null))
     or (p_type = 'STOP_LIMIT' and (p_limit_price is null or p_stop_price is null)) then
    raise exception 'invalid price fields for order type';
  end if;

  select * into v_order from public.orders where trading_account_id = v_account and idempotency_key = v_key;
  if found then return v_order; end if;

  select * into v_snapshot from public.market_snapshots
   where symbol = upper(p_symbol) and received_at > now() - interval '60 seconds'
   order by received_at desc limit 1;
  if v_snapshot.id is null then raise exception 'a fresh server market quote is required before submitting an order'; end if;

  if p_quantity * coalesce(p_limit_price, case when p_side = 'BUY' then v_snapshot.ask_price else v_snapshot.bid_price end) < 10 then
    raise exception 'minimum order notional is 10 USDT';
  end if;

  v_base := regexp_replace(upper(p_symbol), 'USDT$', '');
  v_asset := case when p_side = 'BUY' then 'USDT' else v_base end;
  v_reserve := case when p_side = 'BUY' then p_quantity * greatest(coalesce(p_limit_price, v_snapshot.ask_price), v_snapshot.ask_price) * 1.002 else p_quantity end;

  if public.demo_wallet_balance(v_account, v_asset, 'AVAILABLE') < v_reserve then
    raise exception 'insufficient available %', v_asset;
  end if;

  perform public.post_demo_ledger(
    v_account, 'reserve-' || v_key, 'Reserve funds for demo order',
    jsonb_build_array(
      jsonb_build_object('asset', v_asset, 'kind', 'AVAILABLE', 'amount', -v_reserve),
      jsonb_build_object('asset', v_asset, 'kind', 'RESERVED', 'amount', v_reserve)
    )
  );

  v_state := case when p_type = 'MARKET' then 'ACCEPTED' else 'OPEN' end;
  insert into public.orders(
    trading_account_id, client_order_id, execution_mode, symbol, side, type, state,
    quantity, limit_price, stop_price, reserved_amount, reserved_asset, idempotency_key
  ) values (
    v_account, p_client_order_id, 'DEMO', upper(p_symbol), p_side, p_type, v_state,
    p_quantity, p_limit_price, p_stop_price, v_reserve, v_asset, v_key
  ) returning * into v_order;

  perform public.append_demo_event(
    v_order.id, v_account, 'ACCEPTED', 'PENDING_VALIDATION', v_state, null,
    'event-accept-' || v_key, jsonb_build_object('quantity', p_quantity, 'reserved', v_reserve)
  );

  if p_type = 'MARKET' then
    perform public.fill_demo_order(v_order.id, v_snapshot.id);
    select * into v_order from public.orders where id = v_order.id;
  end if;

  return v_order;
end;
$$;

-- 5. Customer Administration RPCs

-- Apply Account Restriction
create or replace function public.apply_account_restriction(
    p_user_id uuid, p_type text, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_reason text;
    v_res_id uuid;
begin
    v_staff := admin_private.require_staff('customers.restrict_trading');
    if p_user_id is null then raise exception 'validation_failed'; end if;
    if p_type is null or p_type not in ('TRADING') then raise exception 'validation_failed'; end if;
    v_reason := btrim(coalesce(p_reason, ''));
    if char_length(v_reason) not between 3 and 500 then raise exception 'validation_failed'; end if;

    if not exists (select 1 from auth.users where id = p_user_id) then
        raise exception 'not_found';
    end if;

    -- Deactivate any previous active restriction of this type
    update public.account_restrictions
       set active = false, lifted_at = now(), lifted_by = v_staff.user_id, lifted_reason = 'Superseded by new restriction'
     where user_id = p_user_id and restriction_type = p_type and active;

    insert into public.account_restrictions (user_id, restriction_type, active, reason, applied_by, applied_at)
    values (p_user_id, p_type, true, v_reason, v_staff.user_id, now())
    returning id into v_res_id;

    insert into public.admin_audit_events(
        actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state
    ) values (
        v_staff.user_id, 'staff', 'customer.restrict', 'customer', p_user_id, gen_random_uuid(), v_reason,
        jsonb_build_object('restriction_id', v_res_id, 'type', p_type, 'active', true)
    );

    return jsonb_build_object(
        'id', v_res_id, 'user_id', p_user_id, 'type', p_type, 'active', true,
        'reason', v_reason, 'applied_at', now()
    );
end;
$$;

-- Lift Account Restriction
create or replace function public.lift_account_restriction(
    p_restriction_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_reason text;
    v_res public.account_restrictions%rowtype;
begin
    v_staff := admin_private.require_staff('customers.restrict_trading');
    if p_restriction_id is null then raise exception 'validation_failed'; end if;
    v_reason := btrim(coalesce(p_reason, ''));
    if char_length(v_reason) not between 3 and 500 then raise exception 'validation_failed'; end if;

    select * into v_res from public.account_restrictions where id = p_restriction_id;
    if not found or not v_res.active then
        raise exception 'not_found';
    end if;

    update public.account_restrictions
       set active = false, lifted_at = now(), lifted_by = v_staff.user_id, lifted_reason = v_reason
     where id = p_restriction_id;

    insert into public.admin_audit_events(
        actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state
    ) values (
        v_staff.user_id, 'staff', 'customer.lift_restriction', 'customer', v_res.user_id, gen_random_uuid(), v_reason,
        jsonb_build_object('restriction_id', p_restriction_id, 'type', v_res.restriction_type, 'active', false)
    );

    return jsonb_build_object(
        'id', p_restriction_id, 'user_id', v_res.user_id, 'active', false,
        'lifted_at', now(), 'lifted_reason', v_reason
    );
end;
$$;

-- List Customers
create or replace function public.list_admin_customers(
    p_query text default null, p_limit integer default 20, p_offset integer default 0
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_term text;
    v_results jsonb;
begin
    v_staff := admin_private.require_staff('customers.read');
    p_limit := greatest(1, least(coalesce(p_limit, 20), 100));
    p_offset := greatest(0, coalesce(p_offset, 0));
    v_term := btrim(coalesce(p_query, ''));

    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_results from (
        select
            u.id,
            u.email,
            coalesce(p.display_name, split_part(u.email, '@', 1)) as display_name,
            p.created_at,
            (u.email_confirmed_at is not null) as email_verified,
            (select count(*) from public.account_restrictions r where r.user_id = u.id and r.active) as active_restrictions_count,
            (select count(*) from public.support_requests s where s.user_id = u.id) as tickets_count
        from auth.users u
        left join public.profiles p on p.id = u.id
        where v_term = ''
           or u.id::text = v_term
           or lower(u.email) like '%' || lower(v_term) || '%'
           or lower(coalesce(p.display_name, '')) like '%' || lower(v_term) || '%'
        order by p.created_at desc
        limit p_limit offset p_offset
    ) t;

    return v_results;
end;
$$;

-- Get Customer Detail
create or replace function public.get_admin_customer_detail(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_user record;
    v_profile record;
    v_restrictions jsonb;
    v_balances jsonb;
    v_tickets jsonb;
begin
    v_staff := admin_private.require_staff('customers.read');
    if p_user_id is null then raise exception 'validation_failed'; end if;

    select id, email, email_confirmed_at into v_user
      from auth.users where id = p_user_id;
    if not found then raise exception 'not_found'; end if;

    select display_name, lifecycle_status, created_at, updated_at into v_profile
      from public.profiles where id = p_user_id;

    select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) into v_restrictions from (
        select id, restriction_type, active, reason, applied_at, lifted_at, lifted_reason
          from public.account_restrictions
         where user_id = p_user_id
         order by applied_at desc
    ) r;

    select coalesce(jsonb_agg(row_to_json(b)), '[]'::jsonb) into v_balances from (
        select w.asset, a.kind, coalesce(sum(e.amount), 0) as amount
          from public.trading_accounts ta
          join public.wallets w on w.trading_account_id = ta.id and w.ledger_scope = 'DEMO'
          join public.ledger_accounts a on a.wallet_id = w.id
          left join public.ledger_entries e on e.ledger_account_id = a.id
         where ta.user_id = p_user_id and ta.execution_mode = 'DEMO'
         group by w.asset, a.kind
         order by w.asset, a.kind
    ) b;

    select coalesce(jsonb_agg(row_to_json(s)), '[]'::jsonb) into v_tickets from (
        select id, ticket_number, 'SP-' || ticket_number as reference, subject, status, created_at, last_activity
          from public.support_requests
         where user_id = p_user_id
         order by created_at desc
         limit 10
    ) s;

    return jsonb_build_object(
        'user_id', v_user.id,
        'email', v_user.email,
        'display_name', coalesce(v_profile.display_name, split_part(v_user.email, '@', 1)),
        'lifecycle_status', coalesce(v_profile.lifecycle_status, 'ACTIVE'),
        'created_at', coalesce(v_profile.created_at, now()),
        'email_verified', (v_user.email_confirmed_at is not null),
        'restrictions', v_restrictions,
        'demo_balances', v_balances,
        'recent_tickets', v_tickets
    );
end;
$$;

-- 6. Demo Trading Oversight RPCs

-- List Admin Demo Orders
create or replace function public.list_admin_demo_orders(
    p_user_id uuid default null, p_symbol text default null,
    p_state text default null, p_limit integer default 50
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_results jsonb;
begin
    v_staff := admin_private.require_staff('trading.read_demo');
    p_limit := greatest(1, least(coalesce(p_limit, 50), 100));

    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_results from (
        select
            o.id,
            o.symbol,
            o.side,
            o.type as order_type,
            o.limit_price as price,
            o.stop_price,
            o.quantity,
            o.reserved_amount,
            o.reserved_asset,
            o.state,
            o.submitted_at,
            o.updated_at,
            ta.user_id,
            u.email as customer_email,
            coalesce(p.display_name, split_part(u.email, '@', 1)) as customer_name
        from public.orders o
        join public.trading_accounts ta on ta.id = o.trading_account_id
        join auth.users u on u.id = ta.user_id
        left join public.profiles p on p.id = u.id
        where ta.execution_mode = 'DEMO'
          and (p_user_id is null or ta.user_id = p_user_id)
          and (p_symbol is null or o.symbol = upper(trim(p_symbol)))
          and (p_state is null or o.state::text = upper(trim(p_state)))
        order by o.submitted_at desc
        limit p_limit
    ) t;

    return v_results;
end;
$$;

-- Get Demo Order Detail
create or replace function public.get_admin_demo_order_detail(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_order record;
    v_events jsonb;
    v_fills jsonb;
begin
    v_staff := admin_private.require_staff('trading.read_demo');
    if p_order_id is null then raise exception 'validation_failed'; end if;

    select o.*, ta.user_id, u.email as customer_email,
           coalesce(p.display_name, split_part(u.email, '@', 1)) as customer_name
      into v_order
      from public.orders o
      join public.trading_accounts ta on ta.id = o.trading_account_id
      join auth.users u on u.id = ta.user_id
      left join public.profiles p on p.id = u.id
     where o.id = p_order_id and ta.execution_mode = 'DEMO';

    if not found then raise exception 'not_found'; end if;

    select coalesce(jsonb_agg(row_to_json(e)), '[]'::jsonb) into v_events from (
        select id, event_type, previous_state, next_state, actor_type, reason_code, occurred_at as created_at, metadata
          from public.execution_events
         where order_id = p_order_id
         order by occurred_at asc
    ) e;

    select coalesce(jsonb_agg(row_to_json(f)), '[]'::jsonb) into v_fills from (
        select id, order_id, execution_price as price, quantity, fee, fee_asset, executed_at
          from public.fills
         where order_id = p_order_id
         order by executed_at asc
    ) f;

    return jsonb_build_object(
        'id', v_order.id,
        'symbol', v_order.symbol,
        'side', v_order.side,
        'order_type', v_order.type,
        'price', v_order.limit_price,
        'stop_price', v_order.stop_price,
        'quantity', v_order.quantity,
        'reserved_amount', v_order.reserved_amount,
        'reserved_asset', v_order.reserved_asset,
        'state', v_order.state,
        'submitted_at', v_order.submitted_at,
        'customer_id', v_order.user_id,
        'customer_email', v_order.customer_email,
        'customer_name', v_order.customer_name,
        'events', v_events,
        'fills', v_fills
    );
end;
$$;

-- 7. Markets & Quote Health RPCs

-- List Market Health
create or replace function public.list_admin_market_health()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_results jsonb;
begin
    v_staff := admin_private.require_staff('markets.manage');

    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_results from (
        select
            c.symbol,
            c.trading_paused,
            c.paused_at,
            c.reason as pause_reason,
            s.bid_price,
            s.ask_price,
            s.received_at as last_quote_time,
            case
                when s.received_at is null then 'no_data'
                when s.received_at >= now() - interval '2 minutes' then 'fresh'
                else 'stale'
            end as freshness
        from public.market_symbol_controls c
        left join lateral (
            select bid_price, ask_price, received_at
              from public.market_snapshots ms
             where ms.symbol = c.symbol
             order by ms.received_at desc
             limit 1
        ) s on true
        order by c.symbol
    ) t;

    return v_results;
end;
$$;

-- Set Symbol Trading Status (Pause / Resume)
create or replace function public.set_symbol_trading_status(
    p_symbol text, p_paused boolean, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_sym text := upper(btrim(coalesce(p_symbol, '')));
    v_reason text := btrim(coalesce(p_reason, ''));
    v_control_id uuid;
begin
    v_staff := admin_private.require_staff('markets.manage');
    if v_sym not in ('BTCUSDT', 'ETHUSDT') then raise exception 'unsupported symbol %', v_sym; end if;
    if p_paused is null then raise exception 'validation_failed'; end if;
    if p_paused and char_length(v_reason) < 3 then raise exception 'validation_failed'; end if;

    insert into public.market_symbol_controls(symbol, trading_paused, paused_by, paused_at, reason)
    values (v_sym, p_paused, case when p_paused then v_staff.user_id else null end, case when p_paused then now() else null end, case when p_paused then v_reason else null end)
    on conflict (symbol) do update set
        trading_paused = excluded.trading_paused,
        paused_by = excluded.paused_by,
        paused_at = excluded.paused_at,
        reason = excluded.reason
    returning id into v_control_id;

    insert into public.admin_audit_events(
        actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state
    ) values (
        v_staff.user_id, 'staff', case when p_paused then 'markets.pause_symbol' else 'markets.resume_symbol' end,
        'market_symbol', v_control_id, gen_random_uuid(), coalesce(v_reason, 'Status update'),
        jsonb_build_object('symbol', v_sym, 'trading_paused', p_paused)
    );

    return jsonb_build_object('symbol', v_sym, 'trading_paused', p_paused, 'updated_at', now());
end;
$$;

-- 8. Staff Management Extension (Owner-Only)

-- List Staff Members
create or replace function public.list_staff_members()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_results jsonb;
begin
    v_staff := admin_private.require_staff('staff.manage');

    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_results from (
        select
            s.user_id,
            u.email,
            coalesce(p.display_name, split_part(u.email, '@', 1)) as display_name,
            s.role,
            s.active,
            s.version,
            s.updated_at,
            s.granted_by
        from public.staff_roles s
        join auth.users u on u.id = s.user_id
        left join public.profiles p on p.id = u.id
        order by s.active desc, s.role, s.updated_at desc
    ) t;

    return v_results;
end;
$$;

-- 9. Platform Overview Summary RPC
create or replace function public.get_platform_overview()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_open_tickets integer;
    v_unassigned_tickets integer;
    v_waiting_tickets integer;
    v_total_customers integer;
    v_active_restrictions integer;
    v_orders_today integer;
    v_active_staff integer;
    v_market_health text := 'healthy';
begin
    v_staff := admin_private.require_staff('staff.enter');

    select count(*) into v_open_tickets from public.support_requests where status in ('open', 'in_progress');
    select count(*) into v_unassigned_tickets from public.support_requests where status in ('open', 'in_progress') and assignee_id is null;
    select count(*) into v_waiting_tickets from public.support_requests where status = 'waiting_for_customer';

    select count(*) into v_total_customers from auth.users;
    select count(*) into v_active_restrictions from public.account_restrictions where active;
    select count(*) into v_active_staff from public.staff_roles where active;
    select count(*) into v_orders_today from public.orders where submitted_at >= current_date;

    if exists (
        select 1 from public.market_symbol_controls c
        left join lateral (
            select received_at from public.market_snapshots ms where ms.symbol = c.symbol order by received_at desc limit 1
        ) s on true
        where c.trading_paused or s.received_at is null or s.received_at < now() - interval '5 minutes'
    ) then
        v_market_health := 'degraded';
    end if;

    return jsonb_build_object(
        'open_tickets', v_open_tickets,
        'unassigned_tickets', v_unassigned_tickets,
        'waiting_tickets', v_waiting_tickets,
        'total_customers', v_total_customers,
        'active_restrictions', v_active_restrictions,
        'active_staff', v_active_staff,
        'orders_today', v_orders_today,
        'market_health', v_market_health,
        'timestamp', now()
    );
end;
$$;

-- Grant execution to authenticated role
grant execute on function public.apply_account_restriction(uuid, text, text) to authenticated;
grant execute on function public.lift_account_restriction(uuid, text) to authenticated;
grant execute on function public.list_admin_customers(text, integer, integer) to authenticated;
grant execute on function public.get_admin_customer_detail(uuid) to authenticated;
grant execute on function public.list_admin_demo_orders(uuid, text, text, integer) to authenticated;
grant execute on function public.get_admin_demo_order_detail(uuid) to authenticated;
grant execute on function public.list_admin_market_health() to authenticated;
grant execute on function public.set_symbol_trading_status(text, boolean, text) to authenticated;
grant execute on function public.list_staff_members() to authenticated;
grant execute on function public.get_platform_overview() to authenticated;
