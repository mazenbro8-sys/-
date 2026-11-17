package sy.panther.captain;

import android.Manifest;
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
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public class CaptainService extends Service {
    public static final String ACTION_START_DATASYNC = "sy.panther.captain.ACTION_START_DATASYNC";
    public static final String ACTION_START_BACKGROUND = "sy.panther.captain.ACTION_START_BACKGROUND";
    public static final String ACTION_START_FOREGROUND_LOCATION = "sy.panther.captain.ACTION_START_FOREGROUND_LOCATION";

    private static final String TAG = "PantherCaptainService";
    private static final String CHANNEL_BG = "panther_bg_status";
    private static final String CHANNEL_ALERT = "panther_order_alert_v2";
    private static final String CHANNEL_MSG = "panther_messages";
    private static final String GROUP_KEY_ADMIN_MSGS = "sy.panther.captain.ADMIN_MESSAGES";
    private static final String PREF_ALERTED_NOTIF_IDS = "alerted_notif_ids";
    private static final int MAX_CHILD_ADMIN_NOTIFS = 8;
    private static final String TEXT_BG_IDLE = "🟢 متصل (أونلاين) — بانتظار الطلبات الجديدة";
    private static final String TEXT_BG_TRACKING = "🟢 متصل (أونلاين) — التتبع شغّال أثناء ساعات العمل";
    private static final int MAX_ALERTED_NOTIF_IDS = 50;
    private static final long INBOX_POLL_INTERVAL_MS = 15_000L;
    private static final long MSG_CHIME_COOLDOWN_MS = 10_000L;
    private static final long LOC_ACTIVE_MS = 10_000L;
    private static final long LOC_IDLE_MOVED_MS = 15_000L;
    private static final long LOC_IDLE_HEARTBEAT_MS = 60_000L;
    private static final long LOC_NETWORK_IDLE_MS = 20_000L;
    private static final float LOC_MOVE_TRIGGER_M = 50.0f;
    private static final float LOC_MAX_ACCEPTABLE_ACC_M = 100.0f;
    private static final float LOC_GPS_PREFERRED_ACC_M = 50.0f;
    private static final long LOC_GPS_PREFERENCE_WINDOW_MS = 20_000L;
    private static final long LOC_GOOD_FIX_GRACE_MS = 60_000L;
    private static final long LOC_MAX_FIX_AGE_MS = 60_000L;
    private static final long LOC_RETRY_DELAY_MS = 5_000L;
    private static final long NATIVE_ACTIVE_WINDOW_MS = 90_000L;
    private static final int NOTIF_BG_ID = 101;
    private static final int NOTIF_OFFER_ID = 202;
    private static final int NOTIF_MSG_SUMMARY_ID = 2999;
    private static final int NOTIF_MSG_BASE_ID = 3000;

    private static volatile boolean uiInForeground = false;
    private static volatile boolean locationTrackingActive = false;
    private static volatile long lastNativePostSuccessElapsedMs = 0L;

    private static volatile boolean alarmRunning = false;
    private static Thread alarmThread = null;
    private static int lastNotifiedOfferId = -1;
    private static int lastSeenActiveOrderId = -1;

    private volatile boolean serviceRunning = false;
    private Thread pollThread = null;
    private PowerManager.WakeLock wakeLock;
    private long lastInboxCheckAt = 0L;
    private long lastMsgChimeAt = 0L;

    private volatile boolean cachedHasActiveOrder = false;
    private volatile long cachedActiveIntervalMs = LOC_ACTIVE_MS;
    private volatile long cachedIdleIntervalMs = LOC_IDLE_HEARTBEAT_MS;

    private final Object locLock = new Object();
    private LocationManager locationManager = null;
    private HandlerThread locHandlerThread = null;
    private Handler locHandler = null;
    private ScheduledExecutorService locNetExecutor = null;
    private ScheduledFuture<?> pendingRetryFuture = null;
    private boolean gpsRegistered = false;
    private boolean networkRegistered = false;
    private long registeredIntervalMs = 0L;
    private boolean registeredActiveMode = false;

    private long lastSentElapsedMs = 0L;
    private double lastSentLat = Double.NaN;
    private double lastSentLng = Double.NaN;
    private long lastAcceptableSentElapsedMs = 0L;
    private long lastGpsFixElapsedMs = 0L;
    private float lastGpsAccuracy = Float.MAX_VALUE;
    private long sendSeq = 0L;
    private boolean authStoppedSending = false;

    public static void setUiInForeground(boolean inForeground) {
        uiInForeground = inForeground;
    }

    public static boolean isNativeTrackingActive() {
        long lastOk = lastNativePostSuccessElapsedMs;
        return locationTrackingActive && lastOk > 0L && (SystemClock.elapsedRealtime() - lastOk) <= NATIVE_ACTIVE_WINDOW_MS;
    }

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
            stopLocationTracking();
            stopSiren();
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent != null ? intent.getAction() : null;
        boolean onlineReady = hasValidOnlinePrefs();
        boolean isExplicitForegroundLoc = ACTION_START_FOREGROUND_LOCATION.equals(action);
        boolean isBackgroundOrBoot = intent == null || ACTION_START_BACKGROUND.equals(action);

        if (isExplicitForegroundLoc && onlineReady && hasFineLocationPermission()) {
            Notification trackingNotif = buildForegroundNotification(TEXT_BG_TRACKING);
            if (startForegroundCompat(trackingNotif, true)) {
                startLocationTracking();
                updateOngoingNotification(TEXT_BG_TRACKING);
            } else {
                Log.w(TAG, "Foreground location FGS upgrade blocked; continuing with dataSync polling only.");
                stopLocationTracking();
                if (!startForegroundCompat(buildForegroundNotification(TEXT_BG_IDLE), false)) {
                    Log.e(TAG, "Explicit foreground-location fallback dataSync startForeground failed; stopping service.");
                    stopSiren();
                    stopSelf();
                    return START_NOT_STICKY;
                }
            }
        } else {
            if (isBackgroundOrBoot) {
                Log.i(TAG, "CaptainService started from boot/background (dataSync only); native location starts when app opens.");
                stopLocationTracking();
            } else if (!hasFineLocationPermission()) {
                Log.i(TAG, "Fine location permission not granted; skipping native location updates and keeping dataSync active.");
                stopLocationTracking();
            } else if (!onlineReady || ACTION_START_DATASYNC.equals(action)) {
                stopLocationTracking();
            }
            Notification bgNotif = buildForegroundNotification(locationTrackingActive ? TEXT_BG_TRACKING : TEXT_BG_IDLE);
            boolean withLoc = locationTrackingActive && hasFineLocationPermission() && uiInForeground;
            if (!startForegroundCompat(bgNotif, withLoc)) {
                Log.w(TAG, "startForegroundCompat failed in background/dataSync branch; retrying with dataSync-only.");
                stopLocationTracking();
                if (!startForegroundCompat(buildForegroundNotification(TEXT_BG_IDLE), false)) {
                    Log.e(TAG, "dataSync-only startForeground retry failed; stopping service.");
                    stopSiren();
                    stopSelf();
                    return START_NOT_STICKY;
                }
            }
        }

        startPolling();
        return START_STICKY;
    }

    private boolean hasValidOnlinePrefs() {
        SharedPreferences prefs = getSharedPreferences("panther_prefs", MODE_PRIVATE);
        boolean online = prefs.getBoolean("online", false);
        String token = prefs.getString("token", "");
        String serverUrl = prefs.getString("server_url", "");
        return online && token != null && !token.isEmpty() && serverUrl != null && !serverUrl.isEmpty();
    }

    private boolean hasFineLocationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean startForegroundCompat(Notification notif, boolean withLocation) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
                if (withLocation) {
                    fgsType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
                }
                startForeground(NOTIF_BG_ID, notif, fgsType);
            } else {
                startForeground(NOTIF_BG_ID, notif);
            }
            return true;
        } catch (SecurityException se) {
            Log.w(TAG, "startForeground SecurityException (withLocation=" + withLocation + "): " + se.getMessage());
            return false;
        } catch (Exception e) {
            Log.w(TAG, "startForeground blocked (" + e.getClass().getSimpleName() + ", withLocation=" + withLocation + "): " + e.getMessage());
            return false;
        }
    }

    private void updateOngoingNotification(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIF_BG_ID, buildForegroundNotification(text));
            }
        } catch (Exception ignored) {}
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
            stopLocationTracking();
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
                stopLocationTracking();
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
                stopLocationTracking();
                stopSiren();
                clearOrderAlertNotification();
                stopSelf();
                return;
            }

            JSONObject intervalsObj = data.optJSONObject("intervals");
            if (intervalsObj != null) {
                long srvActive = intervalsObj.optLong("active", LOC_ACTIVE_MS);
                long srvIdle = intervalsObj.optLong("idle", LOC_IDLE_HEARTBEAT_MS);
                cachedActiveIntervalMs = Math.max(LOC_ACTIVE_MS, srvActive);
                cachedIdleIntervalMs = Math.max(LOC_IDLE_MOVED_MS, srvIdle);
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
            boolean hasActive = activeOrders != null && activeOrders.length() > 0;
            cachedHasActiveOrder = hasActive;
            if (hasActive) {
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

            if (locationTrackingActive) {
                if (!hasFineLocationPermission()) {
                    Log.w(TAG, "Location permission revoked while running; stopping native location updates silently.");
                    stopLocationTracking();
                    if (!startForegroundCompat(buildForegroundNotification(TEXT_BG_IDLE), false)) {
                        updateOngoingNotification(TEXT_BG_IDLE);
                    }
                } else {
                    refreshLocationUpdateIntervalIfNeeded();
                }
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
            List<JSONObject> allUnread = new ArrayList<>();
            List<JSONObject> unalerted = new ArrayList<>();
            for (int i = arr.length() - 1; i >= 0; i--) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                int id = item.optInt("id", 0);
                boolean isRead = item.optBoolean("read", false) || !item.isNull("read_at");
                if (id > 0 && !isRead) {
                    allUnread.add(item);
                    if (!alertedIds.contains(id)) {
                        unalerted.add(item);
                    }
                }
            }

            if (allUnread.isEmpty()) {
                cancelAdminSummaryNotification();
                return;
            }
            if (unalerted.isEmpty() || alarmRunning) return;

            long now = System.currentTimeMillis();
            boolean canChime = (now - lastMsgChimeAt) >= MSG_CHIME_COOLDOWN_MS;
            if (canChime) {
                lastMsgChimeAt = now;
                playMessageChime();
                vibrateBrief(prefs, 200);
            }

            int startIdx = Math.max(0, unalerted.size() - MAX_CHILD_ADMIN_NOTIFS);
            for (int i = startIdx; i < unalerted.size(); i++) {
                JSONObject item = unalerted.get(i);
                int msgId = item.optInt("id", 0);
                if (msgId <= 0) continue;
                String msgTitle = item.optString("title", "رسالة إدارية");
                String msgBody = item.optString("body", "");
                int childNotifId = NOTIF_MSG_BASE_ID + (msgId % 10_000);
                showAdminMessageNotification(childNotifId, msgTitle, msgBody);
            }

            if (allUnread.size() > 1) {
                showAdminMessageSummaryNotification(allUnread);
            } else {
                cancelAdminSummaryNotification();
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

    private void cancelAdminSummaryNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_MSG_SUMMARY_ID);
        } catch (Exception ignored) {}
    }

    private Notification.Builder createAdminMessageBuilder() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_MSG)
            : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_dialog_email)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setGroup(GROUP_KEY_ADMIN_MSGS)
            .setContentIntent(getLaunchPendingIntent());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b.setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY);
        } else {
            b.setPriority(Notification.PRIORITY_HIGH);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setVisibility(Notification.VISIBILITY_PUBLIC);
        }
        return b;
    }

    private void showAdminMessageNotification(int notifId, String title, String body) {
        if (!canPostNotifications()) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String safeTitle = (title == null || title.trim().isEmpty()) ? "رسالة إدارية" : title;
            String safeBody = body == null ? "" : body;
            Notification.Builder b = createAdminMessageBuilder()
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setStyle(new Notification.BigTextStyle().bigText(safeBody));
            nm.notify(notifId, b.build());
        } catch (Exception ignored) {}
    }

    private void showAdminMessageSummaryNotification(List<JSONObject> unreadItems) {
        if (!canPostNotifications() || unreadItems == null || unreadItems.size() <= 1) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            int totalUnread = unreadItems.size();
            String summaryTitle = "لديك " + totalUnread + " رسائل جديدة";
            JSONObject latest = unreadItems.get(unreadItems.size() - 1);
            String latestTitle = latest.optString("title", "رسالة إدارية");
            String latestBody = latest.optString("body", "");
            String summaryText = (latestTitle + (latestBody.isEmpty() ? "" : ": " + latestBody)).trim();

            Notification.InboxStyle inbox = new Notification.InboxStyle()
                .setBigContentTitle(summaryTitle)
                .setSummaryText("افتح التطبيق لقراءة جميع الرسائل الإدارية");
            int countAdded = 0;
            for (int i = unreadItems.size() - 1; i >= 0 && countAdded < 5; i--) {
                JSONObject item = unreadItems.get(i);
                String t = item.optString("title", "رسالة إدارية");
                String d = item.optString("body", "");
                String line = d.isEmpty() ? t : (t + " — " + d);
                if (line.length() > 90) line = line.substring(0, 87) + "...";
                inbox.addLine(line);
                countAdded++;
            }

            Notification.Builder b = createAdminMessageBuilder()
                .setGroupSummary(true)
                .setContentTitle(summaryTitle)
                .setContentText(summaryText)
                .setStyle(inbox);
            nm.notify(NOTIF_MSG_SUMMARY_ID, b.build());
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
                restartIntent.setAction(ACTION_START_BACKGROUND);
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
        stopLocationTracking();
        synchronized (locLock) {
            if (locNetExecutor != null) {
                try { locNetExecutor.shutdownNow(); } catch (Exception ignored) {}
                locNetExecutor = null;
            }
            if (locHandlerThread != null) {
                try { locHandlerThread.quitSafely(); } catch (Exception ignored) {}
                locHandlerThread = null;
                locHandler = null;
            }
        }
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

    // ---------- Native Location Collection & Upload ----------
    private final LocationListener gpsListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            onNativeLocationFix(location, true);
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}
    };

    private final LocationListener networkListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            onNativeLocationFix(location, false);
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}
    };

    private void ensureLocationWorkersLocked() {
        if (locationManager == null) {
            locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        }
        if (locHandlerThread == null || !locHandlerThread.isAlive()) {
            locHandlerThread = new HandlerThread("PantherLocThread");
            locHandlerThread.start();
            locHandler = new Handler(locHandlerThread.getLooper());
        }
        if (locNetExecutor == null || locNetExecutor.isShutdown()) {
            locNetExecutor = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "PantherLocPost"));
        }
    }

    private void startLocationTracking() {
        if (!hasFineLocationPermission() || !hasValidOnlinePrefs()) {
            stopLocationTracking();
            return;
        }
        synchronized (locLock) {
            authStoppedSending = false;
            locationTrackingActive = true;
            ensureLocationWorkersLocked();
            registerLocationUpdatesLocked(cachedHasActiveOrder);
            seedLastKnownLocationLocked();
        }
    }

    private void refreshLocationUpdateIntervalIfNeeded() {
        if (!locationTrackingActive || !hasFineLocationPermission()) return;
        synchronized (locLock) {
            if (!locationTrackingActive) return;
            boolean activeMode = cachedHasActiveOrder;
            long desiredMs = activeMode ? Math.max(LOC_ACTIVE_MS, cachedActiveIntervalMs) : LOC_IDLE_MOVED_MS;
            if (!gpsRegistered || registeredIntervalMs != desiredMs || registeredActiveMode != activeMode) {
                registerLocationUpdatesLocked(activeMode);
            }
        }
    }

    private void registerLocationUpdatesLocked(boolean activeMode) {
        if (locationManager == null || locHandler == null || !hasFineLocationPermission()) return;
        try {
            locationManager.removeUpdates(gpsListener);
        } catch (Exception ignored) {}
        try {
            locationManager.removeUpdates(networkListener);
        } catch (Exception ignored) {}
        gpsRegistered = false;
        networkRegistered = false;

        long gpsMinMs = activeMode ? Math.max(LOC_ACTIVE_MS, cachedActiveIntervalMs) : LOC_IDLE_MOVED_MS;
        long netMinMs = activeMode ? LOC_IDLE_MOVED_MS : LOC_NETWORK_IDLE_MS;
        try {
            if (locationManager.getAllProviders().contains(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    gpsMinMs,
                    0f,
                    gpsListener,
                    locHandler.getLooper()
                );
                gpsRegistered = true;
            }
        } catch (SecurityException se) {
            Log.w(TAG, "GPS requestLocationUpdates permission denied: " + se.getMessage());
            stopLocationTrackingLocked();
            return;
        } catch (Exception e) {
            Log.w(TAG, "GPS provider unavailable: " + e.getMessage());
        }

        try {
            if (locationManager.getAllProviders().contains(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    netMinMs,
                    0f,
                    networkListener,
                    locHandler.getLooper()
                );
                networkRegistered = true;
            }
        } catch (SecurityException ignored) {
        } catch (Exception e) {
            Log.w(TAG, "Network provider unavailable: " + e.getMessage());
        }

        registeredIntervalMs = gpsMinMs;
        registeredActiveMode = activeMode;
    }

    private void seedLastKnownLocationLocked() {
        if (locationManager == null || !hasFineLocationPermission() || locHandler == null) return;
        try {
            Location gpsLast = locationManager.getAllProviders().contains(LocationManager.GPS_PROVIDER)
                ? locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                : null;
            if (gpsLast != null && computeFixAgeMs(gpsLast) <= LOC_MAX_FIX_AGE_MS) {
                locHandler.post(() -> onNativeLocationFix(gpsLast, true));
                return;
            }
            Location netLast = locationManager.getAllProviders().contains(LocationManager.NETWORK_PROVIDER)
                ? locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                : null;
            if (netLast != null && computeFixAgeMs(netLast) <= LOC_MAX_FIX_AGE_MS) {
                locHandler.post(() -> onNativeLocationFix(netLast, false));
            }
        } catch (SecurityException ignored) {
        } catch (Exception ignored) {}
    }

    private void stopLocationTracking() {
        synchronized (locLock) {
            stopLocationTrackingLocked();
        }
    }

    private void stopLocationTrackingLocked() {
        locationTrackingActive = false;
        lastNativePostSuccessElapsedMs = 0L;
        gpsRegistered = false;
        networkRegistered = false;
        registeredIntervalMs = 0L;
        sendSeq++;
        if (pendingRetryFuture != null) {
            try { pendingRetryFuture.cancel(false); } catch (Exception ignored) {}
            pendingRetryFuture = null;
        }
        if (locationManager != null) {
            try { locationManager.removeUpdates(gpsListener); } catch (Exception ignored) {}
            try { locationManager.removeUpdates(networkListener); } catch (Exception ignored) {}
        }
        lastSentElapsedMs = 0L;
        lastSentLat = Double.NaN;
        lastSentLng = Double.NaN;
        lastAcceptableSentElapsedMs = 0L;
        lastGpsFixElapsedMs = 0L;
        lastGpsAccuracy = Float.MAX_VALUE;
    }

    private long computeFixAgeMs(Location loc) {
        long ageNs = SystemClock.elapsedRealtimeNanos() - loc.getElapsedRealtimeNanos();
        long ageMs = ageNs / 1_000_000L;
        if (ageMs < 0L) ageMs = 0L;
        return ageMs;
    }

    private static float distanceMeters(double lat1, double lng1, double lat2, double lng2) {
        float[] res = new float[1];
        Location.distanceBetween(lat1, lng1, lat2, lng2, res);
        return res[0];
    }

    private boolean isUiActuallyVisible() {
        if (!uiInForeground) return false;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isInteractive();
        } catch (Exception ignored) {
            return uiInForeground;
        }
    }

    private void onNativeLocationFix(Location loc, boolean fromGps) {
        if (loc == null || !serviceRunning || !locationTrackingActive || !hasFineLocationPermission()) return;
        double lat = loc.getLatitude();
        double lng = loc.getLongitude();
        if (!Double.isFinite(lat) || !Double.isFinite(lng) || lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0) {
            return;
        }

        long rawAgeMs = computeFixAgeMs(loc);
        if (rawAgeMs > LOC_MAX_FIX_AGE_MS) {
            return;
        }

        long nowElapsed = SystemClock.elapsedRealtime();
        boolean hasAcc = loc.hasAccuracy() && Float.isFinite(loc.getAccuracy()) && loc.getAccuracy() >= 0f;
        float acc = hasAcc ? loc.getAccuracy() : -1f;

        long seqToSend;
        ScheduledExecutorService exec;
        synchronized (locLock) {
            if (!locationTrackingActive || authStoppedSending) return;

            if (fromGps) {
                lastGpsFixElapsedMs = nowElapsed;
                lastGpsAccuracy = hasAcc ? acc : Float.MAX_VALUE;
            } else {
                boolean recentGoodGps = lastGpsFixElapsedMs > 0L
                    && (nowElapsed - lastGpsFixElapsedMs) <= LOC_GPS_PREFERENCE_WINDOW_MS
                    && lastGpsAccuracy <= LOC_GPS_PREFERRED_ACC_M;
                if (recentGoodGps) {
                    return;
                }
            }

            if (hasAcc && acc > LOC_MAX_ACCEPTABLE_ACC_M) {
                boolean noRecentAcceptable = lastAcceptableSentElapsedMs == 0L
                    || (nowElapsed - lastAcceptableSentElapsedMs) > LOC_GOOD_FIX_GRACE_MS;
                if (!noRecentAcceptable) {
                    return;
                }
            }

            boolean isActive = cachedHasActiveOrder;
            long activeGapMs = Math.max(LOC_ACTIVE_MS, cachedActiveIntervalMs);
            long idleGapMs = Math.max(LOC_IDLE_HEARTBEAT_MS, cachedIdleIntervalMs);
            long idleMovedGapMs = Math.min(idleGapMs, Math.max(activeGapMs, LOC_IDLE_MOVED_MS));

            boolean hasLastSent = !Double.isNaN(lastSentLat) && !Double.isNaN(lastSentLng);
            float movedM = hasLastSent ? distanceMeters(lastSentLat, lastSentLng, lat, lng) : Float.MAX_VALUE;
            long targetGapMs = isActive
                ? activeGapMs
                : (movedM >= LOC_MOVE_TRIGGER_M ? idleMovedGapMs : idleGapMs);

            long elapsedSinceSent = lastSentElapsedMs == 0L ? Long.MAX_VALUE : (nowElapsed - lastSentElapsedMs);
            if (lastSentElapsedMs != 0L && elapsedSinceSent < targetGapMs) {
                return;
            }

            lastSentElapsedMs = nowElapsed;
            sendSeq++;
            seqToSend = sendSeq;
            if (pendingRetryFuture != null) {
                try { pendingRetryFuture.cancel(false); } catch (Exception ignored) {}
                pendingRetryFuture = null;
            }
            ensureLocationWorkersLocked();
            exec = locNetExecutor;
        }

        final Location fixCopy = new Location(loc);
        if (exec != null && !exec.isShutdown()) {
            exec.execute(() -> postLocationAttempt(fixCopy, seqToSend, true));
        }
    }

    private void postLocationAttempt(Location loc, long seq, boolean allowRetry) {
        if (!serviceRunning || !locationTrackingActive || authStoppedSending) return;
        synchronized (locLock) {
            if (!locationTrackingActive || authStoppedSending || seq != sendSeq) return;
        }

        long rawAgeMs = computeFixAgeMs(loc);
        if (rawAgeMs > LOC_MAX_FIX_AGE_MS) {
            return;
        }
        long fixAgeMs = Math.max(0L, Math.min(LOC_MAX_FIX_AGE_MS, rawAgeMs));

        SharedPreferences prefs = getSharedPreferences("panther_prefs", MODE_PRIVATE);
        String serverUrl = prefs.getString("server_url", "");
        String token = prefs.getString("token", "");
        boolean online = prefs.getBoolean("online", false);
        if (!online || token == null || token.isEmpty() || serverUrl == null || serverUrl.isEmpty()) {
            return;
        }

        boolean hasAcc = loc.hasAccuracy() && Float.isFinite(loc.getAccuracy()) && loc.getAccuracy() >= 0f;
        float acc = hasAcc ? loc.getAccuracy() : -1f;
        String vis = isUiActuallyVisible() ? "visible" : "hidden";

        HttpURLConnection conn = null;
        try {
            JSONObject body = new JSONObject();
            body.put("lat", loc.getLatitude());
            body.put("lng", loc.getLongitude());
            if (hasAcc) {
                body.put("accuracy", Math.round(acc * 10.0) / 10.0);
            }
            body.put("fix_age_ms", fixAgeMs);
            body.put("vis", vis);

            byte[] payloadBytes = body.toString().getBytes(StandardCharsets.UTF_8);
            URL url = new URL(serverUrl + "/api/captain/location");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Accept", "application/json");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payloadBytes);
            }

            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                long okNow = SystemClock.elapsedRealtime();
                synchronized (locLock) {
                    if (locationTrackingActive && seq == sendSeq) {
                        lastNativePostSuccessElapsedMs = okNow;
                        lastSentLat = loc.getLatitude();
                        lastSentLng = loc.getLongitude();
                        if (!hasAcc || acc <= LOC_MAX_ACCEPTABLE_ACC_M) {
                            lastAcceptableSentElapsedMs = okNow;
                        }
                    }
                }
                return;
            }
            if (code == 401) {
                Log.w(TAG, "Location POST returned 401; stopping native location sends and letting auth handler run.");
                synchronized (locLock) {
                    authStoppedSending = true;
                    stopLocationTrackingLocked();
                }
                return;
            }
            if (code >= 400 && code < 500) {
                return;
            }
            scheduleSingleRetry(loc, seq, allowRetry);
        } catch (Exception e) {
            scheduleSingleRetry(loc, seq, allowRetry);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void scheduleSingleRetry(Location loc, long seq, boolean allowRetry) {
        if (!allowRetry || !serviceRunning || !locationTrackingActive || authStoppedSending) return;
        synchronized (locLock) {
            if (!locationTrackingActive || authStoppedSending || seq != sendSeq) return;
            if (locNetExecutor == null || locNetExecutor.isShutdown()) return;
            if (pendingRetryFuture != null) {
                try { pendingRetryFuture.cancel(false); } catch (Exception ignored) {}
                pendingRetryFuture = null;
            }
            pendingRetryFuture = locNetExecutor.schedule(
                () -> postLocationAttempt(loc, seq, false),
                LOC_RETRY_DELAY_MS,
                TimeUnit.MILLISECONDS
            );
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
