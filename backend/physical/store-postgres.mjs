import { claimAnalysis, finishAnalysis } from './state.mjs';

export function postgresCameraStore(pool) {
  async function transaction(change) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT payload FROM camera_state WHERE slot = 1 FOR UPDATE');
      if (!rows[0]) throw new Error('Camera schema is missing; run npm run db:init');
      const state = rows[0].payload;
      const result = await change(state, client);
      await client.query('UPDATE camera_state SET payload = $1 WHERE slot = 1', [state]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    async readCameraState() {
      const { rows } = await pool.query('SELECT payload FROM camera_state WHERE slot = 1');
      if (!rows[0]) throw new Error('Camera schema is missing; run npm run db:init');
      return rows[0].payload;
    },
    claimCameraFrame(now) {
      return transaction(async (state, client) => {
        const { rows } = await client.query('SELECT timestamp, jpeg FROM latest_frame WHERE slot = 1');
        return claimAnalysis(state, rows[0], now);
      });
    },
    finishCameraFrame(token, outcome, now) {
      return transaction(async (state, client) => {
        if (!finishAnalysis(state, token, outcome, now)) return false;
        for (const record of outcome.records || []) {
          await client.query(`INSERT INTO evidence (id, source, timestamp, payload) VALUES ($1, $2, $3, $4)
            ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp, payload=excluded.payload`,
          [record.id, record.source, record.timestamp, record]);
          await client.query(`INSERT INTO camera_snapshots (object, frame_id, timestamp, jpeg) VALUES ($1, $2, $3, $4)
            ON CONFLICT(object) DO UPDATE SET frame_id=excluded.frame_id, timestamp=excluded.timestamp, jpeg=excluded.jpeg`,
          [record.object, record.frameId, record.timestamp, outcome.jpeg]);
        }
        return true;
      });
    },
    async cameraSnapshot(id) {
      const { rows } = await pool.query('SELECT timestamp, jpeg FROM camera_snapshots WHERE frame_id = $1 LIMIT 1', [id]);
      return rows[0];
    },
  };
}
