-- Account-owned inbox. Only the RPC may insert; service-role operators manage status.
create table public.support_requests (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    first_name text not null check (char_length(first_name) between 1 and 80),
    last_name text not null check (char_length(last_name) between 1 and 80),
    email text not null check (char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
    phone text not null default '' check (phone = '' or phone ~ '^\+?[0-9 ()\.-]{7,32}$'),
    subject text not null check (subject in ('general','account','deposit','withdrawal','trading','security','bug','partnership','other')),
    message text not null check (char_length(message) between 10 and 5000),
    consent_at timestamptz not null default now(),
    status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
    created_at timestamptz not null default now()
);
create index support_requests_user_created_idx on public.support_requests(user_id, created_at desc);
alter table public.support_requests enable row level security;
revoke all on public.support_requests from anon, authenticated;
grant select on public.support_requests to authenticated;
grant all on public.support_requests to service_role;
create policy support_requests_owner_read on public.support_requests for select to authenticated using (user_id = auth.uid());

create or replace function public.submit_support_request(
    p_id uuid, p_first_name text, p_last_name text, p_email text,
    p_phone text, p_subject text, p_message text, p_consent boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := auth.uid();
begin
    if v_user is null then raise exception 'authentication_required'; end if;
    if p_consent is distinct from true then raise exception 'consent_required'; end if;
    -- Serialize per account so concurrent submissions cannot bypass the limit.
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 161200));
    if exists(select 1 from public.support_requests where id = p_id and user_id = v_user) then
        return p_id;
    end if;
    if (select count(*) from public.support_requests where user_id = v_user
        and created_at > now() - interval '1 hour') >= 5 then
        raise exception 'support_rate_limit';
    end if;
    insert into public.support_requests(id, user_id, first_name, last_name, email, phone, subject, message)
    values (p_id, v_user, btrim(p_first_name), btrim(p_last_name), lower(btrim(p_email)),
        btrim(coalesce(p_phone, '')), p_subject, btrim(p_message));
    return p_id;
end;
$$;
revoke all on function public.submit_support_request(uuid,text,text,text,text,text,text,boolean) from public, anon;
grant execute on function public.submit_support_request(uuid,text,text,text,text,text,text,boolean) to authenticated;
