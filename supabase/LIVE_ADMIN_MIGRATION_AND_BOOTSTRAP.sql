-- ==============================================================================
-- SMARTPROFITBINARY — LIVE ADMIN & OPERATIONS RECONCILIATION + BOOTSTRAP
-- Paste into the Supabase SQL Editor (Dashboard -> SQL Editor) and run once.
--
-- WHY THIS FILE EXISTS
--   An earlier revision of this file defined the admin RPCs with DIFFERENT
--   parameter names and return shapes than supabase/migrations. A database that
--   ran that revision answers PostgREST with PGRST202 ("function not found")
--   for every browser call, because the browser sends the migration's names:
--     list_admin_customers(p_query, p_limit, p_offset)
--     apply_account_restriction(p_user_id, p_type, p_reason)
--     set_symbol_trading_status(p_symbol, p_paused, p_reason)
--   That single drift took out customer search, trading restrictions, and
--   symbol pausing at once.
--
-- AUTHORITY
--   supabase/migrations is the source of truth. This script is the manual,
--   idempotent application of that schema for an environment where the
--   migration runner cannot be used. Keep the two in sync: the bodies below are
--   byte-for-byte equivalents of migrations 20260917100000, 20260918120000,
--   20260919120000 and 20260919130000.
--
-- WHY THE CUSTOMER RPC IS IN HERE
--   This file has drifted once already. 20260919130000 defines
--   get_my_active_restrictions(); this script did not, while the customer account
--   page called that RPC as a fatal dependency. One missing function therefore
--   blanked profile, balances, orders, positions and equity for every customer.
--   Section 7a now carries it, and Section 13 fails loudly if it goes missing
--   again.
--
-- SAFE TO RE-RUN. Every step is idempotent. Section 0 is a prerequisite guard,
--   Section 13 is a self-check that fails loudly if anything is still wrong.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 0. Prerequisite guard
-- ------------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
        begin
            create extension if not exists pgcrypto;
        exception when insufficient_privilege then
            null; -- gen_random_uuid() is built in on PostgreSQL 13+.
        end;
    end if;
    if not exists (select 1 from information_schema.tables
                    where table_schema = 'public' and table_name = 'trading_accounts') then
        raise exception 'Trading foundation is missing. Apply supabase/migrations/20260912150000_trading_foundation.sql first.';
    end if;
    if not exists (select 1 from information_schema.tables
                    where table_schema = 'public' and table_name = 'support_requests') then
        raise exception 'Support schema is missing. Apply supabase/migrations/20260916120000_support_requests.sql first.';
    end if;
end $$;

-- ------------------------------------------------------------------------------
-- 1. Remove the divergent legacy definitions
-- ------------------------------------------------------------------------------
-- Return types changed between revisions, and `create or replace` cannot change
-- a return type, so each one must be dropped before it is recreated. Dropping a
-- callable does not drop callers: PL/pgSQL resolves callees at run time.
drop function if exists public.list_admin_customers(text, integer);
drop function if exists public.get_admin_customer_detail(uuid);
drop function if exists public.apply_account_restriction(uuid, text, text);
drop function if exists public.lift_account_restriction(uuid, text);
drop function if exists public.list_admin_demo_orders(uuid, text, text, integer);
drop function if exists public.get_admin_demo_order_detail(uuid);
drop function if exists public.list_admin_market_health();
drop function if exists public.set_symbol_trading_status(text, text, text);   -- legacy text form
drop function if exists public.set_symbol_trading_status(text, boolean, text);
drop function if exists public.list_staff_members();
drop function if exists public.get_platform_overview();
drop function if exists public.list_admin_audit(timestamptz, uuid);
drop function if exists public.get_staff_context();
drop function if exists public.change_staff_role(uuid, text, boolean, bigint, text, uuid);
drop function if exists public.list_executable_symbols();
-- Return type changes cannot be made with `create or replace`, so the customer
-- restriction reader is dropped for the same reason as the rest of this list.
drop function if exists public.get_my_active_restrictions();
drop function if exists admin_private.require_staff(text, boolean);
drop function if exists admin_private.role_capabilities(text);

-- ------------------------------------------------------------------------------
-- 2. Reconcile the control-plane tables
-- ------------------------------------------------------------------------------
-- The legacy revision used a different column shape for the same two tables.
-- `create table if not exists` would silently keep the wrong shape, so the
-- columns are reconciled in place. Moderation history is preserved.

