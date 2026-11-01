// إعادة تعيين كلمة مرور المدير (للتطوير):  node scripts/reset-admin.js [كلمة_المرور]
import bcrypt from 'bcryptjs';
import { db } from '../src/db.js';
const pw = process.argv[2] || 'Admin12345';
db.prepare("UPDATE users SET pass_hash=?, token_version=token_version+1, failed_logins=0, locked_until=0 WHERE role='admin'").run(bcrypt.hashSync(pw, 12));
console.log('هاتف المدير:', db.prepare("SELECT phone FROM users WHERE role='admin'").get().phone, ' كلمة المرور:', pw);
