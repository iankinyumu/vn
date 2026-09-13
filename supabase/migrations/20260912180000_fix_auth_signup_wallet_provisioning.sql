-- Fix ambiguous PL/pgSQL variable resolution that prevented Auth signups from
-- provisioning their initial zero-balance wallet.
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
