-- Phase 4 operations console: the server side of the Contracts, Engine, Overview
-- and Customers tabs. Every function here is security definer with an empty
-- search_path, checks its capability through admin_private.require_staff, and
-- audits every state change in admin_audit_events.

-- 1. Capability registry. 20260920500000 rebuilt the registry without
-- customers.read and operations.read, which administrators and owners have held
-- since 20260918120000 and which the Customers tab and platform overview require.
create or replace function admin_private.role_capabilities(p_role text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_role
    when 'support_agent' then array['staff.enter', 'support.read_assigned', 'support.reply', 'support.note', 'support.transition', 'customers.restrict.notice']
    when 'administrator' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'customers.read', 'operations.read', 'engine.read', 'engine.manage', 'contracts.read', 'customers.restrict.notice', 'customers.restrict.limit', 'customers.restrict.block']
    when 'owner' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'customers.read', 'operations.read', 'staff.manage', 'audit.read', 'engine.read', 'engine.manage', 'contracts.read', 'contracts.void', 'platform.enable_real', 'customers.restrict.notice', 'customers.restrict.limit', 'customers.restrict.block', 'customers.restrict.block_severe']
    else array[]::text[] end;
$$;

-- 2. Restriction gravity. One mapping decides the capability needed to apply,
-- supersede or lift a restriction (docs/RESTRICTIONS.md).
create or replace function admin_private.restriction_capability(p_type text, p_scope text, p_severity text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_severity = 'NOTICE' then 'customers.restrict.notice'
    when p_severity = 'LIMITED' then 'customers.restrict.limit'
    when p_type in ('ACCESS', 'WITHDRAWAL', 'DEPOSIT') or p_scope in ('ALL', 'REAL') then 'customers.restrict.block_severe'
    else 'customers.restrict.block' end;
$$;
revoke all on function admin_private.restriction_capability(text, text, text) from public, anon, authenticated, service_role;

-- A new restriction supersedes the active one of the same type and scope only
-- when the actor also holds the capability that restriction needed (so the
-- higher of the two), including fresh re-authentication for severe blocks.
create or replace function public.apply_account_restriction(p_user_id uuid,p_type text,p_scope text,p_severity text,p_params jsonb,p_expires_at timestamptz,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_capability text; v_actor public.staff_roles%rowtype; v_reason text:=btrim(coalesce(p_reason,'')); v_prior record; v_superseded uuid[]:=array[]::uuid[]; v_id uuid;
begin
 if p_type is null or p_type not in ('TRADING','WITHDRAWAL','DEPOSIT','ACCESS') or p_scope is null or p_scope not in ('ALL','DEMO','REAL') or p_severity is null or p_severity not in ('NOTICE','LIMITED','BLOCKED') then raise exception 'validation_failed'; end if;
 v_capability:=admin_private.restriction_capability(p_type,p_scope,p_severity);
 v_actor:=admin_private.require_staff(v_capability,v_capability='customers.restrict.block_severe');
 if p_user_id is null or char_length(v_reason) not between 3 and 500 or (p_expires_at is not null and p_expires_at<=now()) then raise exception 'validation_failed'; end if;
 if not exists(select 1 from auth.users where id=p_user_id) then raise exception 'not_found'; end if;
 for v_prior in select r.id,r.restriction_type,r.scope,r.severity,r.expires_at from public.account_restrictions r where r.user_id=p_user_id and r.restriction_type=p_type and r.scope=p_scope and r.active for update loop
  if v_prior.expires_at is null or v_prior.expires_at>now() then
   perform admin_private.require_staff(admin_private.restriction_capability(v_prior.restriction_type,v_prior.scope,v_prior.severity),admin_private.restriction_capability(v_prior.restriction_type,v_prior.scope,v_prior.severity)='customers.restrict.block_severe');
  end if;
  v_superseded:=v_superseded||v_prior.id;
 end loop;
 update public.account_restrictions set active=false,lifted_at=now(),lifted_by=v_actor.user_id,lifted_reason='Superseded by new restriction' where id=any(v_superseded);
 insert into public.account_restrictions(user_id,restriction_type,scope,severity,params,expires_at,active,reason,applied_by) values(p_user_id,p_type,p_scope,p_severity,coalesce(p_params,'{}'::jsonb),p_expires_at,true,v_reason,v_actor.user_id) returning id into v_id;
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state)
 values(v_actor.user_id,'staff','customer.restrict','customer',p_user_id,public.gen_random_uuid(),v_reason,jsonb_build_object('restriction_id',v_id,'type',p_type,'scope',p_scope,'severity',p_severity,'params',coalesce(p_params,'{}'::jsonb),'expires_at',p_expires_at,'superseded',to_jsonb(v_superseded)));
 return v_id;
end; $$;

-- Lifting needs the same capability the restriction needed to be applied.
create or replace function public.lift_account_restriction(p_restriction_id uuid,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.account_restrictions%rowtype; v_capability text; v_actor public.staff_roles%rowtype; v_reason text:=btrim(coalesce(p_reason,''));
begin
 perform admin_private.require_staff('staff.enter');
 select * into v_row from public.account_restrictions where id=p_restriction_id for update;
 if not found or not v_row.active then raise exception 'not_found'; end if;
 v_capability:=admin_private.restriction_capability(v_row.restriction_type,v_row.scope,v_row.severity);
 v_actor:=admin_private.require_staff(v_capability,v_capability='customers.restrict.block_severe');
 if char_length(v_reason) not between 3 and 500 then raise exception 'validation_failed'; end if;
 update public.account_restrictions set active=false,lifted_at=now(),lifted_by=v_actor.user_id,lifted_reason=v_reason where id=v_row.id;
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,before_state,after_state)
 values(v_actor.user_id,'staff','customer.lift_restriction','customer',v_row.user_id,public.gen_random_uuid(),v_reason,
  jsonb_build_object('restriction_id',v_row.id,'type',v_row.restriction_type,'scope',v_row.scope,'severity',v_row.severity,'params',v_row.params,'expires_at',v_row.expires_at,'active',true),
  jsonb_build_object('restriction_id',v_row.id,'active',false));
 return jsonb_build_object('id',v_row.id,'user_id',v_row.user_id,'active',false,'lifted_at',now(),'lifted_reason',v_reason);
end; $$;

-- 3. Customer detail without legacy wallet data: the customer's typed accounts
-- with their ledger-asset balances, and restrictions with every graded field.
create or replace function public.get_admin_customer_detail(p_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user record; v_profile record;
begin
 perform admin_private.require_staff('customers.read');
 if p_user_id is null then raise exception 'validation_failed'; end if;
 select id,email,email_confirmed_at into v_user from auth.users where id=p_user_id;
 if not found then raise exception 'not_found'; end if;
 select display_name,lifecycle_status,created_at into v_profile from public.profiles where id=p_user_id;
 return jsonb_build_object(
  'user_id',v_user.id,'email',v_user.email,
  'display_name',coalesce(v_profile.display_name,split_part(v_user.email,'@',1)),
  'lifecycle_status',coalesce(v_profile.lifecycle_status,'ACTIVE'),
  'created_at',coalesce(v_profile.created_at,now()),
  'email_verified',v_user.email_confirmed_at is not null,
  'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'execution_mode',a.execution_mode,'status',a.status,'created_at',a.created_at,
    'balances',coalesce((select jsonb_object_agg(l.kind,coalesce((select sum(e.amount) from public.ledger_entries e where e.ledger_account_id=l.id),0)) from public.wallets w join public.ledger_accounts l on l.wallet_id=w.id where w.trading_account_id=a.id and w.asset=public.engine_ledger_asset()),'{}'::jsonb),
    'open_contracts',(select count(*) from public.engine_contracts c where c.trading_account_id=a.id and c.state='OPEN')) order by a.execution_mode) from public.trading_accounts a where a.user_id=p_user_id),'[]'::jsonb),
  'currency',public.engine_ledger_asset(),
  'restrictions',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'restriction_type',r.restriction_type,'scope',r.scope,'severity',r.severity,'params',r.params,'expires_at',r.expires_at,'expired',r.expires_at is not null and r.expires_at<=now(),'active',r.active,'reason',r.reason,'applied_at',r.applied_at,'applied_by',r.applied_by,'lifted_at',r.lifted_at,'lifted_reason',r.lifted_reason) order by r.applied_at desc) from public.account_restrictions r where r.user_id=p_user_id),'[]'::jsonb),
  'recent_tickets',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'reference','SP-'||s.ticket_number,'subject',s.subject,'status',s.status,'created_at',s.created_at) order by s.created_at desc) from (select * from public.support_requests where user_id=p_user_id order by created_at desc limit 10) s),'[]'::jsonb)
 );
