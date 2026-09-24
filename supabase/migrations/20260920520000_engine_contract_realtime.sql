-- Deliver engine_contracts changes to the trade page's postgres_changes
-- subscription. Realtime authorises every change against the subscriber's RLS
-- policies (engine_contract_owner_read), so the table is published whole: no row
-- filter and no column list; RLS stays the only filter. Idempotent.
grant select on public.engine_contracts to authenticated;

do $$
begin
 if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
  raise exception 'The supabase_realtime publication is required for contract change events';
 end if;
 if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='engine_contracts') then
  alter publication supabase_realtime add table public.engine_contracts;
 end if;
end $$;
