-- Server-authoritative paper trading.  These RPCs use auth.uid(), never a client
-- supplied account id or execution price.  REAL accounts are intentionally rejected.

create or replace function public.demo_wallet_balance(p_account uuid, p_asset text, p_kind public.ledger_account_kind)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(e.amount), 0)
  from public.wallets w
  join public.ledger_accounts a on a.wallet_id = w.id and a.kind = p_kind
  left join public.ledger_entries e on e.ledger_account_id = a.id
  where w.trading_account_id = p_account and w.asset = upper(p_asset) and w.ledger_scope = 'DEMO';
$$;

create or replace function public.ensure_demo_wallet(p_account uuid, p_asset text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_wallet uuid;
begin
  perform public.provision_account_wallet(p_account, upper(p_asset), 'DEMO');
  select id into v_wallet from public.wallets
   where trading_account_id = p_account and asset = upper(p_asset) and ledger_scope = 'DEMO';
  return v_wallet;
end;
$$;

-- Creates an immutable, balanced ledger transaction. Entries are a JSON array of
-- {asset, kind, amount}; positive values increase the named account balance.
create or replace function public.post_demo_ledger(
  p_account uuid, p_key text, p_description text, p_entries jsonb, p_correlation uuid default gen_random_uuid()
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_tx uuid; v_item jsonb; v_asset text; v_kind public.ledger_account_kind; v_amount numeric; v_wallet uuid; v_ledger uuid;
begin
  if exists (select 1 from public.ledger_transactions where trading_account_id = p_account and idempotency_key = p_key) then
    select id into v_tx from public.ledger_transactions where trading_account_id = p_account and idempotency_key = p_key;
    return v_tx;
  end if;
  if exists (select 1 from jsonb_array_elements(p_entries) e group by upper(e->>'asset') having sum((e->>'amount')::numeric) <> 0) then
    raise exception 'demo ledger postings must balance per asset';
  end if;
  insert into public.ledger_transactions(trading_account_id, correlation_id, idempotency_key, description)
    values (p_account, p_correlation, p_key, p_description) returning id into v_tx;
  for v_item in select * from jsonb_array_elements(p_entries) loop
    v_asset := upper(v_item->>'asset'); v_kind := (v_item->>'kind')::public.ledger_account_kind; v_amount := (v_item->>'amount')::numeric;
    if v_amount = 0 then continue; end if;
    v_wallet := public.ensure_demo_wallet(p_account, v_asset);
    select id into v_ledger from public.ledger_accounts where wallet_id = v_wallet and kind = v_kind;
    insert into public.ledger_entries(ledger_transaction_id, ledger_account_id, amount, asset) values (v_tx, v_ledger, v_amount, v_asset);
  end loop;
  return v_tx;
end;
$$;

create or replace function public.seed_demo_account(p_account uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- USDT is funded because the UI trades Binance USDT spot pairs. The counter-posting
  -- stays in the account's internal P&L bucket so every asset transaction is balanced.
  perform public.ensure_demo_wallet(p_account, 'USDT');
  if not exists (select 1 from public.ledger_transactions where trading_account_id = p_account and idempotency_key = 'demo-opening-balance-v1') then
    perform public.post_demo_ledger(p_account, 'demo-opening-balance-v1', 'Demo opening balance',
      '[{"asset":"USDT","kind":"AVAILABLE","amount":10000},{"asset":"USDT","kind":"REALIZED_PNL","amount":-10000}]'::jsonb);
  end if;
end;
$$;

-- Replace the signup handler so each new demo identity has a usable paper balance.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_account uuid;
begin
  insert into public.profiles(id, display_name) values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', new.email)) on conflict (id) do nothing;
  insert into public.trading_accounts(user_id, execution_mode, base_currency) values (new.id, 'DEMO', 'USD')
    on conflict (user_id, execution_mode, base_currency) do update set user_id = excluded.user_id returning id into v_account;
  perform public.provision_account_wallet(v_account, 'USD', 'DEMO');
  perform public.seed_demo_account(v_account);
  return new;
end;
$$;

create or replace function public.demo_account_for_user()
returns uuid language plpgsql security definer set search_path = public as $$
begin
  return (select id from public.trading_accounts where user_id = auth.uid() and execution_mode = 'DEMO' and status = 'ACTIVE' limit 1);
end;
$$;

-- Fixed-window control is deliberately server-side. Browser throttling is only UX;
-- this table is not exposed through RLS and cannot be reset by a caller.
create table public.demo_order_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0)
);
alter table public.demo_order_rate_limits enable row level security;

create or replace function public.assert_demo_order_rate_limit()
returns void language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  insert into public.demo_order_rate_limits(user_id, window_started_at, request_count)
    values (auth.uid(), now(), 1)
  on conflict (user_id) do update set
    window_started_at = case when public.demo_order_rate_limits.window_started_at <= now() - interval '1 minute' then now() else public.demo_order_rate_limits.window_started_at end,
    request_count = case when public.demo_order_rate_limits.window_started_at <= now() - interval '1 minute' then 1 else public.demo_order_rate_limits.request_count + 1 end
  returning request_count into v_count;
  if v_count > 20 then raise exception 'order rate limit exceeded; retry after the current minute window'; end if;
end;
$$;

create or replace function public.append_demo_event(p_order uuid, p_account uuid, p_type text, p_previous public.order_state, p_next public.order_state, p_reason text, p_key text, p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
 insert into public.execution_events(order_id,trading_account_id,event_type,previous_state,next_state,actor_type,actor_id,reason_code,idempotency_key,metadata)
 values(p_order,p_account,p_type,p_previous,p_next,'SERVICE',auth.uid(),p_reason,p_key,p_metadata);
end;
$$;

create or replace function public.fill_demo_order(p_order uuid, p_snapshot uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o public.orders%rowtype; s public.market_snapshots%rowtype; v_base text; v_quote text := 'USDT'; v_price numeric; v_gross numeric; v_fee numeric; v_reserved numeric; v_new_qty numeric; v_old_qty numeric; v_avg numeric;
begin
 select * into o from public.orders where id=p_order for update;
 if o.state not in ('ACCEPTED','OPEN','PARTIALLY_FILLED') then return; end if;
 select * into s from public.market_snapshots where id=p_snapshot;
 if s.id is null then raise exception 'market snapshot not found'; end if;
 v_base := regexp_replace(o.symbol, 'USDT$', '');
 v_price := case when o.side='BUY' then s.ask_price * 1.0005 else s.bid_price * .9995 end;
 v_gross := o.quantity * v_price; v_fee := v_gross * .001; v_reserved := o.reserved_amount;
 if o.side='BUY' then
   perform public.post_demo_ledger(o.trading_account_id, 'fill-'||o.id, 'Demo buy fill '||o.symbol,
    jsonb_build_array(jsonb_build_object('asset',v_quote,'kind','RESERVED','amount',-v_reserved),jsonb_build_object('asset',v_quote,'kind','AVAILABLE','amount',v_reserved-v_gross-v_fee),jsonb_build_object('asset',v_quote,'kind','REALIZED_PNL','amount',v_gross+v_fee),jsonb_build_object('asset',v_base,'kind','AVAILABLE','amount',o.quantity),jsonb_build_object('asset',v_base,'kind','REALIZED_PNL','amount',-o.quantity)));
 else
   perform public.post_demo_ledger(o.trading_account_id, 'fill-'||o.id, 'Demo sell fill '||o.symbol,
    jsonb_build_array(jsonb_build_object('asset',v_base,'kind','RESERVED','amount',-o.quantity),jsonb_build_object('asset',v_base,'kind','REALIZED_PNL','amount',o.quantity),jsonb_build_object('asset',v_quote,'kind','AVAILABLE','amount',v_gross-v_fee),jsonb_build_object('asset',v_quote,'kind','REALIZED_PNL','amount',-v_gross+v_fee)));
 end if;
 insert into public.fills(order_id,market_snapshot_id,execution_price,quantity,fee,fee_asset,liquidity_source,executed_at) values(p_order,p_snapshot,v_price,o.quantity,v_fee,v_quote,'BINANCE_PUBLIC_SNAPSHOT',s.received_at);
 select quantity, average_entry_price into v_old_qty,v_avg from public.positions where trading_account_id=o.trading_account_id and symbol=o.symbol and margin_type='SPOT' for update;
 v_old_qty:=coalesce(v_old_qty,0);
 if o.side='BUY' then v_new_qty:=v_old_qty+o.quantity; v_avg:=case when v_new_qty=0 then 0 else ((v_old_qty*coalesce(v_avg,0))+(o.quantity*v_price))/v_new_qty end;
 else v_new_qty:=v_old_qty-o.quantity; end if;
 insert into public.positions(trading_account_id,symbol,quantity,average_entry_price,margin_type,realized_pnl,unrealized_pnl) values(o.trading_account_id,o.symbol,v_new_qty,coalesce(v_avg,0),'SPOT',0,0)
 on conflict(trading_account_id,symbol,margin_type) do update set quantity=excluded.quantity,average_entry_price=excluded.average_entry_price;
 update public.orders set state='FILLED' where id=p_order;
 perform public.append_demo_event(p_order,o.trading_account_id,'FILLED',o.state,'FILLED',null,'event-fill-'||o.id,jsonb_build_object('snapshot_id',p_snapshot,'price',v_price,'fee',v_fee));
end;
$$;

create or replace function public.submit_demo_order(p_client_order_id text, p_symbol text, p_side public.order_side, p_type public.order_type, p_quantity numeric, p_limit_price numeric default null, p_stop_price numeric default null, p_idempotency_key text default null)
returns public.orders language plpgsql security definer set search_path = public as $$
declare v_account uuid; v_order public.orders%rowtype; v_snapshot public.market_snapshots%rowtype; v_base text; v_reserve numeric; v_asset text; v_key text:=coalesce(nullif(p_idempotency_key,''),p_client_order_id); v_state public.order_state;
begin
 v_account:=public.demo_account_for_user(); if v_account is null then raise exception 'an active DEMO account is required'; end if;
 perform public.assert_demo_order_rate_limit();
 perform 1 from public.trading_accounts where id=v_account for update;
 if upper(p_symbol) !~ '^[A-Z0-9]{2,20}USDT$' or p_quantity<=0 or p_quantity<>trunc(p_quantity,8) then raise exception 'invalid symbol or quantity precision'; end if;
 if (p_type='MARKET' and (p_limit_price is not null or p_stop_price is not null)) or (p_type='LIMIT' and (p_limit_price is null or p_stop_price is not null)) or (p_type='STOP_LIMIT' and (p_limit_price is null or p_stop_price is null)) then raise exception 'invalid price fields for order type'; end if;
 select * into v_order from public.orders where trading_account_id=v_account and idempotency_key=v_key; if found then return v_order; end if;
 select * into v_snapshot from public.market_snapshots where symbol=upper(p_symbol) and received_at > now()-interval '60 seconds' order by received_at desc limit 1;
 if v_snapshot.id is null then raise exception 'a fresh server market quote is required before submitting an order'; end if;
 if p_quantity * coalesce(p_limit_price,case when p_side='BUY' then v_snapshot.ask_price else v_snapshot.bid_price end) < 10 then raise exception 'minimum order notional is 10 USDT'; end if;
 v_base:=regexp_replace(upper(p_symbol),'USDT$',''); v_asset:=case when p_side='BUY' then 'USDT' else v_base end;
 v_reserve:=case when p_side='BUY' then p_quantity*greatest(coalesce(p_limit_price,v_snapshot.ask_price),v_snapshot.ask_price)*1.002 else p_quantity end;
 if public.demo_wallet_balance(v_account,v_asset,'AVAILABLE') < v_reserve then raise exception 'insufficient available %',v_asset; end if;
 perform public.post_demo_ledger(v_account,'reserve-'||v_key,'Reserve funds for demo order',jsonb_build_array(jsonb_build_object('asset',v_asset,'kind','AVAILABLE','amount',-v_reserve),jsonb_build_object('asset',v_asset,'kind','RESERVED','amount',v_reserve)));
 v_state:=case when p_type='MARKET' then 'ACCEPTED' else 'OPEN' end;
 insert into public.orders(trading_account_id,client_order_id,execution_mode,symbol,side,type,state,quantity,limit_price,stop_price,reserved_amount,reserved_asset,idempotency_key) values(v_account,p_client_order_id,'DEMO',upper(p_symbol),p_side,p_type,v_state,p_quantity,p_limit_price,p_stop_price,v_reserve,v_asset,v_key) returning * into v_order;
 perform public.append_demo_event(v_order.id,v_account,'ACCEPTED','PENDING_VALIDATION',v_state,null,'event-accepted-'||v_key);
 if p_type='MARKET' then perform public.fill_demo_order(v_order.id,v_snapshot.id); select * into v_order from public.orders where id=v_order.id; end if;
 return v_order;
end;
$$;

create or replace function public.process_demo_orders(p_snapshot_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare s public.market_snapshots%rowtype; o record; v_count integer:=0; v_trigger boolean;
begin
 select * into s from public.market_snapshots where id=p_snapshot_id; if s.id is null then raise exception 'snapshot not found'; end if;
 for o in select id,side,type,limit_price,stop_price from public.orders where execution_mode='DEMO' and symbol=s.symbol and state='OPEN' order by submitted_at for update skip locked loop
   v_trigger := (o.type='LIMIT' and ((o.side='BUY' and s.ask_price<=o.limit_price) or (o.side='SELL' and s.bid_price>=o.limit_price))) or (o.type='STOP_LIMIT' and ((o.side='BUY' and s.ask_price>=o.stop_price and s.ask_price<=o.limit_price) or (o.side='SELL' and s.bid_price<=o.stop_price and s.bid_price>=o.limit_price)));
   if v_trigger then perform public.fill_demo_order(o.id,s.id); v_count:=v_count+1; end if;
 end loop; return v_count;
end;
$$;

create or replace function public.cancel_demo_order(p_order_id uuid, p_idempotency_key text)
returns public.orders language plpgsql security definer set search_path = public as $$
declare o public.orders%rowtype; v_account uuid;
begin
 v_account:=public.demo_account_for_user(); select * into o from public.orders where id=p_order_id and trading_account_id=v_account for update;
 if o.id is null then raise exception 'order not found'; end if; if o.state not in ('ACCEPTED','OPEN','PARTIALLY_FILLED') then return o; end if;
 perform public.post_demo_ledger(v_account,'release-'||p_idempotency_key,'Release demo order reservation',jsonb_build_array(jsonb_build_object('asset',o.reserved_asset,'kind','RESERVED','amount',-o.reserved_amount),jsonb_build_object('asset',o.reserved_asset,'kind','AVAILABLE','amount',o.reserved_amount)));
 update public.orders set state='CANCELLED' where id=o.id returning * into o;
 perform public.append_demo_event(o.id,v_account,'CANCELLED','OPEN','CANCELLED','USER_CANCELLED','event-cancel-'||p_idempotency_key); return o;
end;
$$;

-- Browser users may invoke only the authenticated order/cancel RPCs. Snapshot ingestion
-- and order processing are service-side responsibilities (Edge Function, worker, or cron).
revoke all on function public.demo_wallet_balance(uuid,text,public.ledger_account_kind), public.ensure_demo_wallet(uuid,text), public.post_demo_ledger(uuid,text,text,jsonb,uuid), public.fill_demo_order(uuid,uuid), public.process_demo_orders(uuid), public.seed_demo_account(uuid), public.demo_account_for_user(), public.append_demo_event(uuid,uuid,text,public.order_state,public.order_state,text,text,jsonb), public.provision_account_wallet(uuid,text,public.ledger_scope) from public, anon, authenticated;
revoke all on function public.assert_demo_order_rate_limit() from public, anon, authenticated;
revoke all on function public.submit_demo_order(text,text,public.order_side,public.order_type,numeric,numeric,numeric,text), public.cancel_demo_order(uuid,text) from public, anon;
grant execute on function public.submit_demo_order(text,text,public.order_side,public.order_type,numeric,numeric,numeric,text), public.cancel_demo_order(uuid,text) to authenticated;
grant execute on function public.process_demo_orders(uuid) to service_role;

-- The client subscribes only to its own RLS-protected order rows. The database remains
-- the source of truth; realtime is a refresh signal, not a balance transport.
alter publication supabase_realtime add table public.orders;

-- Fund accounts created before this migration once, without overwriting any history.
do $$ declare r record; begin for r in select id from public.trading_accounts where execution_mode='DEMO' loop perform public.seed_demo_account(r.id); end loop; end $$;
