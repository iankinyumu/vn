create or replace function public.reset_practice_balance(p_account_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts%rowtype; available numeric; minimum numeric; amount numeric;
begin
 select * into a from public.trading_accounts where id=p_account_id and user_id=auth.uid() and status='ACTIVE' for update; if not found or a.execution_mode<>'DEMO' then raise exception 'account_not_available'; end if;
 if exists(select 1 from public.engine_contracts where trading_account_id=p_account_id and state='OPEN') then raise exception 'open_contracts_exist'; end if;
 if exists(select 1 from public.ledger_transactions where trading_account_id=p_account_id and idempotency_key like 'practice-reset-%' and created_at>now()-interval '24 hours') then raise exception 'reset_rate_limited'; end if;
 select coalesce(sum(e.amount),0) into available from public.wallets w join public.ledger_accounts l on l.wallet_id=w.id and l.kind='AVAILABLE' left join public.ledger_entries e on e.ledger_account_id=l.id where w.trading_account_id=p_account_id and w.asset=public.engine_ledger_asset();
 select min_stake into minimum from public.engine_policy_limits where policy_version=(select max(version) from public.engine_policy_versions) and execution_mode='DEMO'; if available>=minimum then raise exception 'reset_not_available'; end if;
 amount:=10000-available; perform public.engine_post_ledger(p_account_id,'practice-reset-'||to_char(now(),'YYYYMMDDHH24MISS'),'Reset practice balance',jsonb_build_array(jsonb_build_object('kind','AVAILABLE','amount',amount),jsonb_build_object('kind','REALIZED_PNL','amount',-amount)));
 return jsonb_build_object('available',10000,'currency',public.engine_ledger_asset());
end; $$;
revoke all on function public.reset_practice_balance(uuid) from public,anon; grant execute on function public.reset_practice_balance(uuid) to authenticated;
