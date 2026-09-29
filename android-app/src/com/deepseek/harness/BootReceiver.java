package com.deepseek.harness;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * ash：开机 / 应用升级后拉起前台常驻服务，由它按上次的启动参数把主 Agent 引擎拉起来。
 * 用户在控制台手动停止过的，服务只挂通知、不拉引擎（见 EngineService.KEY_STOPPED）。
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        Log.i("AshBoot", "received " + action);
        try {
            Intent svc = new Intent(ctx, EngineService.class);
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(svc);
            } else {
                ctx.startService(svc);
            }
        } catch (Throwable t) {
            Log.w("AshBoot", "start EngineService failed", t);
        }
    }
}
