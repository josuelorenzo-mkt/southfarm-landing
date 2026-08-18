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
        const val EXTRA_USERNAME = "username"
        const val EXTRA_DURATION = "duration"
    }

    override fun onReceive(context: Context, intent: Intent) {
        Log.i(TAG, "Received action: ${intent.action}")

        when (intent.action) {
            ACTION_START_WARMUP -> {
                val username = intent.getStringExtra(EXTRA_USERNAME) ?: ""
                val duration = intent.getIntExtra(EXTRA_DURATION, 5)
                Log.i(TAG, "Start warmup: username=$username, duration=${duration}min")
                SouthFarmAccessibilityService.startWarmupStatic(username, duration)
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
                SouthFarmAccessibilityService.detectAccountsStatic { _ -> }
            }
        }
    }
}
