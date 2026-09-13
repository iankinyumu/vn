-- SmartProfit trading database foundation.
-- This migration intentionally contains no order-matching or demo-execution engine.
-- Auth sessions are owned by Supabase Auth (auth.users / GoTrue), never browser storage.

create extension if not exists pgcrypto;

create type public.execution_mode as enum ('DEMO', 'REAL');
create type public.account_status as enum ('ACTIVE', 'SUSPENDED', 'CLOSED');
create type public.ledger_scope as enum ('DEMO', 'REAL');
create type public.ledger_account_kind as enum ('AVAILABLE', 'RESERVED', 'FEE', 'REALIZED_PNL');
create type public.order_side as enum ('BUY', 'SELL');
create type public.order_type as enum ('MARKET', 'LIMIT', 'STOP_LIMIT');
create type public.order_state as enum (
  'PENDING_VALIDATION', 'ACCEPTED', 'OPEN', 'PARTIALLY_FILLED', 'FILLED',
  'CANCEL_PENDING', 'CANCELLED', 'REJECTED', 'EXPIRED'
);
create type public.position_margin_type as enum ('SPOT', 'CROSS', 'ISOLATED');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  lifecycle_status text not null default 'ACTIVE'
    check (lifecycle_status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.trading_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  execution_mode public.execution_mode not null,
  base_currency text not null default 'USD' check (base_currency ~ '^[A-Z0-9]{2,12}$'),
  status public.account_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A user has one isolated account for each execution mode and currency.
  unique (user_id, execution_mode, base_currency)
);

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id) on delete restrict,
  asset text not null check (asset ~ '^[A-Z0-9]{2,12}$'),
  ledger_scope public.ledger_scope not null,
  created_at timestamptz not null default now(),
  unique (trading_account_id, asset, ledger_scope)
);

-- Wallet ledger accounts hold no mutable client-controlled balance. Balances are derived
-- from immutable postings; a later server-side execution service is the only writer.
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete restrict,
  kind public.ledger_account_kind not null,
  created_at timestamptz not null default now(),
  unique (wallet_id, kind)
);

create table public.ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id) on delete restrict,
  correlation_id uuid not null,
  idempotency_key text not null,
  description text not null,
  created_at timestamptz not null default now(),
  unique (trading_account_id, idempotency_key)
);

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  ledger_transaction_id uuid not null references public.ledger_transactions(id) on delete restrict,
  ledger_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  -- positive amount is a debit; negative is a credit. The transaction must net to zero.
  amount numeric(38, 18) not null check (amount <> 0),
  asset text not null check (asset ~ '^[A-Z0-9]{2,12}$'),
  created_at timestamptz not null default now()
);

create or replace function public.validate_wallet_scope()
returns trigger language plpgsql set search_path = public as $$
declare account_mode public.execution_mode;
begin
  select execution_mode into account_mode from public.trading_accounts where id = new.trading_account_id;
  if account_mode is null or account_mode::text <> new.ledger_scope::text then
    raise exception 'wallet ledger scope must match its trading account execution mode';
  end if;
  return new;
end;
$$;
create trigger wallets_validate_scope before insert or update of trading_account_id, ledger_scope on public.wallets
  for each row execute function public.validate_wallet_scope();

-- A transaction is balanced independently for every asset. This deferred check lets the
-- server post both sides in one ACID transaction, while preventing one-sided postings.
create or replace function public.assert_balanced_ledger_transaction()
returns trigger language plpgsql set search_path = public as $$
declare affected_transaction uuid;
begin
  if tg_op = 'DELETE' then
    affected_transaction := old.ledger_transaction_id;
  else
    affected_transaction := new.ledger_transaction_id;
  end if;
  if exists (
    select 1 from public.ledger_entries
    where ledger_transaction_id = affected_transaction
    group by asset having sum(amount) <> 0
  ) then
    raise exception 'ledger transaction % is not balanced', affected_transaction;
  end if;
  return null;
end;
$$;
create constraint trigger ledger_entries_must_balance
  after insert or update or delete on public.ledger_entries
  deferrable initially deferred for each row execute function public.assert_balanced_ledger_transaction();

create table public.market_snapshots (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  symbol text not null check (symbol ~ '^[A-Z0-9]{4,24}$'),
  bid_price numeric(38, 18) not null check (bid_price > 0),
  ask_price numeric(38, 18) not null check (ask_price > 0 and ask_price >= bid_price),
  depth jsonb not null default '[]'::jsonb,
  received_at timestamptz not null,
  sequence_id text,
  created_at timestamptz not null default now(),
  unique (source, symbol, sequence_id)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id) on delete restrict,
  client_order_id text not null,
  execution_mode public.execution_mode not null,
  symbol text not null check (symbol ~ '^[A-Z0-9]{4,24}$'),
  side public.order_side not null,
  type public.order_type not null,
  state public.order_state not null default 'PENDING_VALIDATION',
  quantity numeric(38, 18) not null check (quantity > 0),
  limit_price numeric(38, 18) check (limit_price > 0),
  stop_price numeric(38, 18) check (stop_price > 0),
  reserved_amount numeric(38, 18) not null default 0 check (reserved_amount >= 0),
  reserved_asset text check (reserved_asset ~ '^[A-Z0-9]{2,12}$'),
  idempotency_key text not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trading_account_id, client_order_id),
  unique (trading_account_id, idempotency_key),
  check ((type = 'MARKET' and limit_price is null and stop_price is null)
      or (type = 'LIMIT' and limit_price is not null and stop_price is null)
      or (type = 'STOP_LIMIT' and limit_price is not null and stop_price is not null))
);

