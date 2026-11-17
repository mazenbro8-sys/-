import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import helmet from 'helmet';
import { config, ROOT } from './config.js';
import './db.js';
import { api } from './routes.js';
import { attachWs } from './realtime.js';
import { startDispatcher } from './dispatch.js';

const COMPRESSIBLE_TYPES = new Set([
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'application/json',
  'image/svg+xml',
]);
const STATIC_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico']);
const SEVEN_DAYS_SECONDS = 604800;

/** Negotiate 'br' or 'gzip' from Accept-Encoding respecting explicit q-values. */
function pickEncoding(header, { supportsBr, supportsGzip }) {
  if (!header) return null;
  let brQ = 0;
  let gzipQ = 0;
  let brExplicit = false;
  let gzipExplicit = false;
  let starQ = 0;
  for (const part of String(header).toLowerCase().split(',')) {
    const [nameRaw, ...params] = part.trim().split(';');
    const name = nameRaw.trim();
    let q = 1;
    for (const p of params) {
      const m = p.trim().match(/^q\s*=\s*([0-9.]+)$/);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q) || q < 0) continue;
    if (name === 'br') { brExplicit = true; brQ = q; }
    else if (name === 'gzip') { gzipExplicit = true; gzipQ = q; }
    else if (name === '*') { starQ = Math.max(starQ, q); }
  }
  if (!brExplicit && starQ > 0) brQ = starQ;
  if (!gzipExplicit && starQ > 0) gzipQ = starQ;
  if (supportsBr && brQ > 0 && (!supportsGzip || brQ >= gzipQ)) return 'br';
  if (supportsGzip && gzipQ > 0) return 'gzip';
  return null;
}

/** True for HTML, JS, CSS, JSON (including +json), and SVG responses. */
function isCompressibleContentType(ct) {
  if (!ct) return false;
  const mime = String(ct).split(';')[0].trim().toLowerCase();
  return COMPRESSIBLE_TYPES.has(mime) || mime.endsWith('+json');
}

/** Compress compressible HTTP payloads with native zlib Brotli/Gzip without extra dependencies. */
function compressionMiddleware() {
  const supportsBr = typeof zlib.createBrotliCompress === 'function';
  const supportsGzip = typeof zlib.createGzip === 'function';
  return (req, res, next) => {
    if (req.method === 'HEAD' || (!supportsBr && !supportsGzip)) return next();

    const origWrite = res.write;
    const origEnd = res.end;
    const origWriteHead = res.writeHead;
    let zStream = null;
    let decided = false;
    let ended = false;
    let awaitingResDrain = false;
    let awaitingZlibDrain = false;

    const decide = () => {
      if (decided) return;
      decided = true;
      if (res.statusCode === 204 || res.statusCode === 304) return;
      if (res.getHeader('Content-Encoding')) return;
      if (/no-transform/i.test(String(res.getHeader('Cache-Control') || ''))) return;
      if (!isCompressibleContentType(res.getHeader('Content-Type'))) return;

      res.vary('Accept-Encoding');
      const enc = pickEncoding(req.headers['accept-encoding'], { supportsBr, supportsGzip });
      if (!enc) return;

      const etag = res.getHeader('ETag');
      if (typeof etag === 'string' && !etag.startsWith('W/')) {
        res.setHeader('ETag', `W/${etag}`);
      }
      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', enc);

      zStream = enc === 'br'
        ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
        : zlib.createGzip({ level: zlib.constants.Z_DEFAULT_COMPRESSION });

      zStream.on('data', (chunk) => {
        if (!origWrite.call(res, chunk)) {
          awaitingResDrain = true;
          zStream.pause();
        }
      });
      res.on('drain', () => {
        if (awaitingResDrain) {
          awaitingResDrain = false;
          zStream?.resume();
        }
      });
      zStream.on('drain', () => {
        if (awaitingZlibDrain) {
          awaitingZlibDrain = false;
          res.emit('drain');
        }
      });
      zStream.on('end', () => {
        if (!ended) {
          ended = true;
          origEnd.call(res);
        }
      });
      zStream.on('error', () => {
        if (!ended) {
          ended = true;
          try { res.destroy(); } catch {}
        }
      });
    };

    res.writeHead = function (...args) {
      if (typeof args[0] === 'number') res.statusCode = args[0];
      const hdrArg = typeof args[1] === 'object' && args[1] !== null
        ? args[1]
        : typeof args[2] === 'object' && args[2] !== null
          ? args[2]
          : null;
      if (hdrArg) {
        for (const [k, v] of Object.entries(hdrArg)) {
          if (v !== undefined) res.setHeader(k, v);
        }
      }
      decide();
      return typeof args[1] === 'string'
        ? origWriteHead.call(res, res.statusCode, args[1])
        : origWriteHead.call(res, res.statusCode);
    };

    res.write = function (chunk, encoding, cb) {
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      decide();
      if (!zStream) return origWrite.call(res, chunk, encoding, cb);
      const ok = zStream.write(chunk, encoding, cb);
      if (!ok) awaitingZlibDrain = true;
      return ok;
    };

    res.end = function (chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      decide();
      if (!zStream) return origEnd.call(res, chunk, encoding, cb);
      if (cb) res.once('finish', cb);
      if (chunk !== undefined && chunk !== null) zStream.write(chunk, encoding);
      zStream.end();
      return res;
    };

    res.on('close', () => {
      if (zStream && !ended) {
        try { zStream.destroy(); } catch {}
      }
    });

    next();
  };
}

/** Set Cache-Control per static asset type in public/. */
function setStaticCacheHeaders(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.set('Cache-Control', STATIC_IMAGE_EXTS.has(ext) ? `public, max-age=${SEVEN_DAYS_SECONDS}` : 'no-cache');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://tile.openstreetmap.org',
        'https://*.tile.openstreetmap.org',
        'https://*.basemaps.cartocdn.com',
        'https://*.google.com',
        'https://*.googleapis.com',
        'https://*.gstatic.com',
      ],
      connectSrc: [
        "'self'",
        'http:',
        'https:',
        'ws:',
        'wss:',
        'https://router.project-osrm.org',
        'https://nominatim.openstreetmap.org',
      ],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: config.prod ? [] : null,
    },
  },
}));
app.use(compressionMiddleware());
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}, express.json({ limit: '16kb' }), api);

app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules/leaflet/dist'), {
  maxAge: SEVEN_DAYS_SECONDS * 1000,
  etag: true,
  lastModified: true,
}));
app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  etag: true,
  lastModified: true,
  setHeaders: setStaticCacheHeaders,
}));

const server = http.createServer(app);
attachWs(server);
startDispatcher();
server.listen(config.port, () => {
  console.log(`PANTHER يعمل على http://localhost:${config.port}`);
  console.log('  المنشأة: /merchant   الكابتن: /captain   الإدارة: /admin');
});
