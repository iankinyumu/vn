-- Splits customer setup in two (owner decision, 2026-10-03):
--   * Onboarding: a light "get to know you" after sign-up. Why the customer is here, how familiar
--     they are with trading, which contracts interest them and where to start. All optional and
--     skippable; shown once.
--   * Verification (KYC): the identity, address, finances, experience and knowledge check that
--     20261003120000 put into onboarding. Kept, with any answers already given, but started by the
--     customer from their profile, never forced. It will be required before Real mode opens.
-- The first migration's table becomes public.customer_verification (rows kept); its functions are
-- recreated under verification names, and a new, small public.customer_onboarding is created.

drop function if exists public.staff_get_customer_onboarding(uuid);
drop function if exists public.complete_my_onboarding();
drop function if exists public.save_my_onboarding_step(integer, jsonb);
drop function if exists public.get_my_onboarding();
drop function if exists admin_private.onboarding_view(uuid);
drop function if exists admin_private.onboarding_bool(jsonb, text);
drop function if exists admin_private.onboarding_choice(text, text, text[]);
drop function if exists admin_private.onboarding_text(text, text, integer, integer, text);

alter table public.customer_onboarding rename to customer_verification;
alter policy customer_onboarding_owner_read on public.customer_verification rename to customer_verification_owner_read;
alter table public.customer_verification rename constraint customer_onboarding_pkey to customer_verification_pkey;

-- ================================================================ verification (KYC)
-- ---------------------------------------------------------------- validation helpers
-- Free text: trimmed, single-spaced, no control characters, within bounds. An empty optional value
-- becomes null. Raises invalid_<field>.
create function admin_private.verification_text(p_value text, p_field text, p_min integer, p_max integer, p_pattern text default null)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g'), '');
begin
    if v is null then
        if p_min > 0 then raise exception 'invalid_%', p_field; end if;
        return null;
    end if;
    if v ~ '[[:cntrl:]]' or char_length(v) < p_min or char_length(v) > p_max or (p_pattern is not null and v !~ p_pattern) then
        raise exception 'invalid_%', p_field;
    end if;
    return v;
end;
$$;

-- One of a fixed set of choices. Raises invalid_<field>.
create function admin_private.verification_choice(p_value text, p_field text, p_allowed text[])
returns text language plpgsql immutable set search_path = '' as $$
begin
    if p_value is null or not (p_value = any(p_allowed)) then raise exception 'invalid_%', p_field; end if;
    return p_value;
end;
$$;

