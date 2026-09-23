create table public.engine_contracts (
 id uuid primary key default gen_random_uuid(), trading_account_id uuid not null, execution_mode public.execution_mode not null, index_code text not null, contract_type text not null check(contract_type in ('EVEN','ODD','OVER','UNDER','MATCH','DIFFER')), barrier smallint, stake numeric not null check(stake>0), payout numeric not null, payout_multiplier numeric not null, win_digits smallint not null, policy_version integer not null references public.engine_policy_versions(version), entry_tick_no bigint not null, settle_tick_no bigint not null, state text not null default 'OPEN' check(state in ('OPEN','WON','LOST','VOID')), idempotency_key text not null, payload_hash text not null, exit_digit smallint, exit_price numeric, exit_epoch_id uuid, settled_at timestamptz, settlement_attempts integer not null default 0, last_error text, created_at timestamptz not null default now(), unique(trading_account_id,idempotency_key), foreign key(trading_account_id,execution_mode) references public.trading_accounts(id,execution_mode), foreign key(index_code,execution_mode) references public.engine_indices(code,execution_mode)
);
create table public.contract_events (id uuid primary key default gen_random_uuid(), contract_id uuid not null references public.engine_contracts(id), trading_account_id uuid not null references public.trading_accounts(id), execution_mode public.execution_mode not null, event_type text not null, reason text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table public.engine_tick_exposure (execution_mode public.execution_mode not null,index_code text not null,settle_tick_no bigint not null,net_loss_by_digit numeric[] not null,primary key(execution_mode,index_code,settle_tick_no));

create or replace function public.engine_winning_digits(p_type text,p_barrier smallint) returns smallint[] language plpgsql immutable security definer set search_path='' as $$
begin
 if p_type='EVEN' then return array[0,2,4,6,8]; end if; if p_type='ODD' then return array[1,3,5,7,9]; end if;
 if p_type='OVER' and p_barrier between 0 and 8 then return array(select i::smallint from generate_series(p_barrier+1,9)i); end if;
 if p_type='UNDER' and p_barrier between 1 and 9 then return array(select i::smallint from generate_series(0,p_barrier-1)i); end if;
 if p_type='MATCH' and p_barrier between 0 and 9 then return array[p_barrier]; end if;
 if p_type='DIFFER' and p_barrier between 0 and 9 then return array(select i::smallint from generate_series(0,9)i where i<>p_barrier); end if;
 raise exception 'invalid_contract_parameters';
end; $$;

create or replace function public.engine_payout(p_stake numeric,p_type text,p_barrier smallint,p_margin numeric default .035) returns table(payout numeric,multiplier numeric,win_digits smallint) language plpgsql immutable security definer set search_path='' as $$
declare w smallint; v numeric;
begin w:=cardinality(public.engine_winning_digits(p_type,p_barrier)); v:=floor(p_stake*(1-p_margin)*10/w*100)/100; if v-p_stake < p_stake*.01 then raise exception 'profit_too_low'; end if; return query select v,v/p_stake,w; end; $$;

create or replace function public.get_account_summary(p_account_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_available numeric;
begin
 if not exists(select 1 from public.trading_accounts where id=p_account_id and user_id=auth.uid() and status='ACTIVE') then raise exception 'account_not_available'; end if;
 select coalesce(sum(e.amount),0) into v_available from public.wallets w join public.ledger_accounts la on la.wallet_id=w.id and la.kind='AVAILABLE' left join public.ledger_entries e on e.ledger_account_id=la.id where w.trading_account_id=p_account_id and w.asset=public.engine_ledger_asset();
 return jsonb_build_object('available',v_available,'currency',public.engine_ledger_asset());
end; $$;
revoke all on function public.get_account_summary(uuid) from public,anon; grant execute on function public.get_account_summary(uuid) to authenticated;
