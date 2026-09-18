-- Market registry: the single source of truth for which pairs are listed and which
-- are executable. Before this migration the pair universe was hardcoded in four
-- independent places (submit_demo_order's symbol regex, the market_symbol_controls
-- seed, the cron worker watchlist, and the browser coin lists), so the site could
-- advertise a pair that the engine silently refused.
--
-- `tradable` separates "listed/displayed" from "priced and executable". Only pairs
-- the quote worker actually refreshes may be tradable: a resting order on a pair the
-- worker never prices would never be evaluated, which is silently worse than
-- rejecting it up front.

create table if not exists public.market_symbols (
    symbol text primary key check (symbol ~ '^[A-Z0-9]{2,18}USDT$'),
    base_asset text not null check (base_asset ~ '^[A-Z0-9]{2,12}$'),
    display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
    tradable boolean not null default false,
    sort_order integer not null default 1000,
    listed_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists market_symbols_tradable_idx on public.market_symbols(tradable, sort_order);
alter table public.market_symbols enable row level security;
revoke all on public.market_symbols from public, anon, authenticated, service_role;

-- Registry seed. Only BTC and ETH start tradable because those are the pairs the
-- scheduled quote worker prices today. Everything else is listed for display.
insert into public.market_symbols(symbol, base_asset, display_name, tradable, sort_order) values
    ('BTCUSDT','BTC','Bitcoin',true,1),
    ('ETHUSDT','ETH','Ethereum',true,2),
    ('SOLUSDT','SOL','Solana',false,3),
    ('BNBUSDT','BNB','BNB',false,4),
    ('XRPUSDT','XRP','XRP',false,5),
    ('DOGEUSDT','DOGE','Dogecoin',false,6),
    ('ADAUSDT','ADA','Cardano',false,7),
    ('AVAXUSDT','AVAX','Avalanche',false,8),
    ('SUIUSDT','SUI','Sui',false,9),
    ('LINKUSDT','LINK','Chainlink',false,10),
    ('SHIBUSDT','SHIB','Shiba Inu',false,11),
    ('NEARUSDT','NEAR','NEAR Protocol',false,12),
    ('PEPEUSDT','PEPE','Pepe',false,13),
    ('LTCUSDT','LTC','Litecoin',false,14),
    ('DOTUSDT','DOT','Polkadot',false,15),
    ('BCHUSDT','BCH','Bitcoin Cash',false,16),
    ('UNIUSDT','UNI','Uniswap',false,17),
    ('APTUSDT','APT','Aptos',false,18),
    ('ICPUSDT','ICP','Internet Computer',false,19),
    ('FETUSDT','FET','Fetch.ai',false,20),
    ('AAVEUSDT','AAVE','Aave',false,21),
    ('RENDERUSDT','RENDER','Render',false,22),
    ('FILUSDT','FIL','Filecoin',false,23),
    ('ARBUSDT','ARB','Arbitrum',false,24),
    ('OPUSDT','OP','Optimism',false,25),
    ('TIAUSDT','TIA','Celestia',false,26),
    ('INJUSDT','INJ','Injective',false,27),
    ('TRXUSDT','TRX','TRON',false,28),
    ('FTMUSDT','FTM','Fantom',false,29),
    ('WIFUSDT','WIF','dogwifhat',false,30),
    ('STXUSDT','STX','Stacks',false,31),
    ('XLMUSDT','XLM','Stellar',false,32),
    ('ATOMUSDT','ATOM','Cosmos',false,33),
    ('ETCUSDT','ETC','Ethereum Classic',false,34),
    ('XMRUSDT','XMR','Monero',false,35),
    ('GRTUSDT','GRT','The Graph',false,36),
    ('THETAUSDT','THETA','Theta Network',false,37),
    ('MKRUSDT','MKR','Maker',false,38),
    ('VETUSDT','VET','VeChain',false,39),
    ('LDOUSDT','LDO','Lido DAO',false,40),
    ('RUNEUSDT','RUNE','THORChain',false,41),
    ('ALGOUSDT','ALGO','Algorand',false,42),
    ('SEIUSDT','SEI','Sei',false,43),
    ('FLOKIUSDT','FLOKI','FLOKI',false,44),
    ('BONKUSDT','BONK','Bonk',false,45),
    ('JUPUSDT','JUP','Jupiter',false,46),
    ('BEAMUSDT','BEAM','Beam',false,47),
    ('OMUSDT','OM','MANTRA',false,48),
    ('PYTHUSDT','PYTH','Pyth Network',false,49),
    ('GALAUSDT','GALA','Gala',false,50),
    ('BLURUSDT','BLUR','Blur',false,51),
    ('CRVUSDT','CRV','Curve DAO',false,52),
    ('DYDXUSDT','DYDX','dYdX',false,53),
    ('SANDUSDT','SAND','The Sandbox',false,54),
    ('MANAUSDT','MANA','Decentraland',false,55),
    ('AXSUSDT','AXS','Axie Infinity',false,56),
    ('IMXUSDT','IMX','Immutable',false,57),
    ('ENAUSDT','ENA','Ethena',false,58),
    ('PENDLEUSDT','PENDLE','Pendle',false,59),
    ('WLDUSDT','WLD','Worldcoin',false,60),
    ('STRKUSDT','STRK','Starknet',false,61),
    ('JASMYUSDT','JASMY','JasmyCoin',false,62),
    ('NOTUSDT','NOT','Notcoin',false,63),
    ('BOMEUSDT','BOME','BOOK OF MEME',false,64),
    ('TAOUSDT','TAO','Bittensor',false,65),
    ('TONUSDT','TON','Toncoin',false,66),
    ('ONDOUSDT','ONDO','Ondo',false,67),
    ('POLUSDT','POL','POL (MATIC)',false,68),
    ('QNTUSDT','QNT','Quant',false,69),
    ('CHZUSDT','CHZ','Chiliz',false,70),
    ('APEUSDT','APE','ApeCoin',false,71),
    ('EOSUSDT','EOS','EOS',false,72),
    ('NEOUSDT','NEO','NEO',false,73),
    ('FLOWUSDT','FLOW','Flow',false,74),
    ('GMXUSDT','GMX','GMX',false,75)
on conflict (symbol) do update set
    base_asset = excluded.base_asset,
    display_name = excluded.display_name,
    sort_order = excluded.sort_order;

-- Older snapshots may exist for a listed pair before it became executable. Keep
-- them; they are historical evidence, not an allowlist.

create trigger market_symbols_updated_at before update on public.market_symbols
    for each row execute function public.set_updated_at();

-- The pause table is a control-plane row per symbol; it must not invent symbols.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'market_symbol_controls_symbol_fkey'
    ) then
        alter table public.market_symbol_controls
            add constraint market_symbol_controls_symbol_fkey
            foreign key (symbol) references public.market_symbols(symbol) on delete restrict;
    end if;
