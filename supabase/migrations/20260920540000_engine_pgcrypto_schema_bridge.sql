-- The engine functions call public.gen_random_uuid(), public.gen_random_bytes(),
-- public.digest() and public.hmac() (20260920380000 onward). On Supabase,
-- pgcrypto is installed in the `extensions` schema and gen_random_uuid() is a
-- pg_catalog built-in, so none of those public names exist and engine_advance,
-- engine_buy_contract and every staff audit insert fail with
-- "function public.gen_random_uuid() does not exist".
--
-- This adds thin public wrappers that delegate to wherever the real function
-- lives. A wrapper is created only when the public name is missing and its
-- target exists, so a database where pgcrypto already sits in public is left
-- untouched. The wrappers are not callable by API roles; the engine's security
-- definer functions run as their owner.
do $$
declare
  v_crypto text := coalesce(
    (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'),
    (select nspname from pg_namespace where nspname = 'extensions'));
  v_wrapper record;
begin
  for v_wrapper in
    select * from (values
      ('gen_random_uuid', '', 'uuid', 'volatile', 'pg_catalog', 'gen_random_uuid()'),
      ('gen_random_bytes', 'integer', 'bytea', 'volatile', v_crypto, 'gen_random_bytes($1)'),
      ('digest', 'bytea, text', 'bytea', 'immutable', v_crypto, 'digest($1, $2)'),
      ('digest', 'text, text', 'bytea', 'immutable', v_crypto, 'digest($1, $2)'),
      ('hmac', 'bytea, bytea, text', 'bytea', 'immutable', v_crypto, 'hmac($1, $2, $3)'),
      ('hmac', 'text, text, text', 'bytea', 'immutable', v_crypto, 'hmac($1, $2, $3)')
    ) as w(name, args, returns, volatility, target_schema, call)
  loop
    continue when v_wrapper.target_schema is null or v_wrapper.target_schema = 'public';
    continue when to_regprocedure(format('public.%I(%s)', v_wrapper.name, v_wrapper.args)) is not null;
    continue when to_regprocedure(format('%I.%I(%s)', v_wrapper.target_schema, v_wrapper.name, v_wrapper.args)) is null;
    execute format('create function public.%I(%s) returns %s language sql %s parallel safe set search_path = %L as %L',
      v_wrapper.name, v_wrapper.args, v_wrapper.returns, v_wrapper.volatility, '',
      format('select %I.%s', v_wrapper.target_schema, v_wrapper.call));
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', v_wrapper.name, v_wrapper.args);
  end loop;
end $$;
