create or replace function public.validate_engine_restriction_params(p_type text,p_severity text,p_params jsonb) returns void language plpgsql immutable security definer set search_path='' as $$
declare v_key text; v_value text; v_allowed text[];
begin
 if jsonb_typeof(coalesce(p_params,'{}'::jsonb))<>'object' then raise exception 'validation_failed'; end if;
 if p_severity<>'LIMITED' then if p_params<>'{}'::jsonb then raise exception 'validation_failed'; end if; return; end if;
 v_allowed:=case p_type when 'TRADING' then array['max_stake','max_open_contracts','max_daily_net_loss'] when 'DEPOSIT' then array['max_amount_per_day'] when 'WITHDRAWAL' then array['max_amount_per_day'] else array[]::text[] end;
 if cardinality(v_allowed)=0 or p_params='{}'::jsonb then raise exception 'validation_failed'; end if;
 for v_key,v_value in select key,value from jsonb_each_text(p_params) loop
  if not v_key=any(v_allowed) or v_value !~ '^[0-9]+(\.[0-9]+)?$' or v_value::numeric<=0 then raise exception 'validation_failed'; end if;
  if v_key='max_open_contracts' and (v_value::numeric<>floor(v_value::numeric) or v_value::numeric>100000) then raise exception 'validation_failed'; end if;
 end loop;
end; $$;

create or replace function public.effective_restrictions(p_user uuid,p_mode text,p_type text) returns jsonb language sql security definer set search_path='' as $$
with active_rows as (
 select * from public.account_restrictions where user_id=p_user and restriction_type=p_type and active and (expires_at is null or expires_at>now()) and scope in ('ALL',p_mode)
), limits as (
 select e.key, min(e.value::numeric) value from active_rows r cross join lateral jsonb_each_text(r.params) e where r.severity='LIMITED' group by e.key
)
select jsonb_build_object(
 'blocked',coalesce((select bool_or(severity='BLOCKED') from active_rows),false),
 'limits',coalesce((select jsonb_object_agg(key,to_jsonb(value)) from limits),'{}'::jsonb),
 'notices',coalesce((select jsonb_agg(jsonb_build_object('reason',reason,'expires_at',expires_at) order by applied_at desc) from active_rows where severity='NOTICE'),'[]'::jsonb)
) $$;

create or replace function public.engine_validate_restriction_row() returns trigger language plpgsql set search_path='' as $$
begin
 perform public.validate_engine_restriction_params(new.restriction_type,new.severity,new.params);
 return new;
end; $$;

drop trigger if exists account_restrictions_engine_params on public.account_restrictions;
create trigger account_restrictions_engine_params before insert or update of restriction_type,severity,params on public.account_restrictions for each row execute function public.engine_validate_restriction_row();

create or replace function public.engine_contract_guardrails() returns trigger language plpgsql security definer set search_path='' as $$
declare v_limits jsonb; v_value numeric; v_rate integer; v_max_liability numeric; v_prior numeric[]; v_next numeric[]:=array[]::numeric[]; v_digit integer; v_delta numeric;
begin
 if new.state<>'OPEN' then return new; end if;
 v_limits:=(public.effective_restrictions((select user_id from public.trading_accounts where id=new.trading_account_id),new.execution_mode::text,'TRADING')->'limits');
 if v_limits ? 'max_stake' and new.stake>(v_limits->>'max_stake')::numeric then raise exception 'restricted_limit_exceeded'; end if;
 if v_limits ? 'max_open_contracts' and (select count(*) from public.engine_contracts where trading_account_id=new.trading_account_id and state='OPEN') >= (v_limits->>'max_open_contracts')::integer then raise exception 'restricted_limit_exceeded'; end if;
 if v_limits ? 'max_daily_net_loss' then
  select coalesce(sum(stake),0) into v_value from public.engine_contracts where trading_account_id=new.trading_account_id and state='LOST' and settled_at>=date_trunc('day',now());
  if v_value+new.stake>(v_limits->>'max_daily_net_loss')::numeric then raise exception 'restricted_limit_exceeded'; end if;
 end if;
 select max_buys_per_minute,max_liability_per_tick into v_rate,v_max_liability from public.engine_policy_limits where policy_version=new.policy_version and execution_mode=new.execution_mode;
 if v_rate is null then raise exception 'limits_not_configured'; end if;
 if (select count(*) from public.engine_contracts where trading_account_id=new.trading_account_id and created_at>=now()-interval '1 minute')>=v_rate then raise exception 'rate_limit_exceeded'; end if;
 insert into public.engine_tick_exposure(execution_mode,index_code,settle_tick_no,net_loss_by_digit) values(new.execution_mode,new.index_code,new.settle_tick_no,array_fill(0::numeric,array[10])) on conflict do nothing;
 select net_loss_by_digit into v_prior from public.engine_tick_exposure where execution_mode=new.execution_mode and index_code=new.index_code and settle_tick_no=new.settle_tick_no for update;
 for v_digit in 0..9 loop
  v_delta:=case when v_digit=any(public.engine_winning_digits(new.contract_type,new.barrier)) then new.payout-new.stake else -new.stake end;
  v_next:=array_append(v_next,coalesce(v_prior[v_digit+1],0)+v_delta);
 end loop;
 if (select max(x) from unnest(v_next) x)>v_max_liability then raise exception 'exposure_limit'; end if;
 update public.engine_tick_exposure set net_loss_by_digit=v_next where execution_mode=new.execution_mode and index_code=new.index_code and settle_tick_no=new.settle_tick_no;
 return new;
end; $$;

drop trigger if exists engine_contract_guardrails on public.engine_contracts;
create trigger engine_contract_guardrails before insert on public.engine_contracts for each row execute function public.engine_contract_guardrails();

revoke all on function public.validate_engine_restriction_params(text,text,jsonb),public.engine_contract_guardrails() from public,anon,authenticated;
