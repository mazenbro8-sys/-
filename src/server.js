import http from 'node:http';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { config, ROOT } from './config.js';
import './db.js';
import { api } from './routes.js';
import { attachWs } from './realtime.js';
import { startDispatcher } from './dispatch.js';

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
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}, express.json({ limit: '16kb' }), api);

app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules/leaflet/dist')));
app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  },
}));

const server = http.createServer(app);
attachWs(server);
startDispatcher();
server.listen(config.port, () => {
  console.log(`PANTHER يعمل على http://localhost:${config.port}`);
  console.log('  المنشأة: /merchant   الكابتن: /captain   الإدارة: /admin');
});
