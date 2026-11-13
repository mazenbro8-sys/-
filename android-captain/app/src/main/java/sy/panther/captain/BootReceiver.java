package sy.panther.captain;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
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
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception ignored) {}
    }
}
