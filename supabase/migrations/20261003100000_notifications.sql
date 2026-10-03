-- Notification centre. Three sources share one inbox on the customer side:
--   * public.notifications: one row per person, written by the system (trades, funding, account)
--     or by staff (a support agent writing to a customer about their ticket).
--   * public.announcements: one row per site-wide message, written by administrators, so a
--     broadcast never fans out into a row per customer. public.announcement_reads holds who has
--     read which announcement.
-- Customers only ever read their own rows; every write goes through a security definer function
-- below. Staff writes are capability-checked, rate limited and recorded in admin_audit_events.
-- Both tables join the realtime publication so open tabs hear new items as they are written.

-- ---------------------------------------------------------------- capabilities
-- notifications.send: write to one customer. A support agent may only write about a ticket
-- assigned to them, to the customer who opened it. announcements.manage: publish, schedule and
-- withdraw site-wide announcements. The rest of the registry is as 20260926100000 left it.
create or replace function admin_private.role_capabilities(p_role text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_role
    when 'support_agent' then array['staff.enter', 'support.read_assigned', 'support.reply', 'support.note', 'support.transition', 'customers.restrict.notice', 'notifications.send']
    when 'administrator' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'customers.read', 'operations.read', 'engine.read', 'engine.manage', 'contracts.read', 'customers.restrict.notice', 'customers.restrict.limit', 'customers.restrict.block', 'funding.read', 'notifications.send', 'announcements.manage']
    when 'owner' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'customers.read', 'operations.read', 'staff.manage', 'audit.read', 'engine.read', 'engine.manage', 'contracts.read', 'contracts.void', 'platform.enable_real', 'customers.restrict.notice', 'customers.restrict.limit', 'customers.restrict.block', 'customers.restrict.block_severe', 'funding.read', 'funding.manage', 'notifications.send', 'announcements.manage']
    else array[]::text[] end;
$$;

-- ---------------------------------------------------------------- tables
-- Links are same-site page paths only (for example "support.html" or "trade.html?index=SPI10"),
-- so no message can send a customer off the site.
create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    category text not null check (category in ('trade', 'funding', 'support', 'account', 'system')),
    title text not null check (char_length(btrim(title)) between 1 and 120),
    body text not null default '' check (char_length(body) <= 1000),
    link text check (link is null or link ~ '^[a-z0-9-]+\.html(\?[A-Za-z0-9=&_.-]{0,200})?$'),
    data jsonb not null default '{}'::jsonb,
    sent_by uuid,
    dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 200),
    created_at timestamptz not null default now(),
    read_at timestamptz,
    unique (user_id, dedupe_key)
);
create index notifications_user_created_idx on public.notifications(user_id, created_at desc, id desc);
create index notifications_user_unread_idx on public.notifications(user_id) where read_at is null;
create index notifications_sender_created_idx on public.notifications(sent_by, created_at) where sent_by is not null;

create table public.announcements (
    id uuid primary key,
    title text not null check (char_length(btrim(title)) between 1 and 120),
    body text not null check (char_length(btrim(body)) between 1 and 1000),
    link text check (link is null or link ~ '^[a-z0-9-]+\.html(\?[A-Za-z0-9=&_.-]{0,200})?$'),
    severity text not null default 'info' check (severity in ('info', 'important')),
    audience text not null default 'all' check (audience in ('all', 'real', 'practice')),
    starts_at timestamptz not null default now(),
    ends_at timestamptz,
    created_by uuid not null,
    created_at timestamptz not null default now(),
    withdrawn_at timestamptz,
    withdrawn_by uuid,
    check (ends_at is null or ends_at > starts_at)
);
create index announcements_live_idx on public.announcements(starts_at desc) where withdrawn_at is null;

create table public.announcement_reads (
    user_id uuid not null references auth.users(id) on delete cascade,
    announcement_id uuid not null references public.announcements(id) on delete cascade,
    read_at timestamptz not null default now(),
    primary key (user_id, announcement_id)
);
create index announcement_reads_announcement_idx on public.announcement_reads(announcement_id);

-- Whether an announcement is showing to the signed-in customer right now. Real and Practice
-- audiences follow the trading accounts the person holds.
create function public.announcement_visible(a public.announcements) returns boolean
language sql stable security definer set search_path = '' as $$
    select a.withdrawn_at is null and a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())
       and (a.audience = 'all' or exists (
            select 1 from public.trading_accounts t
             where t.user_id = auth.uid() and t.status = 'ACTIVE'
               and t.execution_mode = case a.audience when 'real' then 'REAL'::public.execution_mode else 'DEMO'::public.execution_mode end));
$$;
revoke all on function public.announcement_visible(public.announcements) from public, anon;
grant execute on function public.announcement_visible(public.announcements) to authenticated;