end $$;
-- ============================================================================
-- Registry-driven market controls
-- ============================================================================

create or replace function public.list_admin_market_health()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_results jsonb;
begin
    v_staff := admin_private.require_staff('markets.manage');

    select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_results from (
        select
            r.symbol,
            r.base_asset,
            r.display_name,
            r.tradable,
            coalesce(c.trading_paused, false) as trading_paused,
            c.paused_at,
            c.reason as pause_reason,
            s.bid_price,
            s.ask_price,
            s.received_at as last_quote_time,
            case
                when s.received_at is null then 'no_data'
                when s.received_at >= now() - interval '2 minutes' then 'fresh'
                else 'stale'
            end as freshness
        from public.market_symbols r
        left join public.market_symbol_controls c on c.symbol = r.symbol
        left join lateral (
            select bid_price, ask_price, received_at
              from public.market_snapshots ms
             where ms.symbol = r.symbol
             order by ms.received_at desc
             limit 1
        ) s on true
        order by r.sort_order, r.symbol
    ) t;

    return v_results;
end;
$$;

-- Pause/resume a listed symbol. Any listed pair can be paused, but only tradable
-- pairs can be resumed into execution; a non-tradable pair stays display-only.
create or replace function public.set_symbol_trading_status(
    p_symbol text, p_paused boolean, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_staff public.staff_roles;
    v_sym text := upper(btrim(coalesce(p_symbol, '')));
    v_reason text := btrim(coalesce(p_reason, ''));
    v_control_id uuid;
    v_tradable boolean;
begin
    v_staff := admin_private.require_staff('markets.manage');
    if p_paused is null then raise exception 'validation_failed'; end if;

    select tradable into v_tradable from public.market_symbols where symbol = v_sym;
    if v_tradable is null then raise exception 'unsupported symbol %', v_sym; end if;
    if not p_paused and not v_tradable then raise exception 'symbol_not_tradable'; end if;
    if p_paused and char_length(v_reason) < 3 then raise exception 'validation_failed'; end if;

    insert into public.market_symbol_controls(symbol, trading_paused, paused_by, paused_at, reason)
    values (v_sym, p_paused, case when p_paused then v_staff.user_id else null end, case when p_paused then now() else null end, case when p_paused then v_reason else null end)
    on conflict (symbol) do update set
        trading_paused = excluded.trading_paused,
        paused_by = excluded.paused_by,
        paused_at = excluded.paused_at,
        reason = excluded.reason
    returning id into v_control_id;

    insert into public.admin_audit_events(
        actor_id, actor_type, action, target_type, target_id, correlation_id, reason, after_state
    ) values (
        v_staff.user_id, 'staff', case when p_paused then 'markets.pause_symbol' else 'markets.resume_symbol' end,
        'market_symbol', v_control_id, gen_random_uuid(), coalesce(nullif(v_reason, ''), 'Status update'),
        jsonb_build_object('symbol', v_sym, 'trading_paused', p_paused, 'tradable', v_tradable)
    );

    return jsonb_build_object('symbol', v_sym, 'trading_paused', p_paused, 'tradable', v_tradable, 'updated_at', now());
end;
$$;

-- The scheduled quote worker reads this to decide what to price. It never
-- hardcodes a watchlist: the registry is the only place a pair becomes executable.
create or replace function public.list_executable_symbols()
returns text[] language sql stable security definer set search_path = '' as $$
    select coalesce(array_agg(r.symbol order by r.sort_order, r.symbol), array[]::text[])
      from public.market_symbols r
      left join public.market_symbol_controls c on c.symbol = r.symbol
     where r.tradable and not coalesce(c.trading_paused, false);
$$;

revoke all on function public.list_executable_symbols() from public, anon, authenticated;
grant execute on function public.list_executable_symbols() to service_role;

-- The browser reads the listed catalog from here. This replaces the three
-- hand-maintained coin arrays that previously duplicated this list in
-- trade.js, market-overview.js, and index.js.
create or replace function public.list_market_catalog()
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'symbol', r.symbol,
        'base_asset', r.base_asset,
        'display_name', r.display_name,
        'tradable', r.tradable,
        'paused', coalesce(c.trading_paused, false)
    ) order by r.sort_order, r.symbol), '[]'::jsonb)
      from public.market_symbols r
      left join public.market_symbol_controls c on c.symbol = r.symbol;
