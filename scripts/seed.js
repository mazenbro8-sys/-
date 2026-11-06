// بيانات تجريبية للتطوير فقط:  npm run seed
import bcrypt from 'bcryptjs';
import { db, addEvent } from '../src/db.js';
import { dayOf } from '../src/config.js';

if (process.env.NODE_ENV === 'production') { console.error('ممنوع تشغيل البيانات التجريبية في الإنتاج'); process.exit(1); }
const PASS = 'Demo12345', hash = bcrypt.hashSync(PASS, 10), now = Date.now();
const zone = (await db.get('SELECT id FROM zones ORDER BY id LIMIT 1')).id;

const merchants = [
  ['0911000001', 'مطعم أبو أحمد', 'المزة - جانب الجسر', 33.5, 36.2527],
  ['0911000002', 'بيتزا نابولي', 'المزة - فيلات غربية', 33.5042, 36.2561],
  ['0911000003', 'بقالة الياسمين', 'المزة - شارع الجلاء', 33.4985, 36.2489],
  ['0911000004', 'حلويات الشام', 'المزة - أوتوستراد', 33.5071, 36.2612],
];
const captains = [['0922000001', 'ياسر'], ['0922000002', 'محمود'], ['0922000003', 'سامر'], ['0922000004', 'خالد']];

const insSql = "INSERT OR IGNORE INTO users(role,phone,name,pass_hash,zone_id,status,business_name,address,lat,lng,created_at) VALUES(?,?,?,?,?,'active',?,?,?,?,?)";
for (const [p, b, a, lat, lng] of merchants) await db.run(insSql, 'merchant', p, 'صاحب ' + b, hash, zone, b, a, lat, lng, now);
for (const [p, n] of captains) await db.run(insSql, 'captain', p, n, hash, zone, null, null, null, null, now);
await db.run("INSERT OR IGNORE INTO users(role,phone,name,pass_hash,zone_id,status,business_name,address,created_at) VALUES('captain','0922000099','كابتن بانتظار الموافقة',?,?,'pending',NULL,NULL,?)", hash, zone, now);

const mids = (await db.all("SELECT id FROM users WHERE role='merchant'")).map((r) => r.id);
const cids = (await db.all("SELECT id FROM users WHERE role='captain' AND status='active'")).map((r) => r.id);
const names = ['سارة', 'عمر', 'لينا', 'هادي', 'ريم', 'كريم', 'نور', 'باسل'];
const day = dayOf();
if (!(await db.get('SELECT 1 FROM orders'))) {
  for (let i = 0; i < 14; i++) {
    const m = mids[i % mids.length], c = cids[i % cids.length], t = now - (i + 1) * 25 * 60_000;
    const failed = i % 7 === 6;
    const r = await db.run(
      `INSERT INTO orders(merchant_id,zone_id,customer_name,customer_phone,customer_address,customer_lat,customer_lng,product_amount,delivery_fee,status,captain_id,commission,day,created_at,accepted_at,closed_at,close_reason)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      m, zone, names[i % names.length], '09440000' + String(10 + i), 'المزة - شارع ' + (i + 1), 33.5 + (i % 5) * 0.003, 36.25 + (i % 4) * 0.004,
      (30 + i * 5) * 1000, 5000, failed ? 'failed' : 'delivered', c, failed ? 0 : 2000, day, t, t + 60_000, t + 20 * 60_000, failed ? 'customer_unreachable_or_wrong_address' : null
    );
    for (const e of ['created', 'offered', 'accepted', 'picked_up', failed ? 'failed' : 'delivered']) await addEvent(r.lastInsertRowid, e, c);
  }
}
console.log(`تم. كلمة مرور كل الحسابات التجريبية: ${PASS}`);
console.log('منشآت: ' + merchants.map((m) => m[0]).join(', '));
console.log('كباتن: ' + captains.map((c) => c[0]).join(', ') + '  (0922000099 بانتظار الموافقة)');
