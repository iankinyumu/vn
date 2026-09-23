create table public.real_readiness_checklists (version text primary key, published_at timestamptz not null, items jsonb not null, published_by uuid not null references auth.users(id));
alter table public.real_readiness_checklists enable row level security;
revoke all on public.real_readiness_checklists from public,anon,authenticated,service_role;

create or replace function public.enable_real_accounts(p_checklist_version text,p_evidence jsonb,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_checklist public.real_readiness_checklists%rowtype; v_missing text[]; v_audit uuid;
begin
 perform admin_private.require_staff('platform.enable_real',true);
 select * into v_checklist from public.real_readiness_checklists order by published_at desc limit 1;
 if not found or v_checklist.version<>p_checklist_version then raise exception 'checklist_outdated'; end if;
 select array_agg(key) into v_missing from jsonb_object_keys(v_checklist.items) key where coalesce(btrim(p_evidence->>key),'')='';
 if v_missing is not null then raise exception 'evidence_incomplete: %',array_to_string(v_missing,','); end if;
 if char_length(btrim(coalesce(p_reason,'')))<20 then raise exception 'validation_failed'; end if;
 update public.platform_modules set enabled=true,changed_at=now(),reason=btrim(p_reason) where module_key='real_accounts';
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state) values(auth.uid(),'staff','platform.enable_real','platform',null,gen_random_uuid(),btrim(p_reason),jsonb_build_object('checklist_version',v_checklist.version,'evidence',p_evidence)) returning id into v_audit;
 return v_audit;
end; $$;

create or replace function public.disable_real_accounts(p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_audit uuid;
begin
 perform admin_private.require_staff('platform.enable_real',true); if char_length(btrim(coalesce(p_reason,'')))<20 then raise exception 'validation_failed'; end if;
 update public.platform_modules set enabled=false,changed_at=now(),reason=btrim(p_reason) where module_key='real_accounts';
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason) values(auth.uid(),'staff','platform.disable_real','platform',null,gen_random_uuid(),btrim(p_reason)) returning id into v_audit; return v_audit;
end; $$;
