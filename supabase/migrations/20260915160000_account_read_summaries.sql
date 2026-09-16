-- Compact display reads; invoker security preserves existing per-user RLS.
-- Orders continue to validate balances inside the authoritative transaction.
create index if not exists ledger_entries_account_idx on public.ledger_entries(ledger_account_id);
create index if not exists ledger_transactions_account_created_idx on public.ledger_transactions(trading_account_id, created_at desc);

create or replace function public.account_balance_totals(p_account uuid)
returns table(ledger_account_id uuid, amount numeric)
language sql stable security invoker set search_path = public as $$
  select la.id, coalesce(sum(e.amount), 0)
  from public.trading_accounts a
  join public.wallets w on w.trading_account_id = a.id
  join public.ledger_accounts la on la.wallet_id = w.id
  left join public.ledger_entries e on e.ledger_account_id = la.id
  where a.id = p_account and a.user_id = auth.uid()
  group by la.id;
$$;
revoke all on function public.account_balance_totals(uuid) from public, anon;
grant execute on function public.account_balance_totals(uuid) to authenticated;

create or replace function public.account_position_quotes(p_account uuid)
returns table(symbol text, bid_price numeric, received_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select p.symbol, q.bid_price, q.received_at
  from public.positions p
  join public.trading_accounts a on a.id = p.trading_account_id
  cross join lateral (
    select s.bid_price, s.received_at from public.market_snapshots s
    where s.symbol = p.symbol and s.received_at > now() - interval '60 seconds'
    order by s.received_at desc limit 1
  ) q
  where a.id = p_account and a.user_id = auth.uid() and p.margin_type = 'SPOT' and p.quantity <> 0;
$$;
revoke all on function public.account_position_quotes(uuid) from public, anon;
grant execute on function public.account_position_quotes(uuid) to authenticated;
