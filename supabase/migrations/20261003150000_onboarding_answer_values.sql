-- Onboarding answer values named after what the customer actually chose. The labels were reworded
-- after the values were set, leaving 'fun' for "Trade short-term contracts", 'extra_income' for
-- "Grow my trading", 'exploring' for "Test a strategy" and 'tour' for "Place a trade".
--   goal:       learn, fun to short_term, extra_income to grow, exploring to strategy
--   start_with: tour to trade, guides, dashboard

alter table public.customer_onboarding drop constraint customer_onboarding_goal_check;
alter table public.customer_onboarding drop constraint customer_onboarding_start_with_check;

update public.customer_onboarding set goal = case goal
        when 'fun' then 'short_term' when 'extra_income' then 'grow' when 'exploring' then 'strategy' else goal end
    where goal in ('fun', 'extra_income', 'exploring');
update public.customer_onboarding set start_with = 'trade' where start_with = 'tour';

alter table public.customer_onboarding add constraint customer_onboarding_goal_check
    check (goal is null or goal in ('learn', 'short_term', 'grow', 'strategy'));
alter table public.customer_onboarding add constraint customer_onboarding_start_with_check
    check (start_with is null or start_with in ('trade', 'guides', 'dashboard'));

create or replace function public.save_my_onboarding(p_data jsonb default '{}'::jsonb, p_finish boolean default false, p_skip boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := auth.uid();
    v_data jsonb := coalesce(p_data, '{}'::jsonb);
    v_interests text[];
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    if jsonb_typeof(v_data) <> 'object' then raise exception 'validation_failed'; end if;
    if v_data ? 'goal' and v_data->>'goal' is not null and not (v_data->>'goal' = any(array['learn', 'short_term', 'grow', 'strategy'])) then raise exception 'invalid_goal'; end if;
    if v_data ? 'experience' and v_data->>'experience' is not null and not (v_data->>'experience' = any(array['new', 'some', 'experienced'])) then raise exception 'invalid_experience'; end if;
    if v_data ? 'start_with' and v_data->>'start_with' is not null and not (v_data->>'start_with' = any(array['trade', 'guides', 'dashboard'])) then raise exception 'invalid_start_with'; end if;
    if v_data ? 'interests' then
        if jsonb_typeof(v_data->'interests') <> 'array' then raise exception 'invalid_interests'; end if;
        select coalesce(array_agg(distinct value order by value), '{}') into v_interests from jsonb_array_elements_text(v_data->'interests');
        if not (v_interests <@ array['evenodd', 'matches', 'overunder']) then raise exception 'invalid_interests'; end if;
    end if;

    insert into public.customer_onboarding(user_id) values (v_user) on conflict (user_id) do nothing;
    update public.customer_onboarding set
        goal = case when v_data ? 'goal' then v_data->>'goal' else goal end,
        experience = case when v_data ? 'experience' then v_data->>'experience' else experience end,
        interests = case when v_data ? 'interests' then v_interests else interests end,
        start_with = case when v_data ? 'start_with' then v_data->>'start_with' else start_with end,
        skipped = case when p_skip then true when p_finish then false else skipped end,
        completed_at = case when (p_finish or p_skip) and completed_at is null then now() else completed_at end,
        updated_at = now()
    where user_id = v_user;
    return admin_private.onboarding_view(v_user);
end;
$$;

revoke all on function public.save_my_onboarding(jsonb, boolean, boolean) from public, anon;
grant execute on function public.save_my_onboarding(jsonb, boolean, boolean) to authenticated;
