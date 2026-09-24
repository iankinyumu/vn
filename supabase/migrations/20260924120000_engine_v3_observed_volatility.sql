-- Observed vs target volatility for v3 indices (plan Workstream C.5).
-- Realised volatility = sample sd of ln(P_t/P_{t-1}) over the window x sqrt(TPY),
-- TPY = 365*86400*1000/tick_interval_ms (ADR 0001 §3). Diagnostics only; never
-- fed back into generation. Alert bands are the pre-registered one-day band
-- (3 %) once a full day of ticks exists.

create or replace function engine_private.v3_observed_volatility(p_mode public.execution_mode,p_index text,p_window integer) returns jsonb
language sql stable security definer set search_path='' as $$
 with recent as (
  select t.price,t.previous_price,t.v3_config_hash,t.scheduled_at from public.index_ticks t
  where t.index_code=p_index and t.execution_mode=p_mode and t.generation_version=3 order by t.tick_no desc limit greatest(p_window,2)
 ), stats as (
  select count(*) n,stddev_samp(ln(price/previous_price)) sd,count(*) filter (where price=previous_price) repeats,
   min(scheduled_at) first_at,max(scheduled_at) last_at,(array_agg(v3_config_hash order by scheduled_at desc))[1] cfg from recent
 )
 select jsonb_build_object('window_ticks',s.n,'from',s.first_at,'to',s.last_at,
  'target_annual',(e->>'annual_vol_bp')::numeric/10000,
  'observed_annual',round(s.sd*sqrt(365*86400000.0/(e->>'tick_interval_ms')::numeric),6),
  'relative_error',case when s.sd is null then null else round(s.sd*sqrt(365*86400000.0/(e->>'tick_interval_ms')::numeric)/((e->>'annual_vol_bp')::numeric/10000)-1,6) end,
  'repeat_ratio',case when s.n>0 then round(s.repeats::numeric/s.n,6) end,
  'status',case when s.n<43200 then 'insufficient_data'
   when abs(s.sd*sqrt(365*86400000.0/(e->>'tick_interval_ms')::numeric)/((e->>'annual_vol_bp')::numeric/10000)-1)>0.03 then 'alert' else 'within_band' end)
 from stats s left join lateral (select engine_private.v3_entry(s.cfg,p_index) e) x on true
 where s.n>0 $$;

create or replace function public.get_engine_v3_status() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_now bigint:=engine_private.v3_now_ms();
begin
 if auth.uid() is null then raise exception 'unauthenticated'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
  'index_code',i.code,'execution_mode',i.execution_mode,'engine_generation',i.engine_generation,'shadow',i.v3_shadow,
  'cutover_ms',i.v3_cutover_ms,'v2_final_tick_no',i.v2_final_tick_no,'halted',i.v3_halted_at is not null,
  'current_epoch_witnessed',engine_private.v3_epoch_witnessed(i.execution_mode,v_now/86400000*86400000,v_now),
  'purchase_block',case when i.engine_generation=3 then engine_private.v3_purchase_block(i.execution_mode,i.code,s.last_tick_no+1,s.last_tick_no+1) end,
  'volatility_1d',case when i.engine_generation=3 then engine_private.v3_observed_volatility(i.execution_mode,i.code,43200) end
 ) order by i.execution_mode,i.sort_order) from public.engine_indices i join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode),'[]'::jsonb);
end; $$;

create or replace function public.get_admin_engine_v3_health() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_now bigint:=engine_private.v3_now_ms();
begin
 perform admin_private.require_staff('engine.read');
 return jsonb_build_object(
  'settings',(select to_jsonb(s) from public.engine_v3_settings s),
  'workers',coalesce((select jsonb_agg(to_jsonb(w) order by w.last_seen desc) from public.engine_v3_worker_heartbeats w),'[]'::jsonb),
  'epochs',coalesce((select jsonb_agg(jsonb_build_object('execution_mode',e.execution_mode,'epoch_start_ms',e.epoch_start_ms,'committed_at',e.committed_at,
     'witnesses',(select coalesce(jsonb_agg(jsonb_build_object('provider',r.provider,'gen_time',r.gen_time)),'[]'::jsonb) from public.engine_v3_witness_receipts r where r.subject_hash=e.commitment),
     'revealed',e.revealed_seed is not null,'reveal_overdue',e.revealed_seed is null and v_now>e.epoch_end_ms+86400000) order by e.epoch_start_ms desc)
     from (select * from public.engine_v3_epochs order by epoch_start_ms desc limit 14) e),'[]'::jsonb),
  'indices',public.get_engine_v3_status(),
  'volatility',coalesce((select jsonb_agg(jsonb_build_object('index_code',i.code,'execution_mode',i.execution_mode,
     '1h',engine_private.v3_observed_volatility(i.execution_mode,i.code,1800),'1d',engine_private.v3_observed_volatility(i.execution_mode,i.code,43200),
     '7d',engine_private.v3_observed_volatility(i.execution_mode,i.code,302400)) order by i.sort_order)
     from public.engine_indices i where i.engine_generation=3),'[]'::jsonb),
  'shadow',coalesce((select jsonb_agg(jsonb_build_object('index_code',t.index_code,'last_tick_no',max_tick,'ticks',n)) from
     (select index_code,max(tick_no) max_tick,count(*) n from public.engine_v3_shadow_ticks group by index_code) t),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(to_jsonb(ev) order by ev.id desc) from (select * from public.engine_v3_events order by id desc limit 50) ev),'[]'::jsonb));
end; $$;

revoke all on function engine_private.v3_observed_volatility(public.execution_mode,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.get_engine_v3_status(),public.get_admin_engine_v3_health() from public,anon,service_role;
grant execute on function public.get_engine_v3_status(),public.get_admin_engine_v3_health() to authenticated;
