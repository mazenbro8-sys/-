// إعادة تعيين حساب المدير:  node scripts/reset-admin.js [كلمة_المرور] [رقم_الهاتف]
import bcrypt from 'bcryptjs';
import { db } from '../src/db.js';
const pw = process.argv[2] || 'Pan@2026!Admin#9';
const ph = process.argv[3] || '0782070936';
db.prepare("UPDATE users SET phone=?, pass_hash=?, token_version=token_version+1, failed_logins=0, locked_until=0, status='active' WHERE role='admin'").run(ph, bcrypt.hashSync(pw, 12));
console.log('هاتف المدير:', db.prepare("SELECT phone FROM users WHERE role='admin'").get().phone, ' كلمة المرور:', pw);