create table if not exists public.account_restrictions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    restriction_type text not null,
    reason text not null,
    applied_by uuid not null,
    applied_at timestamptz not null default now(),
    lifted_at timestamptz,
    lifted_by uuid,
    lifted_reason text
);

alter table public.account_restrictions add column if not exists active boolean not null default true;
alter table public.account_restrictions add column if not exists reason text;
alter table public.account_restrictions add column if not exists applied_by uuid;
alter table public.account_restrictions add column if not exists applied_at timestamptz not null default now();
alter table public.account_restrictions add column if not exists lifted_at timestamptz;
alter table public.account_restrictions add column if not exists lifted_by uuid;
alter table public.account_restrictions add column if not exists lifted_reason text;

do $$
begin
    -- Backfill the new shape from the legacy columns, then retire them.
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'account_restrictions' and column_name = 'status') then
        execute $sql$update public.account_restrictions set active = (status = 'active') where active is distinct from (status = 'active')$sql$;
        execute $sql$alter table public.account_restrictions drop column status$sql$;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'account_restrictions' and column_name = 'lift_reason') then
        execute $sql$update public.account_restrictions set lifted_reason = coalesce(lifted_reason, lift_reason) where lifted_reason is null$sql$;
        execute $sql$alter table public.account_restrictions drop column lift_reason$sql$;
    end if;
end $$;

-- The legacy restriction vocabulary is retired; the live vocabulary includes TRADING.
alter table public.account_restrictions drop constraint if exists account_restrictions_restriction_type_check;
alter table public.account_restrictions drop constraint if exists account_restrictions_status_check;
alter table public.account_restrictions add constraint account_restrictions_restriction_type_check
    check (restriction_type in ('TRADING'));
alter table public.account_restrictions drop constraint if exists account_restrictions_reason_check;
alter table public.account_restrictions add constraint account_restrictions_reason_check
    check (char_length(btrim(reason)) between 3 and 500);
alter table public.account_restrictions drop constraint if exists account_restrictions_lifted_reason_check;
alter table public.account_restrictions add constraint account_restrictions_lifted_reason_check
    check (lifted_reason is null or char_length(btrim(lifted_reason)) between 3 and 500);
create index if not exists account_restrictions_user_idx on public.account_restrictions(user_id, active);
alter table public.account_restrictions enable row level security;
revoke all on public.account_restrictions from public, anon, authenticated, service_role;

create table if not exists public.market_symbol_controls (
    id uuid primary key default gen_random_uuid(),
    symbol text unique not null,
    trading_paused boolean not null default false,
    paused_by uuid,
    paused_at timestamptz,
    reason text
);

alter table public.market_symbol_controls add column if not exists id uuid;
alter table public.market_symbol_controls add column if not exists trading_paused boolean not null default false;
alter table public.market_symbol_controls add column if not exists paused_by uuid;
alter table public.market_symbol_controls add column if not exists paused_at timestamptz;
alter table public.market_symbol_controls add column if not exists reason text;

do $$
begin
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'market_symbol_controls' and column_name = 'trading_status') then
        execute $sql$update public.market_symbol_controls set trading_paused = (trading_status = 'paused') where trading_paused is distinct from (trading_status = 'paused')$sql$;
        execute $sql$alter table public.market_symbol_controls drop column trading_status$sql$;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'market_symbol_controls' and column_name = 'pause_reason') then
        execute $sql$update public.market_symbol_controls set reason = coalesce(reason, pause_reason) where reason is null$sql$;
        execute $sql$alter table public.market_symbol_controls drop column pause_reason$sql$;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'market_symbol_controls' and column_name = 'updated_by') then
        execute $sql$update public.market_symbol_controls set paused_by = coalesce(paused_by, updated_by) where paused_by is null$sql$;
        execute $sql$alter table public.market_symbol_controls drop column updated_by$sql$;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'market_symbol_controls' and column_name = 'updated_at') then
        execute $sql$alter table public.market_symbol_controls drop column updated_at$sql$;
    end if;
end $$;

-- Backfill surrogate ids for rows created by the legacy symbol-primary-key shape.
update public.market_symbol_controls set id = gen_random_uuid() where id is null;
create unique index if not exists market_symbol_controls_id_idx on public.market_symbol_controls(id);
create unique index if not exists market_symbol_controls_symbol_idx on public.market_symbol_controls(symbol);
alter table public.market_symbol_controls enable row level security;
revoke all on public.market_symbol_controls from public, anon, authenticated, service_role;
-- ------------------------------------------------------------------------------
-- 3. Private access foundation
-- ------------------------------------------------------------------------------
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

