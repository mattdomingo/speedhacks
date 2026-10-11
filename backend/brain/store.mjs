import { randomBytes } from 'node:crypto';

// Steph's per-user store, written once over a two-method driver so SQLite and Postgres run the
// same SQL. driver.all(sql, params) → rows; driver.run(sql, params) → affected row count;
// driver.pg is true on Postgres. Placeholders are '?'; the Postgres driver numbers them.
export const newId = prefix => `${prefix}_${randomBytes(12).toString('base64url')}`;

const json = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const flag = value => value === true || value === 1 || value === '1';

const USER_FIELDS = ['name', 'role', 'phone', 'google_email', 'apple_sub', 'caregiver_id', 'owner', 'time_zone',
  'settings', 'app_seen_at', 'setup_completed_at'];
const NUDGE_FIELDS = ['status', 'call_id', 'push_id', 'pushed_at', 'outcome', 'channel', 'urgent', 'due_at', 'text'];
// Tables whose rows belong to one user, moved when a placeholder caller merges into a real account.
const USER_TABLES = ['steph_memories', 'steph_tombstones', 'steph_timeline', 'steph_decisions', 'steph_devices',
  'steph_pending', 'steph_nudges', 'steph_sessions'];

function userRow(row) {
  return row && { ...row, owner: flag(row.owner), settings: json(row.settings, {}) };
}
function memoryRow(row) {
  return row && { ...row, people: json(row.people, []), details: json(row.details, {}), confidence: Number(row.confidence) };
}
function timelineRow(row) {
  return row && { ...row, meta: json(row.meta, {}) };
}
function nudgeRow(row) {
  return row && { ...row, urgent: flag(row.urgent), info: flag(row.info), must_confirm: flag(row.must_confirm),
    wake_me: flag(row.wake_me), user_asked: flag(row.user_asked), attempts: Number(row.attempts),
    grace_minutes: Number(row.grace_minutes) };
}

