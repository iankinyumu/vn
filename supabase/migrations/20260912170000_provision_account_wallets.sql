-- Give every account a zero-balance base-currency wallet and the ledger accounts
-- required for future server-side posting. This does not create demo funds.

create or replace function public.provision_account_wallet(p_account_id uuid, p_asset text, p_scope public.ledger_scope)
returns void language plpgsql security definer set search_path = public as $$
declare v_wallet_id uuid;
begin
  insert into public.wallets (trading_account_id, asset, ledger_scope)
    values (p_account_id, p_asset, p_scope)
    on conflict (trading_account_id, asset, ledger_scope) do update set asset = excluded.asset
    returning id into v_wallet_id;

  insert into public.ledger_accounts (wallet_id, kind)
    values
      (v_wallet_id, 'AVAILABLE'),
      (v_wallet_id, 'RESERVED'),
      (v_wallet_id, 'FEE'),
      (v_wallet_id, 'REALIZED_PNL')
    on conflict (wallet_id, kind) do nothing;
end;
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare demo_account_id uuid;
begin
  insert into public.profiles (id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', new.email))
    on conflict (id) do nothing;

  insert into public.trading_accounts (user_id, execution_mode, base_currency)
    values (new.id, 'DEMO', 'USD')
    on conflict (user_id, execution_mode, base_currency) do update set user_id = excluded.user_id
    returning id into demo_account_id;

  perform public.provision_account_wallet(demo_account_id, 'USD', 'DEMO');
  return new;
end;
$$;

-- Backfill identities and accounts created before the original Auth trigger existed.
insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data ->> 'display_name', email)
from auth.users
on conflict (id) do nothing;

insert into public.trading_accounts (user_id, execution_mode, base_currency)
select id, 'DEMO', 'USD'
from auth.users
on conflict (user_id, execution_mode, base_currency) do nothing;

do $$
declare account_record record;
begin
  for account_record in select id, base_currency, execution_mode from public.trading_accounts loop
    perform public.provision_account_wallet(account_record.id, account_record.base_currency, account_record.execution_mode::text::public.ledger_scope);
  end loop;
end;
$$;
