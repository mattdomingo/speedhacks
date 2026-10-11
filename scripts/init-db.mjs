import { Client } from 'pg';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the target Postgres database');
const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  await client.query(readFileSync(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  console.log('Postgres tables initialized; existing records preserved.');
} finally {
  await client.end();
}
