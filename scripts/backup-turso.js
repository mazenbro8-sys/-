import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';

function loadEnvFile(envPath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function defaultOutPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(process.cwd(), 'data', 'backups', `backup-${stamp}.json`);
}

function parseOutArg(argv) {
  const idx = argv.indexOf('--out');
  if (idx !== -1 && argv[idx + 1]) return path.resolve(process.cwd(), argv[idx + 1]);
  return defaultOutPath();
}

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Read-only snapshot export of all tables and schema from Turso or local SQLite. */
export async function backupDatabase({ url, authToken, outPath } = {}) {
  loadEnvFile();
  const dbFile = process.env.DB_FILE || 'data/mashwar.db';
  const targetUrl = url || process.env.TURSO_DATABASE_URL || `file:${path.resolve(process.cwd(), dbFile)}`;
  const targetToken = authToken ?? process.env.TURSO_AUTH_TOKEN;
  const destination = outPath || defaultOutPath();

  const client = createClient({
    url: targetUrl,
    ...(targetToken ? { authToken: targetToken } : {}),
  });

  try {
    const metaRes = await client.execute(
      "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name ASC"
    );
    const schema = metaRes.rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      sql: r.sql ? String(r.sql) : null,
    }));

    const tables = {};
    const counts = {};
    for (const item of schema) {
      if (item.type !== 'table') continue;
      const res = await client.execute(`SELECT * FROM ${ident(item.name)}`);
      tables[item.name] = {
        columns: res.columns ?? [],
        rowCount: res.rows.length,
        rows: res.rows,
      };
      counts[item.name] = res.rows.length;
    }

    const payload = {
      created_at: new Date().toISOString(),
      source: targetUrl.startsWith('file:') ? 'sqlite' : 'turso',
      schema,
      tables,
    };

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(
      destination,
      JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2),
      'utf8'
    );

    return { outPath: destination, counts, source: payload.source };
  } finally {
    client.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const outPath = parseOutArg(process.argv.slice(2));
  backupDatabase({ outPath })
    .then((res) => {
      console.log(`Backup written to: ${res.outPath} (${res.source})`);
      for (const [table, count] of Object.entries(res.counts)) {
        console.log(`  - ${table}: ${count} rows`);
      }
    })
    .catch((err) => {
      console.error('Backup failed:', err?.message || err);
      process.exit(1);
    });
}