$$;

revoke all on function public.list_market_catalog() from public;
grant execute on function public.list_market_catalog() to anon, authenticated;

-- ============================================================================
-- Registry-enforced order submission
-- ============================================================================
-- Replaces the symbol-regex-only gate. An order is now rejected unless the pair is
-- registered, marked tradable, and not paused, in addition to the existing account
-- restriction and quote-freshness checks.
create or replace function public.submit_demo_order(
  p_client_order_id text, p_symbol text, p_side public.order_side, p_type public.order_type,
  p_quantity numeric, p_limit_price numeric default null, p_stop_price numeric default null,
  p_idempotency_key text default null
) returns public.orders language plpgsql security definer set search_path = public as $$
declare
  v_account uuid;
  v_order public.orders%rowtype;
  v_snapshot public.market_snapshots%rowtype;
  v_base text;
  v_reserve numeric;
  v_asset text;
  v_key text := coalesce(nullif(p_idempotency_key,''), p_client_order_id);
  v_state public.order_state;
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_tradable boolean;
  v_paused boolean;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  perform public.assert_demo_order_rate_limit();

  -- Enforcement: Check for active TRADING restriction
  if exists (select 1 from public.account_restrictions where user_id = auth.uid() and restriction_type = 'TRADING' and active) then
    raise exception 'trading_restricted';
  end if;

  -- Enforcement: the symbol must be a registered, tradable, unpaused pair.
  select r.tradable into v_tradable from public.market_symbols r where r.symbol = v_symbol;
  if v_tradable is null then raise exception 'unknown symbol %', v_symbol; end if;
  if not v_tradable then raise exception 'symbol_not_tradable %', v_symbol; end if;
  select coalesce(c.trading_paused, false) into v_paused from public.market_symbol_controls c where c.symbol = v_symbol;
  if coalesce(v_paused, false) then raise exception 'symbol_trading_paused'; end if;

  v_account := public.demo_account_for_user();
  if v_account is null then raise exception 'an active DEMO account is required'; end if;
  perform 1 from public.trading_accounts where id = v_account for update;

  if v_symbol !~ '^[A-Z0-9]{2,20}USDT$' or p_quantity <= 0 or p_quantity <> trunc(p_quantity,8) then
    raise exception 'invalid symbol or quantity precision';
  end if;
  if (p_type = 'MARKET' and (p_limit_price is not null or p_stop_price is not null))
     or (p_type = 'LIMIT' and (p_limit_price is null or p_stop_price is not null))
     or (p_type = 'STOP_LIMIT' and (p_limit_price is null or p_stop_price is null)) then
    raise exception 'invalid price fields for order type';
  end if;

  select * into v_order from public.orders where trading_account_id = v_account and idempotency_key = v_key;
  if found then return v_order; end if;

  select * into v_snapshot from public.market_snapshots
   where symbol = v_symbol and received_at > now() - interval '60 seconds'
   order by received_at desc limit 1;
  if v_snapshot.id is null then raise exception 'a fresh server market quote is required before submitting an order'; end if;

  if p_quantity * coalesce(p_limit_price, case when p_side = 'BUY' then v_snapshot.ask_price else v_snapshot.bid_price end) < 10 then
    raise exception 'minimum order notional is 10 USDT';
  end if;

  v_base := regexp_replace(v_symbol, 'USDT$', '');
  v_asset := case when p_side = 'BUY' then 'USDT' else v_base end;
  v_reserve := case when p_side = 'BUY' then p_quantity * greatest(coalesce(p_limit_price, v_snapshot.ask_price), v_snapshot.ask_price) * 1.002 else p_quantity end;

  if public.demo_wallet_balance(v_account, v_asset, 'AVAILABLE') < v_reserve then
    raise exception 'insufficient available %', v_asset;
  end if;

  perform public.post_demo_ledger(
    v_account, 'reserve-' || v_key, 'Reserve funds for demo order',
    jsonb_build_array(
      jsonb_build_object('asset', v_asset, 'kind', 'AVAILABLE', 'amount', -v_reserve),
      jsonb_build_object('asset', v_asset, 'kind', 'RESERVED', 'amount', v_reserve)
    )
  );

  v_state := case when p_type = 'MARKET' then 'ACCEPTED' else 'OPEN' end;
  insert into public.orders(
    trading_account_id, client_order_id, execution_mode, symbol, side, type, state,
    quantity, limit_price, stop_price, reserved_amount, reserved_asset, idempotency_key
  ) values (
    v_account, p_client_order_id, 'DEMO', v_symbol, p_side, p_type, v_state,
    p_quantity, p_limit_price, p_stop_price, v_reserve, v_asset, v_key
  ) returning * into v_order;

  perform public.append_demo_event(
    v_order.id, v_account, 'ACCEPTED', 'PENDING_VALIDATION', v_state, null,
    'event-accept-' || v_key, jsonb_build_object('quantity', p_quantity, 'reserved', v_reserve)
  );

  if p_type = 'MARKET' then
    perform public.fill_demo_order(v_order.id, v_snapshot.id);
    select * into v_order from public.orders where id = v_order.id;
  end if;

  return v_order;
end;
$$;

revoke all on function public.submit_demo_order(text,text,public.order_side,public.order_type,numeric,numeric,numeric,text) from public, anon;
grant execute on function public.submit_demo_order(text,text,public.order_side,public.order_type,numeric,numeric,numeric,text) to authenticated;

grant execute on function public.list_admin_market_health() to authenticated;
grant execute on function public.set_symbol_trading_status(text, boolean, text) to authenticated;
