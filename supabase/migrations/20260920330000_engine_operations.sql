create or replace function public.void_contract(p_contract_id uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare c public.engine_contracts%rowtype;
begin
 perform admin_private.require_staff('contracts.void',true); if char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 select * into c from public.engine_contracts where id=p_contract_id for update; if not found or c.state<>'OPEN' then raise exception 'not_found'; end if;
 update public.engine_contracts set state='VOID',settled_at=now() where id=c.id;
 perform public.engine_post_ledger(c.trading_account_id,'void-'||c.id,'Manual contract void',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','AVAILABLE','amount',c.stake)));
 insert into public.contract_events(contract_id,trading_account_id,execution_mode,event_type,reason) values(c.id,c.trading_account_id,c.execution_mode,'VOID',btrim(p_reason));
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason) values(auth.uid(),'staff','contracts.void','contract',c.id,gen_random_uuid(),btrim(p_reason));
end; $$;
create or replace function public.get_admin_engine_health() returns jsonb language sql security definer set search_path='' as $$
select jsonb_agg(jsonb_build_object('index_code',i.code,'execution_mode',i.execution_mode,'last_tick_no',s.last_tick_no,'lag_seconds',extract(epoch from now()-s.updated_at),'stuck_contracts',(select count(*) from public.engine_contracts c where c.index_code=i.code and c.execution_mode=i.execution_mode and c.state='OPEN' and c.settle_tick_no<s.last_tick_no),'retry_contracts',(select count(*) from public.engine_contracts c where c.index_code=i.code and c.execution_mode=i.execution_mode and c.settlement_attempts>3),'status',case when now()-s.updated_at>interval '10 seconds' then 'degraded' else 'healthy' end) order by i.sort_order) from public.engine_indices i join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode $$;
revoke all on function public.void_contract(uuid,text),public.get_admin_engine_health() from public,anon; grant execute on function public.void_contract(uuid,text),public.get_admin_engine_health() to authenticated;
