// Read-only post-migration verification. Requires TRADING_DB_URL in the environment.
const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.TRADING_DB_URL, ssl: { rejectUnauthorized: false } });
  client.on('error', () => {});
  await client.connect();
  const { rows } = await client.query(`
    select to_regclass('public.demo_order_rate_limits') as rate_limit_table,
      exists(select 1 from pg_proc where proname = 'submit_demo_order') as submit_rpc,
      exists(select 1 from pg_proc where proname = 'process_demo_orders') as processor_rpc,
      exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') as orders_realtime`);
  console.log(JSON.stringify(rows[0]));
  await client.end();
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