-- Audit UUIDs intentionally have no Auth FK: evidence survives account removal.
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

-- ------------------------------------------------------------------------------
-- 4. Capabilities and the staff gate
-- ------------------------------------------------------------------------------
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

create or replace function admin_private.require_staff(p_capability text, p_fresh boolean default false)
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

create or replace function public.get_staff_context() returns jsonb
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

-- ------------------------------------------------------------------------------
-- 5. Market registry (single source of truth for listed vs executable pairs)
-- ------------------------------------------------------------------------------
create table if not exists public.market_symbols (
    symbol text primary key check (symbol ~ '^[A-Z0-9]{2,18}USDT$'),
    base_asset text not null check (base_asset ~ '^[A-Z0-9]{2,12}$'),
    display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
    tradable boolean not null default false,
    sort_order integer not null default 1000,
    listed_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists market_symbols_tradable_idx on public.market_symbols(tradable, sort_order);
alter table public.market_symbols enable row level security;
revoke all on public.market_symbols from public, anon, authenticated, service_role;

-- Only BTC and ETH start tradable: those are the pairs the quote worker prices.
insert into public.market_symbols(symbol, base_asset, display_name, tradable, sort_order) values
    ('BTCUSDT','BTC','Bitcoin',true,1),
    ('ETHUSDT','ETH','Ethereum',true,2),
    ('SOLUSDT','SOL','Solana',false,3),
    ('BNBUSDT','BNB','BNB',false,4),
    ('XRPUSDT','XRP','XRP',false,5),
    ('DOGEUSDT','DOGE','Dogecoin',false,6),
    ('ADAUSDT','ADA','Cardano',false,7),
    ('AVAXUSDT','AVAX','Avalanche',false,8),
    ('SUIUSDT','SUI','Sui',false,9),
    ('LINKUSDT','LINK','Chainlink',false,10),
    ('SHIBUSDT','SHIB','Shiba Inu',false,11),
    ('NEARUSDT','NEAR','NEAR Protocol',false,12),
    ('PEPEUSDT','PEPE','Pepe',false,13),
    ('LTCUSDT','LTC','Litecoin',false,14),
    ('DOTUSDT','DOT','Polkadot',false,15),
    ('BCHUSDT','BCH','Bitcoin Cash',false,16),
    ('UNIUSDT','UNI','Uniswap',false,17),
    ('APTUSDT','APT','Aptos',false,18),
    ('ICPUSDT','ICP','Internet Computer',false,19),
    ('FETUSDT','FET','Fetch.ai',false,20),
    ('AAVEUSDT','AAVE','Aave',false,21),
    ('RENDERUSDT','RENDER','Render',false,22),
    ('FILUSDT','FIL','Filecoin',false,23),
    ('ARBUSDT','ARB','Arbitrum',false,24),
    ('OPUSDT','OP','Optimism',false,25),
    ('TIAUSDT','TIA','Celestia',false,26),
    ('INJUSDT','INJ','Injective',false,27),
    ('TRXUSDT','TRX','TRON',false,28),
    ('FTMUSDT','FTM','Fantom',false,29),
    ('WIFUSDT','WIF','dogwifhat',false,30),
    ('STXUSDT','STX','Stacks',false,31),
    ('XLMUSDT','XLM','Stellar',false,32),
    ('ATOMUSDT','ATOM','Cosmos',false,33),
    ('ETCUSDT','ETC','Ethereum Classic',false,34),
    ('XMRUSDT','XMR','Monero',false,35),
    ('GRTUSDT','GRT','The Graph',false,36),
    ('THETAUSDT','THETA','Theta Network',false,37),
    ('MKRUSDT','MKR','Maker',false,38),
    ('VETUSDT','VET','VeChain',false,39),
    ('LDOUSDT','LDO','Lido DAO',false,40),
    ('RUNEUSDT','RUNE','THORChain',false,41),
    ('ALGOUSDT','ALGO','Algorand',false,42),
    ('SEIUSDT','SEI','Sei',false,43),
    ('FLOKIUSDT','FLOKI','FLOKI',false,44),
    ('BONKUSDT','BONK','Bonk',false,45),
    ('JUPUSDT','JUP','Jupiter',false,46),
    ('BEAMUSDT','BEAM','Beam',false,47),
    ('OMUSDT','OM','MANTRA',false,48),
    ('PYTHUSDT','PYTH','Pyth Network',false,49),
    ('GALAUSDT','GALA','Gala',false,50),
    ('BLURUSDT','BLUR','Blur',false,51),
    ('CRVUSDT','CRV','Curve DAO',false,52),
    ('DYDXUSDT','DYDX','dYdX',false,53),
    ('SANDUSDT','SAND','The Sandbox',false,54),
    ('MANAUSDT','MANA','Decentraland',false,55),
    ('AXSUSDT','AXS','Axie Infinity',false,56),
    ('IMXUSDT','IMX','Immutable',false,57),
    ('ENAUSDT','ENA','Ethena',false,58),
    ('PENDLEUSDT','PENDLE','Pendle',false,59),
    ('WLDUSDT','WLD','Worldcoin',false,60),
    ('STRKUSDT','STRK','Starknet',false,61),
    ('JASMYUSDT','JASMY','JasmyCoin',false,62),
    ('NOTUSDT','NOT','Notcoin',false,63),
    ('BOMEUSDT','BOME','BOOK OF MEME',false,64),
    ('TAOUSDT','TAO','Bittensor',false,65),
    ('TONUSDT','TON','Toncoin',false,66),
    ('ONDOUSDT','ONDO','Ondo',false,67),
    ('POLUSDT','POL','POL (MATIC)',false,68),
    ('QNTUSDT','QNT','Quant',false,69),
    ('CHZUSDT','CHZ','Chiliz',false,70),
    ('APEUSDT','APE','ApeCoin',false,71),
    ('EOSUSDT','EOS','EOS',false,72),
    ('NEOUSDT','NEO','NEO',false,73),
    ('FLOWUSDT','FLOW','Flow',false,74),
    ('GMXUSDT','GMX','GMX',false,75)
on conflict (symbol) do update set
    base_asset = excluded.base_asset,
    display_name = excluded.display_name,
    sort_order = excluded.sort_order;

drop trigger if exists market_symbols_updated_at on public.market_symbols;
create trigger market_symbols_updated_at before update on public.market_symbols
    for each row execute function public.set_updated_at();

-- Pause rows may only reference registered symbols.
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'market_symbol_controls_symbol_fkey') then
        alter table public.market_symbol_controls
            add constraint market_symbol_controls_symbol_fkey
            foreign key (symbol) references public.market_symbols(symbol) on delete restrict;
    end if;
