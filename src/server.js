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
app.set('trust proxy', config.prod ? 1 : false);
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
app.use('/api', express.json({ limit: '16kb' }), (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, api);

app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules/leaflet/dist')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: 0 }));

const server = http.createServer(app);
attachWs(server);
startDispatcher();
server.listen(config.port, () => {
  console.log(`مشوار يعمل على http://localhost:${config.port}`);
  console.log('  المنشأة: /merchant   الكابتن: /captain   الإدارة: /admin');
});
