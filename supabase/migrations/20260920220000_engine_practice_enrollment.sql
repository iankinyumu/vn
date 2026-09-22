create or replace function public.engine_post_ledger(p_account_id uuid, p_key text, p_description text, p_entries jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_tx uuid; v_item jsonb; v_wallet uuid; v_ledger uuid; v_mode public.execution_mode;
begin
    select execution_mode into v_mode from public.trading_accounts where id = p_account_id;
    if v_mode is null then raise exception 'account_not_available'; end if;
    select id into v_tx from public.ledger_transactions where trading_account_id=p_account_id and idempotency_key=p_key;
    if found then return v_tx; end if;
    insert into public.ledger_transactions(trading_account_id,correlation_id,idempotency_key,description) values(p_account_id,gen_random_uuid(),p_key,p_description) returning id into v_tx;
    for v_item in select * from jsonb_array_elements(p_entries) loop
        insert into public.wallets(trading_account_id,asset,ledger_scope) values(p_account_id,public.engine_ledger_asset(),v_mode::text::public.ledger_scope) on conflict do nothing;
        select w.id into v_wallet from public.wallets w where w.trading_account_id=p_account_id and w.asset=public.engine_ledger_asset() and w.ledger_scope=v_mode::text::public.ledger_scope;
        insert into public.ledger_accounts(wallet_id,kind) values(v_wallet,(v_item->>'kind')::public.ledger_account_kind) on conflict do nothing;
        select id into v_ledger from public.ledger_accounts where wallet_id=v_wallet and kind=(v_item->>'kind')::public.ledger_account_kind;
        insert into public.ledger_entries(ledger_transaction_id,ledger_account_id,amount,asset) values(v_tx,v_ledger,(v_item->>'amount')::numeric,public.engine_ledger_asset());
    end loop;
    return v_tx;
end;
$$;

create or replace function public.enroll_practice_account()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_account uuid;
begin
    if auth.uid() is null then raise exception 'account_not_available'; end if;
    insert into public.trading_accounts(user_id,execution_mode,base_currency) values(auth.uid(),'DEMO','USD') on conflict(user_id,execution_mode) do update set user_id=excluded.user_id returning id into v_account;
    perform public.engine_post_ledger(v_account,'practice-opening-credit-v1','Practice opening credit','[{"kind":"AVAILABLE","amount":10000},{"kind":"REALIZED_PNL","amount":-10000}]'::jsonb);
    return v_account;
end;
$$;

create or replace function public.list_my_accounts()
returns table(id uuid, execution_mode public.execution_mode, currency text, status public.account_status) language sql security definer set search_path = '' as $$
select a.id,a.execution_mode,public.engine_ledger_asset(),a.status from public.trading_accounts a where a.user_id=auth.uid() order by a.execution_mode;
$$;
revoke all on function public.enroll_practice_account(),public.list_my_accounts() from public,anon; grant execute on function public.enroll_practice_account(),public.list_my_accounts() to authenticated;
