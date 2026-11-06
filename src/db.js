import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { DATA_DIR, config } from './config.js';

const tursoUrl = !process.env.DB_FILE && process.env.TURSO_DATABASE_URL ? process.env.TURSO_DATABASE_URL.trim() : '';
const isRemote = Boolean(tursoUrl);
const localDbPath = process.env.DB_FILE || path.join(DATA_DIR, 'mashwar.db');

export const client = isRemote
  ? createClient({
      url: tursoUrl,
      authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined,
    })
  : createClient({
      url: pathToFileURL(path.resolve(localDbPath)).href,
    });

const txStore = new AsyncLocalStorage();
const runner = () => txStore.getStore() || client;
const normArgs = (args) => args.map((a) => (a === undefined ? null : a));

export const db = {
  client,
  isRemote,
  async get(sql, ...args) {
    const rs = await runner().execute({ sql, args: normArgs(args) });
    return rs.rows.length ? { ...rs.rows[0] } : undefined;
  },
  async all(sql, ...args) {
    const rs = await runner().execute({ sql, args: normArgs(args) });
    return rs.rows.map((r) => ({ ...r }));
  },
  async run(sql, ...args) {
    const rs = await runner().execute({ sql, args: normArgs(args) });
    return {
      changes: rs.rowsAffected,
      lastInsertRowid: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : 0,
    };
  },
  prepare(sql) {
    return {
      get: (...args) => db.get(sql, ...args),
      all: (...args) => db.all(sql, ...args),
      run: (...args) => db.run(sql, ...args),
    };
  },
};

export async function tx(fn) {
  if (txStore.getStore()) return await fn();
  const trx = await client.transaction('write');
  try {
    const r = await txStore.run(trx, fn);
    await trx.commit();
    return r;
  } catch (e) {
    try { await trx.rollback(); } catch {}
    throw e;
  } finally {
    try { trx.close(); } catch {}
  }
}

if (!isRemote) {
  await client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
} else {
  try { await client.execute('PRAGMA foreign_keys = ON'); } catch {}
}

await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('admin','merchant','captain','customer')),
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  zone_id INTEGER REFERENCES zones(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  business_name TEXT, address TEXT, lat REAL, lng REAL,
  online INTEGER NOT NULL DEFAULT 0,
  last_lat REAL, last_lng REAL, last_loc_at INTEGER,
  last_assigned_at INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES users(id),
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, customer_address TEXT NOT NULL,
  customer_lat REAL, customer_lng REAL,
  product_amount INTEGER NOT NULL DEFAULT 0,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'searching'
    CHECK (status IN ('searching','offered','accepted','picked_up','arrived','delivered','cancelled','failed','expired')),
  captain_id INTEGER REFERENCES users(id),
  offered_captain_id INTEGER REFERENCES users(id),
  offer_expires_at INTEGER,
  commission INTEGER NOT NULL DEFAULT 0,
  liability INTEGER NOT NULL DEFAULT 0,
  liability_reason TEXT,
  close_reason TEXT,
  day TEXT,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER, picked_at INTEGER, closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, zone_id);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_captain ON orders(captain_id, day);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL, actor_id INTEGER, data TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  captain_id INTEGER NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|timeout|cancelled
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_order ON offers(order_id);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captain_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL NOT NULL, lng REAL NOT NULL, order_id INTEGER, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loc_captain ON locations(captain_id, at);
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captain_id INTEGER NOT NULL REFERENCES users(id),
  merchant_id INTEGER, reason TEXT NOT NULL, at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settlements (
  captain_id INTEGER NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  orders_count INTEGER NOT NULL, commission_total INTEGER NOT NULL,
  liability_total INTEGER NOT NULL, total INTEGER NOT NULL,
  collected_at INTEGER NOT NULL, collected_by INTEGER,
  PRIMARY KEY (captain_id, day)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER, action TEXT NOT NULL, data TEXT, at INTEGER NOT NULL
);
`);

export const getSetting = async (k, def) =>
  (await db.get('SELECT value FROM settings WHERE key=?', k))?.value ?? def;
export const setSetting = (k, v) =>
  db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));
export const commission = async () => Number(await getSetting('commission', config.defaultCommission));

export const audit = (actor, action, data) =>
  db.run('INSERT INTO audit(actor_id,action,data,at) VALUES(?,?,?,?)', actor ?? null, action, data ? JSON.stringify(data) : null, Date.now());

export const addEvent = (orderId, type, actor, data) =>
  db.run('INSERT INTO order_events(order_id,type,actor_id,data,at) VALUES(?,?,?,?,?)', orderId, type, actor ?? null, data ? JSON.stringify(data) : null, Date.now());

// --- Seed or Sync: default zone + admin ---
if (!(await db.get('SELECT 1 FROM zones LIMIT 1'))) {
  await db.run('INSERT INTO zones(name) VALUES (?)', 'المزة');
}
const OWNER_ADMIN_PASS = 'admin1234';
const adminPhone = (process.env.DB_FILE && process.env.ADMIN_PHONE) || '0782070936';
const adminPass = (process.env.DB_FILE && process.env.ADMIN_PASSWORD) || OWNER_ADMIN_PASS;
await tx(async () => {
  await db.run('UPDATE users SET failed_logins=0, locked_until=0 WHERE failed_logins>0 OR locked_until>0');
  const existingAdmin = await db.get("SELECT * FROM users WHERE role='admin'");
  if (!existingAdmin) {
    const conflict = await db.get('SELECT id FROM users WHERE phone=?', adminPhone);
    if (conflict) await db.run('UPDATE users SET phone=? WHERE id=?', `${adminPhone}_old_${conflict.id}`, conflict.id);
    await db.run(
      "INSERT INTO users(role,phone,name,pass_hash,status,created_at) VALUES('admin',?,?,?,'active',?)",
      adminPhone,
      'المدير',
      bcrypt.hashSync(adminPass, 12),
      Date.now()
    );
    console.log('\n=== تم إنشاء حساب المدير ===');
    console.log(`الهاتف: ${adminPhone}`);
    console.log('============================\n');
  } else {
    if (existingAdmin.status !== 'active') {
      await db.run("UPDATE users SET status='active' WHERE id=?", existingAdmin.id);
    }
    if (process.env.DB_FILE && process.env.ADMIN_PASSWORD) {
      const sameCreds = existingAdmin.phone === adminPhone && bcrypt.compareSync(adminPass, existingAdmin.pass_hash);
      if (!sameCreds) {
        await db.run(
          "UPDATE users SET phone=?, pass_hash=?, token_version=token_version+1, failed_logins=0, locked_until=0, status='active' WHERE id=?",
          adminPhone,
          bcrypt.hashSync(adminPass, 12),
          existingAdmin.id
        );
      }
    }
  }
});