create function admin_private.verification_bool(p_data jsonb, p_field text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
    if jsonb_typeof(p_data->p_field) is distinct from 'boolean' then raise exception 'invalid_%', p_field; end if;
    return (p_data->>p_field)::boolean;
end;
$$;

-- The customer-facing view of a row (or of no row yet). Names are pre-filled from sign-up.
create function admin_private.verification_view(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.customer_verification; v_meta jsonb; v_name text[];
begin
    select * into r from public.customer_verification where user_id = p_user;
    if not found then
        select coalesce(raw_user_meta_data, '{}'::jsonb) into v_meta from auth.users where id = p_user;
        v_name := regexp_split_to_array(btrim(coalesce(v_meta->>'display_name', '')), '\s+');
        return jsonb_build_object('status', 'not_started', 'current_step', 1, 'data', jsonb_build_object(
            'legal_first_name', nullif(v_name[1], ''),
            'legal_last_name', nullif(array_to_string(v_name[2:], ' '), ''),
            'country_of_residence', 'KE', 'nationality', 'KE'));
    end if;
    return jsonb_build_object('status', r.status, 'current_step', r.current_step, 'completed_at', r.completed_at,
        'appropriateness', r.appropriateness, 'knowledge_score', r.knowledge_score,
        'data', jsonb_strip_nulls(jsonb_build_object(
            'legal_first_name', r.legal_first_name, 'legal_last_name', r.legal_last_name, 'date_of_birth', r.date_of_birth,
            'nationality', r.nationality, 'country_of_residence', r.country_of_residence, 'phone', r.phone,
            'address_line1', r.address_line1, 'address_line2', r.address_line2, 'city', r.city, 'region', r.region, 'postal_code', r.postal_code,
            'employment_status', r.employment_status, 'occupation', r.occupation, 'annual_income', r.annual_income, 'savings', r.savings,
            'source_of_funds', to_jsonb(r.source_of_funds), 'tax_id', r.tax_id, 'is_pep', r.is_pep,
            'experience_binary', r.experience_binary, 'experience_forex', r.experience_forex, 'experience_shares', r.experience_shares,
            'finance_background', r.finance_background, 'knowledge_answers', r.knowledge_answers,
            'goal', r.goal, 'weekly_time', r.weekly_time, 'risk_acknowledged', r.risk_acknowledged_at is not null)));
end;
$$;
revoke all on function admin_private.verification_view(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- customer RPCs
create function public.get_my_verification()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    return admin_private.verification_view(auth.uid());
end;
$$;

-- Saves one step. Unknown keys are ignored; every known key is validated. Moving forward unlocks
-- the next step; going back to an earlier step and saving it again is allowed until completion.
create function public.save_my_verification_step(p_step integer, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := auth.uid();
    r public.customer_verification;
    v_dob date;
    v_sources text[];
    v_answers jsonb;
    v_score integer := 0;
    v_key constant jsonb := '{"q1":"lose_stake","q2":"same_chance","q3":"expected_loss","q4":"the_stake"}';
    v_question text;
    v_tax_pattern text;
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    if p_step is null or p_step not between 1 and 6 or p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'validation_failed'; end if;

    insert into public.customer_verification(user_id) values (v_user) on conflict (user_id) do nothing;
    select * into r from public.customer_verification where user_id = v_user for update;
    if r.status = 'completed' then raise exception 'verification_completed'; end if;
    if p_step > r.current_step then raise exception 'step_locked'; end if;
    if r.save_count >= 500 then raise exception 'rate_limited'; end if;

    if p_step = 1 then
        begin v_dob := (p_data->>'date_of_birth')::date; exception when others then raise exception 'invalid_date_of_birth'; end;
        if v_dob is null then raise exception 'invalid_date_of_birth'; end if;
        if v_dob > (current_date - interval '18 years')::date then raise exception 'underage'; end if;
        if v_dob < (current_date - interval '110 years')::date then raise exception 'invalid_date_of_birth'; end if;
        update public.customer_verification set
            legal_first_name = admin_private.verification_text(p_data->>'legal_first_name', 'legal_first_name', 1, 50, '^[[:alpha:]][[:alpha:]'' .-]*$'),
            legal_last_name = admin_private.verification_text(p_data->>'legal_last_name', 'legal_last_name', 1, 50, '^[[:alpha:]][[:alpha:]'' .-]*$'),
            date_of_birth = v_dob,
            nationality = admin_private.verification_text(p_data->>'nationality', 'nationality', 2, 2, '^[A-Z]{2}$'),
            country_of_residence = admin_private.verification_text(p_data->>'country_of_residence', 'country_of_residence', 2, 2, '^[A-Z]{2}$'),
            phone = admin_private.verification_text(regexp_replace(coalesce(p_data->>'phone', ''), '[\s()-]', '', 'g'), 'phone', 9, 16, '^\+[1-9][0-9]{7,14}$')
        where user_id = v_user;
    elsif p_step = 2 then
        update public.customer_verification set
            address_line1 = admin_private.verification_text(p_data->>'address_line1', 'address_line1', 2, 120),
            address_line2 = admin_private.verification_text(p_data->>'address_line2', 'address_line2', 0, 120),
            city = admin_private.verification_text(p_data->>'city', 'city', 2, 80),
            region = admin_private.verification_text(p_data->>'region', 'region', 2, 80),
            postal_code = admin_private.verification_text(p_data->>'postal_code', 'postal_code', 0, 12, '^[A-Za-z0-9 -]+$')
        where user_id = v_user;
    elsif p_step = 3 then
        if jsonb_typeof(p_data->'source_of_funds') is distinct from 'array' then raise exception 'invalid_source_of_funds'; end if;
        select array_agg(distinct value order by value) into v_sources from jsonb_array_elements_text(p_data->'source_of_funds');
        if v_sources is null or cardinality(v_sources) > 8
           or not (v_sources <@ array['salary', 'business', 'savings', 'investments', 'inheritance', 'gift', 'pension', 'other']) then
            raise exception 'invalid_source_of_funds';
        end if;
        -- A Kenyan KRA PIN when the customer lives in Kenya; any short alphanumeric tax number otherwise. Optional for now.
        v_tax_pattern := case when r.country_of_residence = 'KE' then '^[AP][0-9]{9}[A-Z]$' else '^[A-Za-z0-9-]{4,20}$' end;
        update public.customer_verification set
            employment_status = admin_private.verification_choice(p_data->>'employment_status', 'employment_status', array['employed', 'self_employed', 'business_owner', 'student', 'unemployed', 'retired']),
            occupation = admin_private.verification_choice(p_data->>'occupation', 'occupation', array['agriculture', 'construction', 'education', 'finance', 'government', 'health', 'hospitality', 'ict', 'manufacturing', 'retail', 'transport', 'other', 'none']),
            annual_income = admin_private.verification_choice(p_data->>'annual_income', 'annual_income', array['under_300k', '300k_1m', '1m_3m', '3m_10m', 'over_10m']),
            savings = admin_private.verification_choice(p_data->>'savings', 'savings', array['under_100k', '100k_500k', '500k_2m', '2m_10m', 'over_10m']),
            source_of_funds = v_sources,
            tax_id = admin_private.verification_text(upper(p_data->>'tax_id'), 'tax_id', 0, 20, v_tax_pattern),
            is_pep = admin_private.verification_bool(p_data, 'is_pep')
        where user_id = v_user;
    elsif p_step = 4 then
        update public.customer_verification set
            experience_binary = admin_private.verification_choice(p_data->>'experience_binary', 'experience_binary', array['none', 'under_1y', '1_3y', 'over_3y']),
            experience_forex = admin_private.verification_choice(p_data->>'experience_forex', 'experience_forex', array['none', 'under_1y', '1_3y', 'over_3y']),
            experience_shares = admin_private.verification_choice(p_data->>'experience_shares', 'experience_shares', array['none', 'under_1y', '1_3y', 'over_3y']),
            finance_background = admin_private.verification_bool(p_data, 'finance_background')
        where user_id = v_user;
    elsif p_step = 5 then
        v_answers := '{}'::jsonb;
        foreach v_question in array array['q1', 'q2', 'q3', 'q4'] loop
            if jsonb_typeof(p_data->v_question) is distinct from 'string' or char_length(p_data->>v_question) > 40
               or p_data->>v_question !~ '^[a-z_]+$' then
                raise exception 'invalid_%', v_question;
            end if;
            v_answers := v_answers || jsonb_build_object(v_question, p_data->>v_question);
            if p_data->>v_question = v_key->>v_question then v_score := v_score + 1; end if;
        end loop;
        update public.customer_verification set knowledge_answers = v_answers, knowledge_score = v_score,
            appropriateness = case when v_score >= 3 then 'appropriate' else 'not_yet' end
        where user_id = v_user;
    else
        if not (coalesce((p_data->>'ack_lose_stake')::boolean, false) and coalesce((p_data->>'ack_practice')::boolean, false)
                and coalesce((p_data->>'ack_afford')::boolean, false)) then
            raise exception 'invalid_acknowledgements';
        end if;
        update public.customer_verification set
            goal = admin_private.verification_choice(p_data->>'goal', 'goal', array['learn', 'entertainment', 'extra_income', 'other']),
            weekly_time = admin_private.verification_choice(p_data->>'weekly_time', 'weekly_time', array['under_1h', '1_5h', 'over_5h']),
            risk_acknowledged_at = now()
        where user_id = v_user;
    end if;

    update public.customer_verification set current_step = greatest(current_step, p_step + 1), save_count = save_count + 1, updated_at = now()
    where user_id = v_user;
    return admin_private.verification_view(v_user);
end;
$$;

-- Finishes onboarding once every step is saved. Safe to call twice.
create function public.complete_my_verification()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.customer_verification;
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    select * into r from public.customer_verification where user_id = auth.uid() for update;
    if not found then raise exception 'verification_incomplete'; end if;
    if r.status = 'completed' then return admin_private.verification_view(auth.uid()); end if;
    if r.current_step < 7 or r.legal_first_name is null or r.date_of_birth is null or r.phone is null or r.address_line1 is null
       or r.employment_status is null or r.is_pep is null or r.experience_binary is null or r.knowledge_score is null
       or r.risk_acknowledged_at is null then
        raise exception 'verification_incomplete';
    end if;
    update public.customer_verification set status = 'completed', completed_at = now(), updated_at = now() where user_id = auth.uid();
    return admin_private.verification_view(auth.uid());
end;
$$;

revoke all on function public.get_my_verification() from public, anon;
revoke all on function public.save_my_verification_step(integer, jsonb) from public, anon;
revoke all on function public.complete_my_verification() from public, anon;
grant execute on function public.get_my_verification() to authenticated;
grant execute on function public.save_my_verification_step(integer, jsonb) to authenticated;
grant execute on function public.complete_my_verification() to authenticated;

-- ---------------------------------------------------------------- staff read
-- The full profile for one customer, for staff who may read customers. Every view is audited,
-- because this is personal and financial data.
create function public.staff_get_customer_verification(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_view jsonb;
begin
    perform admin_private.require_staff('customers.read');
    if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then raise exception 'not_found'; end if;
    v_view := admin_private.verification_view(p_user_id);
    if v_view->>'status' <> 'not_started' then
        insert into public.admin_audit_events(actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state)
        values (auth.uid(), 'staff', 'customer.view_verification', 'customer', p_user_id, gen_random_uuid(), 'Viewed verification profile', jsonb_build_object('status', v_view->>'status'));
    end if;
    return v_view;
end;
$$;
revoke all on function public.staff_get_customer_verification(uuid) from public, anon;
grant execute on function public.staff_get_customer_verification(uuid) to authenticated;

-- ================================================================ onboarding (light)
create table public.customer_onboarding (
    user_id uuid primary key references auth.users(id) on delete cascade,
    goal text check (goal is null or goal in ('learn', 'fun', 'extra_income', 'exploring')),
    experience text check (experience is null or experience in ('new', 'some', 'experienced')),
    interests text[] not null default '{}' check (interests <@ array['evenodd', 'matches', 'overunder']::text[]),
    start_with text check (start_with is null or start_with in ('tour', 'guides', 'dashboard')),
    skipped boolean not null default false,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.customer_onboarding enable row level security;
create policy customer_onboarding_owner_read on public.customer_onboarding for select to authenticated using (user_id = auth.uid());
revoke all on public.customer_onboarding from public, anon, authenticated;
grant select on public.customer_onboarding to authenticated;

create function admin_private.onboarding_view(p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(
        (select jsonb_build_object('status', case when completed_at is null then 'in_progress' else 'completed' end,
                'skipped', skipped, 'completed_at', completed_at,
                'data', jsonb_strip_nulls(jsonb_build_object('goal', goal, 'experience', experience, 'interests', to_jsonb(interests), 'start_with', start_with)))
           from public.customer_onboarding where user_id = p_user),
        jsonb_build_object('status', 'not_started', 'skipped', false, 'data', '{}'::jsonb));
$$;
revoke all on function admin_private.onboarding_view(uuid) from public, anon, authenticated;

create function public.get_my_onboarding()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    if auth.uid() is null then raise exception 'unauthenticated'; end if;
    return admin_private.onboarding_view(auth.uid());
end;
$$;

-- Saves whatever answers are given (unknown keys ignored, every known one checked). p_finish marks
-- onboarding done; p_skip marks it done without asking the rest. Answers can be changed later.
create function public.save_my_onboarding(p_data jsonb default '{}'::jsonb, p_finish boolean default false, p_skip boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := auth.uid();
    v_data jsonb := coalesce(p_data, '{}'::jsonb);
    v_interests text[];
begin
    if v_user is null then raise exception 'unauthenticated'; end if;
    if jsonb_typeof(v_data) <> 'object' then raise exception 'validation_failed'; end if;
    if v_data ? 'goal' and v_data->>'goal' is not null and not (v_data->>'goal' = any(array['learn', 'fun', 'extra_income', 'exploring'])) then raise exception 'invalid_goal'; end if;
    if v_data ? 'experience' and v_data->>'experience' is not null and not (v_data->>'experience' = any(array['new', 'some', 'experienced'])) then raise exception 'invalid_experience'; end if;
    if v_data ? 'start_with' and v_data->>'start_with' is not null and not (v_data->>'start_with' = any(array['tour', 'guides', 'dashboard'])) then raise exception 'invalid_start_with'; end if;
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

revoke all on function public.get_my_onboarding() from public, anon;
revoke all on function public.save_my_onboarding(jsonb, boolean, boolean) from public, anon;
grant execute on function public.get_my_onboarding() to authenticated;
grant execute on function public.save_my_onboarding(jsonb, boolean, boolean) to authenticated;

-- What a customer told us at onboarding, for staff who may read customers.
create function public.staff_get_customer_onboarding(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform admin_private.require_staff('customers.read');
    if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then raise exception 'not_found'; end if;
    return admin_private.onboarding_view(p_user_id);
end;
$$;
revoke all on function public.staff_get_customer_onboarding(uuid) from public, anon;
grant execute on function public.staff_get_customer_onboarding(uuid) to authenticated;