end $$;

-- Seed the pause table for the executable pairs only.
insert into public.market_symbol_controls(symbol, trading_paused)
select s.symbol, false from public.market_symbols s where s.tradable
on conflict (symbol) do nothing;

create or replace function public.list_executable_symbols()
returns text[] language sql stable security definer set search_path = '' as $$
    select coalesce(array_agg(r.symbol order by r.sort_order, r.symbol), array[]::text[])
      from public.market_symbols r
      left join public.market_symbol_controls c on c.symbol = r.symbol
     where r.tradable and not coalesce(c.trading_paused, false);
$$;
revoke all on function public.list_executable_symbols() from public, anon, authenticated;
grant execute on function public.list_executable_symbols() to service_role;

-- The browser reads the listed catalog from here instead of a hardcoded array.
create or replace function public.list_market_catalog()
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'symbol', r.symbol,
        'base_asset', r.base_asset,
        'display_name', r.display_name,
        'tradable', r.tradable,
        'paused', coalesce(c.trading_paused, false)
    ) order by r.sort_order, r.symbol), '[]'::jsonb)
      from public.market_symbols r
      left join public.market_symbol_controls c on c.symbol = r.symbol;
$$;
revoke all on function public.list_market_catalog() from public;
grant execute on function public.list_market_catalog() to anon, authenticated;

