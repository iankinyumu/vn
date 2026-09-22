create schema if not exists engine_private;
revoke all on schema engine_private from public, anon, authenticated, service_role;

create table public.engine_policy_versions (
    version integer primary key, effective_from timestamptz not null, house_margin numeric not null check (house_margin between .005 and .15), margin_overrides jsonb not null default '{}'::jsonb,
    min_ticks integer not null check (min_ticks >= 1), max_ticks integer not null check (max_ticks between min_ticks and 10), max_settlement_delay_seconds integer not null check (max_settlement_delay_seconds > 0),
    max_feed_lag_seconds integer not null check (max_feed_lag_seconds > 0), min_profit_ratio numeric not null check (min_profit_ratio >= 0), tick_retention_days integer not null check (tick_retention_days > 0),
    enabled_contract_types text[] not null, created_by uuid references auth.users(id), reason text not null
);
create table public.engine_policy_limits (
    policy_version integer not null references public.engine_policy_versions(version), execution_mode public.execution_mode not null,
    min_stake numeric not null check (min_stake > 0), max_stake numeric not null check (max_stake >= min_stake), max_open_contracts integer not null check (max_open_contracts > 0), max_buys_per_minute integer not null check (max_buys_per_minute > 0), max_liability_per_tick numeric not null check (max_liability_per_tick > 0), primary key(policy_version, execution_mode)
);
insert into public.engine_policy_versions values (1, now(), .035, '{}'::jsonb, 1, 10, 30, 10, .01, 30, array['EVEN','ODD'], null, 'Initial digit-index policy');
insert into public.engine_policy_limits values (1, 'DEMO', 1, 1000, 20, 30, 100000);

create table public.engine_indices (
    code text not null check (code ~ '^SPI(10|25|50|75|100)$'), execution_mode public.execution_mode not null, display_name text not null, sort_order integer not null,
    tick_interval_ms integer not null check (tick_interval_ms in (1000,2000)), decimals smallint not null check (decimals between 2 and 5), base_price numeric not null check (base_price > 0), sigma_per_tick numeric not null check (sigma_per_tick > 0), kappa numeric not null default .0005, status text not null default 'ACTIVE' check (status in ('ACTIVE','PAUSED')), t0 timestamptz not null default now(), created_at timestamptz not null default now(), primary key(code, execution_mode), check (base_price * sigma_per_tick >= 200 * power(10::numeric, -decimals))
);
create table public.index_state (index_code text not null, execution_mode public.execution_mode not null, last_tick_no bigint not null default 0, last_x numeric, last_price numeric, updated_at timestamptz not null default now(), primary key(index_code,execution_mode), foreign key(index_code,execution_mode) references public.engine_indices(code,execution_mode));
create table public.engine_epochs (id uuid primary key default gen_random_uuid(), execution_mode public.execution_mode not null, starts_at timestamptz not null, ends_at timestamptz not null, seed_commitment text not null, prev_chain_hash text, chain_hash text not null, committed_at timestamptz not null default now(), revealed_seed text, revealed_at timestamptz, unique(execution_mode,starts_at));
create table engine_private.epoch_seeds (epoch_id uuid primary key references public.engine_epochs(id), execution_mode public.execution_mode not null, seed bytea not null check(octet_length(seed)=32));
create table public.index_ticks (index_code text not null, execution_mode public.execution_mode not null, tick_no bigint not null, epoch_id uuid not null references public.engine_epochs(id), scheduled_at timestamptz not null, generated_at timestamptz not null default now(), price numeric not null, digit smallint not null check(digit between 0 and 9), primary key(index_code,execution_mode,tick_no), foreign key(index_code,execution_mode) references public.engine_indices(code,execution_mode));

insert into public.engine_indices(code,execution_mode,display_name,sort_order,tick_interval_ms,decimals,base_price,sigma_per_tick) values
('SPI10','DEMO','SmartProfit Index 10',1,2000,3,1000,.0004),('SPI25','DEMO','SmartProfit Index 25',2,2000,3,1000,.001),('SPI50','DEMO','SmartProfit Index 50',3,2000,3,1000,.002),('SPI75','DEMO','SmartProfit Index 75',4,2000,3,1000,.003),('SPI100','DEMO','SmartProfit Index 100',5,2000,3,1000,.004);
insert into public.index_state(index_code,execution_mode) select code,execution_mode from public.engine_indices;

create or replace function public.engine_ledger_asset() returns text language sql immutable security definer set search_path = '' as $$ select 'USD' $$;
revoke all on function public.engine_ledger_asset() from public; grant execute on function public.engine_ledger_asset() to authenticated;
