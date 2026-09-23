create or replace function public.get_engine_config() returns jsonb language sql security definer set search_path='' as $$
with current_policy as (select * from public.engine_policy_versions order by version desc limit 1)
select jsonb_build_object(
 'ledger_asset',public.engine_ledger_asset(),
 'real_enabled',public.module_enabled('real_accounts'),
 'server_time',now(),
 'policy_version',(select version from current_policy),
 'enabled_contract_types',(select enabled_contract_types from current_policy),
 'indices',coalesce((select jsonb_agg(jsonb_build_object('code',i.code,'display_name',i.display_name,'interval_ms',i.tick_interval_ms,'decimals',i.decimals,'status',i.status,'execution_mode',i.execution_mode) order by i.execution_mode,i.sort_order) from public.engine_indices i where i.execution_mode='DEMO'),'[]'::jsonb),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'execution_mode',a.execution_mode,'currency',public.engine_ledger_asset(),'status',a.status,'limits',jsonb_build_object('min_stake',l.min_stake,'max_stake',l.max_stake,'max_open_contracts',l.max_open_contracts,'max_buys_per_minute',l.max_buys_per_minute,'max_liability_per_tick',l.max_liability_per_tick)) order by a.execution_mode) from public.trading_accounts a left join public.engine_policy_limits l on l.execution_mode=a.execution_mode and l.policy_version=(select version from current_policy) where a.user_id=auth.uid()),'[]'::jsonb)
) $$;
