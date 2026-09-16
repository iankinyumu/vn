-- Keep UUIDs internal; assign permanent, unique, human-readable ticket numbers.
alter table public.support_requests add column ticket_number bigint generated always as identity (start with 1001);
alter table public.support_requests add constraint support_requests_ticket_number_key unique (ticket_number);
create or replace function public.submit_support_ticket(
    p_id uuid, p_first_name text, p_last_name text, p_email text,
    p_phone text, p_subject text, p_message text, p_consent boolean
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_number bigint;
begin
    v_id := public.submit_support_request(p_id,p_first_name,p_last_name,p_email,p_phone,p_subject,p_message,p_consent);
    select ticket_number into strict v_number from public.support_requests where id = v_id;
    return jsonb_build_object('id',v_id,'reference','SP-' || v_number::text);
end;
$$;
revoke all on function public.submit_support_ticket(uuid,text,text,text,text,text,text,boolean) from public, anon;
grant execute on function public.submit_support_ticket(uuid,text,text,text,text,text,text,boolean) to authenticated;
