create or replace function public.reject_engine_policy_mutation() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'engine_policy_immutable'; end; $$;

drop trigger if exists engine_policy_versions_immutable on public.engine_policy_versions;
create trigger engine_policy_versions_immutable before update or delete on public.engine_policy_versions for each row execute function public.reject_engine_policy_mutation();
drop trigger if exists engine_policy_limits_immutable on public.engine_policy_limits;
create trigger engine_policy_limits_immutable before update or delete on public.engine_policy_limits for each row execute function public.reject_engine_policy_mutation();

create or replace function public.publish_engine_policy(p_policy jsonb,p_reason text) returns integer language plpgsql security definer set search_path='' as $$
declare v_version integer; v_margin numeric; v_min_ticks integer; v_max_ticks integer; v_delay integer; v_lag integer; v_ratio numeric; v_retention integer; v_enabled text[]; v_limits jsonb; v_min_stake numeric; v_max_stake numeric; v_open integer; v_rate integer; v_liability numeric; v_type text; v_barrier smallint; v_wins integer; v_payout numeric;
begin
 perform admin_private.require_staff('engine.manage');
 if jsonb_typeof(p_policy)<>'object' or char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 if not (p_policy ?& array['house_margin','min_ticks','max_ticks','max_settlement_delay_seconds','max_feed_lag_seconds','min_profit_ratio','tick_retention_days','enabled_contract_types','limits']) then raise exception 'validation_failed'; end if;
 v_margin:=(p_policy->>'house_margin')::numeric; v_min_ticks:=(p_policy->>'min_ticks')::integer; v_max_ticks:=(p_policy->>'max_ticks')::integer; v_delay:=(p_policy->>'max_settlement_delay_seconds')::integer; v_lag:=(p_policy->>'max_feed_lag_seconds')::integer; v_ratio:=(p_policy->>'min_profit_ratio')::numeric; v_retention:=(p_policy->>'tick_retention_days')::integer;
 select array_agg(value order by value) into v_enabled from jsonb_array_elements_text(p_policy->'enabled_contract_types');
 if v_margin not between .005 and .15 or v_min_ticks<1 or v_max_ticks not between v_min_ticks and 10 or v_delay<=0 or v_lag<=0 or v_ratio<0 or v_retention<=0 or cardinality(v_enabled)=0 or exists(select 1 from unnest(v_enabled) x where x not in ('EVEN','ODD','OVER','UNDER','MATCH','DIFFER')) then raise exception 'validation_failed'; end if;
 if jsonb_typeof(coalesce(p_policy->'margin_overrides','{}'::jsonb))<>'object' or exists(select 1 from jsonb_each_text(coalesce(p_policy->'margin_overrides','{}'::jsonb)) e where e.key not in ('EVEN','ODD','OVER','UNDER','MATCH','DIFFER') or e.value::numeric not between .005 and .15) then raise exception 'validation_failed'; end if;
 v_limits:=p_policy->'limits'->'DEMO';
 if jsonb_typeof(v_limits)<>'object' or not (v_limits ?& array['min_stake','max_stake','max_open_contracts','max_buys_per_minute','max_liability_per_tick']) then raise exception 'validation_failed'; end if;
 v_min_stake:=(v_limits->>'min_stake')::numeric; v_max_stake:=(v_limits->>'max_stake')::numeric; v_open:=(v_limits->>'max_open_contracts')::integer; v_rate:=(v_limits->>'max_buys_per_minute')::integer; v_liability:=(v_limits->>'max_liability_per_tick')::numeric;
 if v_min_stake<=0 or v_max_stake<v_min_stake or v_open<=0 or v_rate<=0 or v_liability<=0 or p_policy->'limits' ? 'REAL' then raise exception 'validation_failed'; end if;
 foreach v_type in array v_enabled loop
  for v_barrier in select case when v_type in ('EVEN','ODD') then null::smallint when v_type='OVER' then g::smallint when v_type='UNDER' then g::smallint else g::smallint end from generate_series(case when v_type='OVER' then 0 when v_type='UNDER' then 1 when v_type in ('MATCH','DIFFER') then 0 else 0 end,case when v_type='OVER' then 8 when v_type='UNDER' then 9 when v_type in ('MATCH','DIFFER') then 9 else 0 end) g loop
   v_wins:=cardinality(public.engine_winning_digits(v_type,case when v_type in ('EVEN','ODD') then null else v_barrier end));
   v_payout:=floor(v_min_stake*(1-coalesce((p_policy->'margin_overrides'->>v_type)::numeric,v_margin))*10/v_wins*100)/100;
   if v_payout-v_min_stake<v_ratio*v_min_stake then raise exception 'validation_failed'; end if;
  end loop;
 end loop;
 select coalesce(max(version),0)+1 into v_version from public.engine_policy_versions;
 insert into public.engine_policy_versions(version,effective_from,house_margin,margin_overrides,min_ticks,max_ticks,max_settlement_delay_seconds,max_feed_lag_seconds,min_profit_ratio,tick_retention_days,enabled_contract_types,created_by,reason) values(v_version,now(),v_margin,coalesce(p_policy->'margin_overrides','{}'::jsonb),v_min_ticks,v_max_ticks,v_delay,v_lag,v_ratio,v_retention,v_enabled,auth.uid(),btrim(p_reason));
 insert into public.engine_policy_limits(policy_version,execution_mode,min_stake,max_stake,max_open_contracts,max_buys_per_minute,max_liability_per_tick) values(v_version,'DEMO',v_min_stake,v_max_stake,v_open,v_rate,v_liability);
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state) values(auth.uid(),'staff','engine.publish_policy','engine_policy',null,public.gen_random_uuid(),btrim(p_reason),p_policy||jsonb_build_object('version',v_version));
 return v_version;
end; $$;