end; $$;

-- 4. Contracts. The listing gains account, index and date filters next to the
-- account-type and state filters; the old three-argument form is replaced so a
-- call by name can never be ambiguous between two overloads.
drop function if exists public.list_admin_contracts(public.execution_mode,text,integer);
create function public.list_admin_contracts(p_mode public.execution_mode default null,p_state text default null,p_limit integer default 100,p_account_id uuid default null,p_index text default null,p_from timestamptz default null,p_to timestamptz default null) returns setof public.engine_contracts language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('contracts.read');
 if p_state is not null and p_state not in ('OPEN','WON','LOST','VOID') then raise exception 'validation_failed'; end if;
 if p_from is not null and p_to is not null and p_to<=p_from then raise exception 'validation_failed'; end if;
 return query select c.* from public.engine_contracts c
  where (p_mode is null or c.execution_mode=p_mode) and (p_state is null or c.state=p_state)
   and (p_account_id is null or c.trading_account_id=p_account_id) and (p_index is null or c.index_code=p_index)
   and (p_from is null or c.created_at>=p_from) and (p_to is null or c.created_at<p_to)
  order by c.created_at desc limit least(greatest(coalesce(p_limit,100),1),500);
end; $$;

create or replace function public.get_admin_contract_detail(p_contract_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_contract public.engine_contracts%rowtype;
begin
 perform admin_private.require_staff('contracts.read');
 select * into v_contract from public.engine_contracts where id=p_contract_id;
 if not found then raise exception 'not_found'; end if;
 return jsonb_build_object(
  'contract',to_jsonb(v_contract),
  'customer',(select jsonb_build_object('user_id',u.id,'email',u.email) from public.trading_accounts a join auth.users u on u.id=a.user_id where a.id=v_contract.trading_account_id),
  'entry_tick',(select jsonb_build_object('tick_no',t.tick_no,'scheduled_at',t.scheduled_at,'price',t.price,'digit',t.digit,'epoch_id',t.epoch_id) from public.index_ticks t where t.index_code=v_contract.index_code and t.execution_mode=v_contract.execution_mode and t.tick_no=v_contract.entry_tick_no),
  'settle_tick',(select jsonb_build_object('tick_no',t.tick_no,'scheduled_at',t.scheduled_at,'price',t.price,'digit',t.digit,'epoch_id',t.epoch_id) from public.index_ticks t where t.index_code=v_contract.index_code and t.execution_mode=v_contract.execution_mode and t.tick_no=v_contract.settle_tick_no),
  'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from public.contract_events e where e.contract_id=p_contract_id),'[]'::jsonb),
  'ledger_transactions',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'idempotency_key',t.idempotency_key,'description',t.description,'created_at',t.created_at) order by t.created_at) from public.ledger_transactions t where t.trading_account_id=v_contract.trading_account_id and t.idempotency_key in ('buy-'||v_contract.id,'settle-'||v_contract.id,'void-'||v_contract.id)),'[]'::jsonb)
 );
