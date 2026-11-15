package sy.panther.captain;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

public class CaptainService extends Service {
    private static final String CHANNEL_BG = "panther_bg_status";
    private static final String CHANNEL_ALERT = "panther_order_alert_v2";
    private static final String CHANNEL_MSG = "panther_messages";
    private static final String PREF_ALERTED_NOTIF_IDS = "alerted_notif_ids";
    private static final int MAX_ALERTED_NOTIF_IDS = 50;
    private static final long INBOX_POLL_INTERVAL_MS = 15_000L;
    private static final long MSG_CHIME_COOLDOWN_MS = 10_000L;
    private static final int NOTIF_BG_ID = 101;
    private static final int NOTIF_OFFER_ID = 202;
    private static final int NOTIF_MSG_SUMMARY_ID = 2999;
    private static final int NOTIF_MSG_BASE_ID = 3000;

    private static volatile boolean alarmRunning = false;
    private static Thread alarmThread = null;
    private static int lastNotifiedOfferId = -1;
    private static int lastSeenActiveOrderId = -1;

    private volatile boolean serviceRunning = false;
    private Thread pollThread = null;
    private PowerManager.WakeLock wakeLock;
    private long lastInboxCheckAt = 0L;
    private long lastMsgChimeAt = 0L;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP_SIREN".equals(intent.getAction())) {
            stopSiren();
            return START_STICKY;
        }
        if (intent != null && "STOP_SERVICE".equals(intent.getAction())) {
            stopSiren();
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification bgNotif = buildForegroundNotification("🟢 متصل (أونلاين) — بانتظار الطلبات الجديدة");
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_BG_ID, bgNotif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_BG_ID, bgNotif);
            }
        } catch (Exception ignored) {}

        startPolling();
        return START_STICKY;
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && (wakeLock == null || !wakeLock.isHeld())) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "panther:CaptainWakeLock");
                wakeLock.acquire();
            }
        } catch (Exception ignored) {}
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            NotificationChannel bg = new NotificationChannel(
                CHANNEL_BG,
                "حالة اتصال الكابتن",
                NotificationManager.IMPORTANCE_LOW
            );
            bg.setDescription("يبقي تطبيق الكابتن متصلاً بالطلبات في الخلفية");
            bg.setShowBadge(false);
            nm.createNotificationChannel(bg);

            NotificationChannel alert = new NotificationChannel(
                CHANNEL_ALERT,
                "تنبيهات الطلبات الجديدة",
                NotificationManager.IMPORTANCE_HIGH
            );
            alert.setDescription("إشعار فوري عند وصول طلب توصيل جديد للكابتن");
            alert.enableVibration(true);
            alert.setVibrationPattern(new long[]{0, 400, 200, 400});
            alert.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(alert);

            NotificationChannel msgChannel = new NotificationChannel(
                CHANNEL_MSG,
                "PANTHER Messages",
                NotificationManager.IMPORTANCE_HIGH
            );
            msgChannel.setDescription("اشعارات ورسائل الإدارة للكابتن");
            msgChannel.enableVibration(true);
            msgChannel.setVibrationPattern(new long[]{0, 200});
            msgChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(msgChannel);
        }
    }

    private PendingIntent getLaunchPendingIntent() {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 0, launch, flags);
    }

    private Notification buildForegroundNotification(String text) {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_BG)
            : new Notification.Builder(this);
        b.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("🛵 PANTHER كابتن")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(getLaunchPendingIntent());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        }
        return b.build();
    }

    private void showOrderAlertNotification(String title, String body) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            PendingIntent pi = getLaunchPendingIntent();
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ALERT)
                : new Notification.Builder(this);
            b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setFullScreenIntent(pi, true);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                b.setPriority(Notification.PRIORITY_MAX);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                b.setCategory(Notification.CATEGORY_CALL)
                    .setVisibility(Notification.VISIBILITY_PUBLIC);
            }
            nm.notify(NOTIF_OFFER_ID, b.build());
        } catch (Exception ignored) {}
    }

    private void clearOrderAlertNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_OFFER_ID);
        } catch (Exception ignored) {}
    }

    private synchronized void startPolling() {
        if (serviceRunning && pollThread != null && pollThread.isAlive()) return;
        serviceRunning = true;
        pollThread = new Thread(() -> {
            while (serviceRunning) {
                try {
                    checkCaptainState();
                } catch (Exception ignored) {}
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    break;
                }
            }
        }, "PantherCaptainPoll");
        pollThread.start();
    }

    private void checkCaptainState() {
        SharedPreferences prefs = getSharedPreferences("panther_prefs", MODE_PRIVATE);
        String serverUrl = prefs.getString("server_url", "");
        String token = prefs.getString("token", "");
        boolean online = prefs.getBoolean("online", false);

        if (!online || token == null || token.isEmpty() || serverUrl == null || serverUrl.isEmpty()) {
            stopSiren();
            return;
        }

        HttpURLConnection conn = null;
        try {
            URL url = new URL(serverUrl + "/api/captain/state");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");

            int code = conn.getResponseCode();
            if (code == 401) {
                prefs.edit().putBoolean("online", false).putString("token", "").apply();
                stopSiren();
                stopSelf();
                return;
            }
            if (code != 200) return;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }

            JSONObject data = new JSONObject(sb.toString());
            boolean isOnline = data.optBoolean("online", false);
            if (!isOnline) {
                prefs.edit().putBoolean("online", false).apply();
                stopSiren();
                clearOrderAlertNotification();
                stopSelf();
                return;
            }

            JSONObject offer = data.optJSONObject("offer");
            int offerId = offer != null ? offer.optInt("id", 0) : 0;
            String offerStatus = offer != null ? offer.optString("status", "offered") : "";
            if (offer != null && offerId > 0 && "offered".equals(offerStatus)) {
                int serial = offer.optInt("serial_no", offerId);
                JSONObject merch = offer.optJSONObject("merchant");
                String mName = merch != null ? merch.optString("name", "منشأة") : "منشأة";
                String addr = offer.optString("customer_address", "—");
                if (offerId != lastNotifiedOfferId) {
                    lastNotifiedOfferId = offerId;
                    showOrderAlertNotification(
                        "🔔 طلب توصيل جديد #" + String.format("%04d", serial),
                        "🏪 من: " + mName + "\n📍 العنوان: " + addr + "\nاضغط لفتح التطبيق وقبول الطلب فوراً"
                    );
                    // Start siren only once when a new offer arrives, not on repeat polls for the same offer
                    startSiren(60000);
                }
            } else {
                if (lastNotifiedOfferId != -1) {
                    lastNotifiedOfferId = -1;
                    clearOrderAlertNotification();
                }
                stopSiren();
            }

            JSONArray activeOrders = data.optJSONArray("activeOrders");
            if (activeOrders != null && activeOrders.length() > 0) {
                JSONObject first = activeOrders.optJSONObject(0);
                if (first != null) {
                    int actId = first.optInt("id", 0);
                    if (actId > 0 && lastSeenActiveOrderId != -1 && actId != lastSeenActiveOrderId) {
                        int serial = first.optInt("serial_no", actId);
                        String addr = first.optString("customer_address", "—");
                        showOrderAlertNotification(
                            "📦 تم إسناد طلب إليك #" + String.format("%04d", serial),
                            "📍 العنوان: " + addr + " — اضغط لمتابعة الطلب"
                        );
                    }
                    lastSeenActiveOrderId = actId;
                }
            } else {
                lastSeenActiveOrderId = 0;
            }

            boolean offerRinging = alarmRunning || (offer != null && offerId > 0 && "offered".equals(offerStatus));
            long nowMs = System.currentTimeMillis();
            if (!offerRinging && (nowMs - lastInboxCheckAt) >= INBOX_POLL_INTERVAL_MS) {
                lastInboxCheckAt = nowMs;
                checkUnreadMessages(prefs, serverUrl, token);
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void checkUnreadMessages(SharedPreferences prefs, String serverUrl, String token) {
        if (alarmRunning) return;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(serverUrl + "/api/notifications/inbox");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");

            int code = conn.getResponseCode();
            if (code != 200) return;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }

            JSONArray arr = new JSONArray(sb.toString());
            LinkedHashSet<Integer> alertedIds = loadAlertedNotifIds(prefs);
            List<JSONObject> unalerted = new ArrayList<>();
            for (int i = arr.length() - 1; i >= 0; i--) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                int id = item.optInt("id", 0);
                boolean isRead = item.optBoolean("read", false) || !item.isNull("read_at");
                if (id > 0 && !isRead && !alertedIds.contains(id)) {
                    unalerted.add(item);
                }
            }

            if (unalerted.isEmpty() || alarmRunning) return;

            long now = System.currentTimeMillis();
            boolean canChime = (now - lastMsgChimeAt) >= MSG_CHIME_COOLDOWN_MS;
            if (canChime) {
                lastMsgChimeAt = now;
                playMessageChime();
                vibrateBrief(prefs, 200);
                JSONObject first = unalerted.get(0);
                int firstId = first.optInt("id", 0);
                String firstTitle = first.optString("title", "رسالة إدارية");
                String firstBody = first.optString("body", "");
                showAdminMessageNotification(NOTIF_MSG_BASE_ID + (firstId % 1000), firstTitle, firstBody);
                if (unalerted.size() > 1) {
                    int restCount = unalerted.size() - 1;
                    showAdminMessageNotification(
                        NOTIF_MSG_SUMMARY_ID,
                        "لديك " + restCount + " رسائل جديدة",
                        "افتح التطبيق لقراءة جميع الرسائل الإدارية"
                    );
                }
            } else {
                vibrateBrief(prefs, 200);
                showAdminMessageNotification(
                    NOTIF_MSG_SUMMARY_ID,
                    "لديك " + unalerted.size() + " رسائل جديدة",
                    "افتح التطبيق لقراءة جميع الرسائل الإدارية"
                );
            }

            for (JSONObject item : unalerted) {
                int id = item.optInt("id", 0);
                if (id > 0) alertedIds.add(id);
            }
            saveAlertedNotifIds(prefs, alertedIds);
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private LinkedHashSet<Integer> loadAlertedNotifIds(SharedPreferences prefs) {
        LinkedHashSet<Integer> ids = new LinkedHashSet<>();
        String raw = prefs.getString(PREF_ALERTED_NOTIF_IDS, "");
        if (raw == null || raw.isEmpty()) return ids;
        for (String part : raw.split(",")) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) continue;
            try {
                int id = Integer.parseInt(trimmed);
                if (id > 0) ids.add(id);
            } catch (NumberFormatException ignored) {}
        }
        return ids;
    }

    private void saveAlertedNotifIds(SharedPreferences prefs, LinkedHashSet<Integer> ids) {
        List<Integer> list = new ArrayList<>(ids);
        if (list.size() > MAX_ALERTED_NOTIF_IDS) {
            list = list.subList(list.size() - MAX_ALERTED_NOTIF_IDS, list.size());
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(list.get(i));
        }
        prefs.edit().putString(PREF_ALERTED_NOTIF_IDS, sb.toString()).apply();
    }

    private boolean canPostNotifications() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    private void showAdminMessageNotification(int notifId, String title, String body) {
        if (!canPostNotifications()) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            PendingIntent pi = getLaunchPendingIntent();
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_MSG)
                : new Notification.Builder(this);
            String safeTitle = (title == null || title.trim().isEmpty()) ? "رسالة إدارية" : title;
            String safeBody = body == null ? "" : body;
            b.setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setStyle(new Notification.BigTextStyle().bigText(safeBody))
                .setAutoCancel(true)
                .setContentIntent(pi);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                b.setPriority(Notification.PRIORITY_HIGH);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                b.setVisibility(Notification.VISIBILITY_PUBLIC);
            }
            nm.notify(notifId, b.build());
        } catch (Exception ignored) {}
    }

    private void vibrateBrief(SharedPreferences prefs, long durationMs) {
        try {
            if (!prefs.getBoolean("vibrate", true)) return;
            Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vib == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vib.vibrate(durationMs);
            }
        } catch (Exception ignored) {}
    }

    private void playMessageChime() {
        if (alarmRunning) return;
        new Thread(() -> {
            if (alarmRunning) return;
            int sampleRate = 16000;
            // Distinct two-note admin message chime: triangle 660 Hz (180ms) -> 40ms gap -> 880 Hz (180ms), peak 0.36
            double totalSec = 0.42;
            int totalSamples = Math.max(1, (int) (sampleRate * totalSec));
            int[] mix = new int[totalSamples];
            addTonePulse(mix, sampleRate, true, 660.0, 660.0, 660.0, 0.00, 0.18, 0.36, 0.008, 0.008);
            addTonePulse(mix, sampleRate, true, 880.0, 880.0, 880.0, 0.22, 0.18, 0.36, 0.008, 0.008);

            short[] chime = new short[totalSamples];
            for (int i = 0; i < totalSamples; i++) {
                int v = mix[i];
                if (v > Short.MAX_VALUE) v = Short.MAX_VALUE;
                else if (v < Short.MIN_VALUE) v = Short.MIN_VALUE;
                chime[i] = (short) v;
            }

            AudioTrack track = null;
            try {
                int minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                AudioFormat fmt = new AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build();
                track = new AudioTrack(attrs, fmt, Math.max(minBuf, chime.length * 2), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
                track.play();
                track.write(chime, 0, chime.length);
                Thread.sleep(450);
            } catch (Exception ignored) {
            } finally {
                if (track != null) {
                    try {
                        track.stop();
                        track.release();
                    } catch (Exception ignored) {}
                }
            }
        }, "PantherMsgChimeThread").start();
    }

    public synchronized void startSiren(long maxDurationMs) {
        if (alarmRunning) return;
        alarmRunning = true;
        alarmThread = new Thread(() -> {
            long start = System.currentTimeMillis();
            int sampleRate = 16000;
            int chunkSize = sampleRate / 10; // 100ms chunks for responsive stop
            AudioTrack track = null;
            try {
                int minBuf = AudioTrack.getMinBufferSize(
                    sampleRate,
                    AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
                );
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                AudioFormat fmt = new AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build();
                track = new AudioTrack(attrs, fmt, Math.max(minBuf, chunkSize * 4), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
                track.play();

                Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                SharedPreferences prefs = getSharedPreferences("panther_prefs", MODE_PRIVATE);
                short[] phraseBuf = buildCaptainPcm(sampleRate, normalizeCaptainTone(null), true);

                while (alarmRunning && (System.currentTimeMillis() - start) < maxDurationMs) {
                    boolean vibOn = prefs.getBoolean("vibrate", true);
                    if (vibOn && vib != null) {
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                vib.vibrate(VibrationEffect.createOneShot(180, VibrationEffect.DEFAULT_AMPLITUDE));
                            } else {
                                vib.vibrate(180);
                            }
                        } catch (Exception ignored) {}
                    }
                    for (int off = 0; off < phraseBuf.length && alarmRunning; off += chunkSize) {
                        if ((System.currentTimeMillis() - start) >= maxDurationMs) break;
                        int len = Math.min(chunkSize, phraseBuf.length - off);
                        track.write(phraseBuf, off, len);
                    }
                }
            } catch (Exception ignored) {
            } finally {
                alarmRunning = false;
                if (track != null) {
                    try {
                        track.stop();
                        track.release();
                    } catch (Exception ignored) {}
                }
            }
        }, "PantherSirenThread");
        alarmThread.start();
    }

    private void playShortBeep() {
        if (alarmRunning) return;
        new Thread(() -> {
            int sampleRate = 16000;
            short[] phrase = buildCaptainPcm(sampleRate, normalizeCaptainTone(null), false);
            AudioTrack track = null;
            try {
                int minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                AudioFormat fmt = new AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build();
                track = new AudioTrack(attrs, fmt, Math.max(minBuf, 4096), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
                track.play();
                track.write(phrase, 0, phrase.length);
            } catch (Exception ignored) {
            } finally {
                if (track != null) {
                    try { track.stop(); track.release(); } catch (Exception ignored) {}
                }
            }
        }).start();
    }

    private static String normalizeCaptainTone(String rawTone) {
        return "order_melody";
    }

    private short[] buildCaptainPcm(int sampleRate, String rawKey, boolean includePause) {
        // Approved fixed melody ("نغمة الطلب الجديد"): 880->1100->1320->1760 Hz + 2nd harmonic (0.20), triangle, 8ms fade
        double cycleSec = includePause ? 2.72 : 0.92;
        int totalSamples = Math.max(1, (int) (sampleRate * cycleSec));
        int[] mix = new int[totalSamples];

        double[] freqs = { 880.0, 1100.0, 1320.0, 1760.0 };
        double[] offsets = { 0.00, 0.20, 0.40, 0.60 };
        double[] durs = { 0.16, 0.16, 0.16, 0.32 };
        for (int i = 0; i < freqs.length; i++) {
            addTonePulse(mix, sampleRate, true, freqs[i], freqs[i], freqs[i], offsets[i], durs[i], 0.42, 0.008, 0.008);
            addTonePulse(mix, sampleRate, true, freqs[i] * 2.0, freqs[i] * 2.0, freqs[i] * 2.0, offsets[i], durs[i], 0.42 * 0.20, 0.008, 0.008);
        }

        short[] out = new short[totalSamples];
        for (int i = 0; i < totalSamples; i++) {
            int v = mix[i];
            if (v > Short.MAX_VALUE) v = Short.MAX_VALUE;
            else if (v < Short.MIN_VALUE) v = Short.MIN_VALUE;
            out[i] = (short) v;
        }
        return out;
    }

    private void addTonePulse(int[] mix, int sampleRate, boolean triangle, double startFreqHz, double midFreqHz, double endFreqHz, double offsetSec, double durSec, double peakGain, double attackSec, double releaseSec) {
        int startIdx = (int) (offsetSec * sampleRate);
        int durSamples = (int) (durSec * sampleRate);
        if (durSamples <= 0 || startIdx >= mix.length) return;
        int atkSamples = Math.max(1, (int) (Math.min(attackSec, durSec * 0.4) * sampleRate));
        int relSamples = Math.max(1, (int) (Math.min(releaseSec, durSec * 0.4) * sampleRate));
        double maxAmp = 32767.0 * peakGain;
        boolean hasSplitSweep = Math.abs(midFreqHz - endFreqHz) > 0.01;
        int halfSamples = Math.max(1, durSamples / 2);
        double phase = 0.0;

        for (int i = 0; i < durSamples; i++) {
            int idx = startIdx + i;
            if (idx >= mix.length) break;
            double env;
            if (i < atkSamples) {
                env = (double) i / atkSamples;
            } else if (i >= durSamples - relSamples) {
                env = (double) (durSamples - 1 - i) / relSamples;
            } else {
                env = 1.0;
            }

            double freqHz;
            if (hasSplitSweep) {
                if (i < halfSamples) {
                    freqHz = startFreqHz + (midFreqHz - startFreqHz) * ((double) i / halfSamples);
                } else {
                    freqHz = midFreqHz + (endFreqHz - midFreqHz) * ((double) (i - halfSamples) / Math.max(1, durSamples - halfSamples));
                }
            } else {
                freqHz = startFreqHz + (endFreqHz - startFreqHz) * ((double) i / Math.max(1, durSamples - 1));
            }

            double frac = phase - Math.floor(phase);
            double wave = triangle
                ? (frac < 0.5 ? (4.0 * frac - 1.0) : (3.0 - 4.0 * frac))
                : Math.sin(2.0 * Math.PI * frac);
            mix[idx] += (int) Math.round(wave * maxAmp * env);
            phase += freqHz / sampleRate;
        }
    }

    public static void stopSiren() {
        alarmRunning = false;
        if (alarmThread != null) {
            try { alarmThread.interrupt(); } catch (Exception ignored) {}
            alarmThread = null;
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        SharedPreferences prefs = getSharedPreferences("panther_prefs", MODE_PRIVATE);
        boolean online = prefs.getBoolean("online", false);
        String token = prefs.getString("token", "");
        String serverUrl = prefs.getString("server_url", "");
        if (online && token != null && !token.isEmpty() && serverUrl != null && !serverUrl.isEmpty()) {
            try {
                Intent restartIntent = new Intent(getApplicationContext(), CaptainService.class);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    flags |= PendingIntent.FLAG_IMMUTABLE;
                }
                PendingIntent pi = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? PendingIntent.getForegroundService(getApplicationContext(), 1002, restartIntent, flags)
                    : PendingIntent.getService(getApplicationContext(), 1002, restartIntent, flags);

                AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
                if (am != null && pi != null) {
                    long triggerAt = SystemClock.elapsedRealtime() + 1000L;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        if (am.canScheduleExactAlarms()) {
                            am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                        } else {
                            am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                        }
                    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                    } else {
                        am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                    }
                }
            } catch (Exception ignored) {}
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        serviceRunning = false;
        stopSiren();
        if (pollThread != null) {
            try { pollThread.interrupt(); } catch (Exception ignored) {}
            pollThread = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
