create or replace function public.reject_real_checklist_mutation() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'real_checklist_immutable'; end; $$;

drop trigger if exists real_readiness_checklists_immutable on public.real_readiness_checklists;
create trigger real_readiness_checklists_immutable before update or delete on public.real_readiness_checklists for each row execute function public.reject_real_checklist_mutation();

create or replace function public.enable_real_accounts(p_checklist_version text,p_evidence jsonb,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_checklist public.real_readiness_checklists%rowtype; v_actor public.staff_roles%rowtype; v_required text[]:=array['seed_custody','funding_reconciliation','real_policy','step_up_authentication','conformance_parity','owner_signoff']; v_key text; v_value text; v_audit uuid;
begin
 v_actor:=admin_private.require_staff('platform.enable_real',true);
 if v_actor.role<>'owner' then raise exception 'forbidden'; end if;
 select * into v_checklist from public.real_readiness_checklists order by published_at desc limit 1;
 if not found or v_checklist.version<>p_checklist_version then raise exception 'checklist_outdated'; end if;
 if jsonb_typeof(v_checklist.items)<>'object' or not (v_checklist.items ?& v_required) or jsonb_typeof(p_evidence)<>'object' or not (p_evidence ?& v_required) then raise exception 'evidence_incomplete'; end if;
 foreach v_key in array v_required loop
  v_value:=btrim(coalesce(p_evidence->>v_key,''));
  if v_value !~ '^(https?://|PR-[0-9]+$|run:[A-Za-z0-9._-]+$)' then raise exception 'evidence_incomplete: %',v_key; end if;
 end loop;
 if char_length(btrim(coalesce(p_reason,'')))<20 then raise exception 'validation_failed'; end if;
 update public.platform_modules set enabled=true,changed_at=now(),reason=btrim(p_reason) where module_key='real_accounts';
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state) values(auth.uid(),'staff','platform.enable_real','platform',null,public.gen_random_uuid(),btrim(p_reason),jsonb_build_object('checklist_version',v_checklist.version,'evidence',p_evidence,'owner',v_actor.user_id)) returning id into v_audit;
 return v_audit;
end; $$;

create or replace function public.disable_real_accounts(p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_actor public.staff_roles%rowtype; v_audit uuid;
begin
 v_actor:=admin_private.require_staff('platform.enable_real',true);
 if v_actor.role<>'owner' then raise exception 'forbidden'; end if;
 if char_length(btrim(coalesce(p_reason,'')))<20 then raise exception 'validation_failed'; end if;
 update public.platform_modules set enabled=false,changed_at=now(),reason=btrim(p_reason) where module_key='real_accounts';
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state) values(auth.uid(),'staff','platform.disable_real','platform',null,public.gen_random_uuid(),btrim(p_reason),jsonb_build_object('owner',v_actor.user_id)) returning id into v_audit;
 return v_audit;
end; $$;
