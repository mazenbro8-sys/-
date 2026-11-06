package sy.panther.captain;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

public class CaptainService extends Service {
    private static final String CHANNEL_BG = "panther_bg_status";
    private static final String CHANNEL_ALERT = "panther_order_alert_v2";
    private static final int NOTIF_BG_ID = 101;
    private static final int NOTIF_OFFER_ID = 202;

    private static volatile boolean alarmRunning = false;
    private static Thread alarmThread = null;
    private static int lastNotifiedOfferId = -1;
    private static int lastSeenActiveOrderId = -1;

    private volatile boolean serviceRunning = false;
    private Thread pollThread = null;
    private PowerManager.WakeLock wakeLock;

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
            if (offer != null) {
                int offerId = offer.optInt("id", 0);
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
                }
                startSiren(60000);
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
                        playShortBeep();
                    }
                    lastSeenActiveOrderId = actId;
                }
            } else {
                lastSeenActiveOrderId = 0;
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
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
                String cachedTone = null;
                short[] phraseBuf = null;

                while (alarmRunning && (System.currentTimeMillis() - start) < maxDurationMs) {
                    String tone = prefs.getString("tone", "soft_bell");
                    if (phraseBuf == null || !tone.equals(cachedTone)) {
                        cachedTone = tone;
                        phraseBuf = buildPhrasePcm(sampleRate, tone, true);
                    }
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
            SharedPreferences prefs = getSharedPreferences("panther_prefs", MODE_PRIVATE);
            String tone = prefs.getString("tone", "soft_bell");
            short[] phrase = buildPhrasePcm(sampleRate, tone, false);
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

    private short[] buildPhrasePcm(int sampleRate, String rawTone, boolean includePause) {
        String tone = rawTone != null ? rawTone : "soft_bell";
        double cycleSec;
        switch (tone) {
            case "marimba": cycleSec = includePause ? 2.10 : 1.05; break;
            case "chime":   cycleSec = includePause ? 1.90 : 0.60; break;
            case "pulse":   cycleSec = includePause ? 2.20 : 1.12; break;
            case "rapid":   cycleSec = includePause ? 1.60 : 0.75; break;
            case "high":    cycleSec = includePause ? 1.75 : 0.68; break;
            case "classic": cycleSec = includePause ? 1.85 : 0.80; break;
            case "soft_bell":
            default:
                tone = "soft_bell";
                cycleSec = includePause ? 2.00 : 0.90;
                break;
        }
        int totalSamples = Math.max(1, (int) (sampleRate * cycleSec));
        int[] mix = new int[totalSamples];

        switch (tone) {
            case "marimba":
                addSoftNote(mix, sampleRate, true, 440.0, 0.00, 0.52, 0.28, 0.008);
                addSoftNote(mix, sampleRate, true, 523.25, 0.17, 0.60, 0.27, 0.008);
                addSoftNote(mix, sampleRate, true, 659.25, 0.34, 0.68, 0.23, 0.008);
                break;
            case "chime":
                addSoftNote(mix, sampleRate, false, 1200.0, 0.00, 0.30, 0.22, 0.008);
                addSoftNote(mix, sampleRate, false, 1600.0, 0.14, 0.38, 0.20, 0.008);
                break;
            case "pulse":
                addSoftNote(mix, sampleRate, false, 220.0, 0.00, 0.48, 0.28, 0.090);
                addSoftNote(mix, sampleRate, false, 220.0, 0.56, 0.52, 0.24, 0.090);
                break;
            case "rapid":
                addSoftNote(mix, sampleRate, true, 880.0, 0.00, 0.20, 0.26, 0.010);
                addSoftNote(mix, sampleRate, true, 659.25, 0.22, 0.22, 0.25, 0.010);
                addSoftNote(mix, sampleRate, true, 880.0, 0.46, 0.24, 0.26, 0.010);
                break;
            case "high":
                addSoftNote(mix, sampleRate, false, 1046.5, 0.00, 0.28, 0.24, 0.012);
                addSoftNote(mix, sampleRate, false, 1318.5, 0.26, 0.36, 0.22, 0.012);
                break;
            case "classic":
                addSoftNote(mix, sampleRate, true, 784.0, 0.00, 0.34, 0.27, 0.015);
                addSoftNote(mix, sampleRate, true, 587.33, 0.36, 0.40, 0.25, 0.015);
                break;
            case "soft_bell":
            default:
                addSoftNote(mix, sampleRate, false, 880.0, 0.00, 0.46, 0.26, 0.014);
                addSoftNote(mix, sampleRate, false, 1046.5, 0.24, 0.60, 0.25, 0.014);
                break;
        }

        short[] out = new short[totalSamples];
        for (int i = 0; i < totalSamples; i++) {
            int v = mix[i];
            if (v > 11000) v = 11000;
            else if (v < -11000) v = -11000;
            out[i] = (short) v;
        }
        return out;
    }

    private void addSoftNote(int[] mix, int sampleRate, boolean triangle, double freqHz, double offsetSec, double durSec, double peakGain, double attackSec) {
        int startIdx = (int) (offsetSec * sampleRate);
        int durSamples = (int) (durSec * sampleRate);
        if (durSamples <= 0 || startIdx >= mix.length) return;
        int atkSamples = Math.max(1, (int) (Math.min(attackSec, durSec * 0.4) * sampleRate));
        double cappedGain = Math.min(peakGain, 0.28);
        double maxAmp = 32767.0 * cappedGain;

        for (int i = 0; i < durSamples; i++) {
            int idx = startIdx + i;
            if (idx >= mix.length) break;
            double env;
            if (i < atkSamples) {
                env = (double) i / atkSamples;
            } else {
                double decayProgress = (double) (i - atkSamples) / Math.max(1, durSamples - atkSamples);
                env = Math.exp(-5.0 * decayProgress);
            }
            double phase = (i * freqHz) / sampleRate;
            double frac = phase - Math.floor(phase);
            double wave = triangle
                ? (frac < 0.5 ? (4.0 * frac - 1.0) : (3.0 - 4.0 * frac))
                : Math.sin(2.0 * Math.PI * frac);
            mix[idx] += (int) (wave * maxAmp * env);
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
