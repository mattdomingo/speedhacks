import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'memory.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS latest_frame (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      timestamp TEXT NOT NULL,
      jpeg BLOB NOT NULL
    );
  `);
  return {
    db,
    put(record) {
      db.prepare('INSERT OR IGNORE INTO evidence VALUES (?, ?, ?, ?)')
        .run(record.id, record.source, record.timestamp, JSON.stringify(record));
    },
    list(source) {
      return db.prepare('SELECT payload FROM evidence WHERE source = ?')
        .all(source).map(row => JSON.parse(row.payload));
    },
    observe(observation) {
      const record = {
        ...observation, id: randomUUID(), source: 'camera', demo: false,
        text: `${observation.object} last seen ${observation.location}`,
      };
      this.put(record);
      return record;
    },
    saveFrame(timestamp, jpeg) {
      db.prepare(`INSERT INTO latest_frame VALUES (1, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET timestamp=excluded.timestamp, jpeg=excluded.jpeg
        WHERE julianday(excluded.timestamp) >= julianday(latest_frame.timestamp)`)
        .run(timestamp, jpeg);
    },
    latestFrame() {
      return db.prepare('SELECT timestamp, jpeg FROM latest_frame WHERE slot = 1').get();
    },
    close() { db.close(); },
  };
}
