package com.example.southfarm_app

import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {

    private val CHANNEL = "com.example.southfarm_app/warmup"
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "startWarmup" -> {
                    val username = call.argument<String>("username") ?: ""
                    val duration = call.argument<Int>("duration") ?: 5
                    startWarmup(username, duration)
                    result.success(true)
                }
                "stopWarmup" -> {
                    stopWarmup()
                    result.success(true)
                }
                "pauseWarmup" -> {
                    SouthFarmAccessibilityService.pauseWarmupStatic()
                    result.success(true)
                }
                "resumeWarmup" -> {
                    SouthFarmAccessibilityService.resumeWarmupStatic()
                    result.success(true)
                }
                "getStatus" -> {
                    result.success(SouthFarmAccessibilityService.currentStatus)
                }
                "getMetrics" -> {
                    result.success(SouthFarmAccessibilityService.warmupMetrics)
                }
                "isServiceRunning" -> {
                    result.success(SouthFarmAccessibilityService.isRunning)
                }
                "getDeviceInfo" -> {
                    val info = hashMapOf<String, String>(
                        "device_id" to android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID),
                        "device_name" to "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}",
                        "android_version" to android.os.Build.VERSION.RELEASE
                    )
                    result.success(info)
                }
                "isAccessibilityEnabled" -> {
                    result.success(isAccessibilityEnabled())
                }
                "openAccessibilitySettings" -> {
                    openAccessibilitySettings()
                    result.success(true)
                }
                "isOverlayPermissionGranted" -> {
                    result.success(Settings.canDrawOverlays(this))
                }
                "requestOverlayPermission" -> {
                    requestOverlayPermission()
                    result.success(true)
                }
                "startOverlay" -> {
                    startOverlay()
                    result.success(true)
                }
                "stopOverlay" -> {
                    stopOverlay()
                    result.success(true)
                }
                "detectAccounts" -> {
                    Log.e("MainActivity", "detectAccounts called, instance=${SouthFarmAccessibilityService.instance != null}")
                    SouthFarmAccessibilityService.detectAccountsStatic { accountsJson ->
                        Log.e("MainActivity", "detectAccounts result: $accountsJson")
                        handler.post {
                            result.success(accountsJson)
                        }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun startWarmup(username: String, durationMinutes: Int) {
        val success = SouthFarmAccessibilityService.startWarmupStatic(username, durationMinutes)
        if (!success) {
            Log.w("MainActivity", "Accessibility service not running, cannot start warmup")
        }
    }

    private fun stopWarmup() {
        SouthFarmAccessibilityService.stopWarmupStatic()
    }

    private fun isAccessibilityEnabled(): Boolean {
        val service = packageName + "/" + SouthFarmAccessibilityService::class.java.canonicalName
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabledServices.contains(service)
    }

    private fun openAccessibilitySettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
    }

    private fun requestOverlayPermission() {
        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:$packageName")
            ).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
        }
    }

    private fun startOverlay() {
        val intent = Intent(this, SouthFarmOverlayService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun stopOverlay() {
        val intent = Intent(this, SouthFarmOverlayService::class.java)
        stopService(intent)
    }

    private fun scanAccounts() {
        val intent = Intent(this, WarmupReceiver::class.java).apply {
            action = WarmupReceiver.ACTION_DETECT_ACCOUNTS
        }
        sendBroadcast(intent)
    }
}
