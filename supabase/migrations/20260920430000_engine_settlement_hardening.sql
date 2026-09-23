create or replace function public.engine_settle_contract(p_contract_id uuid,p_digit smallint,p_price numeric,p_epoch uuid,p_generated_at timestamptz,p_scheduled_at timestamptz) returns void language plpgsql security definer set search_path='' as $$
declare c public.engine_contracts%rowtype; v_won boolean; v_delay integer;
begin
 select * into c from public.engine_contracts where id=p_contract_id for update;
 if not found or c.state<>'OPEN' then return; end if;
 select max_settlement_delay_seconds into v_delay from public.engine_policy_versions where version=c.policy_version;
 if v_delay is null then raise exception 'policy_missing'; end if;
 if p_generated_at>p_scheduled_at+make_interval(secs=>v_delay) then
  update public.engine_contracts set state='VOID',exit_digit=p_digit,exit_price=p_price,exit_epoch_id=p_epoch,settled_at=now() where id=c.id;
  perform public.engine_post_ledger(c.trading_account_id,'settle-'||c.id,'Void delayed digit contract',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','AVAILABLE','amount',c.stake)));
  insert into public.contract_events(contract_id,trading_account_id,execution_mode,event_type,reason,metadata) values(c.id,c.trading_account_id,c.execution_mode,'VOID','ENGINE_DELAY',jsonb_build_object('scheduled_at',p_scheduled_at,'generated_at',p_generated_at));
  return;
 end if;
 v_won:=p_digit=any(public.engine_winning_digits(c.contract_type,c.barrier));
 update public.engine_contracts set state=case when v_won then 'WON' else 'LOST' end,exit_digit=p_digit,exit_price=p_price,exit_epoch_id=p_epoch,settled_at=now() where id=c.id;
 if v_won then
  perform public.engine_post_ledger(c.trading_account_id,'settle-'||c.id,'Settle winning digit contract',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','AVAILABLE','amount',c.payout),jsonb_build_object('kind','REALIZED_PNL','amount',-(c.payout-c.stake))));
 else
  perform public.engine_post_ledger(c.trading_account_id,'settle-'||c.id,'Settle losing digit contract',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','REALIZED_PNL','amount',c.stake)));
 end if;
 insert into public.contract_events(contract_id,trading_account_id,execution_mode,event_type,metadata) values(c.id,c.trading_account_id,c.execution_mode,case when v_won then 'WON' else 'LOST' end,jsonb_build_object('exit_digit',p_digit,'exit_price',p_price,'epoch_id',p_epoch));
end; $$;

create or replace function public.engine_settle_tick(p_index text,p_mode public.execution_mode,p_tick bigint) returns void language plpgsql security definer set search_path='' as $$
declare t public.index_ticks%rowtype; c record; v_open integer;
begin
 select * into t from public.index_ticks where index_code=p_index and execution_mode=p_mode and tick_no=p_tick;
 if not found then return; end if;
 for c in select id from public.engine_contracts where index_code=p_index and execution_mode=p_mode and settle_tick_no=p_tick and state='OPEN' order by created_at loop
  begin
   perform public.engine_settle_contract(c.id,t.digit,t.price,t.epoch_id,t.generated_at,t.scheduled_at);
  exception when others then
   update public.engine_contracts set settlement_attempts=settlement_attempts+1,last_error=left(sqlerrm,500) where id=c.id and state='OPEN';
  end;
 end loop;
 select count(*) into v_open from public.engine_contracts where index_code=p_index and execution_mode=p_mode and settle_tick_no=p_tick and state='OPEN';
 if v_open=0 then
  delete from public.engine_tick_exposure where execution_mode=p_mode and index_code=p_index and settle_tick_no=p_tick;
 end if;
end; $$;

create or replace function public.void_contract(p_contract_id uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare c public.engine_contracts%rowtype;
begin
 perform admin_private.require_staff('contracts.void',true);
 if char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 select * into c from public.engine_contracts where id=p_contract_id for update;
 if not found or c.state<>'OPEN' then raise exception 'not_found'; end if;
 update public.engine_contracts set state='VOID',settled_at=now(),last_error=null where id=c.id;
 perform public.engine_post_ledger(c.trading_account_id,'void-'||c.id,'Manual contract void',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','AVAILABLE','amount',c.stake)));
 insert into public.contract_events(contract_id,trading_account_id,execution_mode,event_type,reason,metadata) values(c.id,c.trading_account_id,c.execution_mode,'VOID',btrim(p_reason),jsonb_build_object('manual',true));
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason) values(auth.uid(),'staff','contracts.void','contract',c.id,public.gen_random_uuid(),btrim(p_reason));
end; $$;

revoke all on function public.engine_settle_contract(uuid,smallint,numeric,uuid,timestamptz,timestamptz),public.engine_settle_tick(text,public.execution_mode,bigint) from public,anon,authenticated;
