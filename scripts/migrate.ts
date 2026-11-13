// Applies db/migrations/*.sql in order, once each. Usage: DATABASE_URL=... npm run migrate
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const dir = join(process.cwd(), 'db', 'migrations');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const done = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (done.has(f)) continue;
  console.log(`applying ${f}`);
  await pool.query(readFileSync(join(dir, f), 'utf8'));
  await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
}
await pool.end();
console.log('migrations up to date');
