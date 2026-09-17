-- Phase 2. Preserve ticket UUIDs, references and the original message in place.
alter table public.support_requests drop constraint support_requests_status_check;
alter table public.support_requests add constraint support_requests_status_check
    check (status in ('open','in_progress','waiting_for_customer','resolved','closed'));
alter table public.support_requests
    add column assignee_id uuid references public.staff_roles(user_id) on delete restrict,
    add column version bigint not null default 1,
    add column last_activity timestamptz not null default now(),
    add column public_sequence bigint not null default 0,
    add column escalated boolean not null default false,
    add column resolved_at timestamptz;
update public.support_requests set last_activity = created_at;
create index support_requests_activity_idx on public.support_requests(last_activity desc, id desc);
create index support_requests_assignee_idx on public.support_requests(assignee_id, last_activity desc, id desc);
create index support_requests_owner_activity_idx on public.support_requests(user_id, last_activity desc, id desc);
create index support_requests_status_activity_idx on public.support_requests(status, last_activity desc, id desc);
-- Retain the legacy customer's approved columns without exposing new staff-only metadata.
revoke select on public.support_requests from authenticated;
grant select(id,user_id,first_name,last_name,email,phone,subject,message,status,created_at,consent_at,ticket_number)
    on public.support_requests to authenticated;
revoke insert, update, delete, truncate on public.support_requests from service_role;

create table public.support_messages (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.support_requests(id) on delete cascade,
    sequence bigint not null check (sequence > 0),
    author_id uuid not null,
    author_kind text not null check (author_kind in ('customer','staff')),
    body text not null check (char_length(body) between 1 and 5000),
    created_at timestamptz not null default now(),
    unique(ticket_id,sequence)
);
create table public.support_internal_notes (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.support_requests(id) on delete cascade,
    author_id uuid not null,
    body text not null check (char_length(body) between 1 and 5000),
    created_at timestamptz not null default now()
);
create index support_notes_ticket_idx on public.support_internal_notes(ticket_id,created_at desc,id desc);
create table public.support_events (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.support_requests(id) on delete cascade,
    actor_id uuid,
    kind text not null,
    changes jsonb not null,
    created_at timestamptz not null default now()
);
create index support_events_ticket_idx on public.support_events(ticket_id,created_at desc,id desc);
create table public.support_read_markers (
    ticket_id uuid not null references public.support_requests(id) on delete cascade,
    viewer_id uuid not null references auth.users(id) on delete cascade,
    sequence bigint not null check(sequence >= 0),
    primary key(ticket_id,viewer_id)
);
create table admin_private.support_receipts (
    actor_id uuid not null,
    request_id uuid not null,
    ticket_id uuid not null references public.support_requests(id) on delete cascade,
    action text not null,
    fingerprint text not null,
    response jsonb not null,
    created_at timestamptz not null default now(),
    primary key(actor_id,request_id)
);
create index support_receipts_actor_time_idx on admin_private.support_receipts(actor_id,created_at);
create table admin_private.support_read_limits (
    actor_id uuid primary key,
    window_start timestamptz not null,
    used integer not null
);
alter table public.support_messages enable row level security;
alter table public.support_internal_notes enable row level security;
alter table public.support_events enable row level security;
alter table public.support_read_markers enable row level security;
revoke all on public.support_messages,public.support_internal_notes,public.support_events,public.support_read_markers
    from public,anon,authenticated,service_role;

create function admin_private.support_read_limit() returns void
language plpgsql security definer set search_path = '' as $$
declare v_used integer;
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    insert into admin_private.support_read_limits(actor_id,window_start,used) values(auth.uid(),now(),1)
    on conflict(actor_id) do update set
        used = case when support_read_limits.window_start <= now() - interval '1 minute' then 1 else support_read_limits.used+1 end,
        window_start = case when support_read_limits.window_start <= now() - interval '1 minute' then now() else support_read_limits.window_start end
    returning used into v_used;
    if v_used > 120 then raise exception 'rate_limited'; end if;
