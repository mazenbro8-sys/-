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
      styleSrc: ["'self'", "'unsafe-inline'"], // Leaflet sets inline styles on markers
      imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://*.basemaps.cartocdn.com'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://router.project-osrm.org'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
  },
}));
app.use('/api', express.json({ limit: '16kb' }), (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, api);

app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules/leaflet/dist')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: config.prod ? '1h' : 0 }));

const server = http.createServer(app);
attachWs(server);
startDispatcher();
server.listen(config.port, () => {
  console.log(`مشوار يعمل على http://localhost:${config.port}`);
  console.log('  المنشأة: /merchant   الكابتن: /captain   الإدارة: /admin');
});
