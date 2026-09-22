alter table public.account_restrictions add column if not exists scope text not null default 'ALL' check(scope in ('ALL','DEMO','REAL'));
alter table public.account_restrictions add column if not exists severity text not null default 'BLOCKED' check(severity in ('NOTICE','LIMITED','BLOCKED'));
alter table public.account_restrictions add column if not exists params jsonb not null default '{}'::jsonb;
alter table public.account_restrictions add column if not exists expires_at timestamptz;
alter table public.account_restrictions drop constraint if exists account_restrictions_restriction_type_check;
alter table public.account_restrictions add constraint account_restrictions_restriction_type_check check(restriction_type in ('TRADING','WITHDRAWAL','DEPOSIT','ACCESS'));

create or replace function public.effective_restrictions(p_user uuid,p_mode text,p_type text) returns jsonb language sql security definer set search_path='' as $$
select jsonb_build_object('blocked',coalesce(bool_or(severity='BLOCKED'),false),'notices',coalesce(jsonb_agg(jsonb_build_object('reason',reason,'expires_at',expires_at)) filter(where severity='NOTICE'),'[]'::jsonb),'limits',coalesce(jsonb_object_agg(k,min_value) filter(where k is not null),'{}'::jsonb)) from (select r.*,e.key k,min(e.value::numeric) over(partition by e.key) min_value from public.account_restrictions r left join lateral jsonb_each_text(r.params)e on r.severity='LIMITED' where r.user_id=p_user and r.restriction_type=p_type and r.active and (r.expires_at is null or r.expires_at>now()) and r.scope in ('ALL',p_mode)) x;
$$;

drop function if exists public.get_my_active_restrictions();
create function public.get_my_active_restrictions() returns table(restriction_type text,scope text,severity text,params jsonb,expires_at timestamptz,reason text,applied_at timestamptz) language sql security definer set search_path='' as $$
select r.restriction_type,r.scope,r.severity,r.params,r.expires_at,r.reason,r.applied_at from public.account_restrictions r where r.user_id=auth.uid() and r.active and (r.expires_at is null or r.expires_at>now()) order by r.applied_at desc;
$$;
