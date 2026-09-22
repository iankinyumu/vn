create or replace function public.engine_quote_contract(p_account_id uuid,p_index text,p_type text,p_barrier smallint,p_stake numeric,p_tick_count integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts%rowtype; p public.engine_policy_versions%rowtype; q record;
begin
 select * into a from public.trading_accounts where id=p_account_id and user_id=auth.uid() and status='ACTIVE'; if not found then raise exception 'account_not_available'; end if;
 if a.execution_mode='REAL' and not public.module_enabled('real_accounts') then raise exception 'real_disabled'; end if;
 if not public.module_enabled('digit_indices') then raise exception 'module_disabled'; end if;
 select * into p from public.engine_policy_versions order by version desc limit 1;
 if p_tick_count not between p.min_ticks and p.max_ticks then raise exception 'invalid_tick_count'; end if;
 if not p_type=any(p.enabled_contract_types) then raise exception 'contract_type_disabled'; end if;
 select * into q from public.engine_payout(p_stake,p_type,p_barrier,p.house_margin);
 return jsonb_build_object('payout',q.payout,'profit',q.payout-p_stake,'payout_multiplier',q.multiplier,'win_probability',q.win_digits::numeric/10,'win_digits',q.win_digits,'policy_version',p.version);
end; $$;

create or replace function public.engine_buy_contract(p_account_id uuid,p_index text,p_type text,p_barrier smallint,p_stake numeric,p_tick_count integer,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.trading_accounts%rowtype; s public.index_state%rowtype; i public.engine_indices%rowtype; quote jsonb; existing public.engine_contracts%rowtype; entry_no bigint; settle_no bigint; payload text; available numeric; contract_id uuid;
begin
 select * into a from public.trading_accounts where id=p_account_id and user_id=auth.uid() and status='ACTIVE' for update; if not found then raise exception 'account_not_available'; end if;
 quote:=public.engine_quote_contract(p_account_id,p_index,p_type,p_barrier,p_stake,p_tick_count);
 select * into i from public.engine_indices where code=p_index and execution_mode=a.execution_mode; if not found or i.status='PAUSED' then raise exception 'index_not_available'; end if;
 select * into s from public.index_state where index_code=p_index and execution_mode=a.execution_mode for share;
 if s.updated_at < now()-interval '10 seconds' then raise exception 'feed_stale'; end if;
 payload:=encode(digest(concat_ws('|',p_index,p_type,coalesce(p_barrier::text,''),p_stake,p_tick_count),'sha256'),'hex');
 select * into existing from public.engine_contracts where trading_account_id=p_account_id and idempotency_key=p_idempotency_key; if found then if existing.payload_hash<>payload then raise exception 'idempotency_conflict'; end if; return jsonb_build_object('id',existing.id,'payout',existing.payout); end if;
 select coalesce(sum(e.amount),0) into available from public.wallets w join public.ledger_accounts la on la.wallet_id=w.id and la.kind='AVAILABLE' left join public.ledger_entries e on e.ledger_account_id=la.id where w.trading_account_id=p_account_id and w.asset=public.engine_ledger_asset(); if available<p_stake then raise exception 'insufficient_funds'; end if;
 entry_no:=greatest(s.last_tick_no,floor(extract(epoch from(clock_timestamp()-i.t0))*1000/i.tick_interval_ms)::bigint)+1; settle_no:=entry_no+p_tick_count-1;
 insert into public.engine_contracts(trading_account_id,execution_mode,index_code,contract_type,barrier,stake,payout,payout_multiplier,win_digits,policy_version,entry_tick_no,settle_tick_no,idempotency_key,payload_hash) values(p_account_id,a.execution_mode,p_index,p_type,p_barrier,p_stake,(quote->>'payout')::numeric,(quote->>'payout_multiplier')::numeric,(quote->>'win_digits')::smallint,(quote->>'policy_version')::integer,entry_no,settle_no,p_idempotency_key,payload) returning id into contract_id;
 perform public.engine_post_ledger(p_account_id,'buy-'||contract_id,'Reserve digit contract stake',jsonb_build_array(jsonb_build_object('kind','AVAILABLE','amount',-p_stake),jsonb_build_object('kind','RESERVED','amount',p_stake)));
 insert into public.contract_events(contract_id,trading_account_id,execution_mode,event_type,metadata) values(contract_id,p_account_id,a.execution_mode,'OPEN',jsonb_build_object('entry_tick_no',entry_no,'settle_tick_no',settle_no));
 return jsonb_build_object('id',contract_id,'payout',(quote->>'payout')::numeric,'entry_tick_no',entry_no,'settle_tick_no',settle_no);
end; $$;
revoke all on function public.engine_quote_contract(uuid,text,text,smallint,numeric,integer),public.engine_buy_contract(uuid,text,text,smallint,numeric,integer,text) from public,anon; grant execute on function public.engine_quote_contract(uuid,text,text,smallint,numeric,integer),public.engine_buy_contract(uuid,text,text,smallint,numeric,integer,text) to authenticated;