-- ------------------------------------------------------------------------------
-- 6. Registry-enforced order submission
-- ------------------------------------------------------------------------------
-- Replaces the symbol-regex-only gate. An order is rejected unless the pair is
-- registered, marked tradable, and unpaused, in addition to the account
-- restriction and quote-freshness checks.
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
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_tradable boolean;
  v_paused boolean;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  perform public.assert_demo_order_rate_limit();

  if exists (select 1 from public.account_restrictions where user_id = auth.uid() and restriction_type = 'TRADING' and active) then
    raise exception 'trading_restricted';
  end if;

  select r.tradable into v_tradable from public.market_symbols r where r.symbol = v_symbol;
  if v_tradable is null then raise exception 'unknown symbol %', v_symbol; end if;
  if not v_tradable then raise exception 'symbol_not_tradable %', v_symbol; end if;
  select coalesce(c.trading_paused, false) into v_paused from public.market_symbol_controls c where c.symbol = v_symbol;
  if coalesce(v_paused, false) then raise exception 'symbol_trading_paused'; end if;

  v_account := public.demo_account_for_user();
  if v_account is null then raise exception 'an active DEMO account is required'; end if;
  perform 1 from public.trading_accounts where id = v_account for update;

  if v_symbol !~ '^[A-Z0-9]{2,20}USDT$' or p_quantity <= 0 or p_quantity <> trunc(p_quantity,8) then
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
   where symbol = v_symbol and received_at > now() - interval '60 seconds'
   order by received_at desc limit 1;
  if v_snapshot.id is null then raise exception 'a fresh server market quote is required before submitting an order'; end if;

  if p_quantity * coalesce(p_limit_price, case when p_side = 'BUY' then v_snapshot.ask_price else v_snapshot.bid_price end) < 10 then
    raise exception 'minimum order notional is 10 USDT';
  end if;

  v_base := regexp_replace(v_symbol, 'USDT$', '');
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
    v_account, p_client_order_id, 'DEMO', v_symbol, p_side, p_type, v_state,
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
revoke all on function public.submit_demo_order(text,text,public.order_side,public.order_type,numeric,numeric,numeric,text) from public, anon;
grant execute on function public.submit_demo_order(text,text,public.order_side,public.order_type,numeric,numeric,numeric,text) to authenticated;

-- ------------------------------------------------------------------------------
-- 7. Customer administration
-- ------------------------------------------------------------------------------
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
            coalesce(p.created_at, u.created_at) as created_at,
            (u.email_confirmed_at is not null) as email_verified,
            (select count(*) from public.account_restrictions r where r.user_id = u.id and r.active) as active_restrictions_count,
            (select count(*) from public.support_requests s where s.user_id = u.id) as tickets_count
        from auth.users u
        left join public.profiles p on p.id = u.id
        where v_term = ''
           or u.id::text = v_term
           or lower(u.email) like '%' || lower(v_term) || '%'
           or lower(coalesce(p.display_name, '')) like '%' || lower(v_term) || '%'
        order by coalesce(p.created_at, u.created_at) desc
        limit p_limit offset p_offset
    ) t;

    return v_results;
end;
$$;

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

    select id, email, email_confirmed_at into v_user from auth.users where id = p_user_id;
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
        select id, 'SP-' || ticket_number as reference, subject, status, created_at, last_activity
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
-- Guard: customer detail joins the friendly ticket reference column.
do $$
begin
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'support_requests' and column_name = 'ticket_number') then
        raise exception 'Ticket numbering is missing. Apply supabase/migrations/20260916130000_friendly_ticket_references.sql first.';
    end if;
end $$;

-- ------------------------------------------------------------------------------
-- 7a. Customer-facing restriction status
-- ------------------------------------------------------------------------------
-- Copied verbatim from migration 20260919130000. public.account_restrictions is
-- revoked from anon/authenticated/service_role, so this SECURITY DEFINER
-- function is the only path a customer has to see why they were restricted.
--
-- It takes no user_id parameter on purpose: it is hard-scoped to auth.uid(), so
-- there is no call shape that can read another customer's rows.
create or replace function public.get_my_active_restrictions()
returns table(restriction_type text, reason text, applied_at timestamptz)
language sql security definer set search_path = public stable as $$
    select r.restriction_type, r.reason, r.applied_at
      from public.account_restrictions r
     where r.user_id = auth.uid()
       and r.active = true
     order by r.applied_at desc;
$$;

-- Granted to authenticated only: no client role may reach the table directly.
revoke all on function public.get_my_active_restrictions() from public, anon;
grant execute on function public.get_my_active_restrictions() to authenticated;

