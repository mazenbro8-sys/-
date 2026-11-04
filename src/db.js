import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DATA_DIR, config } from './config.js';

export const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'mashwar.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
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

export const getSetting = (k, def) =>
  db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? def;
export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
export const commission = () => Number(getSetting('commission', config.defaultCommission));

export const audit = (actor, action, data) =>
  db.prepare('INSERT INTO audit(actor_id,action,data,at) VALUES(?,?,?,?)').run(actor ?? null, action, data ? JSON.stringify(data) : null, Date.now());

export const addEvent = (orderId, type, actor, data) =>
  db.prepare('INSERT INTO order_events(order_id,type,actor_id,data,at) VALUES(?,?,?,?,?)').run(orderId, type, actor ?? null, data ? JSON.stringify(data) : null, Date.now());

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// --- Seed or Sync: default zone + admin ---
if (!db.prepare('SELECT 1 FROM zones').get()) {
  db.prepare('INSERT INTO zones(name) VALUES (?)').run('المزة');
}
const adminPhone = (process.env.DB_FILE && process.env.ADMIN_PHONE) || '0782070936';
const adminPass = (process.env.DB_FILE && process.env.ADMIN_PASSWORD) || 'asd123';
tx(() => {
  db.prepare('UPDATE users SET failed_logins=0, locked_until=0 WHERE failed_logins>0 OR locked_until>0').run();
  const existingAdmin = db.prepare("SELECT * FROM users WHERE role='admin'").get();
  if (!existingAdmin) {
    const conflict = db.prepare('SELECT id FROM users WHERE phone=?').get(adminPhone);
    if (conflict) db.prepare('UPDATE users SET phone=? WHERE id=?').run(`${adminPhone}_old_${conflict.id}`, conflict.id);
    db.prepare("INSERT INTO users(role,phone,name,pass_hash,status,created_at) VALUES('admin',?,?,?,'active',?)")
      .run(adminPhone, 'المدير', bcrypt.hashSync(adminPass, 12), Date.now());
    console.log('\n=== تم إنشاء حساب المدير ===');
    console.log(`الهاتف: ${adminPhone}`);
    console.log('============================\n');
  } else {
    const conflict = db.prepare('SELECT id FROM users WHERE phone=? AND id<>?').get(adminPhone, existingAdmin.id);
    if (conflict) db.prepare('UPDATE users SET phone=? WHERE id=?').run(`${adminPhone}_old_${conflict.id}`, conflict.id);
    const sameCreds = existingAdmin.phone === adminPhone && bcrypt.compareSync(adminPass, existingAdmin.pass_hash);
    if (!sameCreds) {
      db.prepare("UPDATE users SET phone=?, pass_hash=?, token_version=token_version+1, failed_logins=0, locked_until=0, status='active' WHERE id=?")
        .run(adminPhone, bcrypt.hashSync(adminPass, 12), existingAdmin.id);
      console.log('\n=== تم تحديث بيانات المدير وفك قفل الحساب بنجاح ===');
      console.log(`الهاتف: ${adminPhone}`);
      console.log('====================================================\n');
    } else if (existingAdmin.status !== 'active') {
      db.prepare("UPDATE users SET status='active' WHERE id=?").run(existingAdmin.id);
    }
  }

  // Ensure owner admin account (0782070936 / asd123) always works even if cloud env vars differ
  if (!process.env.DB_FILE && adminPhone !== '0782070936') {
    const owner = db.prepare('SELECT * FROM users WHERE phone=?').get('0782070936');
    if (!owner) {
      db.prepare("INSERT INTO users(role,phone,name,pass_hash,status,created_at) VALUES('admin','0782070936','المدير',?,'active',?)")
        .run(bcrypt.hashSync('asd123', 12), Date.now());
    } else if (owner.role !== 'admin' || owner.status !== 'active' || !bcrypt.compareSync('asd123', owner.pass_hash)) {
      db.prepare("UPDATE users SET role='admin', status='active', pass_hash=?, failed_logins=0, locked_until=0 WHERE id=?")
        .run(bcrypt.hashSync('asd123', 12), owner.id);
    }
  }

  // On ephemeral cloud containers (e.g. Render free tier), restore core accounts on fresh DB boot
  if (!process.env.DB_FILE && !db.prepare("SELECT 1 FROM users WHERE role IN ('merchant','captain') LIMIT 1").get()) {
    const z1 = db.prepare('SELECT id FROM zones ORDER BY id LIMIT 1').get()?.id ?? 1;
    const now = Date.now();
    const defaultHash = bcrypt.hashSync('asd123', 12);
    const ins = db.prepare('INSERT INTO users(role,phone,name,pass_hash,zone_id,status,business_name,address,lat,lng,last_lat,last_lng,last_loc_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('merchant', '0796149466', 'تورينو', defaultHash, z1, 'active', 'تورينو', 'دمشق', 33.5001785, 36.2913831, null, null, null, now);
    ins.run('captain', '123123123', 'مازن', defaultHash, z1, 'active', null, null, null, null, 32.0034088, 35.9579298, now, now);
    ins.run('captain', '0922000001', 'ياسر', defaultHash, z1, 'active', null, null, null, null, 32.0030816, 35.9584115, now, now);
  }
});