end; $$;

-- Open contracts whose settle tick is already published, or whose settlement
-- keeps failing: the list the Engine tab offers for investigation and void.
create or replace function public.list_admin_stuck_contracts(p_mode public.execution_mode default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('engine.read');
 perform admin_private.require_staff('contracts.read');
 return coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('last_tick_no',s.last_tick_no,'stuck_reason',case when c.settlement_attempts>3 then 'settlement_retrying' else 'settle_tick_passed' end) order by c.created_at)
  from public.engine_contracts c join public.index_state s on s.index_code=c.index_code and s.execution_mode=c.execution_mode
  where c.state='OPEN' and (c.settle_tick_no<=s.last_tick_no or c.settlement_attempts>3) and (p_mode is null or c.execution_mode=p_mode)),'[]'::jsonb);
end; $$;

-- 5. Engine listings.
create or replace function public.list_admin_engine_indices(p_mode public.execution_mode default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('engine.read');
 return coalesce((select jsonb_agg(jsonb_build_object('code',i.code,'execution_mode',i.execution_mode,'display_name',i.display_name,'status',i.status,'tick_interval_ms',i.tick_interval_ms,'decimals',i.decimals,'t0',i.t0) order by i.execution_mode,i.sort_order)
  from public.engine_indices i where p_mode is null or i.execution_mode=p_mode),'[]'::jsonb);
end; $$;

create or replace function public.list_admin_engine_epochs(p_mode public.execution_mode default null,p_limit integer default 30) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('engine.read');
 return coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'execution_mode',e.execution_mode,'starts_at',e.starts_at,'ends_at',e.ends_at,'seed_commitment',e.seed_commitment,'prev_chain_hash',e.prev_chain_hash,'chain_hash',e.chain_hash,'committed_at',e.committed_at,'revealed_at',e.revealed_at,'revealed_seed',e.revealed_seed,
   'reveal_status',case when e.revealed_at is not null then 'revealed' when e.starts_at>now() then 'upcoming' when e.ends_at>now() then 'active' else 'awaiting_reveal' end) order by e.starts_at desc)
  from (select * from public.engine_epochs where p_mode is null or execution_mode=p_mode order by starts_at desc limit least(greatest(coalesce(p_limit,30),1),200)) e),'[]'::jsonb);
