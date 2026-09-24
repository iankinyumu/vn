-- Phase 4 audit corrections.
-- 1. Digit quality: the chi-square sum only covered digits that appeared in the
--    window, so a digit that never occurred contributed nothing and a stuck or
--    biased generator was under-reported. Every digit 0-9 now contributes.
-- 2. The platform overview's engine_health is the worst per-index status from
--    the same computation as the Engine tab (degraded, alert, watch, healthy),
--    not only feed lag.
-- 3. A manual void's audit row carries the contract's execution_mode, like every
--    other engine audit row.

create or replace function admin_private.engine_index_health() returns jsonb language plpgsql stable set search_path='' as $$
declare v_result jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object(
  'index_code',i.code,'execution_mode',i.execution_mode,'last_tick_no',s.last_tick_no,
  'lag_seconds',extract(epoch from now()-s.updated_at),'missing_ticks_last_hour',coalesce(missing.count,0),
  'stuck_contracts',coalesce(stuck.count,0),'retry_contracts',coalesce(retries.count,0),
  'chi_square',coalesce(quality.chi_square,0),'max_lag_one_pair_deviation',coalesce(quality.pair_deviation,0),'longest_run',coalesce(quality.longest_run,0),
  'status',case when now()-s.updated_at>interval '10 seconds' then 'degraded' when coalesce(quality.chi_square,0)>44.81 then 'alert' when coalesce(quality.chi_square,0)>33.72 then 'watch' else 'healthy' end
 ) order by i.execution_mode,i.sort_order),'[]'::jsonb) into v_result
 from public.engine_indices i join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode
 left join lateral (
  select greatest(0, (floor(extract(epoch from (now() - greatest(i.t0, now() - interval '1 hour'))) * 1000 / i.tick_interval_ms))::integer - count(*)::integer) count
  from public.index_ticks t where t.index_code=i.code and t.execution_mode=i.execution_mode and t.scheduled_at>=now()-interval '1 hour'
 ) missing on true
 left join lateral (select count(*)::integer count from public.engine_contracts c where c.index_code=i.code and c.execution_mode=i.execution_mode and c.state='OPEN' and c.settle_tick_no<=s.last_tick_no) stuck on true
 left join lateral (select count(*)::integer count from public.engine_contracts c where c.index_code=i.code and c.execution_mode=i.execution_mode and c.settlement_attempts>3) retries on true
 left join lateral (
  with recent as (select digit,tick_no from public.index_ticks where index_code=i.code and execution_mode=i.execution_mode order by tick_no desc limit 10000),
  total as (select count(*)::numeric n from recent),
  ordered as (select digit,tick_no,lag(digit) over(order by tick_no) prior from recent),
  groups as (select digit,tick_no,sum(case when prior is null or prior<>digit then 1 else 0 end) over(order by tick_no) run_group from ordered),
  counts as (select d.digit,count(r.digit)::numeric n from generate_series(0,9) d(digit) left join recent r on r.digit=d.digit group by d.digit),
  pairs as (select prior,digit,count(*) n from ordered where prior is not null group by prior,digit),
  run_lengths as (select run_group,count(*) n from groups group by run_group)
  select coalesce((select sum(power(c.n-t.n/10,2)/nullif(t.n/10,0)) from counts c cross join total t),0) chi_square,
    coalesce((select max(abs(n::numeric/nullif((select count(*)-1 from recent),0)-.01)) from pairs),0) pair_deviation,
    coalesce((select max(n) from run_lengths),0) longest_run
 ) quality on true;
 return v_result;
end; $$;
revoke all on function admin_private.engine_index_health() from public,anon,authenticated,service_role;

create or replace function public.get_admin_engine_health() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('engine.read');
 return admin_private.engine_index_health();
end; $$;

create or replace function public.get_platform_overview() returns jsonb language plpgsql security definer set search_path='' as $$
declare v_statuses text[];
begin
 perform admin_private.require_staff('operations.read');
 select coalesce(array_agg(row->>'status'),array[]::text[]) into v_statuses from jsonb_array_elements(admin_private.engine_index_health()) row;
 return jsonb_build_object(
  'open_tickets',(select count(*) from public.support_requests where status in ('open','in_progress')),
  'unassigned_tickets',(select count(*) from public.support_requests where status in ('open','in_progress') and assignee_id is null),
  'waiting_tickets',(select count(*) from public.support_requests where status='waiting_for_customer'),
  'total_customers',(select count(*) from auth.users),
  'active_restrictions',(select count(*) from public.account_restrictions where active and (expires_at is null or expires_at>now())),
  'active_staff',(select count(*) from public.staff_roles where active),
  'contracts_today',(select jsonb_build_object('DEMO',count(*) filter (where execution_mode='DEMO'),'REAL',count(*) filter (where execution_mode='REAL')) from public.engine_contracts where created_at>=date_trunc('day',now())),
  'engine_health',case when cardinality(v_statuses)=0 then 'unavailable'
   when 'degraded'=any(v_statuses) then 'degraded' when 'alert'=any(v_statuses) then 'alert'
   when 'watch'=any(v_statuses) then 'watch' else 'healthy' end,
  'timestamp',now());
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
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,before_state,after_state)
 values(auth.uid(),'staff','contracts.void','contract',c.id,public.gen_random_uuid(),btrim(p_reason),
  jsonb_build_object('state','OPEN','execution_mode',c.execution_mode,'trading_account_id',c.trading_account_id,'index_code',c.index_code,'stake',c.stake),
  jsonb_build_object('state','VOID','execution_mode',c.execution_mode,'refunded',c.stake));
end; $$;

revoke all on function public.get_admin_engine_health(),public.get_platform_overview(),public.void_contract(uuid,text) from public,anon;
grant execute on function public.get_admin_engine_health(),public.get_platform_overview(),public.void_contract(uuid,text) to authenticated;