alter table public.notifications enable row level security;
alter table public.announcements enable row level security;
alter table public.announcement_reads enable row level security;
create policy notifications_owner_read on public.notifications for select to authenticated using (user_id = auth.uid());
create policy announcements_visible_read on public.announcements for select to authenticated using (public.announcement_visible(announcements));
create policy announcement_reads_owner_read on public.announcement_reads for select to authenticated using (user_id = auth.uid());
revoke all on public.notifications, public.announcements, public.announcement_reads from public, anon, authenticated;
grant select on public.notifications, public.announcements, public.announcement_reads to authenticated;

-- ---------------------------------------------------------------- writing
-- The one way rows reach a customer's inbox. Returns the row id, or the existing row's id when the
-- same dedupe key was already delivered, so producers can retry safely. Not granted to clients.
create function admin_private.deliver_notification(p_user_id uuid, p_category text, p_title text, p_body text,
    p_link text default null, p_data jsonb default '{}'::jsonb, p_sent_by uuid default null, p_dedupe_key text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
    insert into public.notifications(user_id, category, title, body, link, data, sent_by, dedupe_key)
    values (p_user_id, p_category, btrim(p_title), coalesce(btrim(p_body), ''), nullif(btrim(p_link), ''), coalesce(p_data, '{}'::jsonb), p_sent_by, p_dedupe_key)
    on conflict (user_id, dedupe_key) do nothing
    returning id into v_id;
    if v_id is null then
        select id into v_id from public.notifications where user_id = p_user_id and dedupe_key = p_dedupe_key;
    end if;
    return v_id;
end;
$$;
revoke all on function admin_private.deliver_notification(uuid, text, text, text, text, jsonb, uuid, text) from public, anon, authenticated;

-- A staff reply on a ticket tells its customer. Internal notes live in another table and never
-- reach here. The notification must never stop the reply itself, so a failure is swallowed.
create function admin_private.notify_support_reply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ticket public.support_requests;
begin
    if new.author_kind <> 'staff' then return new; end if;
    select * into v_ticket from public.support_requests where id = new.ticket_id;
    if not found then return new; end if;
    begin
        perform admin_private.deliver_notification(v_ticket.user_id, 'support',
            format('Support replied on SP-%s', v_ticket.ticket_number),
            left(new.body, 280), 'support.html',
            jsonb_build_object('ticket_id', v_ticket.id, 'reference', 'SP-' || v_ticket.ticket_number),
            new.author_id, 'support-reply:' || new.id::text);
    exception when others then
        raise warning 'support reply notification failed for message %: %', new.id, sqlerrm;
    end;
    return new;
end;
$$;
create trigger support_messages_notify after insert on public.support_messages
    for each row execute function admin_private.notify_support_reply();

-- ---------------------------------------------------------------- customer RPCs
-- The inbox: live announcements first (newest first), then personal notifications, a page at a
-- time. unread counts both.
create function public.list_my_notifications(p_before timestamptz default null, p_limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    return jsonb_build_object(
        'announcements', coalesce((
            select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'link', a.link,
                    'severity', a.severity, 'created_at', a.starts_at, 'read', r.user_id is not null) order by a.starts_at desc)
              from public.announcements a
              left join public.announcement_reads r on r.announcement_id = a.id and r.user_id = v_user
             where public.announcement_visible(a)), '[]'::jsonb),
        'notifications', coalesce((
            select jsonb_agg(item order by item.created_at desc, item.id desc) from (
                select n.id, n.category, n.title, n.body, n.link, n.data, n.created_at, n.read_at is not null as read,
                       n.sent_by is not null as from_staff
                  from public.notifications n
                 where n.user_id = v_user and (p_before is null or n.created_at < p_before)
                 order by n.created_at desc, n.id desc limit v_limit) item), '[]'::jsonb),
        'unread', public.get_notification_unread_count());
end;
$$;

create function public.get_notification_unread_count() returns integer
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    return (select count(*) from public.notifications where user_id = v_user and read_at is null)
         + (select count(*) from public.announcements a
             where public.announcement_visible(a)
               and not exists (select 1 from public.announcement_reads r where r.announcement_id = a.id and r.user_id = v_user));
end;
$$;

