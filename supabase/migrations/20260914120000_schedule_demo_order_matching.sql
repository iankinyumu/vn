-- Schedules periodic evaluation of resting LIMIT/STOP demo orders.
--
-- Problem this fixes: process_demo_orders() only ever ran as a side effect
-- of refresh-market-quote, which only ever ran when a user submitted a new
-- order for that symbol. A resting limit order would not fill even if the
-- market price crossed it, unless some user (any user) happened to place
-- another order on the same symbol afterwards.
--
-- Fix: pg_cron calls the cron-process-demo-orders Edge Function once a
-- minute (pg_cron's minimum granularity) via pg_net. That function is a
-- system-authorized twin of refresh-market-quote (see
-- supabase/functions/cron-process-demo-orders) that does not require a
-- user JWT.
--
-- MANUAL STEPS REQUIRED BEFORE/AFTER RUNNING THIS MIGRATION — these cannot
-- be scripted from inside a migration file:
--   1. Deploy the function:
--        supabase functions deploy cron-process-demo-orders --no-verify-jwt
--   2. Generate a long random secret and set it on the function:
--        supabase secrets set CRON_SECRET=<paste a generated secret>
--   3. Store that SAME secret in Vault so this migration's job can send it:
--        select vault.create_secret('<paste the same secret>', 'cron_secret');
--   4. The project ref below is the linked project's actual ref.
--   5. pg_cron and pg_net must be enabled for this project (Database ->
--      Extensions in the dashboard, or the two `create extension` lines
--      below if you have the privilege to run them directly).

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Idempotent: safe to re-run this migration without creating duplicate jobs.
select cron.unschedule(jobid) from cron.job where jobname = 'process-demo-orders-every-minute';

select cron.schedule(
  'process-demo-orders-every-minute',
  '* * * * *', -- pg_cron's minimum granularity is one minute.
  $$
  select net.http_post(
    url := 'https://cdaxvkpmgqjfukbtrzys.supabase.co/functions/v1/cron-process-demo-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To verify the job is registered:
--   select * from cron.job where jobname = 'process-demo-orders-every-minute';
-- To inspect recent run history / failures:
--   select * from cron.job_run_details order by start_time desc limit 20;
-- To remove it entirely:
--   select cron.unschedule('process-demo-orders-every-minute');
