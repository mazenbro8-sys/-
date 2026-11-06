// Prepares the standalone Captain Android WebView / Capacitor bundle in android-captain/assets/public
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'android-captain', 'app', 'src', 'main', 'assets', 'public');

fs.mkdirSync(path.join(OUT, 'vendor', 'leaflet'), { recursive: true });

// Copy captain assets
const files = ['captain.js', 'shared.js', 'design-tokens.css', 'app.css', 'logo.jpg', 'icon-192.png', 'icon-512.png', 'manifest-captain.json'];
for (const f of files) {
  fs.copyFileSync(path.join(PUB, f), path.join(OUT, f));
}

// Write index.html from captain.html with window.PANTHER_APK = true injected
const defaultSrv = process.env.SERVER_URL || 'https://mashwar-app.onrender.com';
const captainHtml = fs.readFileSync(path.join(PUB, 'captain.html'), 'utf8')
  .replace('<head>', `<head><script>window.PANTHER_APK=true;window.PANTHER_DEFAULT_SERVER=${JSON.stringify(defaultSrv)};</script>`);
fs.writeFileSync(path.join(OUT, 'index.html'), captainHtml, 'utf8');

// Copy Leaflet dist
const leafletDir = path.join(ROOT, 'node_modules', 'leaflet', 'dist');
fs.cpSync(leafletDir, path.join(OUT, 'vendor', 'leaflet'), { recursive: true });

// Copy app launcher icon to Android mipmap
const mipmapDir = path.join(ROOT, 'android-captain', 'app', 'src', 'main', 'res', 'mipmap-xxhdpi');
fs.mkdirSync(mipmapDir, { recursive: true });
fs.copyFileSync(path.join(PUB, 'icon-192.png'), path.join(mipmapDir, 'ic_launcher.png'));

console.log('✅ تم تجهيز ملفات تطبيق الكابتن للأندرويد في:', OUT);
