// Migrates local data/mashwar.db into Turso Cloud (libSQL) without needing WSL or Turso CLI.
// Usage: node scripts/migrate-to-turso.js
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';

const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
const tursoToken = (process.env.TURSO_AUTH_TOKEN || '').trim();

if (!tursoUrl || !tursoToken) {
  console.error('❌ يرجى ضبط TURSO_DATABASE_URL و TURSO_AUTH_TOKEN في ملف .env أو متغيرات البيئة أولاً.');
  process.exit(1);
}

const localPath = path.join(DATA_DIR, 'mashwar.db');
if (!fs.existsSync(localPath)) {
  console.error('❌ لم يتم العثور على قاعدة البيانات المحلية:', localPath);
  process.exit(1);
}

// Import src/db.js first so schema (CREATE TABLE IF NOT EXISTS) is initialized on Turso
await import('../src/db.js');

const src = createClient({ url: pathToFileURL(path.resolve(localPath)).href });
const dst = createClient({ url: tursoUrl, authToken: tursoToken });

// Ordered by foreign-key dependency
const TABLES = [
  'zones',
  'users',
  'orders',
  'order_events',
  'offers',
  'locations',
  'flags',
  'settlements',
  'settings',
  'audit',
];

console.log(`🚀 بدء ترحيل البيانات من ${localPath} إلى Turso Cloud (${tursoUrl})...`);

await dst.execute('PRAGMA foreign_keys = OFF');

for (const table of TABLES) {
  const rs = await src.execute(`SELECT * FROM ${table}`);
  const rows = rs.rows;
  if (!rows.length) {
    console.log(`  • ${table}: 0 سجل (تخطي)`);
    continue;
  }
  const cols = rs.columns;
  const placeholders = cols.map(() => '?').join(',');
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;

  const CHUNK = 150;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => ({
      sql,
      args: cols.map((c) => (r[c] === undefined ? null : r[c])),
    }));
    await dst.batch(slice, 'write');
  }

  const verify = await dst.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  console.log(`  ✅ ${table}: تم ترحيل ${rows.length} سجل (الموجود في Turso: ${verify.rows[0].n})`);
}

// Sync AUTOINCREMENT sequences so new inserts continue cleanly after imported IDs
try {
  const seqRows = await src.execute('SELECT name, seq FROM sqlite_sequence');
  for (const r of seqRows.rows) {
    await dst.execute({ sql: 'DELETE FROM sqlite_sequence WHERE name = ?', args: [r.name] });
    await dst.execute({ sql: 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', args: [r.name, r.seq] });
  }
  console.log('  ✅ sqlite_sequence: تمت مزامنة العدادات التسلسلية بنجاح');
} catch {}

await dst.execute('PRAGMA foreign_keys = ON');

src.close();
dst.close();
console.log('🎉 اكتمل ترحيل قاعدة البيانات إلى Turso Cloud بنجاح!');
