create or replace function public.list_admin_contracts(p_mode public.execution_mode default null,p_state text default null,p_limit integer default 100) returns setof public.engine_contracts language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('contracts.read');
 if p_state is not null and p_state not in ('OPEN','WON','LOST','VOID') then raise exception 'validation_failed'; end if;
 return query select c.* from public.engine_contracts c where (p_mode is null or c.execution_mode=p_mode) and (p_state is null or c.state=p_state) order by c.created_at desc limit least(greatest(coalesce(p_limit,100),1),500);
end; $$;

create or replace function public.get_admin_contract_detail(p_contract_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_contract public.engine_contracts%rowtype;
begin
 perform admin_private.require_staff('contracts.read');
 select * into v_contract from public.engine_contracts where id=p_contract_id;
 if not found then raise exception 'not_found'; end if;
 return jsonb_build_object('contract',to_jsonb(v_contract),'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from public.contract_events e where e.contract_id=p_contract_id),'[]'::jsonb),'ledger_transactions',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'idempotency_key',t.idempotency_key,'description',t.description,'created_at',t.created_at) order by t.created_at) from public.ledger_transactions t where t.trading_account_id=v_contract.trading_account_id and (t.idempotency_key in ('buy-'||v_contract.id,'settle-'||v_contract.id,'void-'||v_contract.id))),'[]'::jsonb));
end; $$;

create or replace function public.set_index_trading_status(p_index text,p_mode public.execution_mode,p_status text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('engine.manage');
 if p_status not in ('ACTIVE','PAUSED') or char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 update public.engine_indices set status=p_status where code=p_index and execution_mode=p_mode;
 if not found then raise exception 'not_found'; end if;
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state) values(auth.uid(),'staff','engine.index_status','engine_index',null,public.gen_random_uuid(),btrim(p_reason),jsonb_build_object('index_code',p_index,'execution_mode',p_mode,'status',p_status));
end; $$;

create or replace function public.get_admin_engine_exposure(p_mode public.execution_mode default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('engine.read');
 return coalesce((select jsonb_agg(jsonb_build_object('execution_mode',execution_mode,'index_code',index_code,'settle_tick_no',settle_tick_no,'net_loss_by_digit',net_loss_by_digit,'max_liability',(select max(x) from unnest(net_loss_by_digit) x)) order by execution_mode,index_code,settle_tick_no) from public.engine_tick_exposure where p_mode is null or execution_mode=p_mode),'[]'::jsonb);
end; $$;

create or replace function public.get_platform_overview() returns jsonb language plpgsql security definer set search_path='' as $$
declare v_staff public.staff_roles;
begin
 v_staff:=admin_private.require_staff('staff.enter');
 return jsonb_build_object('open_tickets',(select count(*) from public.support_requests where status in ('open','in_progress')),'unassigned_tickets',(select count(*) from public.support_requests where status in ('open','in_progress') and assignee_id is null),'waiting_tickets',(select count(*) from public.support_requests where status='waiting_for_customer'),'total_customers',(select count(*) from auth.users),'active_restrictions',(select count(*) from public.account_restrictions where active),'active_staff',(select count(*) from public.staff_roles where active),'contracts_today',(select jsonb_object_agg(execution_mode,count) from (select execution_mode,count(*) count from public.engine_contracts where created_at>=date_trunc('day',now()) group by execution_mode) x),'engine_health',(select coalesce(case when bool_or(now()-updated_at>interval '10 seconds') then 'degraded' else 'healthy' end,'unavailable') from public.index_state),'timestamp',now());
end; $$;

revoke all on function public.list_admin_contracts(public.execution_mode,text,integer),public.get_admin_contract_detail(uuid),public.set_index_trading_status(text,public.execution_mode,text,text),public.get_admin_engine_exposure(public.execution_mode) from public,anon;
grant execute on function public.list_admin_contracts(public.execution_mode,text,integer),public.get_admin_contract_detail(uuid),public.set_index_trading_status(text,public.execution_mode,text,text),public.get_admin_engine_exposure(public.execution_mode) to authenticated;
