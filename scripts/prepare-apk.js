// Prepares the standalone Android WebView / Capacitor bundle in android-captain/assets/public
// Supports flavors: captain (default), merchant, admin
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'android-captain', 'app', 'src', 'main', 'assets', 'public');

const flavor = ['captain', 'merchant', 'admin'].includes(process.argv[2]) ? process.argv[2] : 'captain';
const FLAVOR_ASSETS = {
  captain: ['captain.js', 'shared.js', 'design-tokens.css', 'app.css', 'logo.jpg', 'icon-192.png', 'icon-512.png', 'manifest-captain.json'],
  merchant: ['merchant.js', 'merchant.css', 'shared.js', 'design-tokens.css', 'app.css', 'logo.jpg', 'icon-192.png', 'icon-512.png', 'manifest-merchant.json'],
  admin: ['admin.js', 'admin.css', 'shared.js', 'design-tokens.css', 'app.css', 'logo.jpg', 'icon-192.png', 'icon-512.png', 'manifest-admin.json'],
};

fs.mkdirSync(path.join(OUT, 'vendor', 'leaflet'), { recursive: true });

// Copy flavor assets
for (const f of FLAVOR_ASSETS[flavor]) {
  fs.copyFileSync(path.join(PUB, f), path.join(OUT, f));
}

// Write index.html from <flavor>.html with window.PANTHER_APK = true injected
const defaultSrv = process.env.SERVER_URL || 'https://mashwar-app.onrender.com';
const htmlSrc = fs.readFileSync(path.join(PUB, `${flavor}.html`), 'utf8')
  .replace('<head>', `<head><script>window.PANTHER_APK=true;window.PANTHER_DEFAULT_SERVER=${JSON.stringify(defaultSrv)};</script>`);
fs.writeFileSync(path.join(OUT, 'index.html'), htmlSrc, 'utf8');

// Copy Leaflet dist
const leafletDir = path.join(ROOT, 'node_modules', 'leaflet', 'dist');
fs.cpSync(leafletDir, path.join(OUT, 'vendor', 'leaflet'), { recursive: true });

// Copy app launcher icon to Android mipmap
const mipmapDir = path.join(ROOT, 'android-captain', 'app', 'src', 'main', 'res', 'mipmap-xxhdpi');
fs.mkdirSync(mipmapDir, { recursive: true });
fs.copyFileSync(path.join(PUB, 'icon-192.png'), path.join(mipmapDir, 'ic_launcher.png'));

console.log(`✅ تم تجهيز ملفات تطبيق (${flavor}) للأندرويد في:`, OUT);
