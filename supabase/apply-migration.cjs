// Run with npm exec --package=pg node supabase/apply-migration.cjs <migration.sql>.
// Connection details come only from TRADING_DB_URL; it never prints them.
const fs = require('node:fs');
const { Client } = require('pg');

async function main() {
  const filename = process.argv[2];
  if (!filename || !process.env.TRADING_DB_URL) throw new Error('Usage: TRADING_DB_URL=... node apply-migration.cjs <migration.sql>');
  const sql = fs.readFileSync(filename, 'utf8');
  const client = new Client({ connectionString: process.env.TRADING_DB_URL, ssl: { rejectUnauthorized: false } });
  // pg emits a separate socket error when a managed pooler drops a connection.
  // Keep that event handled so the command returns a useful migration error.
  client.on('error', () => {});
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(638102900)');
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log(`Applied ${filename}`);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.query('select pg_advisory_unlock(638102900)').catch(() => {});
    await client.end();
  }
}
main().catch((error) => {
  const position = Number(error.position);
  if (position && process.argv[2]) {
    const sql = fs.readFileSync(process.argv[2], 'utf8');
    const line = sql.slice(0, position - 1).split('\n').length;
    console.error(`${error.message} (migration line ${line})`);
  } else console.error(error.message);
  process.exitCode = 1;
});
