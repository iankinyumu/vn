create or replace function public.engine_assert_account_access(p_account_id uuid) returns public.execution_mode language plpgsql security definer set search_path='' as $$
declare v_mode public.execution_mode; v_restriction jsonb;
begin
 select execution_mode into v_mode from public.trading_accounts where id=p_account_id and user_id=auth.uid() and status='ACTIVE';
 if not found then raise exception 'account_not_available'; end if;
 if v_mode='REAL' and not public.module_enabled('real_accounts') then raise exception 'real_disabled'; end if;
 v_restriction:=public.effective_restrictions(auth.uid(),v_mode::text,'ACCESS');
 if coalesce((v_restriction->>'blocked')::boolean,false) then raise exception 'access_restricted'; end if;
 return v_mode;
end; $$;

create or replace function public.get_account_summary(p_account_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_available numeric; v_mode public.execution_mode;
begin
 v_mode:=public.engine_assert_account_access(p_account_id);
 select coalesce(sum(e.amount),0) into v_available from public.wallets w join public.ledger_accounts la on la.wallet_id=w.id and la.kind='AVAILABLE' left join public.ledger_entries e on e.ledger_account_id=la.id where w.trading_account_id=p_account_id and w.asset=public.engine_ledger_asset();
 return jsonb_build_object('available',v_available,'currency',public.engine_ledger_asset(),'execution_mode',v_mode);
end; $$;

create or replace function public.engine_quote_contract(p_account_id uuid,p_index text,p_type text,p_barrier smallint,p_stake numeric,p_tick_count integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_mode public.execution_mode; p public.engine_policy_versions%rowtype; q record; v_access jsonb;
begin
 v_mode:=public.engine_assert_account_access(p_account_id);
 if not public.module_enabled('digit_indices') then raise exception 'module_disabled'; end if;
 v_access:=public.effective_restrictions(auth.uid(),v_mode::text,'TRADING');
 if coalesce((v_access->>'blocked')::boolean,false) then raise exception 'trading_restricted'; end if;
 select * into p from public.engine_policy_versions order by version desc limit 1;
 if not found then raise exception 'policy_missing'; end if;
 if p_tick_count not between p.min_ticks and p.max_ticks then raise exception 'invalid_tick_count'; end if;
 if not p_type=any(p.enabled_contract_types) then raise exception 'contract_type_disabled'; end if;
 if not exists(select 1 from public.engine_indices where code=p_index and execution_mode=v_mode) then raise exception 'index_not_available'; end if;
 select * into q from public.engine_payout(p_stake,p_type,p_barrier,coalesce((p.margin_overrides->>p_type)::numeric,p.house_margin));
 return jsonb_build_object('payout',q.payout,'profit',q.payout-p_stake,'payout_multiplier',q.multiplier,'win_probability',q.win_digits::numeric/10,'win_digits',q.win_digits,'policy_version',p.version);
end; $$;

create or replace function public.list_my_contracts(p_account_id uuid,p_state text default null,p_before timestamptz default null,p_limit integer default 50) returns setof public.engine_contracts language plpgsql security definer set search_path='' as $$
begin
 perform public.engine_assert_account_access(p_account_id);
 if p_state is not null and p_state not in ('OPEN','WON','LOST','VOID') then raise exception 'validation_failed'; end if;
 return query select c.* from public.engine_contracts c where c.trading_account_id=p_account_id and (p_state is null or c.state=p_state) and (p_before is null or c.created_at<p_before) order by c.created_at desc limit least(greatest(coalesce(p_limit,50),1),100);
end; $$;

create or replace function public.get_epoch_proofs(p_account_id uuid,p_index text,p_limit integer default 30) returns table(id uuid,starts_at timestamptz,ends_at timestamptz,seed_commitment text,prev_chain_hash text,chain_hash text,revealed_seed text,revealed_at timestamptz) language plpgsql security definer set search_path='' as $$
declare v_mode public.execution_mode;
begin
 v_mode:=public.engine_assert_account_access(p_account_id);
 if not exists(select 1 from public.engine_indices where code=p_index and execution_mode=v_mode) then raise exception 'index_not_available'; end if;
 return query select e.id,e.starts_at,e.ends_at,e.seed_commitment,e.prev_chain_hash,e.chain_hash,e.revealed_seed,e.revealed_at from public.engine_epochs e where e.execution_mode=v_mode order by e.starts_at desc limit least(greatest(coalesce(p_limit,30),1),500);
end; $$;

create or replace function public.reset_practice_balance(p_account_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_mode public.execution_mode; v_available numeric; v_minimum numeric; v_amount numeric;
begin
 v_mode:=public.engine_assert_account_access(p_account_id);
 if v_mode<>'DEMO' then raise exception 'account_not_available'; end if;
 perform 1 from public.trading_accounts where id=p_account_id for update;
 if exists(select 1 from public.engine_contracts where trading_account_id=p_account_id and state='OPEN') then raise exception 'open_contracts_exist'; end if;
 if exists(select 1 from public.ledger_transactions where trading_account_id=p_account_id and idempotency_key like 'practice-reset-%' and created_at>now()-interval '24 hours') then raise exception 'reset_rate_limited'; end if;
 select coalesce(sum(e.amount),0) into v_available from public.wallets w join public.ledger_accounts l on l.wallet_id=w.id and l.kind='AVAILABLE' left join public.ledger_entries e on e.ledger_account_id=l.id where w.trading_account_id=p_account_id and w.asset=public.engine_ledger_asset();
 select min_stake into v_minimum from public.engine_policy_limits where policy_version=(select max(version) from public.engine_policy_versions) and execution_mode='DEMO';
 if v_available>=v_minimum then raise exception 'reset_not_available'; end if;
 v_amount:=10000-v_available;
 perform public.engine_post_ledger(p_account_id,'practice-reset-'||to_char(now(),'YYYYMMDDHH24MISS'),'Reset practice balance',jsonb_build_array(jsonb_build_object('kind','AVAILABLE','amount',v_amount),jsonb_build_object('kind','REALIZED_PNL','amount',-v_amount)));
 return jsonb_build_object('available',10000,'currency',public.engine_ledger_asset());
end; $$;

revoke all on function public.engine_assert_account_access(uuid) from public,anon;
