-- Disable the legacy spot module without deleting its historical data.

create table if not exists public.platform_modules (
    module_key text primary key,
    enabled boolean not null,
    changed_at timestamptz not null default now(),
    reason text not null
);
alter table public.platform_modules enable row level security;
revoke all on public.platform_modules from public, anon, authenticated, service_role;

insert into public.platform_modules(module_key, enabled, reason) values
    ('crypto_spot', false, 'Replaced by the proprietary digit-index engine'),
    ('digit_indices', true, 'Digit-index engine enabled'),
    ('real_accounts', false, 'Real accounts require the audited readiness gate')
on conflict (module_key) do update set enabled = excluded.enabled, changed_at = now(), reason = excluded.reason;

create or replace function public.module_enabled(p_module_key text)
returns boolean language sql stable security definer set search_path = '' as $$
    select coalesce((select m.enabled from public.platform_modules m where m.module_key = p_module_key), false);
$$;
revoke all on function public.module_enabled(text) from public, anon, authenticated;

-- Keep the latest implementations available behind names that cannot be called by clients.
alter function public.submit_demo_order(text,text,public.order_side,public.order_type,numeric,numeric,numeric,text) rename to submit_demo_order_crypto_legacy;
alter function public.cancel_demo_order(uuid,text) rename to cancel_demo_order_crypto_legacy;
alter function public.fill_demo_order(uuid,uuid) rename to fill_demo_order_crypto_legacy;
alter function public.process_demo_orders(uuid) rename to process_demo_orders_crypto_legacy;

create or replace function public.submit_demo_order(
    p_client_order_id text, p_symbol text, p_side public.order_side, p_type public.order_type,
    p_quantity numeric, p_limit_price numeric default null, p_stop_price numeric default null,
    p_idempotency_key text default null
) returns public.orders language plpgsql security definer set search_path = '' as $$
begin
    if not public.module_enabled('crypto_spot') then raise exception 'module_disabled'; end if;
    return public.submit_demo_order_crypto_legacy(p_client_order_id, p_symbol, p_side, p_type, p_quantity, p_limit_price, p_stop_price, p_idempotency_key);
end;
$$;

create or replace function public.cancel_demo_order(p_order_id uuid, p_idempotency_key text)
returns public.orders language plpgsql security definer set search_path = '' as $$
begin
    if not public.module_enabled('crypto_spot') then raise exception 'module_disabled'; end if;
    return public.cancel_demo_order_crypto_legacy(p_order_id, p_idempotency_key);
end;
$$;

create or replace function public.fill_demo_order(p_order uuid, p_snapshot uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
    if not public.module_enabled('crypto_spot') then raise exception 'module_disabled'; end if;
    perform public.fill_demo_order_crypto_legacy(p_order, p_snapshot);
end;
$$;

create or replace function public.process_demo_orders(p_snapshot_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
begin
    if not public.module_enabled('crypto_spot') then raise exception 'module_disabled'; end if;
    return public.process_demo_orders_crypto_legacy(p_snapshot_id);
end;
$$;

revoke all on function public.submit_demo_order(text,text,public.order_side,public.order_type,numeric,numeric,numeric,text), public.cancel_demo_order(uuid,text) from public, anon, authenticated;
revoke all on function public.fill_demo_order(uuid,uuid), public.process_demo_orders(uuid) from public, anon, authenticated;

-- Release every reservation once. The old ledger helper makes this idempotent by key.
do $$
declare v_order record;
begin
    for v_order in select id, trading_account_id, reserved_asset, reserved_amount, state from public.orders where state in ('ACCEPTED', 'OPEN', 'PARTIALLY_FILLED') for update loop
        perform public.post_demo_ledger(v_order.trading_account_id, 'module-disable-release-' || v_order.id,
            'Release reservation after crypto module shutdown',
            jsonb_build_array(
                jsonb_build_object('asset', v_order.reserved_asset, 'kind', 'RESERVED', 'amount', -v_order.reserved_amount),
                jsonb_build_object('asset', v_order.reserved_asset, 'kind', 'AVAILABLE', 'amount', v_order.reserved_amount)
            ));
        update public.orders set state = 'CANCELLED' where id = v_order.id;
        perform public.append_demo_event(v_order.id, v_order.trading_account_id, 'CANCELLED', v_order.state, 'CANCELLED', 'MODULE_DISABLED',
            'module-disable-event-' || v_order.id, jsonb_build_object('reason', 'MODULE_DISABLED'));
    end loop;
end;
$$;

do $$ begin
    if exists (select 1 from pg_namespace where nspname = 'cron') then
        perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'process-demo-orders-every-minute';
    end if;
end $$;

-- New sign-ups are identity-only; Practice enrolment is deliberately lazy.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    insert into public.profiles(id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', new.email))
    on conflict (id) do nothing;
    return new;
end;
$$;

create or replace function admin_private.role_capabilities(p_role text) returns text[]
language sql immutable set search_path = '' as $$
    select case p_role
        when 'support_agent' then array['staff.enter','support.read_assigned','support.reply','support.note','support.transition','customers.restrict.notice']
        when 'administrator' then array['staff.enter','support.read_all','support.reply','support.note','support.transition','support.assign','support.close','customers.read','customers.restrict.notice','customers.restrict.limit','customers.restrict.block','contracts.read','engine.read','engine.manage','operations.read']
        when 'owner' then array['staff.enter','support.read_all','support.reply','support.note','support.transition','support.assign','support.close','customers.read','customers.restrict.notice','customers.restrict.limit','customers.restrict.block','customers.restrict.block_severe','contracts.read','contracts.void','engine.read','engine.manage','operations.read','staff.manage','audit.read','platform.enable_real']
        else array[]::text[] end;
$$;

drop function if exists public.list_admin_market_health();
drop function if exists public.set_symbol_trading_status(text,boolean,text);
drop function if exists public.list_admin_demo_orders(uuid,text,text,integer);
drop function if exists public.get_admin_demo_order_detail(uuid);

create or replace function public.get_platform_overview()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_staff public.staff_roles;
begin
    v_staff := admin_private.require_staff('staff.enter');
    return jsonb_build_object(
        'open_tickets', (select count(*) from public.support_requests where status in ('open','in_progress')),
        'unassigned_tickets', (select count(*) from public.support_requests where status in ('open','in_progress') and assignee_id is null),
        'waiting_tickets', (select count(*) from public.support_requests where status = 'waiting_for_customer'),
        'total_customers', (select count(*) from auth.users),
        'active_restrictions', (select count(*) from public.account_restrictions where active),
        'active_staff', (select count(*) from public.staff_roles where active),
        'contracts_today', 0,
        'engine_health', 'unavailable',
        'timestamp', now()
    );
end;
$$;

revoke all on function public.get_platform_overview() from public, anon;
grant execute on function public.get_platform_overview() to authenticated;
