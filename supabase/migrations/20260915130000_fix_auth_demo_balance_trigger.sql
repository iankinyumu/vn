-- Auth signup calls seed_demo_account(), which creates balanced immutable ledger
-- entries. The deferred balance trigger must retain the function owner's table
-- privileges when it runs at Auth's transaction commit.
create or replace function public.assert_balanced_ledger_transaction()
returns trigger language plpgsql security definer set search_path = public as $$
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
