create or replace function public.engine_settle_contract(p_contract_id uuid,p_digit smallint,p_price numeric,p_epoch uuid,p_generated_at timestamptz,p_scheduled_at timestamptz) returns void language plpgsql security definer set search_path='' as $$
declare c public.engine_contracts%rowtype; won boolean;
begin
 select * into c from public.engine_contracts where id=p_contract_id for update; if not found or c.state<>'OPEN' then return; end if;
 if p_generated_at>p_scheduled_at+interval '30 seconds' then
  update public.engine_contracts set state='VOID',exit_digit=p_digit,exit_price=p_price,exit_epoch_id=p_epoch,settled_at=now() where id=c.id;
  perform public.engine_post_ledger(c.trading_account_id,'settle-'||c.id,'Void delayed digit contract',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','AVAILABLE','amount',c.stake)));
  insert into public.contract_events(contract_id,trading_account_id,execution_mode,event_type,reason) values(c.id,c.trading_account_id,c.execution_mode,'VOID','ENGINE_DELAY'); return;
 end if;
 won:=p_digit=any(public.engine_winning_digits(c.contract_type,c.barrier));
 update public.engine_contracts set state=case when won then 'WON' else 'LOST' end,exit_digit=p_digit,exit_price=p_price,exit_epoch_id=p_epoch,settled_at=now() where id=c.id;
 if won then perform public.engine_post_ledger(c.trading_account_id,'settle-'||c.id,'Settle winning digit contract',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','AVAILABLE','amount',c.payout),jsonb_build_object('kind','REALIZED_PNL','amount',-(c.payout-c.stake)))); else perform public.engine_post_ledger(c.trading_account_id,'settle-'||c.id,'Settle losing digit contract',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','REALIZED_PNL','amount',c.stake))); end if;
 insert into public.contract_events(contract_id,trading_account_id,execution_mode,event_type) values(c.id,c.trading_account_id,c.execution_mode,case when won then 'WON' else 'LOST' end);
end; $$;

create or replace function public.engine_settle_tick(p_index text,p_mode public.execution_mode,p_tick bigint) returns void language plpgsql security definer set search_path='' as $$
declare t public.index_ticks%rowtype; c record;
begin
 select * into t from public.index_ticks where index_code=p_index and execution_mode=p_mode and tick_no=p_tick; if not found then return; end if;
 for c in select id from public.engine_contracts where index_code=p_index and execution_mode=p_mode and settle_tick_no=p_tick and state='OPEN' loop begin perform public.engine_settle_contract(c.id,t.digit,t.price,t.epoch_id,t.generated_at,t.scheduled_at); exception when others then update public.engine_contracts set settlement_attempts=settlement_attempts+1,last_error=sqlerrm where id=c.id; end; end loop;
 delete from public.engine_tick_exposure where execution_mode=p_mode and index_code=p_index and settle_tick_no=p_tick;
end; $$;