end;
$$;

create function admin_private.support_access(p_ticket_id uuid, p_staff boolean)
returns public.support_requests language plpgsql security definer set search_path = '' as $$
declare v_ticket public.support_requests; v_role public.staff_roles;
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    if p_staff is null then raise exception 'validation_failed'; end if;
    if p_staff then v_role := admin_private.require_staff('staff.enter'); end if;
    select * into v_ticket from public.support_requests where id=p_ticket_id;
    if not found then raise exception 'not_found'; end if;
    if p_staff then
        if v_role.role='support_agent' and v_ticket.assignee_id is distinct from auth.uid() then raise exception 'not_found'; end if;
    elsif v_ticket.user_id <> auth.uid() then raise exception 'not_found'; end if;
    return v_ticket;
end;
$$;

create function admin_private.ticket_summary(t public.support_requests, p_staff boolean) returns jsonb
language sql stable set search_path = '' as $$
    select jsonb_build_object('id',t.id,'reference','SP-'||t.ticket_number::text,'subject',t.subject,
        'status',t.status,'version',t.version,'last_activity',t.last_activity,'created_at',t.created_at,
        'public_sequence',t.public_sequence,'unread',t.public_sequence > coalesce((select sequence from public.support_read_markers where ticket_id=t.id and viewer_id=auth.uid()),-1))
    || case when p_staff then jsonb_build_object('customer_name',t.first_name||' '||t.last_name,'assignee_id',t.assignee_id,'escalated',t.escalated) else '{}'::jsonb end;
$$;

