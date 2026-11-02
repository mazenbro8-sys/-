import { makeMap, emoji, makeRoute, fitMapToPoints } from './shared.js';

const log = document.getElementById('log');
const COLORS = { ok: '#22c55e', err: '#ef4444', warn: '#f59e0b' };
function addLog(msg, type = 'ok') {
  const d = document.createElement('div');
  d.style.color = COLORS[type] || '#fff';
  d.textContent = (type === 'ok' ? '✅ ' : type === 'err' ? '❌ ' : '⚠️ ') + msg;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

window.addEventListener('error', (e) => addLog('JS Error: ' + e.message, 'err'));
window.addEventListener('unhandledrejection', (e) => addLog('Promise Error: ' + e.reason, 'err'));
document.addEventListener('securitypolicyviolation', (e) => {
  addLog('CSP Violation: ' + e.violatedDirective + ' blocked: ' + e.blockedURI, 'err');
});

const AMMAN = [32.0032, 35.9581];
addLog('Leaflet v' + L.version + ' loaded');
const map = makeMap('map', AMMAN, 14);
addLog('Google Maps (Arabic Streets + Satellite + Dark) initialized — NO API key needed');

let tileOK = false;
Object.entries(map._tileLayers || {}).forEach(([name, layer]) => {
  layer.on('tileload', () => {
    if (!tileOK) { tileOK = true; addLog(`Map tiles loaded (${name}) ✓`); }
  });
});

fetch('/api/tile/gm/13/4914/3331')
  .then((r) => addLog(`Built-in Tile Proxy (/api/tile/gm): HTTP ${r.status} (${r.headers.get('content-type')})`, r.ok ? 'ok' : 'err'))
  .catch((e) => addLog('Tile proxy error: ' + e.message, 'err'));

const pCap = [32.0034, 35.9579];
const pMer = [32.0062, 35.9625];
const pCus = [31.9995, 35.9535];
L.marker(pCap, { icon: emoji('🛵') }).addTo(map).bindTooltip('🛵 كابتن تجريبي');
L.marker(pMer, { icon: emoji('🏪') }).addTo(map).bindTooltip('🏪 منشأة تجريبية');
L.marker(pCus, { icon: emoji('📍') }).addTo(map).bindTooltip('📍 زبون تجريبي');
fitMapToPoints(map, [pCap, pMer, pCus]);

makeRoute(map, pCap, pMer)
  .then(() => addLog('Road Route (OSRM + Proxy fallback) drawn ✓'))
  .catch((e) => addLog('Route error: ' + e.message, 'err'));