end; $$;

create or replace function public.list_admin_engine_policies(p_limit integer default 20) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('engine.read');
 return coalesce((select jsonb_agg(to_jsonb(v)||jsonb_build_object('limits',coalesce((select jsonb_object_agg(l.execution_mode,to_jsonb(l)-'policy_version'-'execution_mode') from public.engine_policy_limits l where l.policy_version=v.version),'{}'::jsonb)) order by v.version desc)
  from (select * from public.engine_policy_versions order by version desc limit least(greatest(coalesce(p_limit,20),1),100)) v),'[]'::jsonb);
end; $$;

-- 6. Policy publication. Same rules as 20260920410000, with two fixes: the audit
-- row gets a target id (admin_audit_events.target_id is not null, so every
-- publish failed), and each rejection names the failing field in the error
-- detail so the console can show the reason.
create or replace function public.publish_engine_policy(p_policy jsonb,p_reason text) returns integer language plpgsql security definer set search_path='' as $$
declare v_version integer; v_margin numeric; v_min_ticks integer; v_max_ticks integer; v_delay integer; v_lag integer; v_ratio numeric; v_retention integer; v_enabled text[]; v_limits jsonb; v_min_stake numeric; v_max_stake numeric; v_open integer; v_rate integer; v_liability numeric; v_type text; v_barrier smallint; v_payout numeric; v_missing text; v_override record; v_type_margin numeric;
begin
 perform admin_private.require_staff('engine.manage');
 if jsonb_typeof(p_policy) is distinct from 'object' then raise exception 'validation_failed' using detail='The policy must be a JSON object.'; end if;
 if char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed' using detail='reason: give at least 10 characters.'; end if;
 select string_agg(k,', ') into v_missing from unnest(array['house_margin','min_ticks','max_ticks','max_settlement_delay_seconds','max_feed_lag_seconds','min_profit_ratio','tick_retention_days','enabled_contract_types','limits']) k where not p_policy ? k;
 if v_missing is not null then raise exception 'validation_failed' using detail='Missing fields: '||v_missing||'.'; end if;
 begin
  v_margin:=(p_policy->>'house_margin')::numeric; v_min_ticks:=(p_policy->>'min_ticks')::integer; v_max_ticks:=(p_policy->>'max_ticks')::integer; v_delay:=(p_policy->>'max_settlement_delay_seconds')::integer; v_lag:=(p_policy->>'max_feed_lag_seconds')::integer; v_ratio:=(p_policy->>'min_profit_ratio')::numeric; v_retention:=(p_policy->>'tick_retention_days')::integer;
 exception when others then raise exception 'validation_failed' using detail='house_margin and min_profit_ratio must be numbers; tick counts, delays and retention must be whole numbers.';
 end;
 if v_margin is null or v_margin not between .005 and .15 then raise exception 'validation_failed' using detail='house_margin must be between 0.005 and 0.15.'; end if;
 if v_min_ticks is null or v_min_ticks<1 then raise exception 'validation_failed' using detail='min_ticks must be at least 1.'; end if;
 if v_max_ticks is null or v_max_ticks not between v_min_ticks and 10 then raise exception 'validation_failed' using detail='max_ticks must be between min_ticks and 10.'; end if;
 if v_delay is null or v_delay<=0 then raise exception 'validation_failed' using detail='max_settlement_delay_seconds must be positive.'; end if;
 if v_lag is null or v_lag<=0 then raise exception 'validation_failed' using detail='max_feed_lag_seconds must be positive.'; end if;
 if v_ratio is null or v_ratio<0 then raise exception 'validation_failed' using detail='min_profit_ratio must not be negative.'; end if;
 if v_retention is null or v_retention<=0 then raise exception 'validation_failed' using detail='tick_retention_days must be positive.'; end if;
 if jsonb_typeof(p_policy->'enabled_contract_types') is distinct from 'array' then raise exception 'validation_failed' using detail='enabled_contract_types must be a list.'; end if;
 select array_agg(distinct value order by value) into v_enabled from jsonb_array_elements_text(p_policy->'enabled_contract_types');
 if coalesce(cardinality(v_enabled),0)=0 then raise exception 'validation_failed' using detail='Enable at least one contract type.'; end if;
 if exists(select 1 from unnest(v_enabled) x where x not in ('EVEN','ODD','OVER','UNDER','MATCH','DIFFER')) then raise exception 'validation_failed' using detail='enabled_contract_types may only contain EVEN, ODD, OVER, UNDER, MATCH and DIFFER.'; end if;
 if jsonb_typeof(coalesce(p_policy->'margin_overrides','{}'::jsonb)) is distinct from 'object' then raise exception 'validation_failed' using detail='margin_overrides must be an object keyed by contract type.'; end if;
 for v_override in select key,value from jsonb_each_text(coalesce(p_policy->'margin_overrides','{}'::jsonb)) loop
  if v_override.key not in ('EVEN','ODD','OVER','UNDER','MATCH','DIFFER') then raise exception 'validation_failed' using detail='margin_overrides has an unknown contract type: '||v_override.key||'.'; end if;
  if v_override.value !~ '^[0-9]*\.?[0-9]+$' or v_override.value::numeric not between .005 and .15 then raise exception 'validation_failed' using detail='margin_overrides.'||v_override.key||' must be between 0.005 and 0.15.'; end if;
 end loop;
 if p_policy->'limits' ? 'REAL' then raise exception 'validation_failed' using detail='Real limits cannot be published before Real accounts are designed.'; end if;
 v_limits:=p_policy->'limits'->'DEMO';
 if jsonb_typeof(v_limits) is distinct from 'object' then raise exception 'validation_failed' using detail='limits.DEMO is required.'; end if;
 select string_agg(k,', ') into v_missing from unnest(array['min_stake','max_stake','max_open_contracts','max_buys_per_minute','max_liability_per_tick']) k where not v_limits ? k;
 if v_missing is not null then raise exception 'validation_failed' using detail='Missing Practice limits: '||v_missing||'.'; end if;
 begin
  v_min_stake:=(v_limits->>'min_stake')::numeric; v_max_stake:=(v_limits->>'max_stake')::numeric; v_open:=(v_limits->>'max_open_contracts')::integer; v_rate:=(v_limits->>'max_buys_per_minute')::integer; v_liability:=(v_limits->>'max_liability_per_tick')::numeric;
 exception when others then raise exception 'validation_failed' using detail='Practice stakes and liability must be numbers; open-contract and per-minute limits must be whole numbers.';
 end;
 if v_min_stake is null or v_min_stake<=0 then raise exception 'validation_failed' using detail='limits.DEMO.min_stake must be positive.'; end if;
 if v_max_stake is null or v_max_stake<v_min_stake then raise exception 'validation_failed' using detail='limits.DEMO.max_stake must be at least min_stake.'; end if;
 if v_open is null or v_open<=0 then raise exception 'validation_failed' using detail='limits.DEMO.max_open_contracts must be positive.'; end if;
 if v_rate is null or v_rate<=0 then raise exception 'validation_failed' using detail='limits.DEMO.max_buys_per_minute must be positive.'; end if;
 if v_liability is null or v_liability<=0 then raise exception 'validation_failed' using detail='limits.DEMO.max_liability_per_tick must be positive.'; end if;
 -- Coverage: every enabled type must clear min_profit_ratio at the minimum stake for every legal barrier.
 foreach v_type in array v_enabled loop
  v_type_margin:=coalesce((p_policy->'margin_overrides'->>v_type)::numeric,v_margin);
  for v_barrier in select case when v_type in ('EVEN','ODD') then null::smallint else g::smallint end from generate_series(case when v_type='UNDER' then 1 else 0 end,case when v_type in ('EVEN','ODD') then 0 when v_type='OVER' then 8 else 9 end) g loop
   v_payout:=floor(v_min_stake*(1-v_type_margin)*10/cardinality(public.engine_winning_digits(v_type,v_barrier))*100)/100;
   if v_payout-v_min_stake<v_ratio*v_min_stake then
    raise exception 'validation_failed' using detail=format('%s%s pays %s on the minimum stake %s, below min_profit_ratio %s.',v_type,coalesce(' '||v_barrier,''),round(v_payout,2),v_min_stake,v_ratio);
   end if;
  end loop;
 end loop;
 select coalesce(max(version),0)+1 into v_version from public.engine_policy_versions;
 insert into public.engine_policy_versions(version,effective_from,house_margin,margin_overrides,min_ticks,max_ticks,max_settlement_delay_seconds,max_feed_lag_seconds,min_profit_ratio,tick_retention_days,enabled_contract_types,created_by,reason) values(v_version,now(),v_margin,coalesce(p_policy->'margin_overrides','{}'::jsonb),v_min_ticks,v_max_ticks,v_delay,v_lag,v_ratio,v_retention,v_enabled,auth.uid(),btrim(p_reason));
 insert into public.engine_policy_limits(policy_version,execution_mode,min_stake,max_stake,max_open_contracts,max_buys_per_minute,max_liability_per_tick) values(v_version,'DEMO',v_min_stake,v_max_stake,v_open,v_rate,v_liability);
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state) values(auth.uid(),'staff','engine.publish_policy','engine_policy',public.gen_random_uuid(),public.gen_random_uuid(),btrim(p_reason),p_policy||jsonb_build_object('version',v_version));
 return v_version;
