package ai.ash.permissionprobe;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class ProbeActivity extends Activity {
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(this);
        column.addView(status);
        add(column, "Request calendar access", v ->
            requestPermissions(new String[]{Manifest.permission.READ_CALENDAR}, 1));
        add(column, "Open notification listener settings", v -> {
            Intent detail = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            detail.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                new ComponentName(this, ProbeListener.class).flattenToString());
            try {
                startActivity(detail);
            } catch (android.content.ActivityNotFoundException unavailable) {
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
            }
        });
        setContentView(column);
        refresh();
    }

    private void add(LinearLayout column, String label, View.OnClickListener click) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(click);
        column.addView(button);
    }

    @Override protected void onResume() { super.onResume(); refresh(); }
    @Override public void onRequestPermissionsResult(int request, String[] names, int[] grants) {
        super.onRequestPermissionsResult(request, names, grants);
        refresh();
    }

    private void refresh() {
        if (status == null) return;
        boolean calendar = checkSelfPermission(Manifest.permission.READ_CALENDAR)
            == PackageManager.PERMISSION_GRANTED;
        boolean listener = getSystemService(NotificationManager.class)
            .isNotificationListenerAccessGranted(
                new android.content.ComponentName(this, ProbeListener.class));
        status.setText("Calendar read: " + calendar + "\nNotification listener: " + listener);
    }
}