create function public.list_support_tickets(p_staff boolean default false,p_status text default null,
    p_subject text default null,p_reference text default null,p_assignee uuid default null,p_unassigned boolean default false,
    p_before_time timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role public.staff_roles; v_items jsonb; v_next jsonb;
begin
    perform admin_private.support_read_limit();
    if p_staff is null or p_unassigned is null or (p_before_time is null) <> (p_before_id is null)
       or char_length(coalesce(p_reference,'')) > 30
       or (p_reference is not null and p_reference !~ '^SP-[0-9]+$')
       or (p_status is not null and p_status not in ('open','in_progress','waiting_for_customer','resolved','closed'))
       or (p_subject is not null and p_subject not in ('general','account','deposit','withdrawal','trading','security','bug','partnership','other')) then
        raise exception 'validation_failed'; end if;
    if p_staff then v_role := admin_private.require_staff('staff.enter'); end if;
    if (not p_staff or v_role.role='support_agent') and (p_assignee is not null or p_unassigned) then raise exception 'forbidden'; end if;
    with selected as (
        select t.* from public.support_requests t
        where (case when not p_staff then t.user_id=auth.uid() when v_role.role='support_agent' then t.assignee_id=auth.uid() else true end)
        and (p_status is null or t.status=p_status) and (p_subject is null or t.subject=p_subject)
        and (p_reference is null or 'SP-'||t.ticket_number::text=p_reference)
        and (p_assignee is null or t.assignee_id=p_assignee) and (not p_unassigned or t.assignee_id is null)
        and (p_before_time is null or (t.last_activity,t.id)<(p_before_time,p_before_id))
        order by t.last_activity desc,t.id desc limit 26
    ), page as (select * from selected order by last_activity desc,id desc limit 25)
    select coalesce(jsonb_agg(admin_private.ticket_summary(page::public.support_requests,p_staff) order by last_activity desc,id desc),'[]'::jsonb),
        case when (select count(*) from selected)>25 then
            (select jsonb_build_object('time',last_activity,'id',id) from page order by last_activity,id limit 1) else null end
    into v_items,v_next from page;
    return jsonb_build_object('items',v_items,'next',v_next);
end;
$$;

create function public.get_support_ticket(p_ticket_id uuid,p_staff boolean default false,p_before_sequence bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ticket public.support_requests; v_items jsonb; v_next bigint;
begin
    perform admin_private.support_read_limit();
    v_ticket := admin_private.support_access(p_ticket_id,p_staff);
    if p_before_sequence is not null and (p_before_sequence < 0 or p_before_sequence > v_ticket.public_sequence+1) then raise exception 'validation_failed'; end if;
    -- The original message remains authoritative in support_requests and is projected once at sequence 0.
    with conversation as (
        select v_ticket.id id,0::bigint sequence,'customer'::text author_kind,v_ticket.message body,v_ticket.created_at created_at
        union all select m.id,m.sequence,m.author_kind,m.body,m.created_at from public.support_messages m where m.ticket_id=p_ticket_id
    ), selected as (
        select * from conversation where p_before_sequence is null or sequence<p_before_sequence order by sequence desc limit 51
    ), page as (select * from selected order by sequence desc limit 50)
    select coalesce(jsonb_agg(to_jsonb(page) order by sequence),'[]'::jsonb),
        case when (select count(*) from selected)>50 then min(sequence) else null end
    into v_items,v_next from page;
    return jsonb_build_object('ticket',admin_private.ticket_summary(v_ticket,p_staff),'messages',v_items,'next',v_next)
        || case when p_staff then jsonb_build_object('contact',jsonb_build_object('name',v_ticket.first_name||' '||v_ticket.last_name,
            'email',v_ticket.email,'phone',v_ticket.phone,'notice','Contact preference supplied by customer; not verified account identity.')) else '{}'::jsonb end;
end;
$$;

create function public.list_support_activity(p_ticket_id uuid,p_before_time timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_items jsonb; v_next jsonb;
begin
    perform admin_private.support_read_limit();
    perform admin_private.support_access(p_ticket_id,true);
    if (p_before_time is null) <> (p_before_id is null) then raise exception 'validation_failed'; end if;
    with activity as (
        select id,created_at,author_id actor_id,'note'::text kind,jsonb_build_object('body',body) detail from public.support_internal_notes where ticket_id=p_ticket_id
        union all select id,created_at,actor_id,kind,changes from public.support_events where ticket_id=p_ticket_id
    ), selected as (
        select * from activity where p_before_time is null or (created_at,id)<(p_before_time,p_before_id) order by created_at desc,id desc limit 51
    ), page as (select * from selected order by created_at desc,id desc limit 50)
    select coalesce(jsonb_agg(to_jsonb(page) order by created_at desc,id desc),'[]'::jsonb),
        case when (select count(*) from selected)>50 then (select jsonb_build_object('time',created_at,'id',id) from page order by created_at,id limit 1) else null end
    into v_items,v_next from page;
    return jsonb_build_object('items',v_items,'next',v_next);
end;
$$;

create function public.list_support_assignees() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
    perform admin_private.support_read_limit();
    perform admin_private.require_staff('support.assign');
    -- Initial staff model has no approved public display-name field; never return Auth emails.
    return (select coalesce(jsonb_agg(jsonb_build_object('id',user_id,'role',role) order by role,user_id),'[]'::jsonb)
        from (select user_id,role from public.staff_roles where active order by role,user_id limit 100) eligible);
end;
$$;

create function public.get_support_summary() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_role public.staff_roles;
begin
    perform admin_private.support_read_limit();
    v_role := admin_private.require_staff('staff.enter');
    return (select jsonb_build_object('received',count(*) filter(where status='open'),
        'unassigned',case when v_role.role='support_agent' then null else count(*) filter(where assignee_id is null and status not in ('resolved','closed')) end,
        'waiting',count(*) filter(where status='waiting_for_customer'),
        'assigned_to_me',count(*) filter(where assignee_id=auth.uid() and status not in ('resolved','closed')),
        'resolved_last_7_days',count(*) filter(where status in ('resolved','closed') and resolved_at>=now()-interval '7 days'),
        'window_start',now()-interval '7 days','observed_at',now(),'timezone','UTC')
        from public.support_requests where v_role.role<>'support_agent' or assignee_id=auth.uid());
end;
$$;

create function admin_private.mutate_support(p_ticket_id uuid,p_action text,p_body text,p_status text,p_assignee uuid,
    p_reason text,p_expected_version bigint,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_ticket public.support_requests; v_old public.support_requests; v_role public.staff_roles;
    v_staff boolean := p_action<>'customer_reply'; v_prior admin_private.support_receipts;
    v_hash text; v_response jsonb; v_message uuid; v_note uuid; v_limit integer;
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    if p_action is null or p_action not in ('customer_reply','staff_reply','note','status','assign','escalate')
       or p_request_id is null or p_expected_version is null then raise exception 'validation_failed'; end if;
    p_body := btrim(coalesce(p_body,'')); p_reason := btrim(coalesce(p_reason,''));
    if char_length(p_body)>5000 or char_length(p_reason)>500 then raise exception 'validation_failed'; end if;
    -- Consistent order: staff access gate -> per-actor rate/idempotency lock -> ticket lock.
    perform 1 from admin_private.access_lock where singleton for share;
    perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,171100));
    select * into v_ticket from public.support_requests where id=p_ticket_id for update;
    v_ticket := admin_private.support_access(p_ticket_id,v_staff);
    if v_staff then v_role := admin_private.require_staff('staff.enter'); end if;
    if p_action='assign' then perform admin_private.require_staff('support.assign'); end if;
    v_hash := md5(jsonb_build_array(p_ticket_id,p_action,p_body,p_status,p_assignee,p_reason,p_expected_version)::text);
    select * into v_prior from admin_private.support_receipts where actor_id=auth.uid() and request_id=p_request_id;
    if found then
        if v_prior.fingerprint<>v_hash then raise exception 'conflict'; end if;
        return v_prior.response;
    end if;
    if v_ticket.version<>p_expected_version then raise exception 'conflict'; end if;
    v_limit := case when p_action in ('customer_reply','staff_reply') then 30 when p_action in ('note','escalate') then 60 else 120 end;
    if (select count(*) from admin_private.support_receipts where actor_id=auth.uid() and action=p_action and created_at>now()-interval '1 hour')>=v_limit then raise exception 'rate_limited'; end if;
    v_old := v_ticket;
    if p_action in ('customer_reply','staff_reply') then
        if p_body='' then raise exception 'validation_failed'; end if;
        if v_ticket.status='closed' then raise exception 'invalid_transition'; end if;
        if p_action='customer_reply' then
            if v_ticket.status='resolved' then
                if p_status is distinct from 'in_progress' then raise exception 'invalid_transition'; end if;
                v_ticket.status := 'in_progress';
            elsif p_status is not null then raise exception 'invalid_transition';
            elsif v_ticket.status='waiting_for_customer' then v_ticket.status := 'in_progress'; end if;
        else
            if v_ticket.status='resolved' then raise exception 'invalid_transition'; end if;
            if p_status is not null then
                if p_status not in ('waiting_for_customer','resolved') then raise exception 'invalid_transition'; end if;
                v_ticket.status := p_status;
            end if;
        end if;
    elsif p_action='status' then
        if p_status is null or not (
            (v_ticket.status='open' and p_status='in_progress') or
            (v_ticket.status='waiting_for_customer' and p_status='in_progress') or
            (v_ticket.status in ('open','in_progress') and p_status='waiting_for_customer') or
            (v_ticket.status in ('open','in_progress','waiting_for_customer') and p_status='resolved') or
            (v_ticket.status in ('resolved','closed') and p_status='in_progress') or
            (v_ticket.status='resolved' and p_status='closed')) then raise exception 'invalid_transition'; end if;
        if v_ticket.status='closed' or p_status='closed' then perform admin_private.require_staff('support.close'); end if;
        if (v_ticket.status in ('resolved','closed') or p_status='closed') and char_length(p_reason)<3 then raise exception 'validation_failed'; end if;
        if p_status in ('waiting_for_customer','resolved') and p_body='' then raise exception 'validation_failed'; end if;
        v_ticket.status := p_status;
    elsif p_action='assign' then
        if p_assignee is not null and not exists(select 1 from public.staff_roles where user_id=p_assignee and active) then raise exception 'validation_failed'; end if;
        v_ticket.assignee_id := p_assignee; v_ticket.escalated := false;
    elsif p_action in ('note','escalate') then
        if p_body='' then raise exception 'validation_failed'; end if;
        insert into public.support_internal_notes(ticket_id,author_id,body) values(p_ticket_id,auth.uid(),p_body) returning id into v_note;
        if p_action='escalate' then v_ticket.escalated := true; end if;
    end if;
    if p_body<>'' and p_action in ('customer_reply','staff_reply','status') then
        v_ticket.public_sequence := v_ticket.public_sequence+1;
        insert into public.support_messages(ticket_id,sequence,author_id,author_kind,body)
        values(p_ticket_id,v_ticket.public_sequence,auth.uid(),case when v_staff then 'staff' else 'customer' end,p_body) returning id into v_message;
    end if;
    update public.support_requests set status=v_ticket.status,assignee_id=v_ticket.assignee_id,escalated=v_ticket.escalated,
        public_sequence=v_ticket.public_sequence,version=version+1,last_activity=clock_timestamp(),
        resolved_at=case when v_ticket.status='resolved' and v_old.status<>'resolved' then now()
            when v_ticket.status in ('resolved','closed') then resolved_at else null end
        where id=p_ticket_id returning * into v_ticket;
    if v_old.status<>v_ticket.status then
        insert into public.support_events(ticket_id,actor_id,kind,changes) values(p_ticket_id,auth.uid(),'status',
            jsonb_build_object('from',v_old.status,'to',v_ticket.status,'reason',p_reason));
    end if;
    if p_action='assign' then
        insert into public.support_events(ticket_id,actor_id,kind,changes) values(p_ticket_id,auth.uid(),'assignment',
            jsonb_build_object('from',v_old.assignee_id,'to',v_ticket.assignee_id,'reason',p_reason));
    elsif p_action='escalate' then
        insert into public.support_events(ticket_id,actor_id,kind,changes) values(p_ticket_id,auth.uid(),'escalation',jsonb_build_object('escalated',true,'note_id',v_note));
    end if;
    if v_staff then
        insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,before_state,after_state)
        values(auth.uid(),'staff','support.'||p_action,'ticket',p_ticket_id,p_request_id,
            case when p_reason='' then 'Support '||p_action else p_reason end,
            jsonb_build_object('status',v_old.status,'assignee_id',v_old.assignee_id,'version',v_old.version),
            jsonb_build_object('status',v_ticket.status,'assignee_id',v_ticket.assignee_id,'version',v_ticket.version,'message_id',v_message,'note_id',v_note));
    end if;
    v_response := jsonb_build_object('id',p_ticket_id,'version',v_ticket.version,'status',v_ticket.status,'message_id',v_message,'note_id',v_note);
    insert into admin_private.support_receipts(actor_id,request_id,ticket_id,action,fingerprint,response)
    values(auth.uid(),p_request_id,p_ticket_id,p_action,v_hash,v_response);
    return v_response;
end;
$$;

create function public.send_support_reply(p_ticket_id uuid,p_body text,p_expected_version bigint,p_request_id uuid,p_staff boolean default false,p_status text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    if p_staff is null then raise exception 'validation_failed'; end if;
    return admin_private.mutate_support(p_ticket_id,case when p_staff then 'staff_reply' else 'customer_reply' end,p_body,p_status,null,null,p_expected_version,p_request_id);
end;
$$;
create function public.add_support_note(p_ticket_id uuid,p_body text,p_expected_version bigint,p_request_id uuid,p_escalate boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    if p_escalate is null then raise exception 'validation_failed'; end if;
    return admin_private.mutate_support(p_ticket_id,case when p_escalate then 'escalate' else 'note' end,p_body,null,null,null,p_expected_version,p_request_id);
end;
$$;
create function public.assign_support_ticket(p_ticket_id uuid,p_assignee uuid,p_expected_version bigint,p_request_id uuid,p_reason text default '')
returns jsonb language sql security definer set search_path = '' as $$
    select admin_private.mutate_support(p_ticket_id,'assign',null,null,p_assignee,p_reason,p_expected_version,p_request_id);
$$;
create function public.change_support_status(p_ticket_id uuid,p_status text,p_body text,p_reason text,p_expected_version bigint,p_request_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
    select admin_private.mutate_support(p_ticket_id,'status',p_body,p_status,null,p_reason,p_expected_version,p_request_id);
$$;
create function public.mark_support_read(p_ticket_id uuid,p_sequence bigint,p_staff boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare v_ticket public.support_requests;
begin
    v_ticket := admin_private.support_access(p_ticket_id,p_staff);
    if p_sequence is null or p_sequence<0 or p_sequence>v_ticket.public_sequence then raise exception 'validation_failed'; end if;
    insert into public.support_read_markers values(p_ticket_id,auth.uid(),p_sequence)
    on conflict(ticket_id,viewer_id) do update set sequence=greatest(support_read_markers.sequence,excluded.sequence);
end;
$$;

create function admin_private.unassign_ineligible_staff() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ticket public.support_requests;
begin
    if (old.active and not new.active) or old.role<>new.role then
        for v_ticket in select * from public.support_requests where assignee_id=new.user_id order by id for update loop
            update public.support_requests set assignee_id=null,version=version+1,last_activity=clock_timestamp() where id=v_ticket.id;
            insert into public.support_events(ticket_id,actor_id,kind,changes) values(v_ticket.id,auth.uid(),'assignment',
                jsonb_build_object('from',new.user_id,'to',null,'reason','Staff eligibility changed'));
            insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,before_state,after_state)
            values(auth.uid(),case when auth.uid() is null then 'operator' else 'staff' end,'support.unassign_revoked','ticket',v_ticket.id,
                gen_random_uuid(),'Staff eligibility changed',jsonb_build_object('assignee_id',new.user_id),jsonb_build_object('assignee_id',null));
        end loop;
    end if;
    return new;
end;
$$;
create trigger staff_support_unassignment after update on public.staff_roles for each row execute function admin_private.unassign_ineligible_staff();

revoke all on all tables in schema admin_private from public,anon,authenticated,service_role;
revoke all on all functions in schema admin_private from public,anon,authenticated,service_role;
revoke all on function public.list_support_tickets(boolean,text,text,text,uuid,boolean,timestamptz,uuid),
    public.get_support_ticket(uuid,boolean,bigint),public.list_support_activity(uuid,timestamptz,uuid),
    public.list_support_assignees(),public.get_support_summary(),public.send_support_reply(uuid,text,bigint,uuid,boolean,text),
    public.add_support_note(uuid,text,bigint,uuid,boolean),public.assign_support_ticket(uuid,uuid,bigint,uuid,text),
    public.change_support_status(uuid,text,text,text,bigint,uuid),public.mark_support_read(uuid,bigint,boolean)
    from public,anon,service_role;
grant execute on function public.list_support_tickets(boolean,text,text,text,uuid,boolean,timestamptz,uuid),
    public.get_support_ticket(uuid,boolean,bigint),public.list_support_activity(uuid,timestamptz,uuid),
    public.list_support_assignees(),public.get_support_summary(),public.send_support_reply(uuid,text,bigint,uuid,boolean,text),
    public.add_support_note(uuid,text,bigint,uuid,boolean),public.assign_support_ticket(uuid,uuid,bigint,uuid,text),
    public.change_support_status(uuid,text,text,text,bigint,uuid),public.mark_support_read(uuid,bigint,boolean)
    to authenticated;