-- Marks the given items read, or everything showing when p_all. Returns the new unread count.
create function public.mark_notifications_read(p_notification_ids uuid[] default null, p_announcement_ids uuid[] default null, p_all boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid();
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    if coalesce(array_length(p_notification_ids, 1), 0) > 200 or coalesce(array_length(p_announcement_ids, 1), 0) > 200 then raise exception 'validation_failed'; end if;
    update public.notifications set read_at = now()
     where user_id = v_user and read_at is null and (coalesce(p_all, false) or id = any(coalesce(p_notification_ids, '{}')));
    insert into public.announcement_reads(user_id, announcement_id)
    select v_user, a.id from public.announcements a
     where public.announcement_visible(a) and (coalesce(p_all, false) or a.id = any(coalesce(p_announcement_ids, '{}')))
    on conflict do nothing;
    return public.get_notification_unread_count();
end;
$$;

revoke all on function public.list_my_notifications(timestamptz, integer) from public, anon;
revoke all on function public.get_notification_unread_count() from public, anon;
revoke all on function public.mark_notifications_read(uuid[], uuid[], boolean) from public, anon;
grant execute on function public.list_my_notifications(timestamptz, integer) to authenticated;
grant execute on function public.get_notification_unread_count() to authenticated;
grant execute on function public.mark_notifications_read(uuid[], uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------- staff RPCs
create function admin_private.notification_text(p_title text, p_body text, p_link text) returns void
language plpgsql immutable set search_path = '' as $$
begin
    if char_length(btrim(coalesce(p_title, ''))) not between 1 and 120
       or char_length(btrim(coalesce(p_body, ''))) not between 1 and 1000
       or (nullif(btrim(p_link), '') is not null and btrim(p_link) !~ '^[a-z0-9-]+\.html(\?[A-Za-z0-9=&_.-]{0,200})?$') then
        raise exception 'validation_failed';
    end if;
end;
$$;

create function admin_private.notification_audit(p_action text, p_target_type text, p_target uuid, p_reason text, p_after jsonb) returns void
language sql security definer set search_path = '' as $$
    insert into public.admin_audit_events(actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state)
    values (auth.uid(), 'staff', p_action, p_target_type, p_target, gen_random_uuid(), btrim(p_reason), p_after);
$$;

-- Writes to one customer. p_request_id makes a retried send deliver once. A support agent must name
-- a ticket assigned to them, opened by this customer; anyone may attach a ticket, which must belong
-- to the customer. At most 30 sends per staff member per hour.
create function public.staff_send_notification(p_user_id uuid, p_title text, p_body text, p_link text, p_ticket_id uuid, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_staff public.staff_roles; v_ticket public.support_requests; v_id uuid; v_key text := 'staff:' || p_request_id::text;
begin
    v_staff := admin_private.require_staff('notifications.send');
    perform admin_private.notification_text(p_title, p_body, p_link);
    if p_user_id is null or p_request_id is null or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then raise exception 'validation_failed'; end if;
    select id into v_id from public.notifications where user_id = p_user_id and dedupe_key = v_key;
    if found then return jsonb_build_object('id', v_id, 'duplicate', true); end if;
    if p_ticket_id is not null then
        select * into v_ticket from public.support_requests where id = p_ticket_id;
        if not found or v_ticket.user_id <> p_user_id then raise exception 'not_found'; end if;
    end if;
    if v_staff.role = 'support_agent' and (v_ticket.id is null or v_ticket.assignee_id is distinct from auth.uid()) then raise exception 'forbidden'; end if;
    if not exists (select 1 from auth.users where id = p_user_id) or exists (select 1 from public.staff_roles where user_id = p_user_id and active) then raise exception 'not_found'; end if;
    if (select count(*) from public.notifications where sent_by = auth.uid() and created_at > now() - interval '1 hour') >= 30 then raise exception 'rate_limited'; end if;
    v_id := admin_private.deliver_notification(p_user_id, 'support', p_title, p_body, coalesce(nullif(btrim(p_link), ''), case when v_ticket.id is not null then 'support.html' end),
        case when v_ticket.id is null then '{}'::jsonb else jsonb_build_object('ticket_id', v_ticket.id, 'reference', 'SP-' || v_ticket.ticket_number) end,
        auth.uid(), v_key);
    perform admin_private.notification_audit('notification.send', 'customer', p_user_id, p_reason,
        jsonb_build_object('notification_id', v_id, 'ticket_id', v_ticket.id, 'title', btrim(p_title)));
    return jsonb_build_object('id', v_id, 'duplicate', false);
end;
$$;

-- How many customers an audience reaches now, for the confirmation before publishing.
create function public.staff_announcement_audience_count(p_audience text) returns integer
language plpgsql stable security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('announcements.manage');
    if p_audience not in ('all', 'real', 'practice') then raise exception 'validation_failed'; end if;
    return (select count(distinct u.id) from auth.users u
             where not exists (select 1 from public.staff_roles s where s.user_id = u.id and s.active)
               and (p_audience = 'all' or exists (select 1 from public.trading_accounts t where t.user_id = u.id and t.status = 'ACTIVE'
                    and t.execution_mode = case p_audience when 'real' then 'REAL'::public.execution_mode else 'DEMO'::public.execution_mode end)));
end;
$$;

-- Publishes now, or schedules when p_starts_at is in the future. Needs a fresh second factor. The
-- request id is the announcement id, so a retried publish creates one announcement. At most 20 a day.
create function public.staff_publish_announcement(p_title text, p_body text, p_link text, p_severity text, p_audience text,
    p_starts_at timestamptz, p_ends_at timestamptz, p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz := greatest(coalesce(p_starts_at, now()), now());
begin
    perform admin_private.require_staff('announcements.manage', true);
    perform admin_private.notification_text(p_title, p_body, p_link);
    if p_request_id is null or p_severity not in ('info', 'important') or p_audience not in ('all', 'real', 'practice')
       or (p_ends_at is not null and p_ends_at <= v_start) or v_start > now() + interval '90 days'
       or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then raise exception 'validation_failed'; end if;
    if exists (select 1 from public.announcements where id = p_request_id) then
        return jsonb_build_object('id', p_request_id, 'duplicate', true);
    end if;
    if (select count(*) from public.announcements where created_at > now() - interval '1 day') >= 20 then raise exception 'rate_limited'; end if;
    insert into public.announcements(id, title, body, link, severity, audience, starts_at, ends_at, created_by)
    values (p_request_id, btrim(p_title), btrim(p_body), nullif(btrim(p_link), ''), p_severity, p_audience, v_start, p_ends_at, auth.uid());
    perform admin_private.notification_audit('announcement.publish', 'announcement', p_request_id, p_reason,
        jsonb_build_object('title', btrim(p_title), 'severity', p_severity, 'audience', p_audience, 'starts_at', v_start, 'ends_at', p_ends_at));
    return jsonb_build_object('id', p_request_id, 'duplicate', false, 'starts_at', v_start);
end;
$$;

create function public.staff_withdraw_announcement(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('announcements.manage', true);
    if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then raise exception 'validation_failed'; end if;
    update public.announcements set withdrawn_at = now(), withdrawn_by = auth.uid() where id = p_id and withdrawn_at is null;
    if not found then raise exception 'not_found'; end if;
    perform admin_private.notification_audit('announcement.withdraw', 'announcement', p_id, p_reason, null);
end;
$$;

-- Every announcement, newest first, with its state and how many people have read it.
create function public.staff_list_announcements(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('announcements.manage');
    return coalesce((select jsonb_agg(item order by item.created_at desc) from (
        select a.id, a.title, a.body, a.link, a.severity, a.audience, a.starts_at, a.ends_at, a.created_at, a.withdrawn_at,
               case when a.withdrawn_at is not null then 'withdrawn' when a.starts_at > now() then 'scheduled'
                    when a.ends_at is not null and a.ends_at <= now() then 'ended' else 'live' end as state,
               (select count(*) from public.announcement_reads r where r.announcement_id = a.id) as reads
          from public.announcements a order by a.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) item), '[]'::jsonb);
end;
$$;

revoke all on function public.staff_send_notification(uuid, text, text, text, uuid, text, uuid) from public, anon;
revoke all on function public.staff_announcement_audience_count(text) from public, anon;
revoke all on function public.staff_publish_announcement(text, text, text, text, text, timestamptz, timestamptz, text, uuid) from public, anon;
revoke all on function public.staff_withdraw_announcement(uuid, text) from public, anon;
revoke all on function public.staff_list_announcements(integer) from public, anon;
grant execute on function public.staff_send_notification(uuid, text, text, text, uuid, text, uuid) to authenticated;
grant execute on function public.staff_announcement_audience_count(text) to authenticated;
grant execute on function public.staff_publish_announcement(text, text, text, text, text, timestamptz, timestamptz, text, uuid) to authenticated;
grant execute on function public.staff_withdraw_announcement(uuid, text) to authenticated;
grant execute on function public.staff_list_announcements(integer) to authenticated;

-- ---------------------------------------------------------------- retention and realtime
-- Read notifications go after 90 days and unread ones after 180; ended announcements after a year.
create function admin_private.purge_notifications() returns void
language sql security definer set search_path = '' as $$
    delete from public.notifications where (read_at is not null and created_at < now() - interval '90 days') or created_at < now() - interval '180 days';
    delete from public.announcements where coalesce(withdrawn_at, ends_at) < now() - interval '1 year';
$$;
revoke all on function admin_private.purge_notifications() from public, anon, authenticated;

do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.unschedule(jobid) from cron.job where jobname = 'notifications-purge';
        perform cron.schedule('notifications-purge', '30 3 * * *', 'select admin_private.purge_notifications()');
    end if;
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        raise exception 'The supabase_realtime publication is required for notification events';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
        alter publication supabase_realtime add table public.notifications;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'announcements') then
        alter publication supabase_realtime add table public.announcements;
    end if;
end;
$$;