create table public.fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  market_snapshot_id uuid references public.market_snapshots(id) on delete restrict,
  execution_price numeric(38, 18) not null check (execution_price > 0),
  quantity numeric(38, 18) not null check (quantity > 0),
  fee numeric(38, 18) not null default 0 check (fee >= 0),
  fee_asset text not null check (fee_asset ~ '^[A-Z0-9]{2,12}$'),
  liquidity_source text not null,
  executed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  trading_account_id uuid not null references public.trading_accounts(id) on delete restrict,
  symbol text not null check (symbol ~ '^[A-Z0-9]{4,24}$'),
  quantity numeric(38, 18) not null default 0,
  average_entry_price numeric(38, 18) not null default 0 check (average_entry_price >= 0),
  margin_type public.position_margin_type not null default 'SPOT',
  realized_pnl numeric(38, 18) not null default 0,
  unrealized_pnl numeric(38, 18) not null default 0,
  updated_at timestamptz not null default now(),
  unique (trading_account_id, symbol, margin_type)
);

create table public.execution_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete restrict,
  trading_account_id uuid not null references public.trading_accounts(id) on delete restrict,
  event_type text not null,
  previous_state public.order_state,
  next_state public.order_state,
  actor_type text not null check (actor_type in ('USER', 'SYSTEM', 'SERVICE')),
  actor_id uuid references auth.users(id) on delete restrict,
  reason_code text,
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  unique (trading_account_id, idempotency_key)
);

create index orders_account_state_idx on public.orders (trading_account_id, state, submitted_at desc);
create index fills_order_executed_idx on public.fills (order_id, executed_at);
create index ledger_entries_transaction_idx on public.ledger_entries (ledger_transaction_id);
create index market_snapshots_symbol_received_idx on public.market_snapshots (symbol, received_at desc);
create index execution_events_order_occurred_idx on public.execution_events (order_id, occurred_at);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger accounts_updated_at before update on public.trading_accounts for each row execute function public.set_updated_at();
create trigger orders_updated_at before update on public.orders for each row execute function public.set_updated_at();
create trigger positions_updated_at before update on public.positions for each row execute function public.set_updated_at();

-- Supabase Auth signup creates identity and an isolated DEMO account only. REAL accounts
-- are deliberately never provisioned by a client or signup trigger.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare demo_account_id uuid;
begin
  insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', new.email));
  insert into public.trading_accounts (user_id, execution_mode, base_currency)
    values (new.id, 'DEMO', 'USD') returning id into demo_account_id;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Client roles may only read records belonging to their authenticated identity. Mutations
-- are intentionally reserved for a future server-side API using the service role.
alter table public.profiles enable row level security;
alter table public.trading_accounts enable row level security;
alter table public.wallets enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.orders enable row level security;
alter table public.fills enable row level security;
alter table public.positions enable row level security;
alter table public.execution_events enable row level security;
alter table public.market_snapshots enable row level security;

create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());
create policy accounts_select_own on public.trading_accounts for select to authenticated using (user_id = auth.uid());
create policy wallets_select_own on public.wallets for select to authenticated using (exists (select 1 from public.trading_accounts a where a.id = wallets.trading_account_id and a.user_id = auth.uid()));
create policy ledger_accounts_select_own on public.ledger_accounts for select to authenticated using (exists (select 1 from public.wallets w join public.trading_accounts a on a.id = w.trading_account_id where w.id = ledger_accounts.wallet_id and a.user_id = auth.uid()));
create policy ledger_transactions_select_own on public.ledger_transactions for select to authenticated using (exists (select 1 from public.trading_accounts a where a.id = ledger_transactions.trading_account_id and a.user_id = auth.uid()));
create policy ledger_entries_select_own on public.ledger_entries for select to authenticated using (exists (select 1 from public.ledger_transactions t join public.trading_accounts a on a.id = t.trading_account_id where t.id = ledger_entries.ledger_transaction_id and a.user_id = auth.uid()));
create policy orders_select_own on public.orders for select to authenticated using (exists (select 1 from public.trading_accounts a where a.id = orders.trading_account_id and a.user_id = auth.uid()));
create policy fills_select_own on public.fills for select to authenticated using (exists (select 1 from public.orders o join public.trading_accounts a on a.id = o.trading_account_id where o.id = fills.order_id and a.user_id = auth.uid()));
create policy positions_select_own on public.positions for select to authenticated using (exists (select 1 from public.trading_accounts a where a.id = positions.trading_account_id and a.user_id = auth.uid()));
create policy execution_events_select_own on public.execution_events for select to authenticated using (exists (select 1 from public.trading_accounts a where a.id = execution_events.trading_account_id and a.user_id = auth.uid()));
create policy market_snapshots_select_authenticated on public.market_snapshots for select to authenticated using (true);

-- Ledger, fills, snapshots, and audit events are append-only even for table owners.
create or replace function public.reject_mutation()
returns trigger language plpgsql set search_path = public as $$
begin raise exception 'This table is append-only'; end;
$$;
create trigger ledger_entries_immutable before update or delete on public.ledger_entries for each row execute function public.reject_mutation();
create trigger ledger_transactions_immutable before update or delete on public.ledger_transactions for each row execute function public.reject_mutation();
create trigger fills_immutable before update or delete on public.fills for each row execute function public.reject_mutation();
create trigger execution_events_immutable before update or delete on public.execution_events for each row execute function public.reject_mutation();
create trigger market_snapshots_immutable before update or delete on public.market_snapshots for each row execute function public.reject_mutation();

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select on public.profiles, public.trading_accounts, public.wallets, public.ledger_accounts,
  public.ledger_transactions, public.ledger_entries, public.orders, public.fills, public.positions,
  public.execution_events, public.market_snapshots to authenticated;
