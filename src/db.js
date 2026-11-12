import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
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
  role TEXT NOT NULL CHECK (role IN ('admin','zone_admin','merchant','captain','customer')),
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  zone_id INTEGER REFERENCES zones(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','deleted')),
  business_name TEXT, address TEXT, lat REAL, lng REAL,
  online INTEGER NOT NULL DEFAULT 0,
  last_lat REAL, last_lng REAL, last_loc_at INTEGER, last_loc_vis TEXT,
  last_assigned_at INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK (role != 'zone_admin' OR zone_id IS NOT NULL)
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
  delay_until INTEGER,
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

// Migrate existing databases where `users` was created before `zone_admin` role or `deleted` status existed
const usersMeta = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
if (usersMeta?.sql && (!usersMeta.sql.includes("'zone_admin'") || !usersMeta.sql.includes("'deleted'"))) {
  await client.executeMultiple(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS users_new;
    BEGIN TRANSACTION;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('admin','zone_admin','merchant','captain','customer')),
      phone TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      zone_id INTEGER REFERENCES zones(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','deleted')),
      business_name TEXT, address TEXT, lat REAL, lng REAL,
      online INTEGER NOT NULL DEFAULT 0,
      last_lat REAL, last_lng REAL, last_loc_at INTEGER, last_loc_vis TEXT,
      last_assigned_at INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      failed_logins INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      CHECK (role != 'zone_admin' OR zone_id IS NOT NULL)
    );
    INSERT INTO users_new (
      id, role, phone, name, pass_hash, zone_id, status,
      business_name, address, lat, lng, online,
      last_lat, last_lng, last_loc_at, last_assigned_at,
      token_version, failed_logins, locked_until, created_at
    )
    SELECT
      id, role, phone, name, pass_hash, zone_id, status,
      business_name, address, lat, lng, online,
      last_lat, last_lng, last_loc_at, last_assigned_at,
      token_version, failed_logins, locked_until, created_at
    FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// Migrate existing databases where `orders` was created before `delay_until` column existed
const ordersMeta = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'");
if (ordersMeta?.sql && !ordersMeta.sql.includes('delay_until')) {
  await client.execute('ALTER TABLE orders ADD COLUMN delay_until INTEGER');
}

// Migrate existing databases where `users` was created before `last_loc_vis` column existed
const usersVisMeta = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
if (usersVisMeta?.sql && !usersVisMeta.sql.includes('last_loc_vis')) {
  await client.execute('ALTER TABLE users ADD COLUMN last_loc_vis TEXT');
}

// F2: Immutable captain hashtag code column (`tag`, uppercase 5-char unambiguous code without leading '#')
const userColsF2 = await db.all('PRAGMA table_info(users)');
if (!userColsF2.some((c) => c.name === 'tag')) {
  await client.execute('ALTER TABLE users ADD COLUMN tag TEXT');
}
await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tag ON users(tag) WHERE tag IS NOT NULL');

const TAG_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Normalize a captain hashtag lookup string: strip leading '#' and uppercase. */
export const normalizeTag = (raw) => String(raw ?? '').trim().replace(/^#+/, '').toUpperCase();

/** Generate a unique 5-char unambiguous uppercase captain tag (no 0/O/1/I/L). */
export async function generateUniqueCaptainTag() {
  for (let attempt = 0; attempt < 32; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += TAG_ALPHABET[crypto.randomInt(0, TAG_ALPHABET.length)];
    }
    const taken = await db.get('SELECT 1 FROM users WHERE tag=?', code);
    if (!taken) return code;
  }
  throw new Error('Failed to generate unique captain tag');
}

await client.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`);

/** Run a named one-time migration idempotently inside a database write transaction. */
export async function runMigration(id, fn) {
  return tx(async () => {
    const already = await db.get('SELECT 1 FROM schema_migrations WHERE id=?', id);
    if (already) return false;
    await fn();
    await db.run('INSERT INTO schema_migrations(id, applied_at) VALUES (?,?)', id, Date.now());
    return true;
  });
}

// F1: Archive legacy SYP settlements and commission before introducing points wallet
await runMigration('2026_11_archive_syp', async () => {
  const now = Date.now();
  await db.run(
    "CREATE TABLE IF NOT EXISTS settlements_legacy_syp AS SELECT *, CAST('SYP' AS TEXT) AS currency, CAST(0 AS INTEGER) AS archived_at FROM settlements WHERE 0"
  );
  await db.run("INSERT INTO settlements_legacy_syp SELECT *, 'SYP', ? FROM settlements", now);
  const commRow = await db.get("SELECT value FROM settings WHERE key='commission'");
  if (commRow?.value != null) {
    await db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('legacy_commission_syp',?)", String(commRow.value));
  }
  await db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('points_cutover_at',?)", String(now));
});

// F2: Backfill existing captains (including soft-deleted) with immutable unique hashtag codes
await runMigration('2026_11_captain_tags', async () => {
  const captains = await db.all("SELECT id FROM users WHERE role='captain' AND (tag IS NULL OR tag='')");
  for (const c of captains) {
    const tag = await generateUniqueCaptainTag();
    await db.run('UPDATE users SET tag=? WHERE id=?', tag, c.id);
  }
});

// F3: Points wallet column on users and unified append-only points_ledger
const userColsF3 = await db.all('PRAGMA table_info(users)');
if (!userColsF3.some((c) => c.name === 'balance_points')) {
  await client.execute('ALTER TABLE users ADD COLUMN balance_points INTEGER NOT NULL DEFAULT 0');
}

// F5 & F6: Per-captain order cost overrides, temporary exemption bounds, and order cost snapshots
if (!userColsF3.some((c) => c.name === 'cost_override')) {
  await client.execute('ALTER TABLE users ADD COLUMN cost_override INTEGER');
}
if (!userColsF3.some((c) => c.name === 'exempt_from')) {
  await client.execute('ALTER TABLE users ADD COLUMN exempt_from INTEGER');
}
if (!userColsF3.some((c) => c.name === 'exempt_until')) {
  await client.execute('ALTER TABLE users ADD COLUMN exempt_until INTEGER');
}
const orderColsF5 = await db.all('PRAGMA table_info(orders)');
if (!orderColsF5.some((c) => c.name === 'cost_points')) {
  await client.execute('ALTER TABLE orders ADD COLUMN cost_points INTEGER');
}
if (!orderColsF5.some((c) => c.name === 'cost_source')) {
  await client.execute("ALTER TABLE orders ADD COLUMN cost_source TEXT CHECK (cost_source IN ('default','override','exempt_permanent','exempt_temporary'))");
}

await runMigration('2026_11_cost_rules', async () => {
  await db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('order_cost_points',?)", String(config.defaultOrderCostPoints));
  await db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('wallet_enforcement','off')");
});

await runMigration('2026_11_wallet', async () => {
  await db.run(`CREATE TABLE IF NOT EXISTS points_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captain_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('topup','deduction','adjustment')),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    order_id INTEGER,
    actor_id INTEGER,
    note TEXT,
    client_ref TEXT,
    at INTEGER NOT NULL
  )`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_ledger_captain ON points_ledger(captain_id, at DESC)');
  await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_deduct_once ON points_ledger(order_id) WHERE kind='deduction' AND order_id IS NOT NULL");
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_client_ref ON points_ledger(client_ref) WHERE client_ref IS NOT NULL');
});

/** Atomically append a ledger entry and update captain balance_points inside tx(). */
export async function applyPointsEntry({
  captainId,
  kind,
  amount,
  orderId = null,
  actorId = null,
  note = null,
  clientRef = null,
}) {
  if (!['topup', 'deduction', 'adjustment'].includes(kind)) {
    throw new Error(`Invalid points ledger kind: ${kind}`);
  }
  if (!Number.isInteger(amount) || amount === 0) {
    throw new Error('Points amount must be a non-zero integer');
  }
  if (kind === 'topup' && amount < 0) throw new Error('Topup amount must be positive');
  if (kind === 'deduction' && amount > 0) throw new Error('Deduction amount must be negative');

  return tx(async () => {
    if (clientRef != null) {
      const existingRef = await db.get('SELECT * FROM points_ledger WHERE client_ref=?', clientRef);
      if (existingRef) {
        const u = await db.get('SELECT balance_points FROM users WHERE id=?', existingRef.captain_id);
        return { duplicate: true, balance_points: u?.balance_points ?? existingRef.balance_after, entry: existingRef };
      }
    }
    if (kind === 'deduction' && orderId != null) {
      const existingDed = await db.get("SELECT * FROM points_ledger WHERE order_id=? AND kind='deduction'", orderId);
      if (existingDed) {
        const u = await db.get('SELECT balance_points FROM users WHERE id=?', existingDed.captain_id);
        return { duplicate: true, balance_points: u?.balance_points ?? existingDed.balance_after, entry: existingDed };
      }
    }

    const cap = await db.get("SELECT id, balance_points FROM users WHERE id=? AND role='captain'", captainId);
    if (!cap) throw new Error(`Captain not found for points entry: ${captainId}`);

    await db.run('UPDATE users SET balance_points = balance_points + ? WHERE id=?', amount, captainId);
    const updated = await db.get('SELECT balance_points FROM users WHERE id=?', captainId);
    const balanceAfter = updated.balance_points;
    const at = Date.now();
    const res = await db.run(
      'INSERT INTO points_ledger(captain_id,kind,amount,balance_after,order_id,actor_id,note,client_ref,at) VALUES(?,?,?,?,?,?,?,?,?)',
      captainId, kind, amount, balanceAfter, orderId, actorId, note, clientRef, at
    );
    return {
      duplicate: false,
      balance_points: balanceAfter,
      entry: {
        id: Number(res.lastInsertRowid),
        captain_id: captainId,
        kind,
        amount,
        balance_after: balanceAfter,
        order_id: orderId,
        actor_id: actorId,
        note,
        client_ref: clientRef,
        at,
      },
    };
  });
}

export const getSetting = async (k, def) =>
  (await db.get('SELECT value FROM settings WHERE key=?', k))?.value ?? def;
export const setSetting = (k, v) =>
  db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));
export const commission = async () => Number(await getSetting('commission', config.defaultCommission));
export const orderCostPoints = async () => Number(await getSetting('order_cost_points', config.defaultOrderCostPoints));
export const walletEnforcement = async () => (await getSetting('wallet_enforcement', 'off')) === 'on';

export const audit = (actor, action, data) =>
  db.run('INSERT INTO audit(actor_id,action,data,at) VALUES(?,?,?,?)', actor ?? null, action, data ? JSON.stringify(data) : null, Date.now());

export const addEvent = (orderId, type, actor, data) =>
  db.run('INSERT INTO order_events(order_id,type,actor_id,data,at) VALUES(?,?,?,?,?)', orderId, type, actor ?? null, data ? JSON.stringify(data) : null, Date.now());

// --- Seed: default zone + initial admin ---
if (!(await db.get('SELECT 1 FROM zones LIMIT 1'))) {
  await db.run('INSERT INTO zones(name) VALUES (?)', 'المزة');
}
const adminPhone = (process.env.ADMIN_PHONE || '').trim() || '0782070936';
const envAdminPass = (process.env.ADMIN_PASSWORD || '').trim();
await tx(async () => {
  const existingAdmin = await db.get("SELECT * FROM users WHERE role='admin'");
  if (!existingAdmin) {
    const generated = !envAdminPass;
    const adminPass = envAdminPass || crypto.randomBytes(12).toString('base64url');
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
    if (generated) {
      console.log(`كلمة المرور المؤقتة (تظهر عند التأسيس فقط): ${adminPass}`);
    }
    console.log('============================\n');
  } else if (existingAdmin.status !== 'active') {
    await db.run("UPDATE users SET status='active' WHERE id=?", existingAdmin.id);
  }
});
