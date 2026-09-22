create or replace function public.publish_engine_policy(p_policy jsonb,p_reason text) returns integer language plpgsql security definer set search_path='' as $$
declare version_no integer; margin numeric; min_ticks integer; max_ticks integer; enabled text[];
begin
 perform admin_private.require_staff('engine.manage'); if char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 margin:=(p_policy->>'house_margin')::numeric; min_ticks:=(p_policy->>'min_ticks')::integer; max_ticks:=(p_policy->>'max_ticks')::integer; enabled:=array(select jsonb_array_elements_text(p_policy->'enabled_contract_types'));
 if margin not between .005 and .15 or min_ticks<1 or max_ticks>10 or max_ticks<min_ticks or cardinality(enabled)=0 then raise exception 'validation_failed'; end if;
 select coalesce(max(version),0)+1 into version_no from public.engine_policy_versions;
 insert into public.engine_policy_versions(version,effective_from,house_margin,margin_overrides,min_ticks,max_ticks,max_settlement_delay_seconds,max_feed_lag_seconds,min_profit_ratio,tick_retention_days,enabled_contract_types,created_by,reason) values(version_no,now(),margin,coalesce(p_policy->'margin_overrides','{}'),min_ticks,max_ticks,coalesce((p_policy->>'max_settlement_delay_seconds')::integer,30),coalesce((p_policy->>'max_feed_lag_seconds')::integer,10),coalesce((p_policy->>'min_profit_ratio')::numeric,.01),coalesce((p_policy->>'tick_retention_days')::integer,30),enabled,auth.uid(),btrim(p_reason));
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state) values(auth.uid(),'staff','engine.publish_policy','engine_policy',null,gen_random_uuid(),btrim(p_reason),p_policy||jsonb_build_object('version',version_no)); return version_no;
end; $$;
revoke all on function public.publish_engine_policy(jsonb,text) from public,anon; grant execute on function public.publish_engine_policy(jsonb,text) to authenticated;
