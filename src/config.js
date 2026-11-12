import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Minimal .env loader (no extra dependency)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// JWT secret: from env, or generated once and persisted (never committed)
function loadSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, 'jwt.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: loadSecret(),
  jwtTtl: '30d',
  prod: process.env.NODE_ENV === 'production',
  offerTimeoutMs: Number(process.env.OFFER_TIMEOUT_MS || 30_000), // 30 seconds
  shortageTimeoutMs: Number(process.env.SHORTAGE_TIMEOUT_MS || 5 * 60_000), // 5 minutes
  searchMaxMs: 10 * 60_000,
  activeLocIntervalMs: 10_000,
  idleLocIntervalMs: 60_000,
  defaultCommission: 2000,
  defaultOrderCostPoints: 25,
  etaSpeedKmh: 22,
  tz: 'Asia/Damascus',
};

export const dayOf = (ms = Date.now()) =>
  new Date(ms).toLocaleDateString('en-CA', { timeZone: config.tz });
