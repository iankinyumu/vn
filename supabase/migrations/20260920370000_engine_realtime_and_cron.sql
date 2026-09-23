create or replace function public.broadcast_engine_tick() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform realtime.send(jsonb_build_object('index_code',new.index_code,'tick_no',new.tick_no,'price',new.price,'digit',new.digit,'scheduled_at',new.scheduled_at),'tick','ticks:'||lower(new.execution_mode::text)||':'||new.index_code,true);
 return new;
end; $$;
create trigger engine_tick_broadcast after insert on public.index_ticks for each row execute function public.broadcast_engine_tick();
create policy engine_demo_tick_receive on realtime.messages for select to authenticated using (extension='broadcast' and topic like 'ticks:demo:%');
do $$
begin
 if not exists(select 1 from pg_extension where extname='pg_cron' and extversion>='1.5') then raise exception 'pg_cron 1.5 or later is required for the engine scheduler'; end if;
 perform cron.unschedule(jobid) from cron.job where jobname in ('engine-advance','engine-reveal-due-epochs','engine-purge-ticks');
 perform cron.schedule('engine-advance','1 seconds','select public.engine_advance()');
 perform cron.schedule('engine-reveal-due-epochs','* * * * *','select public.engine_reveal_due_epochs()');
 perform cron.schedule('engine-purge-ticks','0 0 * * *','select public.engine_purge_ticks()');
end $$;
