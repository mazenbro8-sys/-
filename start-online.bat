@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   تشغيل تطبيق مشوار + رابط الجوال السحابي
echo ============================================
start "Mashwar Server" cmd /k "node src/server.js"
timeout /t 2 >nul
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate
pause
