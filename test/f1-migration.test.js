import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { backupDatabase } from '../scripts/backup-turso.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panther-f1-'));
const dbPath = path.join(tmpDir, 'legacy.db');
const backupPath = path.join(tmpDir, 'snapshot.json');

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('F1: archives legacy settlements_legacy_syp & commission once and creates clean JSON backup', async () => {
  const raw = createClient({ url: `file:${dbPath}` });
  await raw.executeMultiple(`
    CREATE TABLE settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captain_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      orders_count INTEGER NOT NULL,
      cash_expected INTEGER NOT NULL,
      commission_owed INTEGER NOT NULL,
      cash_collected INTEGER NOT NULL,
      collected_by INTEGER,
      at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  await raw.execute({
    sql: 'INSERT INTO settlements(captain_id,day,orders_count,cash_expected,commission_owed,cash_collected,collected_by,at) VALUES(?,?,?,?,?,?,?,?)',
    args: [7, '2026-10-01', 4, 40000, 8000, 8000, 1, 1700000000000],
  });
  await raw.execute({
    sql: "INSERT INTO settings(key,value) VALUES('commission','2500')",
    args: [],
  });
  raw.close();

  process.env.DB_FILE = dbPath;
  process.env.ADMIN_PHONE = '0911111119';
  process.env.ADMIN_PASSWORD = 'TempPassword123';
  const { db, runMigration, getSetting } = await import('../src/db.js');

  const migRow = await db.get("SELECT id, applied_at FROM schema_migrations WHERE id='2026_11_archive_syp'");
  assert.ok(migRow, 'schema_migrations row should exist');
  assert.ok(migRow.applied_at > 0);

  const archived = await db.all('SELECT * FROM settlements_legacy_syp');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].captain_id, 7);
  assert.equal(archived[0].day, '2026-10-01');
  assert.equal(archived[0].commission_owed, 8000);
  assert.equal(archived[0].currency, 'SYP');
  assert.ok(archived[0].archived_at > 0);

  assert.equal(await getSetting('legacy_commission_syp'), '2500');
  const cutover = Number(await getSetting('points_cutover_at'));
  assert.ok(Number.isFinite(cutover) && cutover > 0);

  const ranAgain = await runMigration('2026_11_archive_syp', async () => {
    throw new Error('2026_11_archive_syp must not re-run');
  });
  assert.equal(ranAgain, false);

  const res = await backupDatabase({ url: `file:${dbPath}`, outPath: backupPath });
  assert.equal(res.source, 'sqlite');
  assert.equal(res.counts.settlements_legacy_syp, 1);
  assert.equal(res.counts.schema_migrations, 1);
  const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(parsed.tables.settlements_legacy_syp.rows[0].currency, 'SYP');
  assert.ok(parsed.schema.some((s) => s.type === 'table' && s.name === 'settlements_legacy_syp'));
});
