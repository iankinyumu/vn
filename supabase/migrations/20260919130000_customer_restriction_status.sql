-- Migration: 20260919130000_customer_restriction_status.sql
-- Customer-facing read of active account restrictions. public.account_restrictions
-- is revoked from anon/authenticated/service_role, so this SECURITY DEFINER
-- function is the only path a customer has to see why they were restricted.
--
-- The function has no user_id parameter on purpose: it is hard-scoped to
-- auth.uid(), so there is no call shape that can read another customer's rows.

create or replace function public.get_my_active_restrictions()
returns table(restriction_type text, reason text, applied_at timestamptz)
language sql security definer set search_path = public stable as $$
    select r.restriction_type, r.reason, r.applied_at
      from public.account_restrictions r
     where r.user_id = auth.uid()
       and r.active = true
     order by r.applied_at desc;
$$;

-- Granted to authenticated only: no client role may reach the table directly.
revoke all on function public.get_my_active_restrictions() from public, anon;
grant execute on function public.get_my_active_restrictions() to authenticated;
