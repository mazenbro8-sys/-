import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { db } from './db.js';

export const signToken = (u) => {
  const payload = { sub: u.id, role: u.role, tv: u.token_version };
  if (u.role === 'zone_admin') payload.zone_id = u.zone_id;
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtTtl, algorithm: 'HS256' });
};

export async function userFromToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    const u = await db.get('SELECT * FROM users WHERE id=?', p.sub);
    if (!u || u.token_version !== p.tv || u.status !== 'active') return null;
    return u;
  } catch { return null; }
}

export function auth(...roles) {
  return async (req, res, next) => {
    try {
      const h = req.headers.authorization || '';
      const u = h.startsWith('Bearer ') ? await userFromToken(h.slice(7)) : null;
      if (!u) return res.status(401).json({ error: 'غير مصرّح، سجّل الدخول من جديد' });
      if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'ليس لديك صلاحية' });
      req.user = u;
      next();
    } catch (e) {
      next(e);
    }
  };
}

// ---------- Realtime (WebSocket) ----------
const clients = new Map(); // userId -> Set<ws>
const roleOf = new Map();  // ws -> role
const zoneOf = new Map();  // ws -> zone_id

export function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });
  wss.on('connection', (ws) => {
    let uid = null;
    const timer = setTimeout(() => { if (!uid) ws.close(4001, 'auth timeout'); }, 10_000);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async (raw) => {
      if (uid) return;
      try {
        const m = JSON.parse(raw.toString());
        const u = m.type === 'auth' && (await userFromToken(String(m.token)));
        if (!u) return ws.close(4003, 'unauthorized');
        if (ws.readyState !== 1) return;
        uid = u.id;
        if (!clients.has(uid)) clients.set(uid, new Set());
        clients.get(uid).add(ws);
        roleOf.set(ws, u.role);
        zoneOf.set(ws, u.zone_id ?? null);
        ws.send(JSON.stringify({ type: 'ready' }));
      } catch { ws.close(4003, 'bad message'); }
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (uid) { clients.get(uid)?.delete(ws); if (!clients.get(uid)?.size) clients.delete(uid); }
      roleOf.delete(ws);
      zoneOf.delete(ws);
    });
    ws.on('error', () => {});
  });
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 30_000);
}

/** True when the user has at least one open, authenticated WebSocket. */
export const isConnected = (userId) => [...(clients.get(userId) ?? [])].some((ws) => ws.readyState === 1);

export function sendTo(userId, msg) {
  if (!userId) return;
  const s = JSON.stringify(msg);
  for (const ws of clients.get(userId) ?? []) if (ws.readyState === 1) ws.send(s);
}
export function sendToAdmins(msg, zoneId = null) {
  const fullJson = JSON.stringify(msg);
  for (const set of clients.values()) {
    for (const ws of set) {
      if (ws.readyState !== 1) continue;
      const role = roleOf.get(ws);
      if (role === 'admin') {
        ws.send(fullJson);
      } else if (role === 'zone_admin') {
        const zId = zoneOf.get(ws);
        if (!zId || (zoneId != null && zId !== zoneId)) continue;
        if (msg.shortage?.orders) {
          const zOrders = msg.shortage.orders.filter((o) => o.zone_id === zId);
          ws.send(JSON.stringify({
            ...msg,
            shortage: {
              ...msg.shortage,
              alert: zOrders.length > 0,
              searchingCount: zOrders.length,
              unassignedCount: zOrders.length,
              orders: zOrders,
            },
          }));
        } else {
          ws.send(fullJson);
        }
      }
    }
  }
}
