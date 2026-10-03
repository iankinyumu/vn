-- Identity verification (KYC) is not required at this stage (owner decision, 2026-10-03). The
-- verification flow from 20261003120000/20261003130000 asked for identity, address and financial
-- details that SmartProfit does not need and should not hold, so the table, every answer in it and
-- its functions are removed. When Real mode needs verification, it will be a single ID-number check
-- through a provider, keeping only the result. Onboarding (customer_onboarding) is unchanged.

drop function if exists public.staff_get_customer_verification(uuid);
drop function if exists public.complete_my_verification();
drop function if exists public.save_my_verification_step(integer, jsonb);
drop function if exists public.get_my_verification();
drop function if exists admin_private.verification_view(uuid);
drop function if exists admin_private.verification_bool(jsonb, text);
drop function if exists admin_private.verification_choice(text, text, text[]);
drop function if exists admin_private.verification_text(text, text, integer, integer, text);
drop table if exists public.customer_verification;

-- Staff views of verification profiles were audited; those audit rows stay (they hold no answers).