end; $$;

-- 7. Platform overview: gated by operations.read like the console tab, engine
-- health reports 'unavailable' when no index exists, and contracts today are
-- always split by account type.
create or replace function public.get_platform_overview() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform admin_private.require_staff('operations.read');
 return jsonb_build_object(
  'open_tickets',(select count(*) from public.support_requests where status in ('open','in_progress')),
  'unassigned_tickets',(select count(*) from public.support_requests where status in ('open','in_progress') and assignee_id is null),
  'waiting_tickets',(select count(*) from public.support_requests where status='waiting_for_customer'),
  'total_customers',(select count(*) from auth.users),
  'active_restrictions',(select count(*) from public.account_restrictions where active and (expires_at is null or expires_at>now())),
  'active_staff',(select count(*) from public.staff_roles where active),
  'contracts_today',(select jsonb_build_object('DEMO',count(*) filter (where execution_mode='DEMO'),'REAL',count(*) filter (where execution_mode='REAL')) from public.engine_contracts where created_at>=date_trunc('day',now())),
  'engine_health',(select case when count(*)=0 then 'unavailable' when bool_or(now()-updated_at>interval '10 seconds') then 'degraded' else 'healthy' end from public.index_state),
  'timestamp',now());
end; $$;

revoke all on function public.apply_account_restriction(uuid,text,text,text,jsonb,timestamptz,text),public.lift_account_restriction(uuid,text),public.get_admin_customer_detail(uuid),public.list_admin_contracts(public.execution_mode,text,integer,uuid,text,timestamptz,timestamptz),public.get_admin_contract_detail(uuid),public.list_admin_stuck_contracts(public.execution_mode),public.list_admin_engine_indices(public.execution_mode),public.list_admin_engine_epochs(public.execution_mode,integer),public.list_admin_engine_policies(integer),public.publish_engine_policy(jsonb,text),public.get_platform_overview() from public,anon;
grant execute on function public.apply_account_restriction(uuid,text,text,text,jsonb,timestamptz,text),public.lift_account_restriction(uuid,text),public.get_admin_customer_detail(uuid),public.list_admin_contracts(public.execution_mode,text,integer,uuid,text,timestamptz,timestamptz),public.get_admin_contract_detail(uuid),public.list_admin_stuck_contracts(public.execution_mode),public.list_admin_engine_indices(public.execution_mode),public.list_admin_engine_epochs(public.execution_mode,integer),public.list_admin_engine_policies(integer),public.publish_engine_policy(jsonb,text),public.get_platform_overview() to authenticated;
