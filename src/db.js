// SQLite persistence layer. Uses the built-in `node:sqlite` (synchronous,
// no native build step) rather than better-sqlite3 — same API shape, but it
// avoids native compilation on bleeding-edge Node versions.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = join(__dirname, '..', 'data', 'mdns.db');

const DEFAULT_SETTINGS = {
  rebroadcast_enabled: '1',
  rebroadcast_interval_seconds: '5',
  rediscovery_interval_seconds: '60',
};

let db;

export function initDb(dbPath = process.env.MDNS_DB_PATH || DEFAULT_DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id            INTEGER PRIMARY KEY,
      instance_name TEXT NOT NULL UNIQUE,
      service_type  TEXT NOT NULL,
      host          TEXT,
      port          INTEGER,
      rebroadcast   INTEGER NOT NULL DEFAULT 0,
      first_seen    TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      id          INTEGER PRIMARY KEY,
      service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      name        TEXT NOT NULL,
      ttl         INTEGER NOT NULL,
      data        TEXT NOT NULL,
      UNIQUE(service_id, type, name, data)
    );

    CREATE INDEX IF NOT EXISTS idx_records_service ON records(service_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, value);
  }

  return db;
}

// --- Settings ---------------------------------------------------------------

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

export function getNumberSetting(key, fallback) {
  const v = Number(getSetting(key));
  return Number.isFinite(v) ? v : fallback;
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

// --- Services & records -----------------------------------------------------

/**
 * Upsert a discovered service and replace its cached records in one transaction.
 * `records` is an array of already-serialised `{ type, name, ttl, data }` rows.
 */
export function upsertService({ instanceName, serviceType, host, port, records }, now) {
  // node:sqlite has no .transaction() helper, so manage the transaction manually.
  db.exec('BEGIN');
  try {
    const existing = db
      .prepare('SELECT id, first_seen FROM services WHERE instance_name = ?')
      .get(instanceName);

    let serviceId;
    if (existing) {
      serviceId = existing.id;
      db.prepare(
        `UPDATE services SET service_type = ?, host = ?, port = ?, last_seen = ?
         WHERE id = ?`,
      ).run(serviceType, host ?? null, port ?? null, now, serviceId);
    } else {
      const info = db
        .prepare(
          `INSERT INTO services (instance_name, service_type, host, port, rebroadcast, first_seen, last_seen)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(instanceName, serviceType, host ?? null, port ?? null, now, now);
      serviceId = Number(info.lastInsertRowid);
    }

    // Replace cached records wholesale — keeps the cache faithful to the latest
    // observation and avoids accumulating superseded rdata.
    db.prepare('DELETE FROM records WHERE service_id = ?').run(serviceId);
    const insertRec = db.prepare(
      `INSERT OR IGNORE INTO records (service_id, type, name, ttl, data)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of records) {
      insertRec.run(serviceId, r.type, r.name, r.ttl, r.data);
    }

    db.exec('COMMIT');
    return serviceId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listServices() {
  const services = db
    .prepare(
      `SELECT id, instance_name, service_type, host, port, rebroadcast, first_seen, last_seen,
              (SELECT COUNT(*) FROM records WHERE records.service_id = services.id) AS record_count
       FROM services ORDER BY service_type, instance_name`,
    )
    .all();
  // Surface the cached A/AAAA addresses (the IPs we actually rebroadcast).
  const addrStmt = db.prepare(
    "SELECT type, data FROM records WHERE service_id = ? AND type IN ('A', 'AAAA')",
  );
  return services.map((s) => {
    const addrs = addrStmt.all(s.id);
    const pick = (t) => addrs.filter((a) => a.type === t).map((a) => JSON.parse(a.data));
    return { ...s, rebroadcast: !!s.rebroadcast, ipv4: pick('A'), ipv6: pick('AAAA') };
  });
}

export function setRebroadcast(serviceId, enabled) {
  const info = db
    .prepare('UPDATE services SET rebroadcast = ? WHERE id = ?')
    .run(enabled ? 1 : 0, serviceId);
  return info.changes > 0;
}

/** Services flagged for rebroadcast, each with its full cached record set. */
export function getRebroadcastServicesWithRecords() {
  const services = db
    .prepare('SELECT id, instance_name FROM services WHERE rebroadcast = 1')
    .all();
  const recStmt = db.prepare(
    'SELECT type, name, ttl, data FROM records WHERE service_id = ?',
  );
  return services.map((s) => ({
    id: s.id,
    instanceName: s.instance_name,
    records: recStmt.all(s.id),
  }));
}

export function deleteService(serviceId) {
  return db.prepare('DELETE FROM services WHERE id = ?').run(serviceId).changes > 0;
}

export function getDb() {
  return db;
}