export function brainStore(driver) {
  const one = async (sql, params) => (await driver.all(sql, params))[0];
  const skipLocked = driver.pg ? ' FOR UPDATE SKIP LOCKED' : '';

  async function upsertMemory(userId, record, now) {
    const tombstoned = await one('SELECT 1 AS x FROM steph_tombstones WHERE user_id = ? AND source_ref = ?',
      [userId, record.source_ref]);
    if (tombstoned) return false;
    await driver.run(`INSERT INTO steph_memories (id, user_id, source_ref, type, summary, people, place, time, source,
        confidence, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, source_ref) DO UPDATE SET type = excluded.type, summary = excluded.summary,
        people = excluded.people, place = excluded.place, time = excluded.time, source = excluded.source,
        confidence = excluded.confidence, details = excluded.details, updated_at = excluded.updated_at`,
    [newId('m'), userId, record.source_ref, record.type, record.summary, JSON.stringify(record.people ?? []),
      record.place ?? null, record.time ?? null, record.source, record.confidence ?? 0.8,
      JSON.stringify(record.details ?? {}), now, now]);
    return true;
  }

  async function tombstone(userId, sourceRefs, now) {
    for (const ref of sourceRefs) {
      await driver.run(`INSERT INTO steph_tombstones (user_id, source_ref, deleted_at) VALUES (?, ?, ?)
        ON CONFLICT (user_id, source_ref) DO UPDATE SET deleted_at = excluded.deleted_at`, [userId, ref, now]);
    }
  }

  return {
    // Users and sign-in.
    async createUser(fields, now) {
      const id = fields.id ?? newId('u');
      await driver.run(`INSERT INTO steph_users (id, name, role, phone, google_email, apple_sub, caregiver_id, owner,
          time_zone, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, fields.name ?? null, fields.role ?? 'self', fields.phone ?? null, fields.google_email ?? null,
        fields.apple_sub ?? null, fields.caregiver_id ?? null, fields.owner ? 1 : 0, fields.time_zone ?? null,
        JSON.stringify(fields.settings ?? {}), now, now]);
      return this.user(id);
    },
    async user(id) {
      return userRow(await one('SELECT * FROM steph_users WHERE id = ?', [id]));
    },
    async userBy(column, value) {
      if (!['phone', 'google_email', 'apple_sub'].includes(column) || !value) return undefined;
      return userRow(await one(`SELECT * FROM steph_users WHERE ${column} = ?`, [value]));
    },
    async users() {
      return (await driver.all('SELECT * FROM steph_users ORDER BY created_at', [])).map(userRow);
    },
    async ownerUser() {
      return userRow(await one('SELECT * FROM steph_users WHERE owner = 1 ORDER BY updated_at DESC', []));
    },
    async updateUser(id, fields, now) {
      const keys = Object.keys(fields).filter(key => USER_FIELDS.includes(key));
      if (!keys.length) return this.user(id);
      const values = keys.map(key => key === 'settings' ? JSON.stringify(fields[key])
        : key === 'owner' ? (fields[key] ? 1 : 0) : fields[key]);
      await driver.run(`UPDATE steph_users SET ${keys.map(key => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        [...values, now, id]);
      return this.user(id);
    },
    // The owner is the person whose household data (Google, camera) Steph serves.
    async setOwner(id, now) {
      await driver.run('UPDATE steph_users SET owner = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ?', [id, now]);
    },
    async mergeUser(fromId, toId) {
      for (const table of USER_TABLES) await driver.run(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`, [toId, fromId]);
      await driver.run('DELETE FROM steph_users WHERE id = ?', [fromId]);
    },
    async createSession(tokenHash, userId, now) {
      await driver.run('INSERT INTO steph_sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
        [tokenHash, userId, now, now]);
    },
    async sessionUser(tokenHash) {
      const row = await one('SELECT user_id FROM steph_sessions WHERE token_hash = ?', [tokenHash]);
      return row && this.user(row.user_id);
    },
    async deleteSessions(userId) {
      await driver.run('DELETE FROM steph_sessions WHERE user_id = ?', [userId]);
    },
    async saveLoginCode(codeHash, userId, expiresAt) {
      await driver.run('INSERT INTO steph_login_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)', [codeHash, userId, expiresAt]);
    },
    // Single use: the row is deleted by whichever request takes it first.
    async takeLoginCode(codeHash, now) {
      const row = await one('DELETE FROM steph_login_codes WHERE code_hash = ? RETURNING user_id, expires_at', [codeHash]);
      return row && row.expires_at > now ? row.user_id : undefined;
    },
    async saveLoginIntent(state, mode, userId, now) {
      await driver.run('INSERT INTO steph_login_intents (state, mode, user_id, created_at) VALUES (?, ?, ?, ?)',
        [state, mode, userId ?? null, now]);
    },
    async loginIntent(state) {
      return one('SELECT * FROM steph_login_intents WHERE state = ?', [state]);
    },
    async takeLoginIntent(state) {
      return one('DELETE FROM steph_login_intents WHERE state = ? RETURNING *', [state]);
    },
    async savePhoneCode(userId, purpose, phone, codeHash, expiresAt) {
      await driver.run(`INSERT INTO steph_phone_codes (user_id, purpose, phone, code_hash, expires_at, attempts)
        VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (user_id, purpose) DO UPDATE SET phone = excluded.phone,
        code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      [userId, purpose, phone, codeHash, expiresAt]);
    },
    // Counts the attempt before comparing, so concurrent guesses cannot exceed the limit.
    async attemptPhoneCode(userId, purpose) {
      return one(`UPDATE steph_phone_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?
        RETURNING phone, code_hash, expires_at, attempts`, [userId, purpose]);
    },
    async deletePhoneCode(userId, purpose) {
      await driver.run('DELETE FROM steph_phone_codes WHERE user_id = ? AND purpose = ?', [userId, purpose]);
    },
    async recordPhoneSend(userId, now) {
      await driver.run('INSERT INTO steph_phone_sends (user_id, sent_at) VALUES (?, ?)', [userId, now]);
    },
    async phoneSendsSince(userId, since) {
      return Number((await one('SELECT COUNT(*) AS n FROM steph_phone_sends WHERE user_id = ? AND sent_at > ?', [userId, since])).n);
    },
    async pruneAuth(before) {
      await driver.run('DELETE FROM steph_login_intents WHERE created_at < ?', [before]);
      await driver.run('DELETE FROM steph_login_codes WHERE expires_at < ?', [before]);
      await driver.run('DELETE FROM steph_phone_sends WHERE sent_at < ?', [before]);
    },

    // Memories.
    async upsertMemories(userId, records, now) {
      let count = 0;
      for (const record of records) if (await upsertMemory(userId, record, now)) count++;
      return count;
    },
    // Replaces one source's memories (e.g. 'google-contacts') with a fresh full copy.
    async replaceSource(userId, source, records, now) {
      const keep = new Set(records.map(record => record.source_ref));
      const existing = await driver.all('SELECT source_ref FROM steph_memories WHERE user_id = ? AND source = ?', [userId, source]);
      for (const { source_ref } of existing) {
        if (!keep.has(source_ref)) await driver.run('DELETE FROM steph_memories WHERE user_id = ? AND source_ref = ?', [userId, source_ref]);
      }
      return this.upsertMemories(userId, records, now);
    },
    // Deletes a whole source family (e.g. 'google-') without tombstoning: a reconnect may re-add it.
    async deleteSourcePrefix(userId, prefix) {
      return driver.run('DELETE FROM steph_memories WHERE user_id = ? AND source LIKE ?', [userId, `${prefix}%`]);
    },
    // "Forget that": delete everywhere and tombstone so no sync brings it back.
    async forgetMemory(userId, id, now) {
      const row = await one('DELETE FROM steph_memories WHERE user_id = ? AND id = ? RETURNING source_ref, summary', [userId, id]);
      if (row) await tombstone(userId, [row.source_ref], now);
      return row;
    },
    // The phone deleted its copy (a photo or contact is gone): no tombstone, it may come back.
    async deleteSourceRefs(userId, sourceRefs) {
      for (const ref of sourceRefs) await driver.run('DELETE FROM steph_memories WHERE user_id = ? AND source_ref = ?', [userId, ref]);
    },
    async forgetSourceRefs(userId, sourceRefs, now) {
      for (const ref of sourceRefs) await driver.run('DELETE FROM steph_memories WHERE user_id = ? AND source_ref = ?', [userId, ref]);
      await tombstone(userId, sourceRefs, now);
    },
    async memory(userId, id) {
      return memoryRow(await one('SELECT * FROM steph_memories WHERE user_id = ? AND id = ?', [userId, id]));
    },
    async memoriesByIds(userId, ids) {
      const out = [];
      for (const id of ids) {
        const row = await this.memory(userId, id);
        if (row) out.push(row);
      }
      return out;
    },
    // Candidate rows for lexical search; ranking happens in memory.mjs.
    async memoryCandidates(userId, { words = [], from, to, types, limit = 300 } = {}) {
      const where = ['user_id = ?'];
      const params = [userId];
      if (words.length) {
        where.push(`(${words.map(() => "LOWER(summary || ' ' || people || ' ' || COALESCE(place, '') || ' ' || details) LIKE ?").join(' OR ')})`);
        params.push(...words.map(word => `%${word}%`));
      }
      if (from) { where.push('time >= ?'); params.push(from); }
      if (to) { where.push('time < ?'); params.push(to); }
      if (types?.length) { where.push(`type IN (${types.map(() => '?').join(', ')})`); params.push(...types); }
      const rows = await driver.all(`SELECT * FROM steph_memories WHERE ${where.join(' AND ')}
        ORDER BY time DESC LIMIT ?`, [...params, limit]);
      return rows.map(memoryRow);
    },
    async memoryCount(userId) {
      return Number((await one('SELECT COUNT(*) AS n FROM steph_memories WHERE user_id = ?', [userId])).n);
    },
    async sourceCounts(userId) {
      return driver.all('SELECT source, COUNT(*) AS n, MAX(updated_at) AS last FROM steph_memories WHERE user_id = ? GROUP BY source', [userId]);
    },
    async tombstonesSince(userId, since) {
      return driver.all('SELECT source_ref, deleted_at FROM steph_tombstones WHERE user_id = ? AND deleted_at > ? ORDER BY deleted_at',
        [userId, since]);
    },

    // Timeline: every exchange on every channel. A ref makes inbound events idempotent.
    async addTimeline(entry) {
      const id = entry.id ?? newId('t');
      const inserted = await driver.run(`INSERT INTO steph_timeline (id, user_id, channel, direction, text, at, ref, kind,
          call_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [id, entry.user_id, entry.channel, entry.direction, entry.text, entry.at, entry.ref ?? null, entry.kind ?? null,
        entry.call_id ?? null, JSON.stringify(entry.meta ?? {})]);
      return inserted ? { ...entry, id } : undefined;
    },
    async timeline(userId, { before, since, limit = 50, channel } = {}) {
      const where = ['user_id = ?'];
      const params = [userId];
      if (before) { where.push('at < ?'); params.push(before); }
      if (since) { where.push('at >= ?'); params.push(since); }
      if (channel) { where.push('channel = ?'); params.push(channel); }
      return (await driver.all(`SELECT * FROM steph_timeline WHERE ${where.join(' AND ')} ORDER BY at DESC, CASE WHEN direction = 'out' THEN 1 ELSE 0 END DESC, id DESC LIMIT ?`,
        [...params, limit])).map(timelineRow);
    },
    async timelineByRef(ref) {
      return timelineRow(await one('SELECT * FROM steph_timeline WHERE ref = ?', [ref]));
    },
    async timelineEntry(userId, id) {
      return timelineRow(await one('SELECT * FROM steph_timeline WHERE user_id = ? AND id = ?', [userId, id]));
    },
    async markSeen(userId, id, now) {
      return driver.run('UPDATE steph_timeline SET seen_at = COALESCE(seen_at, ?) WHERE user_id = ? AND id = ?', [now, userId, id]);
    },
    async markOpened(userId, id, now) {
      return driver.run('UPDATE steph_timeline SET opened_at = COALESCE(opened_at, ?), seen_at = COALESCE(seen_at, ?) WHERE user_id = ? AND id = ?',
        [now, now, userId, id]);
    },
    async latestEntry(userId, { channel, direction, since, kind } = {}) {
      const where = ['user_id = ?'];
      const params = [userId];
      for (const [column, value] of [['channel', channel], ['direction', direction], ['kind', kind]]) {
        if (value) { where.push(`${column} = ?`); params.push(value); }
      }
      if (since) { where.push('at >= ?'); params.push(since); }
      return timelineRow(await one(`SELECT * FROM steph_timeline WHERE ${where.join(' AND ')} ORDER BY at DESC, CASE WHEN direction = 'out' THEN 1 ELSE 0 END DESC, id DESC LIMIT 1`, params));
    },

    // Channel decisions (Diagnostics) and the daily caps they feed.
    async addDecision(decision) {
      await driver.run(`INSERT INTO steph_decisions (id, user_id, at, item, channel, rule, reason, counted, ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('d'), decision.user_id, decision.at, decision.item, decision.channel, decision.rule, decision.reason,
        decision.counted ? 1 : 0, decision.ref ?? null]);
    },
    async hasDecision(userId, rule, ref) {
      return Boolean(await one('SELECT 1 AS x FROM steph_decisions WHERE user_id = ? AND rule = ? AND ref = ?', [userId, rule, ref]));
    },
    async decisions(userId, limit = 50) {
      return driver.all('SELECT at, item, channel, rule, reason, ref FROM steph_decisions WHERE user_id = ? ORDER BY at DESC LIMIT ?',
        [userId, limit]);
    },
    async countedSince(userId, channel, since) {
      return Number((await one('SELECT COUNT(*) AS n FROM steph_decisions WHERE user_id = ? AND channel = ? AND counted = 1 AND at >= ?',
        [userId, channel, since])).n);
    },

    // Push devices.
    async saveDevice(token, userId, environment, now) {
      await driver.run(`INSERT INTO steph_devices (apns_token, user_id, environment, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (apns_token) DO UPDATE SET user_id = excluded.user_id, environment = excluded.environment`,
      [token, userId, environment, now]);
    },
    async devices(userId) {
      return driver.all('SELECT apns_token, environment FROM steph_devices WHERE user_id = ?', [userId]);
    },
    async deleteDevice(token) {
      await driver.run('DELETE FROM steph_devices WHERE apns_token = ?', [token]);
    },

    // Actions Steph may only take after a spoken or tapped yes.
    async addPending(pending) {
      const id = newId('pa');
      await driver.run(`INSERT INTO steph_pending (id, user_id, kind, payload, summary, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, pending.user_id, pending.kind, JSON.stringify(pending.payload), pending.summary, pending.created_at, pending.expires_at]);
      return id;
    },
    async latestPending(userId, now) {
      const row = await one(`SELECT * FROM steph_pending WHERE user_id = ? AND resolved_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`, [userId, now]);
      return row && { ...row, payload: json(row.payload, {}) };
    },
    // Resolves exactly once; a second confirmation finds nothing.
    async resolvePending(userId, id, now) {
      const row = await one(`UPDATE steph_pending SET resolved_at = ? WHERE user_id = ? AND id = ? AND resolved_at IS NULL
        AND expires_at > ? RETURNING *`, [now, userId, id, now]);
      return row && { ...row, payload: json(row.payload, {}) };
    },

    // Nudges: everything Steph delivers later (reminders, medication, briefings, leave-by texts).
    async addNudge(nudge) {
      const id = nudge.id ?? newId('n');
      const inserted = await driver.run(`INSERT INTO steph_nudges (id, user_id, kind, text, due_at, channel, urgent, info,
          must_confirm, wake_me, user_asked, grace_minutes, status, dedupe_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?) ON CONFLICT DO NOTHING`,
      [id, nudge.user_id, nudge.kind, nudge.text, nudge.due_at, nudge.channel ?? 'auto', nudge.urgent ? 1 : 0,
        nudge.info ? 1 : 0, nudge.must_confirm ? 1 : 0, nudge.wake_me ? 1 : 0, nudge.user_asked ? 1 : 0,
        nudge.grace_minutes ?? 15, nudge.dedupe_key ?? null, nudge.created_at, nudge.created_at]);
      return inserted ? this.nudge(id) : undefined;
    },
    async nudge(id) {
      return nudgeRow(await one('SELECT * FROM steph_nudges WHERE id = ?', [id]));
    },
    async upcomingNudges(userId, { limit = 10, kinds } = {}) {
      const kindFilter = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
      return (await driver.all(`SELECT * FROM steph_nudges WHERE user_id = ? AND status = 'scheduled'${kindFilter}
        ORDER BY due_at LIMIT ?`, [userId, ...(kinds ?? []), limit])).map(nudgeRow);
    },
    async cancelNudge(userId, id, now) {
      return (await driver.run(`UPDATE steph_nudges SET status = 'canceled', updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'scheduled'`, [now, id, userId])) > 0;
    },
    async claimDueNudges(now, leaseUntil, limit = 10) {
      return (await driver.all(`UPDATE steph_nudges SET status = 'sending', attempts = attempts + 1, lease_until = ?, updated_at = ?
        WHERE id IN (SELECT id FROM steph_nudges
          WHERE (status = 'scheduled' AND due_at <= ?) OR (status = 'sending' AND lease_until < ?)
          ORDER BY due_at LIMIT ?${skipLocked}) RETURNING *`, [leaseUntil, now, now, now, limit])).map(nudgeRow);
    },
    // Conditional transition: only the request that still sees fromStatus wins.
    async updateNudge(id, fromStatus, fields, now) {
      const keys = Object.keys(fields).filter(key => NUDGE_FIELDS.includes(key));
      const values = keys.map(key => key === 'urgent' ? (fields[key] ? 1 : 0) : fields[key]);
      return (await driver.run(`UPDATE steph_nudges SET ${[...keys.map(key => `${key} = ?`), 'lease_until = NULL', 'updated_at = ?'].join(', ')}
        WHERE id = ? AND status = ?`, [...values, now, id, fromStatus])) > 0;
    },
    async nudgeByCall(callId) {
      return nudgeRow(await one('SELECT * FROM steph_nudges WHERE call_id = ?', [callId]));
    },
    async nudgesInStatus(status, before, limit = 20) {
      return (await driver.all(`SELECT * FROM steph_nudges WHERE status = ? AND updated_at < ? ORDER BY updated_at LIMIT ?`,
        [status, before, limit])).map(nudgeRow);
    },
    async openNudge(userId, kind, now) {
      return nudgeRow(await one(`SELECT * FROM steph_nudges WHERE user_id = ? AND kind = ? AND status IN ('awaiting', 'calling', 'pushed')
        AND due_at <= ? ORDER BY due_at DESC LIMIT 1`, [userId, kind, now]));
    },
    async nextCall(userId, now, until) {
      return nudgeRow(await one(`SELECT * FROM steph_nudges WHERE user_id = ? AND status = 'scheduled' AND channel = 'call'
        AND due_at >= ? AND due_at <= ? ORDER BY due_at LIMIT 1`, [userId, now, until]));
    },
    async activeCall(userId) {
      return nudgeRow(await one(`SELECT * FROM steph_nudges WHERE user_id = ? AND status = 'calling' ORDER BY updated_at DESC LIMIT 1`, [userId]));
    },
  };
}

export function sqliteDriver(db) {
  return {
    pg: false,
    async all(sql, params = []) { return db.prepare(sql).all(...params); },
    async run(sql, params = []) { return Number(db.prepare(sql).run(...params).changes); },
  };
}

export function postgresDriver(pool) {
  const number = sql => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
  return {
    pg: true,
    async all(sql, params = []) { return (await pool.query(number(sql), params)).rows; },
    async run(sql, params = []) { return (await pool.query(number(sql), params)).rowCount; },
  };
}
