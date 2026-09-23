alter table public.engine_contracts enable row level security;
alter table public.contract_events enable row level security;
alter table public.index_ticks enable row level security;
create policy engine_contract_owner_read on public.engine_contracts for select to authenticated using (trading_account_id in (select id from public.trading_accounts where user_id=auth.uid()));
create policy contract_event_owner_read on public.contract_events for select to authenticated using (trading_account_id in (select id from public.trading_accounts where user_id=auth.uid()));
create policy index_ticks_authenticated_read on public.index_ticks for select to authenticated using (execution_mode='DEMO');
create or replace function public.reject_index_tick_mutation() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'index_ticks_immutable'; end; $$;
create trigger index_ticks_reject_update before update or delete on public.index_ticks for each row execute function public.reject_index_tick_mutation();
revoke all on public.engine_contracts,public.contract_events,public.index_ticks from public,anon;
