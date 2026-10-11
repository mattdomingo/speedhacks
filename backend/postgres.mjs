import { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { randomUUID } from 'node:crypto';
import { postgresCameraStore } from './physical/store-postgres.mjs';
import { postgresDigitalStore } from './digital/store-postgres.mjs';
import { postgresVoiceStore } from './voice/store-postgres.mjs';

export function openPostgresStore(connectionString) {
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 5_000 });
  attachDatabasePool(pool);
  pool.on('error', error => console.error('Idle database connection failed:', error.code));
  return {
    ...postgresCameraStore(pool),
    ...postgresDigitalStore(pool),
    ...postgresVoiceStore(pool),
    async put(record) {
      await pool.query('INSERT INTO evidence (id, source, timestamp, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
        [record.id, record.source, record.timestamp, record]);
    },
    async list(source) {
      const { rows } = await pool.query('SELECT payload FROM evidence WHERE source = $1', [source]);
      return rows.map(row => row.payload);
    },
    async observe(observation) {
      const record = {
        ...observation, id: randomUUID(), source: 'camera', demo: false,
        text: `${observation.object} last seen ${observation.location}`,
      };
      await this.put(record);
      return record;
    },
    async saveFrame(timestamp, jpeg) {
      const result = await pool.query(`INSERT INTO latest_frame (slot, timestamp, jpeg) VALUES (1, $1, $2)
        ON CONFLICT (slot) DO UPDATE SET timestamp=excluded.timestamp, jpeg=excluded.jpeg
        WHERE excluded.timestamp::timestamptz > latest_frame.timestamp::timestamptz`, [timestamp, jpeg]);
      return result.rowCount > 0;
    },
    async latestFrame() {
      const { rows } = await pool.query('SELECT timestamp, jpeg FROM latest_frame WHERE slot = 1');
      return rows[0];
    },
    async ping() { await pool.query('SELECT 1'); },
    close() { return pool.end(); },
  };
}
