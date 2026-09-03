'use strict';

const fs = require('node:fs');
const path = require('node:path');

const clone = value => JSON.parse(JSON.stringify(value));

class FileStorage {
  constructor(file) { this.file = file; }
  async init() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); }
  async load() {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }
  async save(value) {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }
  async backup(label = 'manual') {
    if (!fs.existsSync(this.file)) return null;
    const target = `${this.file}.${label}-${Date.now()}.backup`;
    fs.copyFileSync(this.file, target);
    return target;
  }
  async health() { return { driver: 'json', connected: true }; }
  async close() {}
}

class PostgresStorage {
  constructor(connectionString) {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_SIZE) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
    this.queue = Promise.resolve();
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ordo_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ordo_state_backups (
        id BIGSERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        reason TEXT NOT NULL DEFAULT 'automatic',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ordo_state_backups_created_idx ON ordo_state_backups(created_at DESC);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, type TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_members (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL, last_read_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, data JSONB NOT NULL,
        UNIQUE(conversation_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, read_at BIGINT, type TEXT NOT NULL DEFAULT 'text', attachment_url TEXT, data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members(user_id);
    `);
  }
  async load() {
    const result = await this.pool.query('SELECT data FROM ordo_state WHERE id = 1');
    return result.rows[0]?.data || null;
  }
  async save(value) {
    const snapshot = clone(value);
    this.queue = this.queue.then(async () => {
      await this.pool.query(`
        INSERT INTO ordo_state (id, data) VALUES (1, $1::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      `, [JSON.stringify(snapshot)]);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of snapshot.conversations || []) await client.query(`INSERT INTO conversations(id,company_id,type,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO UPDATE SET updated_at=EXCLUDED.updated_at,data=EXCLUDED.data`, [item.id,item.companyId,item.type||'direct',item.createdAt,item.updatedAt,JSON.stringify(item)]);
        for (const item of snapshot.conversationMembers || []) await client.query(`INSERT INTO conversation_members(id,company_id,conversation_id,user_id,last_read_at,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at,updated_at=EXCLUDED.updated_at,data=EXCLUDED.data`, [item.id,item.companyId,item.conversationId,item.userId,item.lastReadAt||null,item.createdAt,item.updatedAt,JSON.stringify(item)]);
        for (const item of snapshot.messages || []) await client.query(`INSERT INTO messages(id,company_id,conversation_id,sender_id,text,created_at,updated_at,read_at,type,attachment_url,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(id) DO UPDATE SET text=EXCLUDED.text,updated_at=EXCLUDED.updated_at,read_at=EXCLUDED.read_at,data=EXCLUDED.data`, [item.id,item.companyId,item.conversationId,item.senderId,item.text||'',item.createdAt,item.updatedAt,item.readAt||null,item.type||'text',item.attachmentUrl||null,JSON.stringify(item)]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    });
    return this.queue;
  }
  async backup(reason = 'automatic') {
    await this.pool.query(`
      INSERT INTO ordo_state_backups (data, reason)
      SELECT data, $1 FROM ordo_state WHERE id = 1;
      DELETE FROM ordo_state_backups
      WHERE id NOT IN (SELECT id FROM ordo_state_backups ORDER BY created_at DESC LIMIT 30)
    `, [String(reason).slice(0, 100)]);
  }
  async ensureDailyBackup() {
    const result = await this.pool.query("SELECT 1 FROM ordo_state_backups WHERE created_at > NOW() - INTERVAL '24 hours' LIMIT 1");
    if (!result.rowCount) await this.backup('daily');
  }
  async health() {
    const result = await this.pool.query('SELECT NOW() AS now');
    return { driver: 'postgresql', connected: true, serverTime: result.rows[0].now };
  }
  async close() { await this.pool.end(); }
}

function createStorage({ databaseUrl, dataFile }) {
  return databaseUrl ? new PostgresStorage(databaseUrl) : new FileStorage(dataFile);
}

module.exports = { createStorage };
