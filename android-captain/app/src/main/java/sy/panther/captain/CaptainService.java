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
            int halfSecSamples = sampleRate / 3; // ~333ms per tone
            short[] hiBuf = buildToneBuffer(sampleRate, halfSecSamples, 1050.0);
            short[] loBuf = buildToneBuffer(sampleRate, halfSecSamples, 700.0);
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
                track = new AudioTrack(attrs, fmt, Math.max(minBuf, halfSecSamples * 2), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
                track.play();

                Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                boolean hi = false;
                while (alarmRunning && (System.currentTimeMillis() - start) < maxDurationMs) {
                    hi = !hi;
                    short[] buf = hi ? hiBuf : loBuf;
                    track.write(buf, 0, buf.length);
                    if (hi && vib != null) {
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                vib.vibrate(VibrationEffect.createOneShot(250, VibrationEffect.DEFAULT_AMPLITUDE));
                            } else {
                                vib.vibrate(250);
                            }
                        } catch (Exception ignored) {}
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
            int samples = sampleRate / 3;
            short[] hi = buildToneBuffer(sampleRate, samples, 1050.0);
            short[] lo = buildToneBuffer(sampleRate, samples, 700.0);
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
                track = new AudioTrack(attrs, fmt, Math.max(minBuf, samples * 2), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
                track.play();
                track.write(hi, 0, hi.length);
                track.write(lo, 0, lo.length);
            } catch (Exception ignored) {
            } finally {
                if (track != null) {
                    try { track.stop(); track.release(); } catch (Exception ignored) {}
                }
            }
        }).start();
    }

    private short[] buildToneBuffer(int sampleRate, int count, double freqHz) {
        short[] buf = new short[count];
        double period = sampleRate / freqHz;
        for (int i = 0; i < count; i++) {
            double phase = (i % period) / period;
            buf[i] = (short) (phase < 0.5 ? 24000 : -24000);
        }
        return buf;
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
