drop function if exists public.apply_account_restriction(uuid,text,text);
create function public.apply_account_restriction(p_user_id uuid,p_type text,p_scope text,p_severity text,p_params jsonb,p_expires_at timestamptz,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare capability text; actor public.staff_roles%rowtype; restriction_id uuid;
begin
 capability:=case when p_severity='NOTICE' then 'customers.restrict.notice' when p_severity='LIMITED' then 'customers.restrict.limit' when p_type in ('ACCESS','WITHDRAWAL','DEPOSIT') or p_scope in ('ALL','REAL') then 'customers.restrict.block_severe' else 'customers.restrict.block' end;
 actor:=admin_private.require_staff(capability,capability='customers.restrict.block_severe');
 if p_type not in ('TRADING','WITHDRAWAL','DEPOSIT','ACCESS') or p_scope not in ('ALL','DEMO','REAL') or p_severity not in ('NOTICE','LIMITED','BLOCKED') or char_length(btrim(coalesce(p_reason,''))) not between 3 and 500 then raise exception 'validation_failed'; end if;
 update public.account_restrictions set active=false,lifted_at=now(),lifted_by=actor.user_id,lifted_reason='Superseded by new restriction' where user_id=p_user_id and restriction_type=p_type and scope=p_scope and active;
 insert into public.account_restrictions(user_id,restriction_type,scope,severity,params,expires_at,active,reason,applied_by) values(p_user_id,p_type,p_scope,p_severity,coalesce(p_params,'{}'),p_expires_at,true,btrim(p_reason),actor.user_id) returning id into restriction_id;
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state) values(actor.user_id,'staff','customer.restrict','customer',p_user_id,gen_random_uuid(),btrim(p_reason),jsonb_build_object('restriction_id',restriction_id,'type',p_type,'scope',p_scope,'severity',p_severity,'params',coalesce(p_params,'{}'),'expires_at',p_expires_at)); return restriction_id;
end; $$;
revoke all on function public.apply_account_restriction(uuid,text,text,text,jsonb,timestamptz,text) from public,anon; grant execute on function public.apply_account_restriction(uuid,text,text,text,jsonb,timestamptz,text) to authenticated;
