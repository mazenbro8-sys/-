package sy.panther.captain;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "PantherBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        SharedPreferences prefs = context.getSharedPreferences("panther_prefs", Context.MODE_PRIVATE);
        boolean online = prefs.getBoolean("online", false);
        String token = prefs.getString("token", "");
        String serverUrl = prefs.getString("server_url", "");
        if (!online || token == null || token.isEmpty() || serverUrl == null || serverUrl.isEmpty()) {
            return;
        }

        Intent svc = new Intent(context, CaptainService.class);
        svc.setAction(CaptainService.ACTION_START_BACKGROUND);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
            Log.i(TAG, "BootReceiver started CaptainService in dataSync-only background mode; location starts when app opens.");
        } catch (SecurityException se) {
            Log.w(TAG, "BootReceiver background start rejected (SecurityException): " + se.getMessage());
        } catch (Exception e) {
            Log.w(TAG, "BootReceiver background start not allowed (" + e.getClass().getSimpleName() + "): " + e.getMessage());
        }
    }
}