-- ------------------------------------------------------------------------------
-- 8. Demo trading oversight
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- 9. Market controls and platform overview
-- ------------------------------------------------------------------------------
create or replace function public.list_admin_market_health()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_results jsonb;
begin
    v_staff := admin_private.require_staff('markets.manage');

    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_results from (
        select
            r.symbol,
            r.base_asset,
            r.display_name,
            r.tradable,
            coalesce(c.trading_paused, false) as trading_paused,
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
        from public.market_symbols r
        left join public.market_symbol_controls c on c.symbol = r.symbol
        left join lateral (
            select bid_price, ask_price, received_at
              from public.market_snapshots ms
             where ms.symbol = r.symbol
             order by ms.received_at desc
             limit 1
        ) s on true
        order by r.sort_order, r.symbol
    ) t;

    return v_results;
end;
$$;

create or replace function public.set_symbol_trading_status(
    p_symbol text, p_paused boolean, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_sym text := upper(btrim(coalesce(p_symbol, '')));
    v_reason text := btrim(coalesce(p_reason, ''));
    v_control_id uuid;
    v_tradable boolean;
begin
    v_staff := admin_private.require_staff('markets.manage');
    if p_paused is null then raise exception 'validation_failed'; end if;

    select tradable into v_tradable from public.market_symbols where symbol = v_sym;
    if v_tradable is null then raise exception 'unsupported symbol %', v_sym; end if;
    if not p_paused and not v_tradable then raise exception 'symbol_not_tradable'; end if;
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
        'market_symbol', v_control_id, gen_random_uuid(), coalesce(nullif(v_reason, ''), 'Status update'),
        jsonb_build_object('symbol', v_sym, 'trading_paused', p_paused, 'tradable', v_tradable)
    );

    return jsonb_build_object('symbol', v_sym, 'trading_paused', p_paused, 'tradable', v_tradable, 'updated_at', now());
end;
$$;

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
        select 1 from public.market_symbols r
        left join public.market_symbol_controls c on c.symbol = r.symbol
        left join lateral (
            select received_at from public.market_snapshots ms where ms.symbol = r.symbol order by received_at desc limit 1
        ) s on true
        where r.tradable and (coalesce(c.trading_paused, false) or s.received_at is null or s.received_at < now() - interval '5 minutes')
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
-- ------------------------------------------------------------------------------
-- 10. Staff governance and the immutable audit trail
-- ------------------------------------------------------------------------------
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

create or replace function admin_private.bootstrap_owner(p_user_id uuid, p_verified_email text, p_reason text)
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

