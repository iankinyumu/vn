create or replace function public.engine_ensure_epochs() returns integer language plpgsql security definer set search_path='' as $$
declare r record; created_count integer:=0;
begin
 for r in select distinct execution_mode from public.engine_indices where status in ('ACTIVE','PAUSED') loop
  perform public.engine_ensure_epoch(r.execution_mode,now());
  perform public.engine_ensure_epoch(r.execution_mode,now()+interval '1 day');
  created_count:=created_count+2;
 end loop; return created_count;
end; $$;
create or replace function public.engine_reveal_due_epochs() returns integer language plpgsql security definer set search_path='' as $$
declare r record; count_revealed integer:=0;
begin
 for r in select e.id,s.seed from public.engine_epochs e join engine_private.epoch_seeds s on s.epoch_id=e.id where e.revealed_at is null and e.ends_at+interval '10 minutes'<now() and not exists(select 1 from public.engine_contracts c where c.execution_mode=e.execution_mode and c.state='OPEN') loop
  update public.engine_epochs set revealed_seed=encode(r.seed,'hex'),revealed_at=now() where id=r.id; count_revealed:=count_revealed+1;
 end loop; return count_revealed;
end; $$;
create or replace function public.engine_purge_ticks() returns integer language plpgsql security definer set search_path='' as $$
declare removed integer;
begin delete from public.index_ticks t using public.engine_epochs e where e.id=t.epoch_id and e.revealed_at is not null and t.generated_at<now()-interval '30 days' and not exists(select 1 from public.engine_contracts c where c.index_code=t.index_code and c.execution_mode=t.execution_mode and (c.entry_tick_no=t.tick_no or c.settle_tick_no=t.tick_no)); get diagnostics removed=row_count; return removed; end; $$;
revoke all on function public.engine_ensure_epochs(),public.engine_reveal_due_epochs(),public.engine_purge_ticks() from public,anon,authenticated;
