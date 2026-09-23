-- Lifetime contract statistics for one account, aggregated on the server over every
-- contract the account holds (not a page of recent rows). Ownership, ACTIVE status,
-- the Real gate and ACCESS restrictions are enforced by engine_assert_account_access,
-- exactly as get_account_summary enforces them.
create or replace function public.get_account_stats(p_account_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_stats jsonb;
begin
 perform public.engine_assert_account_access(p_account_id);
 select jsonb_build_object(
  'wins',count(*) filter (where c.state='WON'),
  'losses',count(*) filter (where c.state='LOST'),
  'voids',count(*) filter (where c.state='VOID'),
  'open',count(*) filter (where c.state='OPEN'),
  'net_result',round(coalesce(sum(case c.state when 'WON' then c.payout-c.stake when 'LOST' then -c.stake else 0 end),0),2),
  'currency',public.engine_ledger_asset()
 ) into v_stats
 from public.engine_contracts c
 where c.trading_account_id=p_account_id;
 return v_stats;
end; $$;

revoke all on function public.get_account_stats(uuid) from public,anon;
grant execute on function public.get_account_stats(uuid) to authenticated;
