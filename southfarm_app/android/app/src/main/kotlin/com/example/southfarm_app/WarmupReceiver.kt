package com.example.southfarm_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class WarmupReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "WarmupReceiver"
        const val ACTION_START_WARMUP = "com.example.southfarm_app.START_WARMUP"
        const val ACTION_STOP_WARMUP = "com.example.southfarm_app.STOP_WARMUP"
        const val ACTION_GET_STATUS = "com.example.southfarm_app.GET_STATUS"
        const val ACTION_DETECT_ACCOUNTS = "com.example.southfarm_app.DETECT_ACCOUNTS"
        const val ACTION_DUMP_UI = "com.example.southfarm_app.DUMP_UI"
        const val ACTION_SET_API_BASE = "com.example.southfarm_app.SET_API_BASE"
        const val ACTION_SET_DEVICE_TOKEN = "com.example.southfarm_app.SET_DEVICE_TOKEN"
        const val EXTRA_USERNAME = "username"
        const val EXTRA_DURATION = "duration"
        const val EXTRA_PLATFORM = "platform"
        const val EXTRA_BASE = "base"
        const val EXTRA_TOKEN = "token"
    }

    override fun onReceive(context: Context, intent: Intent) {
        Log.i(TAG, "Received action: ${intent.action}")

        when (intent.action) {
            ACTION_START_WARMUP -> {
                val username = intent.getStringExtra(EXTRA_USERNAME) ?: ""
                val duration = intent.getIntExtra(EXTRA_DURATION, 5)
                val platform = intent.getStringExtra(EXTRA_PLATFORM) ?: "instagram"
                Log.i(TAG, "Start warmup: platform=$platform, username=$username, duration=${duration}min")
                SouthFarmAccessibilityService.startWarmupStatic(username, duration, platform)
            }

            ACTION_STOP_WARMUP -> {
                Log.i(TAG, "Stop warmup")
                SouthFarmAccessibilityService.stopWarmupStatic()
            }

            ACTION_GET_STATUS -> {
                Log.i(TAG, "Status requested: ${SouthFarmAccessibilityService.currentStatus}")
            }

            ACTION_DETECT_ACCOUNTS -> {
                Log.i(TAG, "Detecting accounts...")
                val platform = intent.getStringExtra(EXTRA_PLATFORM) ?: "instagram"
                SouthFarmAccessibilityService.detectAccountsStatic(platform) { _ -> }
            }

            ACTION_DUMP_UI -> {
                Log.i(TAG, "UI dump requested")
                SouthFarmAccessibilityService.dumpUiStatic()
            }

            ACTION_SET_API_BASE -> {
                val base = intent.getStringExtra(EXTRA_BASE) ?: ""
                if (isDebuggable(context)) {
                    context.getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
                        .edit().putString("flutter.api_base", base).commit()
                    Log.i(TAG, "API base set to: $base")
                } else {
                    Log.w(TAG, "Ignoring SET_API_BASE: app is not debuggable")
                }
            }

            ACTION_SET_DEVICE_TOKEN -> {
                val token = intent.getStringExtra(EXTRA_TOKEN) ?: ""
                if (isDebuggable(context)) {
                    context.getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
                        .edit().putString("flutter.device_token", token).commit()
                    Log.i(TAG, "Device token set: ${token.take(12)}...")
                } else {
                    Log.w(TAG, "Ignoring SET_DEVICE_TOKEN: app is not debuggable")
                }
            }
        }
    }

    private fun isDebuggable(context: Context): Boolean {
        return (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }
}