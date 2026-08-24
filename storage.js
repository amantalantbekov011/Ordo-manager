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
