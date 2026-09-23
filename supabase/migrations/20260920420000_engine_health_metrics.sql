create or replace function public.get_admin_engine_health() returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
 perform admin_private.require_staff('engine.read');
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
  ordered as (select digit,tick_no,lag(digit) over(order by tick_no) prior from recent),
  groups as (select digit,tick_no,sum(case when prior is null or prior<>digit then 1 else 0 end) over(order by tick_no) run_group from ordered),
  counts as (select digit,count(*) n from recent group by digit),
  pairs as (select prior,digit,count(*) n from ordered where prior is not null group by prior,digit),
  run_lengths as (select run_group,count(*) n from groups group by run_group)
  select coalesce((select sum(power(n-(select count(*) from recent)::numeric/10,2)/nullif((select count(*) from recent)::numeric/10,0)) from counts),0) chi_square,
    coalesce((select max(abs(n::numeric/nullif((select count(*)-1 from recent),0)-.01)) from pairs),0) pair_deviation,
    coalesce((select max(n) from run_lengths),0) longest_run
 ) quality on true;
 return v_result;
end; $$;

revoke all on function public.get_admin_engine_health() from public,anon;
grant execute on function public.get_admin_engine_health() to authenticated;
