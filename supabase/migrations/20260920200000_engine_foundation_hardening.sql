-- Shared-account safeguards required before engine tables are introduced.

alter table public.trading_accounts add constraint trading_accounts_id_execution_mode_key unique (id, execution_mode);
alter table public.trading_accounts add constraint trading_accounts_user_execution_mode_key unique (user_id, execution_mode);

create or replace function public.reject_execution_mode_change()
returns trigger language plpgsql set search_path = '' as $$
begin
    if new.execution_mode is distinct from old.execution_mode then
        raise exception 'execution_mode_immutable';
    end if;
    return new;
end;
$$;

drop trigger if exists trading_accounts_execution_mode_immutable on public.trading_accounts;
create trigger trading_accounts_execution_mode_immutable
before update on public.trading_accounts for each row execute function public.reject_execution_mode_change();

create or replace function public.assert_ledger_entry_account_and_asset()
returns trigger language plpgsql set search_path = '' as $$
declare v_transaction_account uuid; v_wallet_account uuid; v_wallet_asset text;
begin
    select trading_account_id into v_transaction_account from public.ledger_transactions where id = new.ledger_transaction_id;
    select w.trading_account_id, w.asset into v_wallet_account, v_wallet_asset
      from public.ledger_accounts la join public.wallets w on w.id = la.wallet_id
     where la.id = new.ledger_account_id;
    if v_transaction_account is null or v_wallet_account is null or v_transaction_account <> v_wallet_account then
        raise exception 'ledger_entry_account_mismatch';
    end if;
    if new.asset <> v_wallet_asset then raise exception 'ledger_entry_asset_mismatch'; end if;
    return new;
end;
$$;

drop trigger if exists ledger_entries_account_asset_guard on public.ledger_entries;
create trigger ledger_entries_account_asset_guard
before insert on public.ledger_entries for each row execute function public.assert_ledger_entry_account_and_asset();