create or replace function public.change_staff_role(p_user_id uuid, p_role text, p_active boolean,
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

create or replace function public.list_admin_audit(p_before_time timestamptz default null, p_before_id uuid default null)
returns setof public.admin_audit_events language plpgsql security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('audit.read');
    if (p_before_time is null) <> (p_before_id is null) then raise exception 'validation_failed'; end if;
    return query select * from public.admin_audit_events
        where p_before_time is null or (created_at, id) < (p_before_time, p_before_id)
        order by created_at desc, id desc limit 50;
end;
$$;

-- ------------------------------------------------------------------------------
-- 11. Grants
-- ------------------------------------------------------------------------------
revoke all on all tables in schema admin_private from public, anon, authenticated, service_role;
revoke all on all functions in schema admin_private from public, anon, authenticated, service_role;

revoke all on function public.get_staff_context() from public, anon, service_role;
revoke all on function public.change_staff_role(uuid,text,boolean,bigint,text,uuid) from public, anon, service_role;
revoke all on function public.list_admin_audit(timestamptz,uuid) from public, anon, service_role;
revoke all on function public.apply_account_restriction(uuid,text,text) from public, anon, service_role;
revoke all on function public.lift_account_restriction(uuid,text) from public, anon, service_role;
revoke all on function public.list_admin_customers(text,integer,integer) from public, anon, service_role;
revoke all on function public.get_admin_customer_detail(uuid) from public, anon, service_role;
revoke all on function public.list_admin_demo_orders(uuid,text,text,integer) from public, anon, service_role;
revoke all on function public.get_admin_demo_order_detail(uuid) from public, anon, service_role;
revoke all on function public.list_admin_market_health() from public, anon, service_role;
revoke all on function public.set_symbol_trading_status(text,boolean,text) from public, anon, service_role;
revoke all on function public.list_staff_members() from public, anon, service_role;
revoke all on function public.get_platform_overview() from public, anon, service_role;

grant execute on function public.get_staff_context() to authenticated;
grant execute on function public.change_staff_role(uuid,text,boolean,bigint,text,uuid) to authenticated;
grant execute on function public.list_admin_audit(timestamptz,uuid) to authenticated;
grant execute on function public.apply_account_restriction(uuid,text,text) to authenticated;
grant execute on function public.lift_account_restriction(uuid,text) to authenticated;
grant execute on function public.list_admin_customers(text,integer,integer) to authenticated;
grant execute on function public.get_admin_customer_detail(uuid) to authenticated;
grant execute on function public.list_admin_demo_orders(uuid,text,text,integer) to authenticated;
grant execute on function public.get_admin_demo_order_detail(uuid) to authenticated;
grant execute on function public.list_admin_market_health() to authenticated;
grant execute on function public.set_symbol_trading_status(text,boolean,text) to authenticated;
grant execute on function public.list_staff_members() to authenticated;
grant execute on function public.get_platform_overview() to authenticated;

-- ------------------------------------------------------------------------------
-- 12. Bootstrap the platform owner
-- ------------------------------------------------------------------------------
-- Replace the email with the signed-up Supabase account that should own the
-- platform, then re-run this block alone. It refuses to run twice.
do $$
declare
    v_user_id uuid;
    v_owner_email text := 'ianwanjiru001@gmail.com';
begin
    select id into v_user_id from auth.users
     where lower(email) = lower(v_owner_email) and email_confirmed_at is not null;
    if v_user_id is null then
        raise notice 'User % has not signed up (or is unconfirmed). Sign up, confirm the email, then re-run this block.', v_owner_email;
    elsif exists (select 1 from public.staff_roles) or exists (select 1 from public.admin_audit_events where action = 'staff.bootstrap') then
        raise notice 'Owner bootstrap already completed; no change made.';
    else
        perform admin_private.bootstrap_owner(v_user_id, v_owner_email, 'Initial platform owner bootstrap');
        raise notice 'User % is now the live platform owner.', v_owner_email;
    end if;
end $$;

-- ------------------------------------------------------------------------------
-- 13. Post-apply self-check
-- ------------------------------------------------------------------------------
-- Fails loudly if any browser-facing signature is still missing or wrong. A
-- clean run prints nothing; a broken run raises with the offending name.
do $$
declare
    v_missing text[] := array[]::text[];
    v_signature record;
begin
    for v_signature in
        select * from (values
            ('list_admin_customers', 'text, integer, integer'::text, 'jsonb'),
            ('get_admin_customer_detail', 'uuid', 'jsonb'),
            ('apply_account_restriction', 'uuid, text, text', 'jsonb'),
            ('lift_account_restriction', 'uuid, text', 'jsonb'),
            ('list_admin_demo_orders', 'uuid, text, text, integer', 'jsonb'),
            ('get_admin_demo_order_detail', 'uuid', 'jsonb'),
            ('list_admin_market_health', '', 'jsonb'),
            ('set_symbol_trading_status', 'text, boolean, text', 'jsonb'),
            ('list_staff_members', '', 'jsonb'),
            ('get_platform_overview', '', 'jsonb'),
            ('list_market_catalog', '', 'jsonb'),
            -- get_my_active_restrictions is a table-returning function, so
            -- pg_get_function_result() reports its column list rather than a
            -- scalar type name; the expected value is that TABLE(...) signature.
            ('get_my_active_restrictions', '', 'TABLE(restriction_type text, reason text, applied_at timestamp with time zone)')
        ) as expected(name, args, returns)
    loop
        if not exists (
            select 1 from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = v_signature.name
              and pg_get_function_result(p.oid) = v_signature.returns
              and oidvectortypes(p.proargtypes) = v_signature.args
        ) then
            v_missing := v_missing || (v_signature.name || '(' || v_signature.args || ')');
        end if;
    end loop;

    -- Stale divergent overloads must be gone, or PostgREST cannot pick a candidate.
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'list_admin_customers'
                  and oidvectortypes(p.proargtypes) = 'text, integer') then
        v_missing := v_missing || 'stale list_admin_customers(text, integer) still present';
    end if;
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'set_symbol_trading_status'
                  and oidvectortypes(p.proargtypes) = 'text, text, text') then
        v_missing := v_missing || 'stale set_symbol_trading_status(text, text, text) still present';
    end if;

    if array_length(v_missing, 1) is not null then
        raise exception 'Reconciliation incomplete. Fix: %', array_to_string(v_missing, '; ');
    end if;

    raise notice 'Admin reconciliation verified: registry has % symbols (% executable).',
        (select count(*) from public.market_symbols),
        (select count(*) from public.list_executable_symbols());
end $$;
