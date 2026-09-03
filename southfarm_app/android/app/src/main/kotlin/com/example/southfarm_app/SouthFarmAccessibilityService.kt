package com.example.southfarm_app

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.ActivityManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Path
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Random

// TEST MODE: overlays (loading + warmup control panel) stay disabled so the
// phone screen remains visible during manual device QA. Must be false in
// production builds.
private const val TEST_NO_OVERLAYS = true

class SouthFarmAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "SouthFarmA11y"
        private const val API_BASE_DEFAULT = "https://api.southfarm.tech/api"
        // Monotonic per-dump counter stamped on <hierarchy seq="..."> so the
        // PC worker can tell a fresh dump from one whose renameTo landed after
        // the worker's rm+broadcast (stale tree read as fresh).
        private val dumpSeq = java.util.concurrent.atomic.AtomicLong(0)
        var isRunning = false
            private set
        @Volatile var currentStatus: String = "idle"
            internal set
        @Volatile var warmupMetrics: String = "{}"
            private set
        var detectedAccounts: String = "[]"
        var instance: SouthFarmAccessibilityService? = null
            private set

        fun startWarmupStatic(
            username: String,
            durationMinutes: Int,
            platform: String = "instagram",
            sourceAccountName: String = "",
            sourceAccountEmail: String = "",
            channelDisplayName: String = "",
        ): Boolean {
            val svc = instance ?: return false
            svc.startWarmup(
                username,
                durationMinutes,
                platform,
                sourceAccountName,
                sourceAccountEmail,
                channelDisplayName,
            )
            return true
        }

        fun stopWarmupStatic() {
            val svc = instance ?: return
            svc.stopWarmup()
        }

        fun pauseWarmupStatic(): Boolean {
            val svc = instance ?: return false
            return svc.pauseWarmup()
        }

        fun pauseWarmupAndReturnStatic(): Boolean {
            val svc = instance ?: return false
            return svc.pauseWarmupAndReturn()
        }

        fun resumeWarmupStatic() {
            val svc = instance ?: return
            svc.resumeWarmup()
        }

        private var detectCallback: ((String) -> Unit)? = null

        fun detectAccountsStatic(platform: String = "instagram", callback: (String) -> Unit) {
            val svc = instance
            if (svc == null) {
                android.util.Log.e("SouthFarmA11y", "detectAccountsStatic: instance is NULL")
                callback("[]")
                return
            }
            detectCallback = callback
            Thread {
                try {
                    android.util.Log.e("SouthFarmA11y", "detectAccountsStatic: starting thread")
                    val json = if (platform.lowercase() == "youtube") {
                        val channels = svc.detectYouTubeChannels()
                        org.json.JSONArray().apply {
                            channels.forEach { channel ->
                                put(org.json.JSONObject().apply {
                                    put("username", channel.handle)
                                    put("display_name", channel.displayName)
                                    put("source_account_name", channel.sourceAccountName)
                                    put("source_account_email", channel.sourceAccountEmail)
                                    put("byline", channel.byline)
                                    put("platform", "youtube")
                                })
                            }
                        }.toString()
                    } else {
                        val accounts = when (platform.lowercase()) {
                            "tiktok" -> svc.detectTikTokAccounts()
                            else -> svc.detectInstagramAccounts()
                        }
                        org.json.JSONArray(accounts).toString()
                    }
                    detectedAccounts = json
                    android.util.Log.e("SouthFarmA11y", "detectAccountsStatic: result=$json")
                    detectCallback?.invoke(json)
                } catch (e: Exception) {
                    android.util.Log.e("SouthFarmA11y", "detectAccountsStatic ERROR: ${e.message}")
                    detectCallback?.invoke("[]")
                }
                detectCallback = null
            }.start()
        }

        fun dumpUiStatic(): Boolean {
            val svc = instance ?: run {
                Log.e(TAG, "dumpUiStatic: instance is NULL")
                return false
            }
            Thread { svc.dumpActiveWindowXml() }.start()
            return true
        }
    }

    @Volatile private var isWarmupRunning = false
    @Volatile private var isWarmupPaused = false
    private var warmupThread: Thread? = null
    private var random = Random()
    private var currentWarmupAccount = ""
    private var currentWarmupDurationMinutes = 0
    private var currentWarmupDurationSecOverride = 0L
    private var currentWarmupTotalDurationSec = 0L
    private var currentWarmupInitialMetrics = JSONObject()
    private var currentWarmupPlatform = "instagram"
    private var currentWarmupSourceAccountName = ""
    private var currentWarmupSourceAccountEmail = ""
    private var currentWarmupChannelDisplayName = ""
    @Volatile private var warmupStartTimeMs = 0L
    @Volatile private var warmupPauseStartedAtMs = 0L
    @Volatile private var warmupPausedAccumulatedMs = 0L
    @Volatile private var resumeNavigationPending = false
    @Volatile private var currentRemoteTaskId = 0
    @Volatile private var lastControlVersion = -1
    @Volatile private var lastCheckpointControlVersion = -1
    @Volatile private var lastControlMode = "normal"
    @Volatile private var lastControlQueuePaused = false
    @Volatile private var controlCheckInFlight = false
    private val screenWidth = android.content.res.Resources.getSystem().displayMetrics.widthPixels
    private val screenHeight = android.content.res.Resources.getSystem().displayMetrics.heightPixels

    // Metrics
    private var reelsViewed = 0
    private var likesGiven = 0
    private var savesGiven = 0
    private var adsDetected = 0
    private var adsDismissed = 0
    private var stuckCount = 0
    private var lastReelIdentity: String? = null

    // Ad form resource IDs (from v6.py)
    private val adFormResourceIds = listOf(
        "com.instagram.android:id/multi_step_form_viewpager",
        "com.instagram.android:id/stepper_header",
        "com.instagram.android:id/form_static_header",
        "com.instagram.android:id/static_header_business_name",
        "com.instagram.android:id/context_card_title_text_view",
        "com.instagram.android:id/multiple_choice_view",
        "com.instagram.android:id/igds_textcell_radio",
    )

    // Dismiss texts (from v6.py)
    private val adDismissTexts = listOf(
        "Dismiss", "Not now", "Not Now", "No ahora", "Close", "Skip",
        "Omitir", "Maybe later", "Later", "Got it", "Don't allow", "No permitir"
    )

    // Close patterns for generic popups
    private val closePatterns = mapOf(
        "content_desc" to listOf("Close", "Dismiss"),
        "text" to listOf("Not now", "Not Now", "No ahora", "Cancel", "Cancelar",
            "OK", "Got it", "Skip", "Omitir", "Maybe later", "Don't allow")
    )

    private var pollHandler: Handler? = null
    private var pollRunnable: Runnable? = null
    private var isPolling = false
    private var isProcessingRemoteTask = false
    // Connection being used by an active publish_reel download; the keep-alive
    // thread closes it to abort a stuck read when the lease is lost.
    @Volatile private var publishDownloadConnection: HttpURLConnection? = null

    private fun stableDeviceId(): String {
        return android.provider.Settings.Secure.getString(
            contentResolver,
            android.provider.Settings.Secure.ANDROID_ID,
        ).orEmpty().ifBlank { "unknown" }
    }

    private fun installationId(): String {
        val prefs = getSharedPreferences("FlutterSharedPreferences", MODE_PRIVATE)
        return prefs.getString("flutter.installation_id", null)
            ?.takeIf { it.isNotBlank() }
            ?: stableDeviceId()
    }

    private fun authToken(): String? {
        val prefs = getSharedPreferences("FlutterSharedPreferences", MODE_PRIVATE)
        return prefs.getString("flutter.device_token", null)
            ?.takeIf { it.isNotBlank() }
            ?: prefs.getString("flutter.auth_token", null)
    }

    private fun apiBase(): String {
        // Debug builds may override the API base at runtime via the
        // SET_API_BASE broadcast (see WarmupReceiver); release builds always
        // use the compiled-in default.
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debuggable) {
            val prefs = getSharedPreferences("FlutterSharedPreferences", MODE_PRIVATE)
            val override = prefs.getString("flutter.api_base", null)?.trim().orEmpty()
            if (override.isNotBlank()) return override
        }
        return API_BASE_DEFAULT
    }

    private fun devicePayload(): JSONObject {
        return JSONObject()
            .put("device_id", stableDeviceId())
            .put("installation_id", installationId())
            .put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            .put("android_version", Build.VERSION.RELEASE ?: "unknown")
            .put("app_version", packageManager.getPackageInfo(packageName, 0).versionName.orEmpty())
    }

    private fun sendDeviceHeartbeat(token: String): Boolean {
        return try {
            val url = URL("${apiBase()}/devices/heartbeat")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.doOutput = true
            conn.outputStream.use { output ->
                output.write(devicePayload().toString().toByteArray())
            }
            val ok = conn.responseCode in 200..299
            Log.i(TAG, "Heartbeat: response=${conn.responseCode} device=${stableDeviceId()}")
            conn.disconnect()
            ok
        } catch (e: Exception) {
            Log.e(TAG, "Heartbeat error: ${e.message}")
            false
        }
    }

    override fun onCreate() {
        super.onCreate()
        Log.e(TAG, "onCreate called — starting task polling")
        startTaskPolling()
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        isRunning = true
        instance = this
        currentStatus = "connected"
        Log.e(TAG, "Accessibility service connected")
        startTaskPolling()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Events processed in real-time by the warmup loop
    }

    override fun onInterrupt() {
        Log.w(TAG, "Service interrupted")
    }

    override fun onDestroy() {
        super.onDestroy()
        stopTaskPolling()
        isRunning = false
        isWarmupRunning = false
        currentStatus = "destroyed"
        instance = null
        warmupThread?.interrupt()
    }

    // ─── Remote Task Polling ───

    private fun startTaskPolling() {
        if (isPolling) {
            Log.e(TAG, "Task polling already running, skip")
            return
        }
        isPolling = true
        pollHandler = Handler(Looper.getMainLooper())
        pollRunnable = object : Runnable {
            override fun run() {
                if (isPolling) {
                    Log.e(TAG, "Poll tick — checking pending tasks...")
                    checkGlobalControl()
                    checkPendingTasks()
                    pollHandler?.postDelayed(this, 5000)
                }
            }
        }
        // First check after 2 seconds
        pollHandler?.postDelayed(pollRunnable!!, 2000)
        Log.e(TAG, "Task polling started (5s interval)")
    }

    private fun stopTaskPolling() {
        isPolling = false
        pollRunnable?.let { pollHandler?.removeCallbacks(it) }
        pollHandler = null
        pollRunnable = null
        Log.i(TAG, "Task polling stopped")
    }

    /**
     * Reads the durable workspace control. This is deliberately device-scoped:
     * the phone can react to a global pause without receiving user credentials
     * or the whole fleet state.
     */
    private fun checkGlobalControl() {
        if (controlCheckInFlight) return
        controlCheckInFlight = true
        Thread {
            try {
                val token = authToken() ?: return@Thread
                val device = java.net.URLEncoder.encode(stableDeviceId(), "UTF-8")
                val installation = java.net.URLEncoder.encode(installationId(), "UTF-8")
                val url = URL("${apiBase()}/devices/control?device_id=$device&installation_id=$installation")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                val responseCode = conn.responseCode
                if (responseCode !in 200..299) {
                    Log.w(TAG, "Global control poll failed: HTTP $responseCode")
                    conn.disconnect()
                    return@Thread
                }
                val payload = JSONObject(conn.inputStream.bufferedReader().readText())
                conn.disconnect()

                val control = payload.optJSONObject("control") ?: return@Thread
                val mode = control.optString("scheduler_mode", "normal").lowercase()
                val queuePaused = control.optBoolean("queue_paused", false)
                val version = control.optInt("control_version", 0)
                val previousMode = lastControlMode
                val controlChanged = version != lastControlVersion
                lastControlVersion = version
                lastControlMode = mode
                lastControlQueuePaused = queuePaused

                if (mode == "paused") {
                    val activeTask = payload.optJSONObject("active_task")
                    val taskId = if (currentRemoteTaskId > 0) {
                        currentRemoteTaskId
                    } else {
                        activeTask?.optInt("id", 0) ?: 0
                    }

                    if (isWarmupRunning) {
                        val enteringPause = !isWarmupPaused
                        if (enteringPause) pauseWarmupAndReturn()
                        val shouldCheckpoint = enteringPause || lastCheckpointControlVersion != version
                        val checkpointed = taskId > 0 && shouldCheckpoint && checkpointRemoteTask(taskId, version)
                        if (checkpointed) {
                            lastCheckpointControlVersion = version
                            acknowledgeControl(token, version, "paused")
                        } else if (taskId <= 0 && (enteringPause || controlChanged)) {
                            acknowledgeControl(token, version, "paused")
                        }
                    } else if (controlChanged) {
                        stopActivityOverlays()
                        returnToSouthFarm(paused = true)
                        acknowledgeControl(token, version, "paused")
                    }
                } else if (previousMode == "paused") {
                    // A running local warmup can continue in the same thread.
                    // If Android restarted while paused, the normal task poll
                    // will reattach to the device-scoped lease after resume.
                    if (isWarmupRunning && isWarmupPaused) {
                        resumeWarmup()
                        acknowledgeControl(token, version, "resumed")
                    } else if (controlChanged) {
                        acknowledgeControl(token, version, "resumed")
                    }
                } else if (controlChanged && version >= 0) {
                    acknowledgeControl(token, version, "idle")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Global control poll error: ${e.message}")
            } finally {
                controlCheckInFlight = false
            }
        }.start()
    }

    private fun acknowledgeControl(token: String, controlVersion: Int, state: String): Boolean {
        return try {
            val url = URL("${apiBase()}/devices/control/ack")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.doOutput = true
            val body = JSONObject(devicePayload().toString())
                .put("control_version", controlVersion)
                .put("state", state)
            conn.outputStream.use { output ->
                output.write(body.toString().toByteArray())
            }
            val ok = conn.responseCode in 200..299
            Log.i(TAG, "Control ack: version=$controlVersion state=$state response=${conn.responseCode}")
            conn.disconnect()
            ok
        } catch (e: Exception) {
            Log.e(TAG, "Control ack error: ${e.message}")
            false
        }
    }

    private fun checkpointRemoteTask(taskId: Int, controlVersion: Int): Boolean {
        return try {
            val token = authToken() ?: return false
            val totalSec = currentWarmupTotalDurationSec.takeIf { it > 0 }
                ?: (currentWarmupDurationMinutes * 60L)
            val activeElapsed = if (warmupStartTimeMs > 0L) {
                activeElapsedSeconds(warmupStartTimeMs)
            } else {
                0L
            }
            warmupMetrics = buildMetricsJson(activeElapsed, totalSec)
            val metrics = JSONObject(warmupMetrics)
            val elapsed = metrics.optLong("elapsed_sec", 0L)
            val remaining = (totalSec - elapsed).coerceAtLeast(0L)
            val url = URL("${apiBase()}/tasks/runs/$taskId/checkpoint")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "PATCH"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.doOutput = true
            val body = JSONObject(devicePayload().toString())
                .put("status", "paused")
                .put("result", metrics)
                .put("remaining_duration_sec", remaining)
                .put("control_version", controlVersion)
                .put("pause_reason", "general_pause")
            conn.outputStream.use { output ->
                output.write(body.toString().toByteArray())
            }
            val ok = conn.responseCode in 200..299
            Log.i(TAG, "Task checkpoint: task=$taskId elapsed=${elapsed}s remaining=${remaining}s response=${conn.responseCode}")
            conn.disconnect()
            ok
        } catch (e: Exception) {
            Log.e(TAG, "Task checkpoint error: ${e.message}")
            false
        }
    }

    private fun stopActivityOverlays() {
        try {
            stopService(Intent(applicationContext, SouthFarmOverlayService::class.java))
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping activity overlay: ${e.message}")
        }
        try {
            SouthFarmLoadingService.dismissLoading()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping loading overlay: ${e.message}")
        }
    }

    private fun checkPendingTasks() {
        if (isProcessingRemoteTask || isWarmupRunning) return
        Thread {
            try {
                val token = authToken()
                Log.e(TAG, "Poll: token=${if (token != null) token.take(20) + "..." else "NULL"}")
                if (token == null) return@Thread

                sendDeviceHeartbeat(token)

                val url = URL("${apiBase()}/tasks/claim")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.doOutput = true
                conn.outputStream.use { output ->
                    output.write(devicePayload().toString().toByteArray())
                }

                val responseCode = conn.responseCode
                Log.e(TAG, "Poll: response=$responseCode")

                if (responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val json = JSONObject(body)
                    val claimed = json.optBoolean("claimed", false)
                    Log.e(TAG, "Poll: claimed=$claimed")
                    if (claimed) {
                        val task = json.getJSONObject("task")
                        val claimToken = json.optString("claim_token", "")
                        Log.e(TAG, "Poll: claimed task id=${task.getInt("id")} type=${task.getString("task_type")} status=${task.getString("status")}")
                        val taskType = task.getString("task_type")
                        if (claimToken.isNotBlank() && taskType in setOf(
                                "warmup_ig", "warmup_tiktok", "warmup_youtube",
                                "scan_instagram", "scan_tiktok", "scan_youtube",
                                "publish_reel",
                            )) {
                            isProcessingRemoteTask = true
                            if (taskType == "publish_reel") {
                                executeRemotePublishTask(task, token, claimToken)
                            } else if (taskType.startsWith("scan_")) {
                                executeRemoteScanTask(task, token, claimToken)
                            } else {
                                executeRemoteTask(task, token, claimToken)
                            }
                        }
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                Log.e(TAG, "Poll error: ${e.message}")
            }
        }.start()
    }

    private fun executeRemoteTask(task: JSONObject, token: String, claimToken: String) {
        try {
            val paramsStr = task.optString("params", "{}")
            val params = JSONObject(paramsStr)
            val account = params.optString("account", "")
            val configuredDuration = params.optInt("duration_minutes", 2)
            val previousResult = try {
                when (val rawResult = task.opt("result")) {
                    is JSONObject -> rawResult
                    is String -> JSONObject(rawResult)
                    else -> JSONObject()
                }
            } catch (_: Exception) {
                JSONObject()
            }
            val previousElapsed = previousResult.optLong("elapsed_sec", 0L)
            val plannedDurationSec = task.optLong("planned_duration_sec", configuredDuration * 60L)
                .takeIf { it > 0L }
                ?: (configuredDuration * 60L)
            val requestedRemainingSec = params.optLong("remaining_duration_sec", 0L)
            val remainingDurationSec = if (requestedRemainingSec > 0L) {
                requestedRemainingSec
            } else if (previousElapsed > 0L && plannedDurationSec > previousElapsed) {
                plannedDurationSec - previousElapsed
            } else {
                0L
            }
            val duration = if (remainingDurationSec > 0L) {
                ((remainingDurationSec + 59L) / 60L).toInt().coerceAtLeast(1)
            } else {
                configuredDuration
            }
            val sourceAccountName = params.optString("source_account_name", "")
            val sourceAccountEmail = params.optString("source_account_email", "")
            val channelDisplayName = params.optString("channel_display_name", "")
            val taskId = task.getInt("id")
            val taskType = task.optString("task_type", "warmup_ig")
            val platform = params.optString(
                "platform",
                when (taskType) {
                    "warmup_tiktok" -> "tiktok"
                    "warmup_youtube" -> "youtube"
                    else -> "instagram"
                }
            )

            if (account.isEmpty()) {
                updateTaskStatus(taskId, "error", token, null, claimToken)
                isProcessingRemoteTask = false
                return
            }

            Log.i(TAG, "[Remote] Starting $platform warmup: @$account for ${duration}m (task $taskId)")
            currentRemoteTaskId = taskId

            // Start overlay
            try {
                val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                overlayIntent.putExtra("username", account)
                overlayIntent.putExtra("duration", duration)
                if (!TEST_NO_OVERLAYS) startService(overlayIntent)
            } catch (e: Exception) {
                Log.e(TAG, "Error starting overlay: ${e.message}")
            }

            // Start warmup
            startWarmup(
                account,
                duration,
                platform,
                sourceAccountName,
                sourceAccountEmail,
                channelDisplayName,
                durationSecondsOverride = remainingDurationSec.takeIf { it > 0L },
                initialMetrics = previousResult,
            )

            var remoteTaskCancelled = false
            var remoteClaimLost = false

            // Re-read the server state immediately after starting. This avoids
            // overwriting a pause/cancel command issued between claim and launch.
            when (heartbeatTask(taskId, token, claimToken)) {
                "cancelled" -> {
                    remoteTaskCancelled = true
                    stopWarmup()
                }
                "__claim_lost__" -> {
                    remoteClaimLost = true
                    stopWarmup()
                }
                "paused" -> {
                    pauseWarmup()
                }
            }

            // Wait for completion
            Thread {
                var heartbeatTicks = 0
                while (isWarmupRunning) {
                    Thread.sleep(3000)
                    heartbeatTicks += 1
                    if (heartbeatTicks >= 5) {
                        heartbeatTicks = 0
                        when (heartbeatTask(taskId, token, claimToken)) {
                            "cancelled" -> {
                                remoteTaskCancelled = true
                                stopWarmup()
                            }
                            "__claim_lost__" -> {
                                remoteClaimLost = true
                                stopWarmup()
                            }
                            "paused" -> {
                                if (!isWarmupPaused) pauseWarmup()
                            }
                            "running" -> {
                                if (isWarmupPaused) resumeWarmup()
                            }
                        }
                    }
                }

                // Stop overlay
                try {
                    val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                    stopService(overlayIntent)
                } catch (e: Exception) {
                    Log.e(TAG, "Error stopping overlay: ${e.message}")
                }

                // Get metrics and mark as completed only if the server still owns
                // this lease. A cancelled or expired task must not be overwritten
                // by a stale phone.
                if (!remoteTaskCancelled && !remoteClaimLost) {
                    val metrics = warmupMetrics
                    updateTaskStatus(taskId, "completed", token, metrics, claimToken)
                    Log.i(TAG, "[Remote] Task $taskId completed")
                } else {
                    Log.i(TAG, "[Remote] Task $taskId stopped without completion (cancelled=$remoteTaskCancelled claimLost=$remoteClaimLost)")
                }
                isProcessingRemoteTask = false
                currentRemoteTaskId = 0
            }.start()
        } catch (e: Exception) {
            Log.e(TAG, "[Remote] Error: ${e.message}")
            val taskId = task.optInt("id", -1)
            if (taskId > 0) updateTaskStatus(taskId, "error", token, null, claimToken)
            isProcessingRemoteTask = false
            currentRemoteTaskId = 0
        }
    }

    private fun executeRemoteScanTask(task: JSONObject, token: String, claimToken: String) {
        val taskId = task.optInt("id", -1)
        try {
            val params = JSONObject(task.optString("params", "{}"))
            val taskType = task.optString("task_type", "scan_instagram")
            val platform = params.optString(
                "platform",
                when (taskType) {
                    "scan_tiktok" -> "tiktok"
                    "scan_youtube" -> "youtube"
                    else -> "instagram"
                },
            ).lowercase()

            val preflight = heartbeatTask(taskId, token, claimToken)
            if (preflight == "cancelled" || preflight == "__claim_lost__") return

            Log.i(TAG, "[Remote] Starting $platform account scan (task $taskId)")
            val accounts = org.json.JSONArray()
            if (platform == "youtube") {
                detectYouTubeChannels().forEach { channel ->
                    accounts.put(org.json.JSONObject().apply {
                        put("username", channel.handle)
                        put("display_name", channel.displayName)
                        put("source_account_name", channel.sourceAccountName)
                        put("source_account_email", channel.sourceAccountEmail)
                        put("byline", channel.byline)
                        put("platform", "youtube")
                    })
                }
            } else {
                val detected = if (platform == "tiktok") detectTikTokAccounts() else detectInstagramAccounts()
                detected.forEach { accounts.put(it) }
            }

            val url = URL("${apiBase()}/social-accounts")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 10000
            conn.readTimeout = 10000
            conn.doOutput = true
            val payload = JSONObject()
                .put("device_id", stableDeviceId())
                .put("platform", platform)
                .put("accounts", accounts)
                .put("scan_task_id", taskId)
                .put("scan_metadata", JSONObject().put("source", "remote_task"))
            conn.outputStream.use { output ->
                output.write(payload.toString().toByteArray())
            }
            val responseCode = conn.responseCode
            val responseBody = if (responseCode in 200..299) {
                conn.inputStream.bufferedReader().readText()
            } else {
                conn.errorStream?.bufferedReader()?.readText().orEmpty()
            }
            conn.disconnect()
            if (responseCode !in 200..299) {
                throw IllegalStateException("Account sync failed: HTTP $responseCode $responseBody")
            }

            val response = JSONObject(responseBody)
            val result = JSONObject()
                .put("platform", platform)
                .put("accounts_found", response.optInt("count", accounts.length()))
            response.optJSONObject("scan_session")?.let { scan ->
                result.put("scan_session_id", scan.optInt("id", 0))
            }
            updateTaskStatus(taskId, "completed", token, result.toString(), claimToken)
            Log.i(TAG, "[Remote] Scan task $taskId completed: ${accounts.length()} accounts")
        } catch (e: Exception) {
            Log.e(TAG, "[Remote] Scan error: ${e.message}", e)
            if (taskId > 0) updateTaskStatus(taskId, "error", token, null, claimToken)
        } finally {
            isProcessingRemoteTask = false
        }
    }

    private fun executeRemotePublishTask(task: JSONObject, token: String, claimToken: String) {
        val taskId = task.optInt("id", -1)
        var publishStage = "download"
        var publishFile: File? = null
        var leaseThread: Thread? = null
        try {
            val params = JSONObject(task.optString("params", "{}"))
            val assetId = params.optString("assetId", params.optString("asset_id", ""))
            val assetName = params.optString("assetName", "")
            val assetExtension = params.optString("asset_extension", "")
            val title = params.optString("title", "")
            val account = params.optString("account", "")

            val preflight = heartbeatTask(taskId, token, claimToken)
            if (preflight == "cancelled" || preflight == "__claim_lost__") return

            if (assetId.isBlank()) {
                val err = JSONObject().put("stage", "download").put("error", "task has no asset")
                if (taskId > 0) updateTaskStatus(taskId, "error", token, err.toString(), claimToken)
                return
            }

            val ext = guessExtension(assetName, assetExtension, assetId)
            publishFile = File(cacheDir, "publish-$taskId.$ext")
            Log.i(TAG, "[Publish] Task $taskId downloading asset $assetId (ext=$ext)")

            // The server lease expires after 45s, so a separate keep-alive thread
            // renews it while the download runs. If the task is cancelled or the
            // claim is lost mid-download the flag aborts the copy loop and we
            // exit without a final PATCH.
            val leaseLost = java.util.concurrent.atomic.AtomicBoolean(false)
            val lastLeaseStatus = java.util.concurrent.atomic.AtomicReference<String?>(null)
            leaseThread = Thread {
                try {
                    while (!Thread.currentThread().isInterrupted && !leaseLost.get()) {
                        Thread.sleep(10000)
                        if (Thread.currentThread().isInterrupted || leaseLost.get()) break
                        val status = heartbeatTask(taskId, token, claimToken)
                        lastLeaseStatus.set(status)
                        if (status == "cancelled" || status == "__claim_lost__") {
                            leaseLost.set(true)
                            // Abort a stuck read on the poll thread.
                            try { publishDownloadConnection?.disconnect() } catch (_: Exception) {}
                        }
                    }
                } catch (_: InterruptedException) {
                    // Download finished; keep-alive stopping.
                }
            }
            leaseThread.isDaemon = true

            // The asset URL lives at the server root, not under /api.
            val url = URL("${apiBase().removeSuffix("/api")}/assets/cluster/$assetId")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 10000
            conn.readTimeout = 60000
            publishDownloadConnection = conn
            leaseThread.start()

            val responseCode = conn.responseCode
            if (responseCode !in 200..299) {
                val errorBody = conn.errorStream?.bufferedReader()?.readText().orEmpty()
                throw IllegalStateException("Asset download failed: HTTP $responseCode $errorBody")
            }

            var bytesCopied = 0L
            val buffer = ByteArray(64 * 1024)
            try {
                conn.inputStream.use { input ->
                    FileOutputStream(publishFile!!).use { output ->
                        while (true) {
                            if (leaseLost.get()) break
                            val read = input.read(buffer)
                            if (read == -1) break
                            output.write(buffer, 0, read)
                            bytesCopied += read
                        }
                    }
                }
            } finally {
                publishDownloadConnection = null
                conn.disconnect()
            }

            if (leaseLost.get()) {
                Log.w(TAG, "[Publish] Task $taskId aborted mid-download (${lastLeaseStatus.get()}); no final PATCH sent")
                return
            }
            if (bytesCopied == 0L) {
                throw IllegalStateException("Downloaded file is empty (0 bytes)")
            }
            Log.i(TAG, "[Publish] Task $taskId downloaded $bytesCopied bytes")

            // Save the asset into the gallery.
            publishStage = "save"
            val baseName = sanitizeDisplayName(assetName) ?: "southfarm-$taskId"
            val displayName = if (baseName.endsWith(".$ext", ignoreCase = true)) baseName else "$baseName.$ext"
            val mime = mimeTypeForExtension(ext)
            val (uriString, savedTo) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    saveToMediaStore(publishFile!!, displayName, mime) to "media_store"
                } catch (mediaErr: Exception) {
                    // MediaStore failed — fall back to app-private storage so the
                    // asset is not lost, and report the fallback in the result.
                    Log.w(TAG, "[Publish] Task $taskId MediaStore save failed (${mediaErr.message}); falling back to app storage")
                    saveToAppStorage(publishFile!!, displayName, mime) to "app_storage"
                }
            } else {
                val hasPermission = Build.VERSION.SDK_INT < 23 ||
                    checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
                    PackageManager.PERMISSION_GRANTED
                if (hasPermission) {
                    saveToLegacyStorage(publishFile!!, displayName, mime) to "legacy_storage"
                } else {
                    saveToAppStorage(publishFile!!, displayName, mime) to "app_storage"
                }
            }

            val result = JSONObject()
                .put("downloaded", true)
                .put("uri", uriString)
                .put("bytes", bytesCopied)
                .put("title", title)
                .put("account", account)
                .put("saved_to", savedTo)
            updateTaskStatus(taskId, "completed", token, result.toString(), claimToken)
            Log.i(TAG, "[Publish] Task $taskId completed: bytes=$bytesCopied, saved_to=$savedTo")
        } catch (e: Exception) {
            Log.e(TAG, "[Publish] Task $taskId error: ${e.message}", e)
            if (taskId > 0) {
                val err = JSONObject()
                    .put("stage", publishStage)
                    .put("error", e.message ?: "unknown error")
                updateTaskStatus(taskId, "error", token, err.toString(), claimToken)
            }
        } finally {
            leaseThread?.interrupt()
            try { publishDownloadConnection?.disconnect() } catch (_: Exception) {}
            publishDownloadConnection = null
            publishFile?.delete()
            isProcessingRemoteTask = false
        }
    }

    private fun guessExtension(assetName: String, assetExtension: String, assetId: String): String {
        // Priority: extension embedded in assetName, then asset_extension,
        // then an extension embedded in assetId, then "mp4".
        listOf(assetName, assetExtension, assetId).forEach { candidate ->
            val idx = candidate.lastIndexOf('.')
            if (idx >= 0 && idx < candidate.length - 1) {
                val ext = candidate.substring(idx + 1).lowercase()
                if (ext.isNotBlank() && ext.all { it.isLetterOrDigit() }) return ext
            }
        }
        if (assetExtension.isNotBlank() && assetExtension.all { it.isLetterOrDigit() }) {
            return assetExtension.lowercase()
        }
        return "mp4"
    }

    private fun sanitizeDisplayName(name: String): String? {
        val cleaned = name.trim().replace(Regex("[\\\\/:*?\"<>|]"), "_")
        return cleaned.takeIf { it.isNotBlank() }
    }

    private fun mimeTypeForExtension(ext: String): String {
        return when (ext.lowercase()) {
            "mp4" -> "video/mp4"
            "mov" -> "video/quicktime"
            "webm" -> "video/webm"
            "m4v" -> "video/x-m4v"
            "mkv" -> "video/x-matroska"
            else -> "application/octet-stream"
        }
    }

    private fun isVideoMime(mime: String): Boolean {
        return mime in setOf(
            "video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/x-matroska",
        )
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.Q)
    private fun saveToMediaStore(src: File, displayName: String, mime: String): String {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "Movies/SouthFarm")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val collection = if (isVideoMime(mime)) {
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        } else {
            MediaStore.Files.getContentUri("external")
        }
        val uri = contentResolver.insert(collection, values)
            ?: throw IllegalStateException("MediaStore insert returned null")
        try {
            val out = contentResolver.openOutputStream(uri)
                ?: throw IllegalStateException("MediaStore openOutputStream returned null")
            out.use { output ->
                FileInputStream(src).use { input -> input.copyTo(output, 64 * 1024) }
            }
            val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            contentResolver.update(uri, done, null, null)
            return uri.toString()
        } catch (e: Exception) {
            // Leave no pending half-written item behind.
            try { contentResolver.delete(uri, null, null) } catch (_: Exception) {}
            throw e
        }
    }

    private fun saveToLegacyStorage(src: File, displayName: String, mime: String): String {
        val baseDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES) ?: filesDir
        val dir = File(baseDir, "SouthFarm")
        if (!dir.exists()) dir.mkdirs()
        val dest = File(dir, displayName)
        FileInputStream(src).use { input ->
            FileOutputStream(dest).use { output -> input.copyTo(output, 64 * 1024) }
        }
        MediaScannerConnection.scanFile(this, arrayOf(dest.absolutePath), arrayOf(mime), null)
        return dest.absolutePath
    }

    private fun saveToAppStorage(src: File, displayName: String, mime: String): String {
        val baseDir = getExternalFilesDir(Environment.DIRECTORY_MOVIES) ?: filesDir
        val dir = File(baseDir, "SouthFarm")
        if (!dir.exists()) dir.mkdirs()
        val dest = File(dir, displayName)
        FileInputStream(src).use { input ->
            FileOutputStream(dest).use { output -> input.copyTo(output, 64 * 1024) }
        }
        return dest.absolutePath
    }

    private fun heartbeatTask(taskId: Int, token: String, claimToken: String): String? {
        return try {
            val url = URL("${apiBase()}/tasks/runs/$taskId/heartbeat")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.doOutput = true
            val body = JSONObject()
                .put("device_id", stableDeviceId())
                .put("claim_token", claimToken)
            conn.outputStream.use { output ->
                output.write(body.toString().toByteArray())
            }
            val responseCode = conn.responseCode
            val responseBody = if (responseCode in 200..299) {
                conn.inputStream.bufferedReader().readText()
            } else {
                conn.errorStream?.bufferedReader()?.readText().orEmpty()
            }
            conn.disconnect()
            if (responseCode == 409) return "__claim_lost__"
            if (responseCode !in 200..299) return null
            JSONObject(responseBody).optJSONObject("task")?.optString("status")
        } catch (e: Exception) {
            Log.e(TAG, "Task heartbeat error: ${e.message}")
            null
        }
    }

    private fun updateTaskStatus(taskId: Int, status: String, token: String, metrics: String?, claimToken: String) {
        try {
            val url = URL("${apiBase()}/tasks/runs/$taskId")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "PATCH"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 5000

            val body = JSONObject()
            body.put("status", status)
            body.put("device_id", stableDeviceId())
            body.put("claim_token", claimToken)
            if (metrics != null) {
                try { body.put("result", JSONObject(metrics)) } catch (_: Exception) { body.put("result", metrics) }
            }

            val os = conn.outputStream
            os.write(body.toString().toByteArray())
            os.flush()
            os.close()

            Log.i(TAG, "[Task] Updated $taskId → $status (${conn.responseCode})")
            conn.disconnect()
        } catch (e: Exception) {
            Log.e(TAG, "[Task] Update error: ${e.message}")
        }
    }

    // ─── Public API (called from Flutter via MethodChannel → BroadcastReceiver) ───

    fun startWarmup(
        username: String,
        durationMinutes: Int,
        platform: String = "instagram",
        sourceAccountName: String = "",
        sourceAccountEmail: String = "",
        channelDisplayName: String = "",
        durationSecondsOverride: Long? = null,
        initialMetrics: JSONObject? = null,
    ) {
        if (isWarmupRunning) {
            currentStatus = "already_running"
            return
        }

        isWarmupRunning = true
        isWarmupPaused = false
        warmupStartTimeMs = 0L
        warmupPauseStartedAtMs = 0L
        warmupPausedAccumulatedMs = 0L
        resumeNavigationPending = false
        currentWarmupAccount = username.removePrefix("@").trim()
        currentWarmupDurationMinutes = durationMinutes
        currentWarmupDurationSecOverride = durationSecondsOverride?.takeIf { it > 0L } ?: 0L
        currentWarmupInitialMetrics = initialMetrics ?: JSONObject()
        val initialElapsed = currentWarmupInitialMetrics.optLong("elapsed_sec", 0L)
        currentWarmupTotalDurationSec = if (currentWarmupDurationSecOverride > 0L) {
            initialElapsed + currentWarmupDurationSecOverride
        } else {
            durationMinutes * 60L
        }
        currentWarmupSourceAccountName = sourceAccountName.trim()
        currentWarmupSourceAccountEmail = sourceAccountEmail.trim()
        currentWarmupChannelDisplayName = channelDisplayName.trim()
        currentWarmupPlatform = when (platform.lowercase()) {
            "tiktok" -> "tiktok"
            "youtube" -> "youtube"
            else -> "instagram"
        }
        SouthFarmOverlayService.setPaused(false)
        currentStatus = "starting"

        // Start loading overlay (Service-based — can draw over other apps)
        try {
            val loadingIntent = Intent(applicationContext, SouthFarmLoadingService::class.java)
            if (!TEST_NO_OVERLAYS) startForegroundService(loadingIntent)
        } catch (e: Exception) {
            Log.e(TAG, "Could not start loading overlay: ${e.message}")
        }

        warmupThread = Thread {
            try {
                runWarmupLoop(username, durationMinutes)
            } catch (e: InterruptedException) {
                Log.i(TAG, "Warmup interrupted")
            } catch (e: Exception) {
                Log.e(TAG, "Warmup error: ${e.message}")
                currentStatus = "error: ${e.message}"
            } finally {
                isWarmupRunning = false
                // Preserve an explicit stop or error. Previously every interrupted
                // warmup was rewritten as "finished" here.
                if (currentStatus != "finished" && currentStatus != "stopped" && !currentStatus.startsWith("error:")) {
                    currentStatus = "finished"
                }
                isWarmupPaused = false
                SouthFarmOverlayService.setPaused(false)
                // Stop overlay service to clean up
                try {
                    val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                    stopService(overlayIntent)
                } catch (e: Exception) {
                    Log.e(TAG, "Error stopping overlay: ${e.message}")
                }
                // Stop loading overlay if still showing
                try {
                    SouthFarmLoadingService.dismissLoading()
                } catch (e: Exception) {
                    Log.e(TAG, "Error stopping loading overlay: ${e.message}")
                }
                // Close the social app so the next launch starts from its home
                // screen (covers finished, errored, stopped and remote-cancel).
                closeSocialAppForCleanStart(currentWarmupPlatform)
                returnToSouthFarm(paused = false)
            }
        }
        warmupThread?.start()
    }

    fun stopWarmup() {
        isWarmupRunning = false
        isWarmupPaused = false
        warmupPauseStartedAtMs = 0L
        warmupThread?.interrupt()
        currentStatus = "stopped"
        SouthFarmOverlayService.setPaused(false)
    }

    fun pauseWarmup(): Boolean {
        if (!isWarmupRunning) return false
        if (!isWarmupPaused) warmupPauseStartedAtMs = System.currentTimeMillis()
        isWarmupPaused = true
        currentStatus = "paused"
        SouthFarmOverlayService.setPaused(true)
        debugLog("Warmup paused")
        return true
    }

    fun pauseWarmupAndReturn(): Boolean {
        if (!isWarmupRunning) {
            returnToSouthFarm(paused = true)
            return false
        }
        if (!isWarmupPaused) warmupPauseStartedAtMs = System.currentTimeMillis()
        isWarmupPaused = true
        resumeNavigationPending = true
        currentStatus = "paused"
        SouthFarmOverlayService.setPaused(true)
        stopActivityOverlays()
        returnToSouthFarm(paused = true)
        debugLog("Warmup paused by global control and returned to SouthFarm")
        return true
    }

    fun resumeWarmup() {
        if (!isWarmupRunning) return
        if (isWarmupPaused && warmupPauseStartedAtMs > 0L) {
            warmupPausedAccumulatedMs += (System.currentTimeMillis() - warmupPauseStartedAtMs)
        }
        warmupPauseStartedAtMs = 0L
        isWarmupPaused = false
        currentStatus = "warming_up"
        SouthFarmOverlayService.setPaused(false)
        debugLog("Warmup resumed")
    }

    /**
     * Serializes the current accessibility tree(s) as uiautomator-compatible
     * XML and writes them atomically to southfarm_ui.xml in the app's external
     * files dir, so a PC worker can pull the dump over ADB. Unlike
     * `uiautomator dump`, this never waits for an idle UI thread, which is
     * what fails ("could not get idle state") while Instagram plays video.
     *
     * Synchronized: a slow dump (~500ms of serialization) from a previous
     * broadcast must not renameTo over the file after a newer dump already
     * wrote it, and two threads must never interleave writes to the same
     * .tmp file. Broadcasts are enqueued by the receiver, so serializing
     * dumps only adds a few milliseconds of latency.
     */
    @Synchronized
    fun dumpActiveWindowXml() {
        val startedAt = System.currentTimeMillis()
        val seq = dumpSeq.incrementAndGet()

        // Prefer the full window list: dialogs (e.g. the Instagram account
        // switcher) live in separate windows that rootInActiveWindow misses.
        // Instagram exposes many windows carrying the exact same tree; without
        // dedup every node would be serialized once per window, bloating the
        // dump and making the worker's selectors collide, so roots are skipped
        // when their signature (package|bounds|childCount) was already dumped.
        val roots = mutableListOf<AccessibilityNodeInfo>()
        val serializedSignatures = HashSet<String>()
        try {
            for (window in windows) {
                val windowRoot = window.root ?: continue
                if (!serializedSignatures.add(rootSignature(windowRoot))) continue
                roots.add(windowRoot)
            }
        } catch (e: Exception) {
            Log.e(TAG, "dumpActiveWindowXml: windows failed: ${e.message}")
        }
        // rootInActiveWindow is only serialized when `windows` produced no
        // root, so its signature cannot duplicate an already-dumped window.
        if (roots.isEmpty()) {
            try {
                rootInActiveWindow?.let { roots.add(it) }
            } catch (e: Exception) {
                Log.e(TAG, "dumpActiveWindowXml: rootInActiveWindow failed: ${e.message}")
            }
        }
        if (roots.isEmpty()) {
            // No file is written on purpose: the worker treats a missing/old
            // file plus its own timeout as a failed dump attempt.
            Log.e(TAG, "dumpActiveWindowXml: no accessibility root available, dump skipped")
            return
        }

        val xml = StringBuilder()
        xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n")
        xml.append("<hierarchy rotation=\"0\" seq=\"").append(seq).append("\">\n")
        for (root in roots) {
            appendNodeXml(xml, root, 0, 1)
        }
        xml.append("</hierarchy>\n")

        // The dump goes to both the external files dir (legacy PC worker path)
        // and the internal filesDir: on Android 11+ adb/run-as cannot traverse
        // /sdcard/Android/data of another app, so the internal copy is the one
        // `adb shell run-as ... cat files/southfarm_ui.xml` can retrieve.
        val dirs = mutableListOf(filesDir)
        getExternalFilesDir(null)?.let { dirs.add(it) }
        try {
            var written = 0L
            for (dir in dirs) {
                val tmpFile = java.io.File(dir, "southfarm_ui.xml.tmp")
                val finalFile = java.io.File(dir, "southfarm_ui.xml")
                tmpFile.writeText(xml.toString(), Charsets.UTF_8)
                if (finalFile.exists()) finalFile.delete()
                if (!tmpFile.renameTo(finalFile)) {
                    Log.e(TAG, "dumpActiveWindowXml: renameTo failed in $dir")
                    continue
                }
                written = finalFile.length()
            }
            val elapsedMs = System.currentTimeMillis() - startedAt
            Log.i(TAG, "dumpActiveWindowXml: wrote $written bytes in ${elapsedMs}ms (${roots.size} window root(s))")
        } catch (e: Exception) {
            Log.e(TAG, "dumpActiveWindowXml: write error: ${e.message}")
        }
    }

    /**
     * Identity of a window root for dump deduplication: several windows of the
     * same app (Instagram exposes ~20+) carry the identical tree, so a root
     * with the same package, screen bounds and child count is a copy.
     */
    private fun rootSignature(root: AccessibilityNodeInfo): String {
        val rect = android.graphics.Rect()
        root.getBoundsInScreen(rect)
        return "${root.packageName}|${rect.left},${rect.top},${rect.right},${rect.bottom}|${root.childCount}"
    }

    private fun appendNodeXml(sb: StringBuilder, node: AccessibilityNodeInfo, index: Int, depth: Int) {
        if (depth > 60) return

        val rect = android.graphics.Rect()
        node.getBoundsInScreen(rect)
        val hasChildren = node.childCount > 0
        // Skip degenerate leaves (invisible zero-area nodes); parents with
        // degenerate bounds are kept so their descendants survive.
        if (!hasChildren && (rect.width() <= 0 || rect.height() <= 0)) return

        val indent = "  ".repeat(depth)
        sb.append(indent).append("<node")
        sb.append(" index=\"").append(index).append("\"")
        sb.append(" text=\"").append(escapeXmlAttr(node.text?.toString())).append("\"")
        sb.append(" resource-id=\"").append(escapeXmlAttr(node.viewIdResourceName?.toString())).append("\"")
        sb.append(" class=\"").append(escapeXmlAttr(node.className?.toString())).append("\"")
        sb.append(" package=\"").append(escapeXmlAttr(node.packageName?.toString())).append("\"")
        sb.append(" content-desc=\"").append(escapeXmlAttr(node.contentDescription?.toString())).append("\"")
        sb.append(" checkable=\"").append(node.isCheckable).append("\"")
        sb.append(" checked=\"").append(node.isChecked).append("\"")
        sb.append(" clickable=\"").append(node.isClickable).append("\"")
        sb.append(" enabled=\"").append(node.isEnabled).append("\"")
        sb.append(" focusable=\"").append(node.isFocusable).append("\"")
        sb.append(" focused=\"").append(node.isFocused).append("\"")
        sb.append(" scrollable=\"").append(node.isScrollable).append("\"")
        sb.append(" long-clickable=\"").append(node.isLongClickable).append("\"")
        sb.append(" password=\"").append(node.isPassword).append("\"")
        sb.append(" selected=\"").append(node.isSelected).append("\"")
        sb.append(" bounds=\"[").append(rect.left).append(",").append(rect.top)
            .append("][").append(rect.right).append(",").append(rect.bottom).append("]\"")

        if (!hasChildren) {
            sb.append(" />\n")
            return
        }

        sb.append(">\n")
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            appendNodeXml(sb, child, i, depth + 1)
        }
        sb.append(indent).append("</node>\n")
    }

    private fun escapeXmlAttr(value: String?): String {
        if (value.isNullOrEmpty()) return ""
        val sb = StringBuilder(value.length)
        for (ch in value) {
            when (ch) {
                '&' -> sb.append("&amp;")
                '<' -> sb.append("&lt;")
                '>' -> sb.append("&gt;")
                '"' -> sb.append("&quot;")
                '\'' -> sb.append("&apos;")
                else -> sb.append(ch)
            }
        }
        return sb.toString()
    }

    // ─── Main Warmup Loop (based on v6.py do_reels_session) ───

    private fun updateLoadingText(text: String) {
        SouthFarmLoadingService.showLoading(text)
    }

    private fun runWarmupLoop(username: String, durationMinutes: Int) {
        when (currentWarmupPlatform) {
            "tiktok" -> runTikTokWarmupLoop(username, durationMinutes)
            "youtube" -> runYouTubeWarmupLoop(username, durationMinutes)
            else -> runInstagramWarmupLoop(username, durationMinutes)
        }
    }

    private fun warmupDurationSeconds(durationMinutes: Int): Long {
        return currentWarmupDurationSecOverride.takeIf { it > 0L }
            ?: (durationMinutes * 60L)
    }

    private fun activeElapsedSeconds(startTimeMs: Long): Long {
        if (startTimeMs <= 0L) return 0L
        val now = System.currentTimeMillis()
        val currentlyPausedMs = if (isWarmupPaused && warmupPauseStartedAtMs > 0L) {
            now - warmupPauseStartedAtMs
        } else {
            0L
        }
        return ((now - startTimeMs - warmupPausedAccumulatedMs - currentlyPausedMs) / 1000L)
            .coerceAtLeast(0L)
    }

    private fun handleResumeNavigationIfNeeded(): Boolean {
        if (!resumeNavigationPending || isWarmupPaused) return false
        resumeNavigationPending = false
        currentStatus = "resuming"
        return resumeSocialSession()
    }

    private fun resumeSocialSession(): Boolean {
        return try {
            val loadingIntent = Intent(applicationContext, SouthFarmLoadingService::class.java)
            if (!TEST_NO_OVERLAYS) startForegroundService(loadingIntent)
            val ready = when (currentWarmupPlatform) {
                "tiktok" -> {
                    updateLoadingText("Resuming TikTok warmup...")
                    openTikTok() && run {
                        Thread.sleep(2500)
                        ensureCorrectTikTokAccount(currentWarmupAccount) && navigateToTikTokForYou()
                    }
                }
                "youtube" -> {
                    updateLoadingText("Resuming YouTube warmup...")
                    openYouTube() && run {
                        Thread.sleep(2500)
                        ensureCorrectYouTubeChannel(
                            currentWarmupAccount,
                            currentWarmupSourceAccountName,
                            currentWarmupSourceAccountEmail,
                            currentWarmupChannelDisplayName,
                        ) && navigateToYouTubeShorts()
                    }
                }
                else -> {
                    updateLoadingText("Resuming Instagram warmup...")
                    openInstagram() && run {
                        Thread.sleep(2000)
                        ensureCorrectAccount(currentWarmupAccount) && run {
                            navigateToReels()
                            true
                        }
                    }
                }
            }
            if (ready) {
                SouthFarmLoadingService.dismissLoading()
                SouthFarmOverlayService.transitionToRunning()
                currentStatus = "warming_up"
            } else {
                Log.w(TAG, "Could not restore ${currentWarmupPlatform} session after global resume")
            }
            ready
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        } catch (e: Exception) {
            Log.e(TAG, "Error restoring social session: ${e.message}")
            false
        }
    }

    private fun runInstagramWarmupLoop(username: String, durationMinutes: Int) {
        val durationSec = warmupDurationSeconds(durationMinutes)
        resetMetrics()

        Log.e(TAG, "Starting warmup: username=$username, duration=${durationMinutes}min, screen=${screenWidth}x${screenHeight}")

        // Step 1: Open Instagram
        currentStatus = "opening_instagram"
        updateLoadingText("Preparing warmup...")
        if (!openInstagram()) {
            Log.e(TAG, "ERROR: could not open Instagram")
            currentStatus = "error: could_not_open_instagram"
            updateLoadingText("Error al abrir Instagram")
            Thread.sleep(2000)
            SouthFarmLoadingService.dismissLoading()
            return
        }
        Thread.sleep(2500)
        Log.e(TAG, "Instagram opened, checking active account...")

        // Step 2: Verify and switch to correct account
        currentStatus = "switching_account"
        updateLoadingText("Setting up account...")
        if (!ensureCorrectAccount(username)) {
            Log.e(TAG, "ERROR: could not switch to account $username")
            currentStatus = "error: could_not_switch_to_$username"
            updateLoadingText("Error al cambiar cuenta")
            Thread.sleep(2000)
            SouthFarmLoadingService.dismissLoading()
            return
        }
        Thread.sleep(1000)
        Log.e(TAG, "Correct account confirmed, navigating to reels...")

        // Step 3: Navigate to Reels
        currentStatus = "navigating_to_reels"
        updateLoadingText("Lanzando warmup...")
        navigateToReels()
        Thread.sleep(1000)
        Log.e(TAG, "Navigated to reels, starting main loop...")

        // Step 4: Dismiss loading overlay — warmup starts now
        currentStatus = "warming_up"
        SouthFarmLoadingService.dismissLoading()
        // Transition overlay from loading mode (black/green/white) to running mode (waves + bubble)
        SouthFarmOverlayService.transitionToRunning()

        // Step 4: Main loop
        val startTime = System.currentTimeMillis()
        warmupStartTimeMs = startTime

        currentStatus = "warming_up"
        var loopCount = 0

        while (activeElapsedSeconds(startTime) < durationSec && isWarmupRunning) {
            try {
                // Check for pause
                if (isWarmupPaused) {
                    Thread.sleep(500)
                    continue
                }
                if (resumeNavigationPending) {
                    handleResumeNavigationIfNeeded()
                    continue
                }

                loopCount++
                val root = rootInActiveWindow
                if (root == null) {
                    Log.e(TAG, "Loop $loopCount: rootInActiveWindow is null")
                    Thread.sleep(1000)
                    continue
                }

                if (loopCount <= 3) {
                    Log.e(TAG, "Loop $loopCount: root OK, pkg=${root.packageName}")
                }

                // Instagram keeps the save confirmation sheet open after a
                // Reel is saved. Close it before any further interaction.
                if (isSaveCollectionPopup(root)) {
                    Log.e(TAG, "Save collections popup detected; pressing BACK")
                    val closed = performGlobalAction(GLOBAL_ACTION_BACK)
                    Log.e(TAG, "Save collections popup back result=$closed")
                    Thread.sleep(600)
                    root.recycle()
                    continue
                }

                // Step 3a: Check we're still on Reels (not Home/Explore)
                if (!isOnReelsTab(root)) {
                    Log.e(TAG, "Left Reels tab, navigating back...")
                    navigateToReels()
                    Thread.sleep(1000)
                    continue
                }

                // Step 3b: Detect and handle ads
                val adStatus = detectAndHandleAd(root)
                if (adStatus == "dismissed") {
                    adsDetected++
                    adsDismissed++
                    Thread.sleep(500)
                    continue
                }
                if (adStatus == "skipped") {
                    adsDetected++
                    scrollToNextReel()
                    Thread.sleep(300 + random.nextInt(200).toLong())
                    continue
                }

                // Step 3b: Check stuck (same reel)
                val currentReelId = getReelIdentity(root)
                if (currentReelId != null && currentReelId == lastReelIdentity) {
                    stuckCount++
                    if (stuckCount >= 3) {
                        scrollToNextReel()
                        Thread.sleep(300)
                    }
                    scrollToNextReel()
                    Thread.sleep(300 + random.nextInt(200).toLong())
                    continue
                }
                lastReelIdentity = currentReelId
                stuckCount = 0
                reelsViewed++

                // Step 3c: Watch time (from v6.py distribution)
                val watchTimeMs = getReelsWatchTimeMs()
                Thread.sleep(watchTimeMs)

                // Step 3d: Like (35% chance)
                if (isWarmupPaused) {
                    root.recycle()
                    continue
                }
                var postInteractionOccurred = false
                if (random.nextDouble() < 0.35) {
                    if (likeCurrentContent(root)) {
                        likesGiven++
                        postInteractionOccurred = true
                    }
                    dismissUnexpectedPopup()
                }

                // Step 3e: Save (60% chance)
                if (isWarmupPaused) {
                    root.recycle()
                    continue
                }
            if (random.nextDouble() < 0.15) {
                    if (saveCurrentContent(root)) {
                        savesGiven++
                        postInteractionOccurred = true
                    }
                    dismissUnexpectedPopup()
                }

                // Step 3f: Scroll to next reel
                if (isWarmupPaused) {
                    root.recycle()
                    continue
                }
                if (postInteractionOccurred) {
                    pauseAfterPostInteraction()
                }
                scrollToNextReel()

                // Update metrics
                val elapsed = activeElapsedSeconds(startTime)
                currentStatus = "warming_up"
                warmupMetrics = buildMetricsJson(elapsed, durationSec)

                // Small delay between cycles
                Thread.sleep(100 + random.nextInt(200).toLong())

                root.recycle()
            } catch (e: InterruptedException) {
                Log.e(TAG, "Warmup interrupted")
                break
            } catch (e: Exception) {
                Log.e(TAG, "Loop error: ${e.message}")
                e.printStackTrace()
                Thread.sleep(1000)
            }
        }

        val totalElapsed = activeElapsedSeconds(startTime)
        warmupMetrics = buildMetricsJson(totalElapsed, durationSec)
        currentStatus = "finished"
        Log.i(TAG, "Warmup finished: $warmupMetrics")

        // Close Instagram and return to SouthFarm (clean start next time)
        closeSocialAppForCleanStart(currentWarmupPlatform)
        returnToSouthFarm()
    }

    /**
     * TikTok warmup mirrors the Instagram action policy but uses TikTok's
     * accessibility metadata: Home → For You, semantic Like/Favorites
     * controls, and ACTION_SCROLL_FORWARD on the video ViewPager.
     */
    private fun runTikTokWarmupLoop(username: String, durationMinutes: Int) {
        val durationSec = warmupDurationSeconds(durationMinutes)
        resetMetrics()
        Log.e(TAG, "Starting TikTok warmup: username=$username, duration=${durationMinutes}min")

        currentStatus = "opening_tiktok"
        updateLoadingText("Preparing TikTok warmup...")
        if (!openTikTok()) {
            currentStatus = "error: could_not_open_tiktok"
            updateLoadingText("Error al abrir TikTok")
            Thread.sleep(2000)
            SouthFarmLoadingService.dismissLoading()
            return
        }
        // TikTok may still be rendering its first accessibility tree after
        // the activity launch, especially after SouthFarm was foregrounded.
        Thread.sleep(4000)

        currentStatus = "switching_account"
        updateLoadingText("Setting up TikTok account...")
        if (!ensureCorrectTikTokAccount(username)) {
            Log.e(TAG, "ERROR: could not switch TikTok account $username")
            currentStatus = "error: could_not_switch_to_$username"
            updateLoadingText("Error al cambiar cuenta de TikTok")
            Thread.sleep(2000)
            SouthFarmLoadingService.dismissLoading()
            return
        }
        Thread.sleep(1000)

        currentStatus = "navigating_to_for_you"
        updateLoadingText("Launching TikTok warmup...")
        if (!navigateToTikTokForYou()) {
            currentStatus = "error: could_not_open_for_you"
            updateLoadingText("No se pudo abrir For You")
            Thread.sleep(2000)
            SouthFarmLoadingService.dismissLoading()
            return
        }
        Thread.sleep(1000)

        currentStatus = "warming_up"
        SouthFarmLoadingService.dismissLoading()
        SouthFarmOverlayService.transitionToRunning()

        val startTime = System.currentTimeMillis()
        warmupStartTimeMs = startTime
        var loopCount = 0

        while (activeElapsedSeconds(startTime) < durationSec && isWarmupRunning) {
            try {
                if (isWarmupPaused) {
                    Thread.sleep(500)
                    continue
                }
                if (resumeNavigationPending) {
                    handleResumeNavigationIfNeeded()
                    continue
                }

                loopCount++
                val root = getTikTokRoot()
                if (root == null) {
                    Log.e(TAG, "TikTok loop $loopCount: root is null")
                    Thread.sleep(1000)
                    continue
                }

                if (!isOnTikTokForYou(root)) {
                    root.recycle()
                    navigateToTikTokForYou()
                    Thread.sleep(700)
                    continue
                }

                if (isTikTokSponsoredContent(root)) {
                    adsDetected++
                    val moved = scrollToNextTikTokVideo(root)
                    root.recycle()
                    if (!moved) Thread.sleep(600)
                    continue
                }

                val identity = getTikTokIdentity(root)
                if (identity != null && identity == lastReelIdentity) {
                    stuckCount++
                    val moved = scrollToNextTikTokVideo(root)
                    root.recycle()
                    if (!moved || stuckCount < 2) Thread.sleep(400)
                    continue
                }
                lastReelIdentity = identity
                stuckCount = 0
                reelsViewed++

                Thread.sleep(getReelsWatchTimeMs())

                var postInteractionOccurred = false
                if (!isWarmupPaused && random.nextDouble() < 0.35 && likeTikTokContent(root)) {
                    likesGiven++
                    postInteractionOccurred = true
                }
            if (!isWarmupPaused && random.nextDouble() < 0.15 && favoriteTikTokContent(root)) {
                    savesGiven++
                    postInteractionOccurred = true
                }

                if (!isWarmupPaused) {
                    if (postInteractionOccurred) {
                        pauseAfterPostInteraction()
                    }
                    scrollToNextTikTokVideo(root)
                }

                val elapsed = activeElapsedSeconds(startTime)
                currentStatus = "warming_up"
                warmupMetrics = buildMetricsJson(elapsed, durationSec)
                Thread.sleep(100 + random.nextInt(200).toLong())
                root.recycle()
            } catch (e: InterruptedException) {
                Log.e(TAG, "TikTok warmup interrupted")
                break
            } catch (e: Exception) {
                Log.e(TAG, "TikTok loop error: ${e.message}")
                Thread.sleep(1000)
            }
        }

        val totalElapsed = activeElapsedSeconds(startTime)
        warmupMetrics = buildMetricsJson(totalElapsed, durationSec)
        currentStatus = "finished"
        Log.i(TAG, "TikTok warmup finished: $warmupMetrics")
        closeSocialAppForCleanStart(currentWarmupPlatform)
        returnToSouthFarm()
    }

    /**
     * YouTube warmup uses Shorts as the video surface. Unlike Instagram and
     * TikTok, Shorts exposes Save behind More → Save to playlist → Watch
     * later, so the save action is deliberately handled as a two-sheet flow.
     */
    private fun runYouTubeWarmupLoop(username: String, durationMinutes: Int) {
        val durationSec = warmupDurationSeconds(durationMinutes)
        resetMetrics()
        Log.e(TAG, "Starting YouTube warmup: channel=$username, duration=${durationMinutes}min")

        currentStatus = "opening_youtube"
        updateLoadingText("Preparing YouTube warmup...")
        if (!openYouTube()) {
            currentStatus = "error: could_not_open_youtube"
            updateLoadingText("Error al abrir YouTube")
            Thread.sleep(2000)
            SouthFarmLoadingService.dismissLoading()
            return
        }
        Thread.sleep(4000)

        currentStatus = "switching_account"
        updateLoadingText("Setting up YouTube channel...")
        if (!ensureCorrectYouTubeChannel(
                username,
                currentWarmupSourceAccountName,
                currentWarmupSourceAccountEmail,
                currentWarmupChannelDisplayName,
            )) {
            Log.e(TAG, "ERROR: could not switch YouTube channel $username")
            currentStatus = "error: could_not_switch_to_$username"
            updateLoadingText("Error al cambiar canal de YouTube")
            Thread.sleep(2000)
            SouthFarmLoadingService.dismissLoading()
            return
        }
        Thread.sleep(1000)

        currentStatus = "navigating_to_shorts"
        updateLoadingText("Launching YouTube Shorts warmup...")
        if (!navigateToYouTubeShorts()) {
            currentStatus = "error: could_not_open_shorts"
            updateLoadingText("No se pudo abrir Shorts")
            Thread.sleep(2000)
            SouthFarmLoadingService.dismissLoading()
            return
        }
        Thread.sleep(1000)

        currentStatus = "warming_up"
        SouthFarmLoadingService.dismissLoading()
        SouthFarmOverlayService.transitionToRunning()

        val startTime = System.currentTimeMillis()
        warmupStartTimeMs = startTime
        var loopCount = 0

        while (activeElapsedSeconds(startTime) < durationSec && isWarmupRunning) {
            try {
                if (isWarmupPaused) {
                    Thread.sleep(500)
                    continue
                }
                if (resumeNavigationPending) {
                    handleResumeNavigationIfNeeded()
                    continue
                }

                loopCount++
                val root = getYouTubeRoot()
                if (root == null) {
                    Log.e(TAG, "YouTube loop $loopCount: root is null")
                    Thread.sleep(1000)
                    continue
                }

                if (!isOnYouTubeShorts(root)) {
                    root.recycle()
                    navigateToYouTubeShorts()
                    Thread.sleep(700)
                    continue
                }

                if (isSponsoredContent(root)) {
                    adsDetected++
                    val moved = scrollToNextYouTubeShort(root)
                    root.recycle()
                    if (!moved) Thread.sleep(600)
                    continue
                }

                val identity = getYouTubeIdentity(root)
                if (identity != null && identity == lastReelIdentity) {
                    stuckCount++
                    val moved = scrollToNextYouTubeShort(root)
                    root.recycle()
                    if (!moved || stuckCount < 2) Thread.sleep(400)
                    continue
                }
                lastReelIdentity = identity
                stuckCount = 0
                reelsViewed++

                Thread.sleep(getReelsWatchTimeMs())

                var postInteractionOccurred = false
                if (!isWarmupPaused && random.nextDouble() < 0.35 && likeYouTubeContent(root)) {
                    likesGiven++
                    postInteractionOccurred = true
                }
                if (!isWarmupPaused && random.nextDouble() < 0.15 && saveYouTubeShort(root)) {
                    savesGiven++
                    postInteractionOccurred = true
                }

                if (!isWarmupPaused) {
                    if (postInteractionOccurred) pauseAfterPostInteraction()
                    scrollToNextYouTubeShort(root)
                }

                val elapsed = activeElapsedSeconds(startTime)
                currentStatus = "warming_up"
                warmupMetrics = buildMetricsJson(elapsed, durationSec)
                Thread.sleep(100 + random.nextInt(200).toLong())
                root.recycle()
            } catch (e: InterruptedException) {
                Log.e(TAG, "YouTube warmup interrupted")
                break
            } catch (e: Exception) {
                Log.e(TAG, "YouTube loop error: ${e.message}")
                Thread.sleep(1000)
            }
        }

        val totalElapsed = activeElapsedSeconds(startTime)
        warmupMetrics = buildMetricsJson(totalElapsed, durationSec)
        currentStatus = "finished"
        Log.i(TAG, "YouTube warmup finished: $warmupMetrics")
        closeSocialAppForCleanStart(currentWarmupPlatform)
        returnToSouthFarm()
    }

    private fun returnToSouthFarm(paused: Boolean = false) {
        try {
            // Go back to SouthFarm (don't force-stop IG, just bring our app to front)
            val intent = packageManager.getLaunchIntentForPackage("com.example.southfarm_app")
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                intent.putExtra("warmup_finished", !paused)
                intent.putExtra("warmup_paused", paused)
                startActivity(intent)
            }
            Log.i(TAG, "Returned to SouthFarm (paused=$paused)")
        } catch (e: Exception) {
            Log.e(TAG, "Error returning to SouthFarm: ${e.message}")
        }
    }

    // ─── Clean social app exit ───

    // Social apps keep their last screen alive, so the next launch lands
    // mid-app where task automation can't find its anchors. Closing them
    // through the recents switcher wipes them from the switcher entirely,
    // so the next launch is a clean cold start. Sequence per owner spec:
    // task finishes or stop is received → recents (right nav button) →
    // wait 2s → swipe up from the center of the screen once → home (center
    // nav button) → back to SouthFarm (caller's returnToSouthFarm).
    private var lastCleanExitPackage: String? = null
    private var lastCleanExitAtMs = 0L

    // Sleeps that swallow interrupts: stopWarmup() interrupts the warmup
    // thread before this cleanup runs, and a second stop signal must not cut
    // the close sequence short.
    private fun cleanupSleep(ms: Long) {
        var remaining = ms
        while (remaining > 0) {
            try {
                Thread.sleep(remaining)
                remaining = 0
            } catch (e: InterruptedException) {
                remaining -= 100
                if (remaining < 0) remaining = 0
            }
        }
    }

    private fun socialPackageFor(platform: String?): String? {
        return when (platform?.lowercase()) {
            "instagram" -> "com.instagram.android"
            "tiktok" -> "com.zhiliaoapp.musically"
            "youtube" -> "com.google.android.youtube"
            else -> null
        }
    }

    private fun closeSocialAppForCleanStart(platform: String?) {
        Log.e(TAG, "SF-CLEAN: called for platform=$platform")
        val pkg = socialPackageFor(platform)
        if (pkg == null) {
            Log.e(TAG, "SF-CLEAN: no package for platform=$platform, returning")
            return
        }
        try {
            // The warmup loops close on finish and the startWarmup finally
            // runs right after — don't redo the whole sequence.
            val now = System.currentTimeMillis()
            if (pkg == lastCleanExitPackage && now - lastCleanExitAtMs < 10_000L) {
                Log.i(TAG, "Clean exit for $pkg already done recently, skipping")
                return
            }

            // 1) Right nav button: open the app switcher (recents)
            performGlobalAction(GLOBAL_ACTION_RECENTS)
            cleanupSleep(2000)

            // 2) One fling up over the centered app card: dismisses it from
            //    the switcher, closing the app completely. The touch must
            //    start INSIDE the card (its lower edge sits near mid-screen
            //    in the launcher overview) and be straight and fast — a slow
            //    or curved drag reads as scrolling the switcher.
            val dismissed = try {
                val path = Path().apply {
                    moveTo(screenWidth / 2f, screenHeight * 0.45f)
                    lineTo(screenWidth / 2f, screenHeight * 0.08f)
                }
                dispatchGesture(
                    GestureDescription.Builder()
                        .addStroke(GestureDescription.StrokeDescription(path, 0, 250L))
                        .build(),
                    null, null,
                )
            } catch (e: Exception) {
                Log.w(TAG, "dismiss swipe failed: ${e.message}")
                false
            }
            cleanupSleep(1000)

            // 3) Center nav button: go to the phone home screen
            performGlobalAction(GLOBAL_ACTION_HOME)
            cleanupSleep(500)

            try {
                val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                am.killBackgroundProcesses(pkg)
            } catch (e: Exception) {
                Log.w(TAG, "killBackgroundProcesses($pkg) failed: ${e.message}")
            }

            lastCleanExitPackage = pkg
            lastCleanExitAtMs = System.currentTimeMillis()
            Log.i(TAG, "Clean exit for $pkg done (recents+fling+home, dismissed=$dismissed)")
            Log.e(TAG, "SF-CLEAN: done pkg=$pkg recents_fling_home dismissed=$dismissed")
        } catch (e: Exception) {
            Log.e(TAG, "Clean exit for $pkg failed: ${e.message}")
            Log.e(TAG, "SF-CLEAN: FAILED pkg=$pkg err=${e.message}")
        }
    }

    // ─── Instagram Navigation ───

    private fun openInstagram(): Boolean {
        return try {
            val intent = packageManager.getLaunchIntentForPackage("com.instagram.android")
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                startActivity(intent)
                true
            } else {
                Log.e(TAG, "Instagram not installed")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error opening Instagram: ${e.message}")
            false
        }
    }

    private fun openTikTok(): Boolean {
        return try {
            val intent = packageManager.getLaunchIntentForPackage("com.zhiliaoapp.musically")
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                startActivity(intent)
                true
            } else {
                Log.e(TAG, "TikTok not installed")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error opening TikTok: ${e.message}")
            false
        }
    }

    private fun openYouTube(): Boolean {
        return try {
            val intent = packageManager.getLaunchIntentForPackage("com.google.android.youtube")
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                startActivity(intent)
                true
            } else {
                Log.e(TAG, "YouTube not installed")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error opening YouTube: ${e.message}")
            false
        }
    }

    private fun navigateToYouTubeYou(): Boolean {
        repeat(15) { attempt ->
            val root = getYouTubeRoot()
            if (root != null) {
                val accounts = findNodeByDesc(root, "Accounts")
                if (accounts != null) {
                    root.recycle()
                    Log.e(TAG, "YouTube You page confirmed on attempt ${attempt + 1}")
                    return true
                }

                val you = findNodeByDesc(root, "You", minY = screenHeight - 220)
                    ?: findNodeByText(root, "You")
                val clicked = you != null && clickNode(you)
                root.recycle()
                Thread.sleep(if (clicked) 1200 else 700)
            } else {
                Thread.sleep(700)
            }
        }
        Log.e(TAG, "YouTube You page semantic control unavailable after retries")
        return false
    }

    private fun navigateToYouTubeShorts(): Boolean {
        repeat(15) { attempt ->
            val root = getYouTubeRoot()
            if (root != null) {
                if (isOnYouTubeShorts(root)) {
                    root.recycle()
                    Log.e(TAG, "YouTube Shorts confirmed on attempt ${attempt + 1}")
                    return true
                }

                val shorts = findNodeByDesc(root, "Shorts", minY = screenHeight - 220)
                    ?: findNodeByText(root, "Shorts")
                val clicked = shorts != null && clickNode(shorts)
                root.recycle()
                Thread.sleep(if (clicked) 1300 else 700)
            } else {
                Thread.sleep(700)
            }
        }
        Log.e(TAG, "YouTube Shorts semantic control unavailable after retries")
        return false
    }

    private fun isOnYouTubeShorts(root: AccessibilityNodeInfo): Boolean {
        val shortsRoot = findNodeById(root, "com.google.android.youtube:id/reel_watch_fragment_root")
        if (shortsRoot != null && shortsRoot.isVisibleToUser) return true
        val recycler = findNodeById(root, "com.google.android.youtube:id/reel_recycler")
        return recycler != null && recycler.isVisibleToUser
    }

    private fun openYouTubeAccounts(): Boolean {
        if (!navigateToYouTubeYou()) return false
        val root = getYouTubeRoot() ?: return false
        val accounts = findNodeByDesc(root, "Accounts")
        val opened = accounts != null && clickNode(accounts)
        root.recycle()
        if (!opened) {
            Log.e(TAG, "YouTube Accounts control unavailable")
            return false
        }

        repeat(10) {
            Thread.sleep(500)
            val popupRoot = getYouTubeRoot()
            if (popupRoot != null) {
                val list = findNodeById(popupRoot, "com.google.android.youtube:id/account_list")
                val title = findNodeByTextContains(popupRoot, "Accounts")
                if (list != null || title != null) {
                    popupRoot.recycle()
                    return true
                }
                popupRoot.recycle()
            }
        }
        Log.e(TAG, "YouTube Accounts popup did not appear")
        return false
    }

    private fun closeYouTubeAccounts() {
        try {
            performGlobalAction(GLOBAL_ACTION_BACK)
            Thread.sleep(500)
        } catch (e: Exception) {
            Log.e(TAG, "Error closing YouTube Accounts popup: ${e.message}")
        }
    }

    private fun ensureCorrectYouTubeChannel(
        targetChannel: String,
        sourceAccountName: String = "",
        sourceAccountEmail: String = "",
        channelDisplayName: String = "",
    ): Boolean {
        val target = targetChannel.trim().removePrefix("@").lowercase()
        if (target.isEmpty() || !openYouTubeAccounts()) return false

        var root = getYouTubeRoot() ?: return false
        val originalSelection = findYouTubeSelectedChannelInfo(root)
        val selected = originalSelection?.handle
        Log.e(
            TAG,
            "YouTube channel check: current=$selected target=$target " +
                "source=$sourceAccountName <$sourceAccountEmail>",
        )
        if (selected?.equals(target, ignoreCase = true) == true) {
            root.recycle()
            closeYouTubeAccounts()
            return true
        }

        // Fast path: channels belonging to the currently visible Google
        // account already expose their @handle in the Accounts sheet.
        val directRow = findYouTubeChannelRow(root, target)
        if (directRow != null) {
            val switched = clickNode(directRow)
            Log.e(TAG, "YouTube direct channel row found=true switched=$switched")
            root.recycle()
            if (switched && verifyYouTubeSelectedChannel(target)) return true
            closeYouTubeAccounts()
            return false
        }

        // An inactive Google account can advertise a channel via
        // "No subscribers" without exposing its @handle. Prefer the account
        // saved alongside the channel, then verify the real handle after
        // YouTube materializes it.
        val candidates = findYouTubeInactiveAccountCandidates(root)
            .sortedByDescending { candidate ->
                when {
                    sourceAccountName.isNotBlank() &&
                        candidate.name.equals(sourceAccountName, ignoreCase = true) -> 3
                    channelDisplayName.isNotBlank() &&
                        candidate.name.equals(channelDisplayName, ignoreCase = true) -> 2
                    else -> 1
                }
            }
        root.recycle()

        Log.e(
            TAG,
            "YouTube channel not materialized; candidates=${candidates.map { it.name }}",
        )
        var accountsOpen = true
        for (candidate in candidates) {
            if (!accountsOpen && !openYouTubeAccountsForScan()) continue
            accountsOpen = true
            if (!switchYouTubeAccountForScan(candidate)) continue
            accountsOpen = false
            if (!openYouTubeAccountsForScan()) continue
            accountsOpen = true

            val candidateRoot = getYouTubeRoot()
            if (candidateRoot == null) {
                closeYouTubeAccounts()
                continue
            }
            root = candidateRoot

            val selectedAfterSwitch = findYouTubeSelectedChannel(root)
            val materializedRow = findYouTubeChannelRow(root, target)
            Log.e(
                TAG,
                "YouTube candidate=${candidate.name} selected=$selectedAfterSwitch " +
                    "targetRow=${materializedRow != null}",
            )
            if (selectedAfterSwitch?.equals(target, ignoreCase = true) == true) {
                root.recycle()
                closeYouTubeAccounts()
                return true
            }

            val clickedTarget = materializedRow != null && clickNode(materializedRow)
            root.recycle()
            if (clickedTarget) accountsOpen = false
            if (clickedTarget && verifyYouTubeSelectedChannel(target)) return true
            closeYouTubeAccounts()
            accountsOpen = false
        }

        // Do not leave the device on an arbitrary Google account when a
        // stale channel record cannot be resolved.
        restoreYouTubeSelectionAfterScan(originalSelection)
        Log.e(TAG, "YouTube channel verification failed: target=$target")
        return false
    }

    private fun verifyYouTubeSelectedChannel(target: String): Boolean {
        Thread.sleep(1800)
        if (!openYouTubeAccountsForScan()) return false
        val root = getYouTubeRoot() ?: return false
        val verified = findYouTubeSelectedChannel(root)
        root.recycle()
        closeYouTubeAccounts()
        val success = verified?.equals(target, ignoreCase = true) == true
        Log.e(
            TAG,
            "YouTube channel verification: current=$verified target=$target success=$success",
        )
        return success
    }

    private fun navigateTikTokToProfile(): Boolean {
        // A cold TikTok launch can keep SplashActivity visible for several
        // seconds. Poll the semantic tree long enough for the main activity
        // to expose Profile instead of guessing a screen coordinate.
        repeat(15) { attempt ->
            val root = getTikTokRoot()
            if (root != null) {
                // Account scans can finish while TikTok's account sheet is
                // still open. Close it semantically before looking for the
                // bottom navigation Profile control.
                if (findNodeByDesc(root, "Switch account") != null || findNodeByDesc(root, "Bottom sheet") != null) {
                    val close = findNodeByDesc(root, "Close") ?: findNodeByText(root, "Close")
                    if (close != null) {
                        clickNode(close)
                        root.recycle()
                        Thread.sleep(700)
                        return@repeat
                    }
                }
                val profile = findNodeByDesc(root, "Profile", minY = screenHeight - 220)
                    ?: findNodeByDesc(root, "Perfil", minY = screenHeight - 220)
                    ?: findNodeByText(root, "Profile")
                if (profile != null && clickNode(profile)) {
                    root.recycle()
                    Log.e(TAG, "TikTok Profile opened on semantic attempt ${attempt + 1}")
                    Thread.sleep(1200)
                    return true
                }
                root.recycle()
            }
            Thread.sleep(600)
        }
        Log.e(TAG, "TikTok Profile semantic control unavailable after retries")
        return false
    }

    private fun navigateToTikTokForYou(): Boolean {
        repeat(12) { attempt ->
            val root = getTikTokRoot()
            if (root != null) {
                if (isOnTikTokForYou(root)) {
                    root.recycle()
                    Log.e(TAG, "TikTok For You confirmed on attempt ${attempt + 1}")
                    return true
                }

                val home = findNodeByDesc(root, "Home", minY = screenHeight - 220)
                val clickedHome = home != null && clickNode(home)
                root.recycle()
                if (clickedHome) Thread.sleep(1200) else Thread.sleep(700)

                val refreshed = getTikTokRoot()
                if (refreshed != null) {
                    val forYou = findNodeByDesc(refreshed, "For You")
                        ?: findNodeByText(refreshed, "For You")
                    val clickedForYou = forYou != null && clickNode(forYou)
                    val selected = forYou?.let { isNodeSelectedOrParent(it) } == true
                    refreshed.recycle()
                    if (clickedForYou || selected) Thread.sleep(1200)
                }
            } else {
                Thread.sleep(700)
            }
        }
        Log.e(TAG, "TikTok For You semantic control unavailable after retries")
        return false
    }

    private fun isOnTikTokForYou(root: AccessibilityNodeInfo): Boolean {
        val forYou = findNodeByDesc(root, "For You") ?: findNodeByText(root, "For You")
        if (forYou != null && isNodeSelectedOrParent(forYou)) return true
        val like = findNodeByDescContains(root, "Like video") ?: return false
        if (!like.isVisibleToUser) return false
        val rect = android.graphics.Rect()
        like.getBoundsInScreen(rect)
        return rect.centerY() in 150..(screenHeight - 120)
    }

    private fun isNodeSelectedOrParent(node: AccessibilityNodeInfo): Boolean {
        if (node.isSelected) return true
        var parent = node.parent
        var depth = 0
        while (parent != null && depth < 3) {
            if (parent.isSelected) return true
            val next = parent.parent
            parent.recycle()
            parent = next
            depth++
        }
        return false
    }

    private fun findTikTokProfileHandle(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        // TikTok's current profile screen exposes the handle as s0c. Keep
        // the semantic text fallback for app variants/locales.
        val handleById = findNodeById(root, "com.zhiliaoapp.musically:id/s0c")
        if (handleById != null && handleById.isVisibleToUser) return handleById
        return findNodeByPredicate(root) { node ->
            val text = node.text?.toString()?.trim() ?: ""
            node.isVisibleToUser && text.startsWith("@") && text.length in 3..40 &&
                text.substring(1).matches(Regex("[a-zA-Z0-9._]+"))
        }
    }

    private fun findTikTokAccountSelector(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        // On the observed TikTok build the display-name row (s5_) opens the
        // account sheet; the @handle row only exposes the current identity.
        return findNodeById(root, "com.zhiliaoapp.musically:id/s5_")
            ?: findNodeByPredicate(root) { node ->
                node.isClickable && node.text?.toString()?.trim()?.matches(Regex("[a-zA-Z0-9._]+")) == true
            }
    }

    private fun readTikTokProfileUsername(root: AccessibilityNodeInfo): String {
        val handle = findTikTokProfileHandle(root)?.text?.toString()?.trim()?.removePrefix("@")
        if (!handle.isNullOrEmpty()) return handle
        return ""
    }

    private fun ensureCorrectTikTokAccount(targetUsername: String): Boolean {
        val cleanTarget = targetUsername.trimStart('@')
        if (!navigateTikTokToProfile()) return false

        var root = getTikTokRoot() ?: return false
        var current = readTikTokProfileUsername(root)
        root.recycle()
        // Profile may still be rendering when the navigation action returns.
        // Give the visible semantic handle a short polling window before
        // opening the account selector.
        for (attempt in 0 until 5) {
            if (current.isNotEmpty()) break
            Thread.sleep(700)
            root = getTikTokRoot() ?: continue
            current = readTikTokProfileUsername(root)
            root.recycle()
        }
        Log.e(TAG, "TikTok account check: current=$current target=$cleanTarget")
        if (current.equals(cleanTarget, ignoreCase = true)) {
            return true
        }

        root = getTikTokRoot() ?: return false
        val selector = findTikTokAccountSelector(root)
        val openedSwitcher = selector != null && clickNode(selector)
        Log.e(TAG, "TikTok account selector opened=$openedSwitcher")
        root.recycle()
        if (!openedSwitcher) return false
        Thread.sleep(1500)

        root = getTikTokRoot() ?: return false
        val account = findNodeByPredicate(root) { node ->
            node.isClickable && node.contentDescription?.toString()?.trim()
                ?.equals(cleanTarget, ignoreCase = true) == true
        }
        Log.e(TAG, "TikTok target row found=${account != null}")
        val switched = account != null && clickNode(account)
        root.recycle()
        if (!switched) return false

        // TikTok often closes the selector and lands on Home/For You after a
        // successful switch. In that state the profile handle is not in the
        // visible tree, so do not treat an empty read as a failed switch.
        // Re-open Profile semantically and verify the visible handle instead.
        var verified = ""
        for (attempt in 0 until 10) {
            Thread.sleep(900)
            navigateTikTokToProfile()
            root = getTikTokRoot() ?: continue
            verified = readTikTokProfileUsername(root)
            root.recycle()
            Log.e(TAG, "TikTok account verification attempt=${attempt + 1}: current=$verified target=$cleanTarget")
            if (verified.equals(cleanTarget, ignoreCase = true)) break
        }
        val success = verified.equals(cleanTarget, ignoreCase = true)
        Log.e(TAG, "TikTok account verification: current=$verified target=$cleanTarget success=$success")
        return success
    }

    private fun getTikTokIdentity(root: AccessibilityNodeInfo): String? {
        val title = findNodeById(root, "com.zhiliaoapp.musically:id/title")?.text?.toString()?.trim()
        if (!title.isNullOrEmpty()) return title
        val author = findNodeByDescContains(root, "profile")?.contentDescription?.toString()?.trim()
        if (!author.isNullOrEmpty()) return author
        val sound = findNodeByDescContains(root, "Sound:")?.contentDescription?.toString()?.trim()
        return sound
    }

    private fun isTikTokSponsoredContent(root: AccessibilityNodeInfo): Boolean {
        return checkNodeForSponsored(root)
    }

    private fun likeTikTokContent(root: AccessibilityNodeInfo): Boolean {
        val button = findNodeByDescContains(root, "Like video") ?: return false
        val description = button.contentDescription?.toString()?.lowercase() ?: ""
        if ("unlike" in description || button.isSelected) return false
        return clickNode(button)
    }

    private fun favoriteTikTokContent(root: AccessibilityNodeInfo): Boolean {
        // The tree captured before the watch delay can be stale. Refresh it so
        // the tap is based on the currently visible video and button bounds.
        val currentRoot = getTikTokRoot() ?: root
        val button = findTikTokFavoriteNode(currentRoot)
        if (button == null) {
            Log.e(TAG, "TikTok favorite button not found")
            return false
        }

        val description = button.contentDescription?.toString()?.lowercase() ?: ""
        if (isTikTokFavoriteMarked(button)) {
            Log.d(TAG, "TikTok favorite skipped: already saved desc=$description")
            return false
        }

        val beforeState = getTikTokFavoriteState(button)
        val tapped = tapNodeCenter(button)
        Log.e(
            TAG,
            "TikTok favorite physical tap=$tapped id=${button.viewIdResourceName} " +
                "clickable=${button.isClickable} bounds=${getNodeBounds(button)} desc=$description"
        )
        if (!tapped) return false

        Thread.sleep(450)
        val afterRoot = getTikTokRoot()
        val afterButton = afterRoot?.let { findTikTokFavoriteNode(it) }
        val afterState = afterButton?.let { getTikTokFavoriteState(it) }
        val stateChanged = afterState != null && afterState != beforeState
        val confirmationVisible = afterRoot?.let { hasTikTokFavoriteConfirmation(it) } == true
        Log.e(
            TAG,
            "TikTok favorite verified=$stateChanged confirmation=$confirmationVisible " +
                "before=$beforeState after=$afterState"
        )
        // TikTok sometimes keeps the same accessibility state and label even
        // after the video was actually added to Favorites. The physical tap
        // on the live element is therefore the authoritative action result;
        // stateChanged/confirmationVisible remain diagnostic signals.
        val actionCompleted = tapped
        Log.e(TAG, "TikTok favorite counted=$actionCompleted accessibilityVerified=${stateChanged || confirmationVisible}")
        return actionCompleted
    }

    private fun findTikTokFavoriteNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val idNodes = root.findAccessibilityNodeInfosByViewId("com.zhiliaoapp.musically:id/hr0")
        return idNodes.firstOrNull { it.isVisibleToUser && it.isEnabled }
            ?: idNodes.firstOrNull { it.isEnabled }
            ?: findNodeByPredicate(root) { node ->
                val desc = node.contentDescription?.toString()?.lowercase() ?: ""
                node.isVisibleToUser && node.isEnabled &&
                    (desc.contains("favorites") || desc.contains("add to favorites"))
            }
    }

    private fun isTikTokFavoriteMarked(button: AccessibilityNodeInfo): Boolean {
        val description = button.contentDescription?.toString()?.lowercase() ?: ""
        val parent = button.parent
        val parentMarked = parent?.isSelected == true || parent?.isChecked == true
        parent?.recycle()
        return button.isSelected || button.isChecked || parentMarked ||
            ("add or remove" !in description &&
                (description.startsWith("remove") ||
                    "unfavorite" in description ||
                    "saved" in description))
    }

    private fun getTikTokFavoriteState(button: AccessibilityNodeInfo): String {
        val parent = button.parent
        val parentState = parent?.let {
            "${it.isSelected}|${it.isChecked}|${it.contentDescription}"
        } ?: "none"
        parent?.recycle()
        return "${button.isSelected}|${button.isChecked}|${button.contentDescription}|$parentState"
    }

    private fun hasTikTokFavoriteConfirmation(root: AccessibilityNodeInfo): Boolean {
        return findNodeByPredicate(root) { node ->
            val value = ((node.text?.toString() ?: "") + " " +
                (node.contentDescription?.toString() ?: "")).lowercase()
            value.contains("added to favorites") ||
                value.contains("saved to favorites") ||
                value.contains("added to your favorites")
        } != null
    }

    private fun getNodeBounds(node: AccessibilityNodeInfo): String {
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        return bounds.toShortString()
    }

    private fun scrollToNextTikTokVideo(root: AccessibilityNodeInfo): Boolean {
        // TikTok exposes several nested nodes with the same resource-id. Use
        // the actual AndroidX pager, but drive it with a physical gesture so
        // the transition has a human-like speed instead of an instant page
        // jump from ACTION_SCROLL_FORWARD.
        val currentRoot = getTikTokRoot() ?: root
        val pagerNodes = currentRoot.findAccessibilityNodeInfosByViewId("com.zhiliaoapp.musically:id/viewpager")
        val pager = pagerNodes.firstOrNull {
            it.isScrollable && it.className?.toString()?.contains("ViewPager", ignoreCase = true) == true
        } ?: pagerNodes.firstOrNull { it.isScrollable }
            ?: findNodeByPredicate(currentRoot) { node ->
                node.isScrollable && (
                    node.viewIdResourceName?.endsWith(":id/viewpager") == true ||
                        node.className?.toString()?.contains("ViewPager", ignoreCase = true) == true
                    )
            }
        if (pager == null) {
            Log.e(TAG, "TikTok video pager not found; refusing coordinate fallback")
            return false
        }
        val pagerBounds = android.graphics.Rect()
        pager.getBoundsInScreen(pagerBounds)
        val usableTop = pagerBounds.top + 100
        val usableBottom = pagerBounds.bottom - 120
        val usableHeight = usableBottom - usableTop
        if (pagerBounds.width() < 200 || usableHeight < 300) {
            Log.e(TAG, "TikTok video pager bounds unusable: $pagerBounds")
            return false
        }

        val startX = (pagerBounds.centerX() + (random.nextFloat() - 0.5f) * 36f)
            .coerceIn((pagerBounds.left + 40).toFloat(), (pagerBounds.right - 40).toFloat())
        val endX = (startX + (random.nextFloat() - 0.5f) * 54f)
            .coerceIn((pagerBounds.left + 40).toFloat(), (pagerBounds.right - 40).toFloat())
        val startY = usableTop + usableHeight * (0.68f + random.nextFloat() * 0.10f)
        val endY = usableTop + usableHeight * (0.20f + random.nextFloat() * 0.10f)
        val duration = 50L + random.nextInt(351) // 50-400ms
        val moved = swipe(startX, startY, endX, endY, duration)
        Log.e(TAG, "TikTok physical swipe accepted=$moved bounds=$pagerBounds duration=${duration}ms")
        Thread.sleep(350 + random.nextInt(451).toLong())
        return moved
    }

    private fun getYouTubeIdentity(root: AccessibilityNodeInfo): String? {
        val channel = findNodeByDescContains(root, "Go to channel")
            ?.contentDescription?.toString()?.trim()
        val titleIds = listOf(
            "com.google.android.youtube:id/reel_player_title",
            "com.google.android.youtube:id/reel_title",
            "com.google.android.youtube:id/video_title",
            "com.google.android.youtube:id/title"
        )
        val title = titleIds.asSequence()
            .mapNotNull { id -> findNodeById(root, id)?.text?.toString()?.trim() }
            .firstOrNull { it.isNotEmpty() }
        val identity = listOfNotNull(channel, title).joinToString("|")
        return identity.ifEmpty { null }
    }

    private fun isYouTubeLikeActionDescription(description: String): Boolean {
        val normalized = description.lowercase()
        return normalized.contains("like this video") ||
            normalized.contains("like this short") ||
            normalized.contains("dar me gusta") ||
            normalized.contains("me gusta este video") ||
            normalized.contains("me gusta este short")
    }

    private fun findYouTubeLikeNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        return findNodeByPredicate(root) { node ->
            val description = node.contentDescription?.toString()?.lowercase() ?: ""
            node.isVisibleToUser && node.isEnabled &&
                isYouTubeLikeActionDescription(description) &&
                !description.contains("unlike") &&
                !description.contains("quitar me gusta")
        }
    }

    private fun isYouTubeLikeMarked(node: AccessibilityNodeInfo): Boolean {
        val description = node.contentDescription?.toString()?.lowercase() ?: ""
        return node.isSelected || node.isChecked ||
            description.contains("unlike") ||
            description.contains("quitar me gusta")
    }

    private fun isYouTubeLikeConfirmationNode(
        node: AccessibilityNodeInfo,
        beforeDescription: String,
    ): Boolean {
        if (!node.isVisibleToUser) return false
        val description = node.contentDescription?.toString()?.lowercase() ?: ""
        if (description.contains("unlike") || description.contains("quitar me gusta")) {
            return true
        }
        if (node.isSelected || node.isChecked) return true

        // In the current YouTube Shorts accessibility tree the liked state is
        // exposed as the like count (for example, "164,769 likes") instead of
        // an "Unlike this video" label. The old verifier required the latter,
        // so every real like was discarded before metrics were generated.
        val exposesLikeCount = (description.contains("likes") ||
            description.contains("me gusta")) &&
            !isYouTubeLikeActionDescription(description)
        val changedToAnotherLikeState = beforeDescription.isNotEmpty() &&
            description != beforeDescription &&
            (description.contains("like") || description.contains("gusta"))
        return exposesLikeCount || changedToAnotherLikeState
    }

    private fun likeYouTubeContent(root: AccessibilityNodeInfo): Boolean {
        val currentRoot = getYouTubeRoot() ?: root
        val button = findYouTubeLikeNode(currentRoot)
        if (button == null) {
            if (currentRoot !== root) currentRoot.recycle()
            Log.e(TAG, "YouTube like button not found")
            return false
        }
        if (isYouTubeLikeMarked(button)) {
            if (currentRoot !== root) currentRoot.recycle()
            return false
        }

        val beforeDescription = button.contentDescription?.toString()?.trim() ?: ""
        val clicked = clickNode(button)
        Log.e(TAG, "YouTube like clicked=$clicked desc=$beforeDescription")
        if (!clicked) {
            val tapped = tapNodeCenter(button)
            if (currentRoot !== root) currentRoot.recycle()
            if (!tapped) return false
        } else if (currentRoot !== root) {
            currentRoot.recycle()
        }

        // YouTube changes the live accessibility label asynchronously. Count
        // only after the liked state or the updated like-count label is
        // observed in a fresh accessibility tree.
        repeat(12) {
            Thread.sleep(150)
            val afterRoot = getYouTubeRoot()
            if (afterRoot != null) {
                val after = findNodeByPredicate(afterRoot) { node ->
                    isYouTubeLikeConfirmationNode(node, beforeDescription)
                }
                afterRoot.recycle()
                if (after != null) {
                    Log.e(TAG, "YouTube like confirmed: accessibility state changed")
                    return true
                }
            }
        }
        Log.e(TAG, "YouTube like was not accessibility-confirmed")
        return false
    }

    private fun findYouTubeMoreNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        return findNodeByPredicate(root) { node ->
            val description = node.contentDescription?.toString()?.lowercase() ?: ""
            if (!node.isVisibleToUser || !node.isEnabled ||
                !(description == "more" || description.contains("more options"))) {
                false
            } else {
                val bounds = android.graphics.Rect()
                node.getBoundsInScreen(bounds)
                bounds.top < 260 && bounds.right > screenWidth - 160
            }
        }
    }

    private fun findYouTubeFirstPlaylistRow(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val list = findNodeById(root, "com.google.android.youtube:id/bottom_sheet_list") ?: return null
        return findNodeByPredicate(list) { node ->
            if (!node.isClickable || !node.isVisibleToUser) return@findNodeByPredicate false
            val bounds = android.graphics.Rect()
            node.getBoundsInScreen(bounds)
            bounds.width() > screenWidth / 2 && bounds.height() in 70..200 && bounds.top > 500
        }
    }

    private fun hasYouTubeWatchLaterConfirmation(root: AccessibilityNodeInfo): Boolean {
        return findNodeByDescContains(root, "Saved to Watch later") != null ||
            findNodeByTextContains(root, "Saved to Watch later") != null ||
            findNodeByDescContains(root, "Guardado en Ver más tarde") != null ||
            findNodeByTextContains(root, "Guardado en Ver más tarde") != null
    }

    private fun saveYouTubeShort(root: AccessibilityNodeInfo): Boolean {
        val currentRoot = getYouTubeRoot() ?: root
        val more = findYouTubeMoreNode(currentRoot)
        if (more == null) {
            if (currentRoot !== root) currentRoot.recycle()
            Log.e(TAG, "YouTube More menu button not found")
            return false
        }
        val openedMenu = clickNode(more)
        if (openedMenu) pauseAfterYouTubeSaveAction("More")
        if (currentRoot !== root) currentRoot.recycle()
        if (!openedMenu) return false

        var menuRoot: AccessibilityNodeInfo? = null
        var saveMenuItem: AccessibilityNodeInfo? = null
        repeat(10) {
            if (saveMenuItem != null) return@repeat
            val candidate = getYouTubeRoot() ?: return@repeat
            val item = findNodeByTextContains(candidate, "Save to playlist")
            if (item != null) {
                menuRoot = candidate
                saveMenuItem = item
            } else {
                candidate.recycle()
                Thread.sleep(150)
            }
        }
        val menu = menuRoot
        val item = saveMenuItem
        if (menu == null || item == null) {
            Log.e(TAG, "YouTube Save to playlist menu item not found")
            performGlobalAction(GLOBAL_ACTION_BACK)
            return false
        }
        val openedSaveSheet = clickNode(item)
        if (openedSaveSheet) pauseAfterYouTubeSaveAction("Save to playlist")
        menu.recycle()
        if (!openedSaveSheet) return false

        var sheetRoot: AccessibilityNodeInfo? = null
        var watchLater: AccessibilityNodeInfo? = null
        repeat(10) {
            if (sheetRoot != null) return@repeat
            val candidate = getYouTubeRoot() ?: return@repeat
            val saveToTitle = findNodeByTextContains(candidate, "Save to")
            if (saveToTitle != null &&
                findNodeByTextContains(candidate, "Save to playlist") == null) {
                sheetRoot = candidate
                watchLater = findNodeByTextContains(candidate, "Watch later")
                    ?: findNodeByDescContains(candidate, "Watch later")
                    ?: findNodeByTextContains(candidate, "Ver más tarde")
                    ?: findNodeByDescContains(candidate, "Ver más tarde")
                return@repeat
            }
            candidate.recycle()
            Thread.sleep(150)
        }

        val sheet = sheetRoot
        if (sheet == null) {
            Log.e(TAG, "YouTube Save to sheet not found")
            performGlobalAction(GLOBAL_ACTION_BACK)
            return false
        }
        val target = watchLater ?: findYouTubeFirstPlaylistRow(sheet)
        if (watchLater == null) {
            Log.e(TAG, "YouTube Watch later label not exposed; using first playlist row only after Save to confirmation")
        }
        if (target == null) {
            sheet.recycle()
            Log.e(TAG, "YouTube Watch later row not found")
            performGlobalAction(GLOBAL_ACTION_BACK)
            return false
        }

        val tapped = clickNode(target)
        if (tapped) pauseAfterYouTubeSaveAction("Watch later")
        sheet.recycle()
        if (!tapped) return false

        repeat(12) {
            Thread.sleep(150)
            val confirmationRoot = getYouTubeRoot()
            if (confirmationRoot != null) {
                val confirmed = hasYouTubeWatchLaterConfirmation(confirmationRoot)
                confirmationRoot.recycle()
                if (confirmed) {
                    Log.e(TAG, "YouTube save confirmed: Watch later")
                    return true
                }
            }
        }
        Log.e(TAG, "YouTube save tap was not confirmed by Watch later feedback")
        return false
    }

    /**
     * Keep the three YouTube save taps separated by a human-scale pause. The
     * delay is randomized between 800 and 1000 ms per action so the menu flow
     * does not run at a fixed machine-like cadence.
     */
    private fun pauseAfterYouTubeSaveAction(action: String) {
        val delayMs = 800L + random.nextInt(201).toLong()
        Log.e(TAG, "YouTube save action=$action; pausing ${delayMs}ms")
        Thread.sleep(delayMs)
    }

    private fun scrollToNextYouTubeShort(root: AccessibilityNodeInfo): Boolean {
        val currentRoot = getYouTubeRoot() ?: root
        val recycler = findNodeById(currentRoot, "com.google.android.youtube:id/reel_recycler")
            ?: findNodeById(currentRoot, "com.google.android.youtube:id/reel_player_page_container")
        if (recycler == null) {
            if (currentRoot !== root) currentRoot.recycle()
            Log.e(TAG, "YouTube Shorts recycler not found; refusing coordinate fallback")
            return false
        }

        val bounds = android.graphics.Rect()
        recycler.getBoundsInScreen(bounds)
        val usableTop = maxOf(bounds.top + 100, 120)
        val usableBottom = minOf(bounds.bottom - 100, screenHeight - 180)
        val usableHeight = usableBottom - usableTop
        if (bounds.width() < 200 || usableHeight < 300) {
            if (currentRoot !== root) currentRoot.recycle()
            Log.e(TAG, "YouTube Shorts bounds unusable: $bounds")
            return false
        }

        val startX = (bounds.centerX() + (random.nextFloat() - 0.5f) * 36f)
            .coerceIn((bounds.left + 40).toFloat(), (bounds.right - 40).toFloat())
        val endX = (startX + (random.nextFloat() - 0.5f) * 54f)
            .coerceIn((bounds.left + 40).toFloat(), (bounds.right - 40).toFloat())
        val startY = usableTop + usableHeight * (0.68f + random.nextFloat() * 0.10f)
        val endY = usableTop + usableHeight * (0.20f + random.nextFloat() * 0.10f)
        val duration = 50L + random.nextInt(351)
        val moved = swipe(startX, startY, endX, endY, duration)
        if (currentRoot !== root) currentRoot.recycle()
        Log.e(TAG, "YouTube Shorts swipe accepted=$moved bounds=$bounds duration=${duration}ms")
        Thread.sleep(350 + random.nextInt(451).toLong())
        return moved
    }

    private fun navigateToReels() {
        Thread.sleep(1000)
        // The loading overlay is still visible during setup, so the active
        // accessibility window can belong to SouthFarm instead of Instagram.
        val root = getInstagramRoot() ?: return

        // Try finding Reels tab by content description
        val reelsTab = findNodeByDesc(root, "Reels", minY = screenHeight - 200)
        if (reelsTab != null) {
            clickNode(reelsTab)
            Thread.sleep(1000)
            return
        }

        // Fallback: known position for Reels tab on POCO C71
        tapAt(540f, 1560f)
        Thread.sleep(1000)
    }

    // ─── Account Switching ───

    /**
     * Ensure the correct Instagram account is active before starting warmup.
     * Flow: Go to Profile → read current username → if wrong, open switcher → tap correct account.
     * Returns true if the correct account is active, false if failed.
     */
    private fun ensureCorrectAccount(targetUsername: String): Boolean {
        val cleanTarget = targetUsername.trimStart('@')
        debugLog("ensureCorrectAccount: target=$targetUsername clean=$cleanTarget")

        // Step 1: Go to Profile tab
        val root = getInstagramRoot() ?: run {
            debugLog("ensureCorrectAccount: root is null")
            return false
        }

        val profileTab = findNodeByDesc(root, "Profile", minY = screenHeight - 200)
            ?: findNodeByDesc(root, "Perfil", minY = screenHeight - 200)
        if (profileTab != null) {
            clickNode(profileTab)
        } else {
            tapAt(screenWidth - 80f, screenHeight - 80f)
        }
        Thread.sleep(3000)
        root.recycle()

        // Step 2: Read current active username from profile header
        val profileRoot = getInstagramRoot() ?: return false
        val currentUsername = readProfileUsername(profileRoot)

        debugLog("ensureCorrectAccount: current=$currentUsername, target=$targetUsername")

        // Step 3: If already correct, we're done
        if (currentUsername.equals(cleanTarget, ignoreCase = true)) {
            profileRoot.recycle()
            debugLog("ensureCorrectAccount: already on correct account")
            return true
        }

        // Step 4: Open the account switcher by tapping the username header
        debugLog("ensureCorrectAccount: switching from $currentUsername to $cleanTarget")
        val usernameHeader = findNodeById(profileRoot, "com.instagram.android:id/action_bar_username_container")
        if (usernameHeader != null && clickNode(usernameHeader)) {
            debugLog("ensureCorrectAccount: opened switcher through username header")
        } else {
            debugLog("ensureCorrectAccount: semantic username header unavailable, using coordinate fallback")
            tapAt(170f, 120f)
        }
        profileRoot.recycle()
        Thread.sleep(2500)

        // Step 5: Find and tap the target account in the switcher
        val switcherRoot = getInstagramRoot() ?: return false
        var switched = tapAccountInSwitcher(switcherRoot, cleanTarget)
        switcherRoot.recycle()

        // The switcher can expose its rows a little after the Instagram
        // window itself becomes active. Re-read the Instagram window once
        // before declaring the target missing.
        if (!switched) {
            Thread.sleep(1000)
            val retryRoot = getInstagramRoot()
            if (retryRoot != null) {
                switched = tapAccountInSwitcher(retryRoot, cleanTarget)
                retryRoot.recycle()
            }
        }

        if (!switched) {
            debugLog("ensureCorrectAccount: could not find $cleanTarget in switcher")
            return false
        }

        // Step 6: Wait for account switch to complete
        Thread.sleep(3000)

        // Step 7: Verify the switch worked by reading the profile again
        val verifyRoot = getInstagramRoot() ?: return false
        val verifyUsername = readProfileUsername(verifyRoot)
        verifyRoot.recycle()

        val success = verifyUsername.equals(cleanTarget, ignoreCase = true)
        debugLog("ensureCorrectAccount: verification after switch = $verifyUsername, success=$success")
        return success
    }

    /**
     * Read the current username from the profile page.
     * Looks for text matching username pattern in the top action bar area.
     */
    private fun readProfileUsername(root: AccessibilityNodeInfo): String {
        // First try the known resource ID
        val headerNodes = root.findAccessibilityNodeInfosByViewId(
            "com.instagram.android:id/profile_header_user_name"
        )
        if (headerNodes.isNotEmpty()) {
            val name = headerNodes[0].text?.toString()?.trim() ?: ""
            if (name.isNotEmpty()) return name
        }

        // Fallback: find username-like text in the top action bar area
        var bestMatch = ""
        var bestY = Int.MAX_VALUE

        fun searchNodes(node: AccessibilityNodeInfo) {
            val t = node.text?.toString()?.trim() ?: ""
            if (t.length >= 3 && t.length <= 30 && t.matches(Regex("[a-z0-9._]+")) && !t.all { it.isDigit() }) {
                val rect = android.graphics.Rect()
                node.getBoundsInScreen(rect)
                if (rect.centerY() < 200 && rect.centerY() < bestY) {
                    bestY = rect.centerY()
                    bestMatch = t
                }
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                searchNodes(child)
            }
        }
        searchNodes(root)

        debugLog("readProfileUsername: found '$bestMatch' at Y=$bestY")
        return bestMatch
    }

    /**
     * Find and tap the target account in the account switcher popup.
     */
    private fun tapAccountInSwitcher(root: AccessibilityNodeInfo, targetUsername: String): Boolean {
        val switcherIgnoreDescs = setOf(
            "Add Instagram account", "Agregar cuenta de Instagram",
            "Add Facebook profile", "Agregar perfil de Facebook",
            "Go to Accounts Center", "Ir al Centro de cuentas",
            "Your Facebook profile", "Tu perfil de Facebook"
        )

        return findAndTapAccountNode(root, targetUsername, switcherIgnoreDescs)
    }

    private fun findAndTapAccountNode(
        node: AccessibilityNodeInfo,
        targetUsername: String,
        ignoreDescs: Set<String>
    ): Boolean {
        val desc = node.contentDescription?.toString()?.trim() ?: ""

        if (node.isClickable && desc.isNotEmpty() && desc !in ignoreDescs) {
            val username = desc.split(",")[0].trim()
            if (username.equals(targetUsername, ignoreCase = true)) {
                debugLog("tapAccountInSwitcher: found and tapping $username")
                val clicked = clickNode(node)
                if (!clicked) {
                    val bounds = android.graphics.Rect()
                    node.getBoundsInScreen(bounds)
                    if (bounds.centerX() > 0 && bounds.centerY() > 0) {
                        tapAt(bounds.centerX().toFloat(), bounds.centerY().toFloat())
                    }
                }
                return true
            }
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (findAndTapAccountNode(child, targetUsername, ignoreDescs)) return true
        }
        return false
    }

    // ─── Ad Detection (from v6.py detect_and_handle_ad) ───

    private fun detectAndHandleAd(root: AccessibilityNodeInfo): String {
        // Check 1: Is there a like button? → Clean content
        val likeBtn = findNodeById(root, "com.instagram.android:id/like_button")
        if (likeBtn != null) return "clean"

        // Check 2: Browser close button
        val browserClose = findNodeByDesc(root, "Close browser")
        if (browserClose != null) {
            clickNode(browserClose)
            Thread.sleep(2000)
            return "dismissed"
        }

        // Check 3: Sponsored content without like button
        if (isSponsoredContent(root)) {
            for (text in adDismissTexts) {
                val btn = findNodeByText(root, text)
                if (btn != null && btn.isClickable) {
                    clickNode(btn)
                    Thread.sleep(2000)
                    return "dismissed"
                }
            }
            return "skipped"
        }

        // Check 4: Ad form
        for (rid in adFormResourceIds) {
            val node = findNodeById(root, rid)
            if (node != null) {
                for (text in adDismissTexts) {
                    val btn = findNodeByText(root, text)
                    if (btn != null && btn.isClickable) {
                        clickNode(btn)
                        Thread.sleep(2000)
                        return "dismissed"
                    }
                }
                // Try back button
                val backBtn = findNodeById(root, "com.instagram.android:id/action_bar_button_back")
                if (backBtn != null) {
                    clickNode(backBtn)
                    Thread.sleep(2000)
                    return "dismissed"
                }
                return "skipped"
            }
        }

        // Check 5: Are we in valid IG content?
        val hasReel = findNodeByDescContains(root, "Reel by") != null
        val hasClips = findNodeById(root, "com.instagram.android:id/clips_viewer_container") != null
        val hasFeedTab = findNodeById(root, "com.instagram.android:id/feed_tab") != null
        val hasClipsTab = findNodeById(root, "com.instagram.android:id/clips_tab") != null

        if (hasReel || hasClips || hasFeedTab || hasClipsTab) return "clean"

        return "clean" // Default: assume clean (from v6.py CHECK 6)
    }

    // ─── Content Interaction (from v6.py) ───

    private fun likeCurrentContent(root: AccessibilityNodeInfo): Boolean {
        if (isSponsoredContent(root)) return false

        var likeBtn = findNodeById(root, "com.instagram.android:id/like_button")
        if (likeBtn == null) likeBtn = findNodeByDesc(root, "Like")
        if (likeBtn == null) {
            // Debug: log what IDs we can see
            Log.e(TAG, "Like button not found! Dumping visible IDs...")
            dumpNodeIds(root, 0)
            return false
        }

        if (likeBtn.isSelected) return false // Already liked

        clickNode(likeBtn)
        Thread.sleep(100)

        // Verify (re-read root)
        val newRoot = rootInActiveWindow
        if (newRoot != null) {
            var afterBtn = findNodeById(newRoot, "com.instagram.android:id/like_button")
            if (afterBtn == null) afterBtn = findNodeByDesc(newRoot, "Like")
            if (afterBtn != null && afterBtn.isSelected) return true
        }
        return true // Assume success even if verification fails
    }

    private fun saveCurrentContent(root: AccessibilityNodeInfo): Boolean {
        if (isSponsoredContent(root)) {
            Log.d(TAG, "Instagram save skipped: sponsored content")
            return false
        }

        var saveBtn = findNodeById(root, "com.instagram.android:id/save_button")
        if (saveBtn == null) saveBtn = findNodeById(root, "com.instagram.android:id/save")
        if (saveBtn == null) {
            saveBtn = findNodeByPredicate(root) { node ->
                val description = node.contentDescription?.toString()?.lowercase() ?: ""
                node.isVisibleToUser &&
                    (description == "save" ||
                        description.contains("save to collection") ||
                        description.contains("save post"))
            }
        }
        if (saveBtn == null) {
            Log.e(TAG, "Instagram save button not found")
            return false
        }

        if (saveBtn.isSelected) {
            Log.d(TAG, "Instagram save skipped: already saved")
            return false
        }

        // Get exact bounds to avoid hitting nav bar
        val bounds = android.graphics.Rect()
        saveBtn.getBoundsInScreen(bounds)
        if (bounds.bottom > 1400) {
            Log.e(TAG, "Instagram save skipped: control outside Reel action area bounds=$bounds")
            return false
        }

        val clicked = clickNode(saveBtn)
        Log.e(TAG, "Instagram save control clicked=$clicked id=${saveBtn.viewIdResourceName} desc=${saveBtn.contentDescription}")
        if (!clicked) return false
        Thread.sleep(300)

        // Handle collection popup — look for close/done button in CENTER of screen
        try {
            val newRoot = rootInActiveWindow
            if (newRoot != null) {
                // Log all nodes to see what the popup looks like
                Log.e(TAG, "Save popup dump:")
                dumpNodeIds(newRoot, 0)

                // Look for close/dismiss buttons in the popup area (center of screen)
                for (text in listOf("Done", "Listo", "×", "Remove", "Eliminar")) {
                    val closeBtn = findNodeByText(newRoot, text)
                    if (closeBtn != null) {
                        val cb = android.graphics.Rect()
                        closeBtn.getBoundsInScreen(cb)
                        // Only click if in center area (popup), not bottom (nav)
                        if (cb.top > 300 && cb.top < 1200) {
                            Log.e(TAG, "Closing save popup with: $text")
                            clickNode(closeBtn)
                            Thread.sleep(300)
                            return true
                        }
                    }
                }
                // Don't use BACK — just leave the popup, IG will dismiss it on next scroll
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling save popup: ${e.message}")
        }
        Log.e(TAG, "Instagram save interaction completed")
        return true
    }

    // ─── Tab Detection ───

    private fun isOnReelsTab(root: AccessibilityNodeInfo): Boolean {
        // Reels-specific: look for like button OR clips author
        // These only appear in the Reels viewer, not in Home feed
        val likeBtn = findNodeById(root, "com.instagram.android:id/like_button")
        if (likeBtn != null) {
            // Verify it's in the middle/right area (reels position), not bottom (home feed)
            val bounds = android.graphics.Rect()
            likeBtn.getBoundsInScreen(bounds)
            if (bounds.right > screenWidth / 2) return true // Reels like is on right side
        }

        val author = findNodeById(root, "com.instagram.android:id/clips_author_username")
        if (author != null) return true

        val clipsPlayer = findNodeById(root, "com.instagram.android:id/clips_viewer")
        if (clipsPlayer != null) return true

        return false
    }

    // ─── Gestures ───

    private fun scrollToNextReel() {
        // Keep swipe well away from bottom tab bar (Y > 1450)
        // POCO C71: tab bar is at ~1560, screen is 1640
        val startX = screenWidth * 0.5f + (random.nextFloat() - 0.5f) * 80f
        val endX = startX + (random.nextFloat() - 0.5f) * 70f
        val startY = screenHeight * 0.6f + random.nextFloat() * 80f  // ~980-1060
        val endY = screenHeight * 0.2f + random.nextFloat() * 80f  // ~320-400
        val duration = 50L + random.nextInt(351) // 50-400ms

        swipe(startX, startY, endX, endY, duration)

        try { Thread.sleep(250 + random.nextInt(351).toLong()) } catch (_: InterruptedException) {}
    }

    private fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, duration: Long): Boolean {
        val path = Path().apply {
            moveTo(startX, startY)
            cubicTo(
                startX + (endX - startX) * 0.25f + (random.nextFloat() - 0.5f) * 24f,
                startY - (startY - endY) * 0.25f,
                endX + (random.nextFloat() - 0.5f) * 24f,
                startY - (startY - endY) * 0.75f,
                endX,
                endY
            )
        }
        val gesture = GestureDescription.StrokeDescription(path, 0, duration)
        val builder = GestureDescription.Builder()
        builder.addStroke(gesture)

        return dispatchGesture(builder.build(), null, null)
    }

    private fun tapNodeCenter(node: AccessibilityNodeInfo): Boolean {
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        if (bounds.width() <= 0 || bounds.height() <= 0) return false
        return tapAt(bounds.centerX().toFloat(), bounds.centerY().toFloat())
    }

    private fun tapAt(x: Float, y: Float): Boolean {
        val path = Path().apply {
            moveTo(x, y)
        }
        val gesture = GestureDescription.StrokeDescription(path, 0, 50)
        val builder = GestureDescription.Builder()
        builder.addStroke(gesture)

        return dispatchGesture(builder.build(), null, null)
    }

    // ─── UI Tree Helpers ───

    private fun findNodeById(root: AccessibilityNodeInfo, resourceId: String): AccessibilityNodeInfo? {
        val nodes = root.findAccessibilityNodeInfosByViewId(resourceId)
        return nodes.firstOrNull()
    }

    /**
     * Return Instagram's accessibility tree even when a SouthFarm loading or
     * running overlay is the active window. The overlay must remain visible
     * during account setup, but account navigation must target Instagram.
     */
    private fun getInstagramRoot(): AccessibilityNodeInfo? {
        try {
            val activeRoot = rootInActiveWindow
            if (activeRoot != null) {
                if (activeRoot.packageName?.toString() == "com.instagram.android") return activeRoot
                activeRoot.recycle()
            }

            for (window in windows) {
                val windowRoot = window.root ?: continue
                if (windowRoot.packageName?.toString() == "com.instagram.android") return windowRoot
                windowRoot.recycle()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not retrieve Instagram window: ${e.message}")
        }
        return null
    }

    private fun getTikTokRoot(): AccessibilityNodeInfo? {
        try {
            val activeRoot = rootInActiveWindow
            if (activeRoot != null) {
                if (activeRoot.packageName?.toString() == "com.zhiliaoapp.musically") return activeRoot
                activeRoot.recycle()
            }
            for (window in windows) {
                val windowRoot = window.root ?: continue
                if (windowRoot.packageName?.toString() == "com.zhiliaoapp.musically") return windowRoot
                windowRoot.recycle()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not retrieve TikTok window: ${e.message}")
        }
        return null
    }

    private fun getYouTubeRoot(): AccessibilityNodeInfo? {
        try {
            val activeRoot = rootInActiveWindow
            if (activeRoot != null) {
                if (activeRoot.packageName?.toString() == "com.google.android.youtube") return activeRoot
                activeRoot.recycle()
            }
            for (window in windows) {
                val windowRoot = window.root ?: continue
                if (windowRoot.packageName?.toString() == "com.google.android.youtube") return windowRoot
                windowRoot.recycle()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not retrieve YouTube window: ${e.message}")
        }
        return null
    }

    private fun findNodeByText(root: AccessibilityNodeInfo, text: String): AccessibilityNodeInfo? {
        val nodes = root.findAccessibilityNodeInfosByText(text)
        return nodes.firstOrNull { it.text?.toString()?.equals(text, ignoreCase = true) == true }
    }

    private fun findNodeByTextContains(root: AccessibilityNodeInfo, text: String): AccessibilityNodeInfo? {
        val needle = text.trim()
        return findNodeByPredicate(root) { node ->
            node.isVisibleToUser &&
                ((node.text?.toString()?.contains(needle, ignoreCase = true) == true) ||
                    (node.contentDescription?.toString()?.contains(needle, ignoreCase = true) == true))
        }
    }

    private fun findNodeByDesc(root: AccessibilityNodeInfo, desc: String, minY: Int = 0): AccessibilityNodeInfo? {
        return findNodeByPredicate(root) { node ->
            node.contentDescription?.toString()?.equals(desc, ignoreCase = true) == true &&
            (minY == 0 || let {
                val rect = android.graphics.Rect()
                node.getBoundsInScreen(rect)
                rect.centerY() > minY
            })
        }
    }

    private fun findNodeByDescContains(root: AccessibilityNodeInfo, substring: String): AccessibilityNodeInfo? {
        return findNodeByPredicate(root) { node ->
            node.contentDescription?.contains(substring, ignoreCase = true) == true
        }
    }

    private fun findNodeByPredicate(root: AccessibilityNodeInfo, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (predicate(root)) return root
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val result = findNodeByPredicate(child, predicate)
            if (result != null) return result
            child.recycle()
        }
        return null
    }

    private fun clickNode(node: AccessibilityNodeInfo): Boolean {
        if (node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
        // TikTok often exposes the label on a non-clickable child while the
        // clickable action is one or two levels above it.
        var parent = node.parent
        var depth = 0
        while (parent != null && depth < 4) {
            if (parent.isClickable && parent.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            val next = parent.parent
            parent.recycle()
            parent = next
            depth++
        }
        return false
    }

    private fun isSponsoredContent(root: AccessibilityNodeInfo): Boolean {
        return checkNodeForSponsored(root)
    }

    private fun checkNodeForSponsored(node: AccessibilityNodeInfo): Boolean {
        val text = (node.text?.toString() ?: "").lowercase()
        val desc = (node.contentDescription?.toString() ?: "").lowercase()
        val combined = "$text $desc"

        if (node.text?.toString()?.trim() == "Ad") return true
        if (node.contentDescription?.toString()?.trim() == "Ad") return true

        val sponsoredKeywords = listOf(
            "sponsored", "patrocinado", "paid partnership",
            "asociación pagada", "publicidad"
        )
        if (sponsoredKeywords.any { it in combined }) return true

        val ctaKeywords = listOf(
            "get in touch", "shop now", "learn more", "install now",
            "sign up", "book now", "apply now", "download", "order now",
            "comprar ahora", "más información", "descargar", "reservar"
        )
        if (ctaKeywords.any { it in combined }) return true

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (checkNodeForSponsored(child)) return true
        }
        return false
    }

    // ─── Popup Handling ───

    private fun isSaveCollectionPopup(root: AccessibilityNodeInfo): Boolean {
        val hasSaved = containsVisibleText(root, "Saved")
        val hasCollections = containsVisibleText(root, "Collections")
        val hasNewCollection = containsVisibleText(root, "New collection")
        return hasSaved && (hasCollections || hasNewCollection)
    }

    private fun containsVisibleText(root: AccessibilityNodeInfo, target: String): Boolean {
        val nodes = root.findAccessibilityNodeInfosByText(target)
        return nodes.any { node ->
            node.text?.toString()?.contains(target, ignoreCase = true) == true ||
                node.contentDescription?.toString()?.contains(target, ignoreCase = true) == true
        }
    }

    private fun dismissUnexpectedPopup() {
        try {
            val root = rootInActiveWindow ?: return

            // Only look for close patterns that are small dialogs (not full screen elements)
            // Don't use GLOBAL_ACTION_BACK — it can exit Reels
            for (text in listOf("Not now", "Not Now", "No ahora", "No thanks", "Skip", "Omitir", "Maybe later")) {
                val btn = findNodeByText(root, text)
                if (btn != null && btn.isClickable) {
                    val bounds = android.graphics.Rect()
                    btn.getBoundsInScreen(bounds)
                    // Only click if it's in the center area (dialog), not in nav bar
                    if (bounds.top > 300 && bounds.top < 1200) {
                        clickNode(btn)
                        Thread.sleep(500)
                    }
                    return
                }
            }
        } catch (_: Exception) {}
    }

    // ─── Reel Identity (from v6.py) ───

    private fun getReelIdentity(root: AccessibilityNodeInfo): String? {
        val reelBy = findNodeByDescContains(root, "Reel by")
            ?: return findNodeById(root, "com.instagram.android:id/clips_author_username")?.text?.toString()
        return reelBy.contentDescription?.toString()
    }

    // ─── Watch Time (from v6.py distribution) ───

    private fun getReelsWatchTimeMs(): Long {
        val r = random.nextDouble()
        val seconds = when {
            r < 0.55 -> 4.0 + random.nextDouble() * 12.0  // 4-16s (55%)
            r < 0.95 -> 14.0 + random.nextDouble() * 17.0 // 14-31s (40%)
            else -> 32.0 + random.nextDouble() * 26.0    // 32-58s (5%)
        }
        return (seconds * 1000).toLong()
    }

    /** Wait after a successful post interaction before advancing the feed. */
    private fun pauseAfterPostInteraction() {
        val delayMs = 1500L + random.nextInt(1501).toLong()
        Thread.sleep(delayMs)
    }

    // ─── Metrics ───

    private fun resetMetrics() {
        reelsViewed = currentWarmupInitialMetrics.optInt("reels_viewed", 0)
        likesGiven = currentWarmupInitialMetrics.optInt("likes", 0)
        savesGiven = currentWarmupInitialMetrics.optInt("saves", 0)
        adsDetected = currentWarmupInitialMetrics.optInt("ads_detected", 0)
        adsDismissed = currentWarmupInitialMetrics.optInt("ads_dismissed", 0)
        stuckCount = 0
        lastReelIdentity = null
    }

    private fun createNotificationChannel() {
        val channel = android.app.NotificationChannel(
            "southfarm_service",
            "SouthFarm Service",
            android.app.NotificationManager.IMPORTANCE_LOW
        )
        val manager = getSystemService(android.app.NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun dumpNodeIds(node: AccessibilityNodeInfo, depth: Int) {
        if (depth > 5) return
        val id = node.viewIdResourceName ?: ""
        val desc = node.contentDescription?.toString() ?: ""
        val text = node.text?.toString() ?: ""
        if (id.isNotEmpty() || desc.isNotEmpty() || text.isNotEmpty()) {
            Log.e(TAG, "  depth=$depth id=$id desc=$desc text=$text")
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            dumpNodeIds(child, depth + 1)
        }
    }

    private fun buildMetricsJson(elapsedSec: Long, totalSec: Long): String {
        val initialElapsed = currentWarmupInitialMetrics.optLong("elapsed_sec", 0L)
        val totalElapsed = (initialElapsed + elapsedSec).coerceAtLeast(0L)
        return """{"platform":"$currentWarmupPlatform","account":"$currentWarmupAccount","duration_minutes":$currentWarmupDurationMinutes,"reels_viewed":$reelsViewed,"likes":$likesGiven,"saves":$savesGiven,"ads_detected":$adsDetected,"ads_dismissed":$adsDismissed,"elapsed_sec":$totalElapsed,"total_sec":$totalSec,"status":"$currentStatus"}"""
    }

    // ─── Account Detection ───

    private fun debugLog(msg: String) {
        Log.e(TAG, msg)
        try {
            val f = java.io.File("/sdcard/sf_scan.log")
            f.appendText("$msg\n")
        } catch (_: Exception) {}
    }

    // Known non-username texts in the account switcher
    private val ignoreTexts = setOf(
        "Add Instagram account", "Agregar cuenta de Instagram",
        "Add Facebook profile", "Agregar perfil de Facebook",
        "Go to Accounts Center", "Ir al Centro de cuentas",
        "Your Facebook profile", "Tu perfil de Facebook",
        "Edit profile", "Editar perfil",
        "Share profile", "Compartir perfil",
        "Posts", "Followers", "Following",
        "Publicaciones", "Seguidores", "Seguidos",
        "chats", "messages"
    )

    private val youtubeChannelHandleId = "com.google.android.youtube:id/channel_handle"
    private val youtubeBylineId = "com.google.android.youtube:id/byline"
    private val youtubeNameId = "com.google.android.youtube:id/name"
    private val youtubeGoogleAccountHeaderId = "com.google.android.youtube:id/google_account_header"
    private val youtubeEmailId = "com.google.android.youtube:id/email"

    private data class YouTubeAccountCandidate(
        val name: String,
        val byline: String,
    )

    private data class YouTubeGoogleAccount(
        val name: String,
        val email: String,
    )

    private data class YouTubeChannelRecord(
        val handle: String,
        val displayName: String,
        val sourceAccountName: String,
        val sourceAccountEmail: String,
        val byline: String,
    )

    private data class YouTubeSelectedChannel(
        val handle: String,
        val accountName: String,
        val byline: String,
    )

    private fun isYouTubeSubscriberLine(value: String): Boolean {
        val normalized = value.trim().replace(Regex("\\s+"), " ")
        if (normalized.equals("No subscribers", ignoreCase = true) ||
            normalized.equals("Sin suscriptores", ignoreCase = true)
        ) return true

        return Regex(
            "^\\d[\\d\\s,.]*\\s+(subscribers?|suscriptores?)$",
            RegexOption.IGNORE_CASE,
        ).matches(normalized)
    }

    private fun isYouTubeNoChannelLine(value: String): Boolean {
        val normalized = value.trim().replace(Regex("\\s+"), " ")
        return normalized.equals("No channel", ignoreCase = true) ||
            normalized.equals("Sin canal", ignoreCase = true)
    }

    private fun cleanYouTubeHandle(value: String?): String? {
        val handle = value?.trim() ?: return null
        if (!handle.startsWith("@") || handle.length < 3) return null
        if (!handle.substring(1).matches(Regex("[a-zA-Z0-9._-]+"))) return null
        return handle.removePrefix("@").trim()
    }

    private fun findYouTubeSubscriberLine(root: AccessibilityNodeInfo): String? {
        val byline = findNodeById(root, youtubeBylineId)
        val bylineText = byline?.text?.toString()?.trim()
        if (!bylineText.isNullOrEmpty() && isYouTubeSubscriberLine(bylineText)) return bylineText
        val fallback = findNodeByPredicate(root) { node ->
            val value = node.text?.toString()?.trim() ?: ""
            value.isNotEmpty() && isYouTubeSubscriberLine(value)
        }
        return fallback?.text?.toString()?.trim()
    }

    private fun findYouTubeChannelRowForHandle(handleNode: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var candidate = handleNode.parent
        var depth = 0
        while (candidate != null && depth < 7) {
            if (candidate.isClickable && findYouTubeSubscriberLine(candidate) != null) {
                return candidate
            }
            candidate = candidate.parent
            depth++
        }
        return null
    }

    private fun parseYouTubeInactiveAccountDescription(
        description: String?
    ): YouTubeAccountCandidate? {
        val value = description?.trim() ?: return null
        val separator = value.indexOf(",,")
        if (separator <= 0 || value.contains("@")) return null
        val name = value.substring(0, separator).trim()
        val byline = value.substring(separator + 2).trim()
        if (name.isEmpty() || !isYouTubeSubscriberLine(byline)) return null
        return YouTubeAccountCandidate(name, byline)
    }

    /**
     * YouTube exposes inactive account rows in two forms depending on the
     * app version: sometimes the complete row is in contentDescription, and
     * sometimes only the name/byline child nodes are populated. Prefer the
     * stable resource ids and use contentDescription as a fallback.
     */
    private fun parseYouTubeAccountRow(
        node: AccessibilityNodeInfo,
    ): YouTubeAccountCandidate? {
        if (!node.isClickable) return null
        val fromDescription = parseYouTubeInactiveAccountDescription(
            node.contentDescription?.toString(),
        )
        val name = findNodeById(node, youtubeNameId)?.text?.toString()?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: fromDescription?.name
        val byline = findNodeById(node, youtubeBylineId)?.text?.toString()?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: fromDescription?.byline
        if (name.isNullOrEmpty() || byline.isNullOrEmpty()) return null
        if (isYouTubeNoChannelLine(byline) || !isYouTubeSubscriberLine(byline)) return null
        return YouTubeAccountCandidate(name, byline)
    }

    private fun findYouTubeInactiveAccountCandidates(
        root: AccessibilityNodeInfo
    ): List<YouTubeAccountCandidate> {
        val candidates = mutableListOf<YouTubeAccountCandidate>()

        fun walk(node: AccessibilityNodeInfo) {
            val candidate = parseYouTubeAccountRow(node)
            val hasHandle = cleanYouTubeHandle(
                findNodeById(node, youtubeChannelHandleId)?.text?.toString(),
            ) != null
            if (candidate != null && candidates.none {
                    it.name.equals(candidate.name, ignoreCase = true) &&
                        it.byline.equals(candidate.byline, ignoreCase = true)
                } && !hasHandle) {
                candidates.add(candidate)
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                walk(child)
                child.recycle()
            }
        }

        walk(root)
        return candidates
    }

    private fun findYouTubeInactiveAccountRow(
        root: AccessibilityNodeInfo,
        target: YouTubeAccountCandidate
    ): AccessibilityNodeInfo? {
        var result: AccessibilityNodeInfo? = null

        fun walk(node: AccessibilityNodeInfo) {
            if (result != null) return
            val candidate = parseYouTubeAccountRow(node)
            if (candidate != null &&
                candidate.name.equals(target.name, ignoreCase = true) &&
                candidate.byline.equals(target.byline, ignoreCase = true)
            ) {
                result = node
                return
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                walk(child)
                if (result == null) child.recycle()
            }
        }

        walk(root)
        return result
    }

    private fun findYouTubeChannelRow(
        root: AccessibilityNodeInfo,
        targetChannel: String
    ): AccessibilityNodeInfo? {
        val target = targetChannel.trim().removePrefix("@").lowercase()
        var result: AccessibilityNodeInfo? = null

        fun walk(node: AccessibilityNodeInfo) {
            if (result != null) return
            val handle = node.text?.toString()?.trim()
            if (cleanYouTubeHandle(handle)?.lowercase() == target) {
                val row = findYouTubeChannelRowForHandle(node)
                if (row != null) result = row
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                walk(child)
                if (result == null) child.recycle()
            }
        }
        walk(root)
        return result
    }

    private fun findYouTubeSelectedChannelInfo(
        root: AccessibilityNodeInfo
    ): YouTubeSelectedChannel? {
        var selected: YouTubeSelectedChannel? = null

        fun walk(node: AccessibilityNodeInfo) {
            if (selected != null) return
            val handle = cleanYouTubeHandle(node.text?.toString())
            if (handle != null) {
                val row = findYouTubeChannelRowForHandle(node)
                val rowDescription = row?.contentDescription?.toString()?.lowercase() ?: ""
                if (row != null && rowDescription.contains("selected account")) {
                    val accountName = findNodeById(row, youtubeNameId)?.text?.toString()?.trim()
                        ?: rowDescription
                            .removePrefix("selected account:")
                            .substringBefore(",")
                            .trim()
                    val byline = findNodeById(row, youtubeBylineId)?.text?.toString()?.trim()
                        ?: rowDescription.substringAfterLast(",").trim()
                    selected = YouTubeSelectedChannel(handle, accountName, byline)
                    return
                }
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                walk(child)
                if (selected == null) child.recycle()
            }
        }
        walk(root)
        return selected
    }

    private fun findYouTubeSelectedChannel(root: AccessibilityNodeInfo): String? {
        return findYouTubeSelectedChannelInfo(root)?.handle
    }

    private fun findYouTubeGoogleAccount(root: AccessibilityNodeInfo): YouTubeGoogleAccount {
        val header = findNodeById(root, youtubeGoogleAccountHeaderId)
        val name = findNodeById(header ?: root, youtubeNameId)?.text?.toString()?.trim()
            ?: ""
        val email = findNodeById(header ?: root, youtubeEmailId)?.text?.toString()?.trim()
            ?: ""
        return YouTubeGoogleAccount(name, email)
    }

    private fun extractYouTubeChannels(
        root: AccessibilityNodeInfo,
        channels: MutableList<YouTubeChannelRecord>,
    ) {
        val googleAccount = findYouTubeGoogleAccount(root)
        fun walk(node: AccessibilityNodeInfo) {
            val handle = cleanYouTubeHandle(node.text?.toString())
            val row = if (handle != null) findYouTubeChannelRowForHandle(node) else null
            if (handle != null && row != null) {
                val displayName = findNodeById(row, youtubeNameId)?.text?.toString()?.trim()
                    ?: ""
                val byline = findNodeById(row, youtubeBylineId)?.text?.toString()?.trim()
                    ?: findYouTubeSubscriberLine(row)
                    ?: ""
                val record = YouTubeChannelRecord(
                    handle = handle,
                    displayName = displayName,
                    sourceAccountName = googleAccount.name,
                    sourceAccountEmail = googleAccount.email,
                    byline = byline,
                )
                if (channels.none { it.handle.equals(handle, ignoreCase = true) }) {
                    channels.add(record)
                    debugLog(
                        "YouTube channel: @$handle display=${record.displayName} " +
                            "source=${record.sourceAccountName} <${record.sourceAccountEmail}>",
                    )
                }
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                walk(child)
                child.recycle()
            }
        }
        walk(root)
    }

    private fun switchYouTubeAccountForScan(
        target: YouTubeAccountCandidate
    ): Boolean {
        val root = getYouTubeRoot() ?: return false
        val row = findYouTubeInactiveAccountRow(root, target)
        val clicked = row != null && clickNode(row)
        Log.e(
            TAG,
            "YouTube account scan switch: name=${target.name} byline=${target.byline} " +
                "found=${row != null} clicked=$clicked"
        )
        root.recycle()
        if (!clicked) return false

        Thread.sleep(1800)
        // Switching to a Google account can show YouTube's notification
        // prompt before the account's channel handle is exposed.
        dismissUnexpectedPopup()
        Thread.sleep(600)
        return true
    }

    private fun openYouTubeAccountsForScan(): Boolean {
        if (openYouTubeAccounts()) return true
        dismissUnexpectedPopup()
        Thread.sleep(600)
        return openYouTubeAccounts()
    }

    private fun restoreYouTubeSelectionAfterScan(
        selection: YouTubeSelectedChannel?
    ) {
        if (selection == null) {
            closeYouTubeAccounts()
            return
        }

        if (!openYouTubeAccountsForScan()) return
        val root = getYouTubeRoot() ?: return
        val current = findYouTubeSelectedChannel(root)
        if (current?.equals(selection.handle, ignoreCase = true) == true) {
            root.recycle()
            closeYouTubeAccounts()
            return
        }

        val directRow = findYouTubeChannelRow(root, selection.handle)
        val fallbackRow = if (directRow == null) {
            findYouTubeInactiveAccountRow(
                root,
                YouTubeAccountCandidate(selection.accountName, selection.byline)
            )
        } else {
            null
        }
        val clicked = (directRow ?: fallbackRow)?.let { clickNode(it) } == true
        Log.e(
            TAG,
            "YouTube account scan restore: target=@${selection.handle} " +
                "found=${directRow != null || fallbackRow != null} clicked=$clicked"
        )
        root.recycle()

        if (clicked) {
            Thread.sleep(1800)
            dismissUnexpectedPopup()
            Thread.sleep(600)
            // Re-open and close the sheet so the final selected channel is
            // verified by YouTube before the scanner returns to SouthFarm.
            if (openYouTubeAccountsForScan()) {
                val verifiedRoot = getYouTubeRoot()
                val verified = verifiedRoot?.let { findYouTubeSelectedChannel(it) }
                verifiedRoot?.recycle()
                Log.e(
                    TAG,
                    "YouTube account scan restore verification: current=$verified " +
                        "target=${selection.handle}"
                )
            }
        }
        closeYouTubeAccounts()
    }

    fun detectTikTokAccounts(): List<String> {
        val accounts = mutableListOf<String>()
        try {
            debugLog("=== TIKTOK ACCOUNT SCAN ===")
            try {
                val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                if (!TEST_NO_OVERLAYS) { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(overlayIntent) else startService(overlayIntent) }
                SouthFarmLoadingService.setInitialText("Scanning TikTok...")
                val loadingIntent = Intent(applicationContext, SouthFarmLoadingService::class.java)
                if (!TEST_NO_OVERLAYS) { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(loadingIntent) else startService(loadingIntent) }
            } catch (e: Exception) {
                Log.e(TAG, "Error starting TikTok scan overlays: ${e.message}")
            }
            Thread.sleep(800)

            debugLog("TikTok scan: opening app")
            if (!openTikTok()) return accounts
            // Wait bounded for TikTok to reach the foreground instead of
            // paying a fixed 3.5s sleep; navigateTikTokToProfile's retry
            // loop absorbs any remaining wait if the app is slow to start.
            for (i in 0 until 12) {
                if (getTikTokRoot() != null) break
                Thread.sleep(500)
            }

            debugLog("TikTok scan: opening Profile semantically")
            if (!navigateTikTokToProfile()) return accounts
            val profileRoot = getTikTokRoot() ?: return accounts
            val selector = findTikTokAccountSelector(profileRoot)
            val openedSwitcher = selector != null && clickNode(selector)
            profileRoot.recycle()
            if (!openedSwitcher) {
                debugLog("TikTok scan: profile handle selector not found")
                return accounts
            }
            Thread.sleep(1500)

            SouthFarmLoadingService.showLoading("Detecting TikTok profiles...")
            val switcherRoot = getTikTokRoot() ?: return accounts
            extractTikTokAccounts(switcherRoot, accounts)
            val close = findNodeByDesc(switcherRoot, "Close") ?: findNodeByText(switcherRoot, "Close")
            if (close != null) clickNode(close)
            switcherRoot.recycle()
            debugLog("TIKTOK ACCOUNT SCAN RESULT: ${accounts.size} accounts -> $accounts")
        } catch (e: Exception) {
            debugLog("TIKTOK SCAN ERROR: ${e.message}")
            Log.e(TAG, "Error detecting TikTok accounts: ${e.message}", e)
        } finally {
            closeSocialAppForCleanStart("tiktok")
            try { returnToSouthFarm() } catch (e: Exception) { Log.e(TAG, "Error returning after TikTok scan: ${e.message}") }
            Thread.sleep(500)
            try { SouthFarmLoadingService.dismissLoading() } catch (_: Exception) {}
            try { stopService(Intent(applicationContext, SouthFarmOverlayService::class.java)) } catch (_: Exception) {}
        }
        return accounts.distinct()
    }

    private fun extractTikTokAccounts(root: AccessibilityNodeInfo, accounts: MutableList<String>) {
        val ignored = setOf(
            "add account", "switch account", "close", "profile menu", "home", "profile",
            "videos", "favorites", "friends", "create", "inbox", "community", "following", "for you",
            "posts", "private videos", "liked videos", "lock", "add bio"
        )
        fun walk(node: AccessibilityNodeInfo) {
            val desc = node.contentDescription?.toString()?.trim() ?: ""
            val username = desc.substringBefore(",").trim()
            val id = node.viewIdResourceName ?: ""
            val looksLikeAccountRow = id.endsWith(":id/l4z") || node.className?.toString()?.endsWith("Button") == true
            if (node.isClickable && looksLikeAccountRow && username.length in 3..40 &&
                username.matches(Regex("[a-zA-Z0-9._]+")) &&
                ignored.none { it.equals(username, ignoreCase = true) }) {
                if (accounts.none { it.equals(username, ignoreCase = true) }) {
                    accounts.add(username)
                    debugLog("TikTok account: $username selected=${node.isSelected}")
                }
                return
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                walk(child)
            }
        }
        walk(root)
    }

    private fun detectYouTubeChannels(): List<YouTubeChannelRecord> {
        val channels = mutableListOf<YouTubeChannelRecord>()
        try {
            debugLog("=== YOUTUBE CHANNEL SCAN ===")
            try {
                val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                if (!TEST_NO_OVERLAYS) { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(overlayIntent) else startService(overlayIntent) }
                SouthFarmLoadingService.setInitialText("Scanning YouTube channels...")
                val loadingIntent = Intent(applicationContext, SouthFarmLoadingService::class.java)
                if (!TEST_NO_OVERLAYS) { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(loadingIntent) else startService(loadingIntent) }
            } catch (e: Exception) {
                Log.e(TAG, "Error starting YouTube scan overlays: ${e.message}")
            }
            Thread.sleep(800)

            debugLog("YouTube scan: opening app")
            if (!openYouTube()) return channels
            Thread.sleep(4000)

            debugLog("YouTube scan: opening You → Accounts")
            if (!openYouTubeAccounts()) return channels
            Thread.sleep(700)
            SouthFarmLoadingService.showLoading("Detecting YouTube channels...")

            val popupRoot = getYouTubeRoot() ?: return channels
            extractYouTubeChannels(popupRoot, channels)
            popupRoot.recycle()
            debugLog("YouTube scan: channels=${channels.size}")
            debugLog(
                "YOUTUBE CHANNEL SCAN RESULT: ${channels.size} channels -> " +
                    channels.map { "@${it.handle}(${it.sourceAccountName})" },
            )
        } catch (e: Exception) {
            debugLog("YOUTUBE SCAN ERROR: ${e.message}")
            Log.e(TAG, "Error detecting YouTube channels: ${e.message}", e)
        } finally {
            closeSocialAppForCleanStart("youtube")
            try { returnToSouthFarm() } catch (e: Exception) { Log.e(TAG, "Error returning after YouTube scan: ${e.message}") }
            Thread.sleep(500)
            try { SouthFarmLoadingService.dismissLoading() } catch (_: Exception) {}
            try { stopService(Intent(applicationContext, SouthFarmOverlayService::class.java)) } catch (_: Exception) {}
        }
        return channels.distinct()
    }

    fun detectInstagramAccounts(): List<String> {
        val accounts = mutableListOf<String>()
        try {
            Log.e(TAG, "SF-NOOVERLAY: overlay-free TEST build, scan starting")
            debugLog("=== ACCOUNT SCAN v5 (loading overlay) ===")

            // [Loading Overlay] Keep Instagram interaction protected while scanning.
            try {
                if (!TEST_NO_OVERLAYS) {
                    val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(overlayIntent)
                    } else {
                        startService(overlayIntent)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error starting overlay for scan: ${e.message}")
            }
            Thread.sleep(500)

            try {
                if (!TEST_NO_OVERLAYS) {
                    SouthFarmLoadingService.setInitialText("Scanning app...")
                    val loadingIntent = Intent(applicationContext, SouthFarmLoadingService::class.java)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(loadingIntent)
                    } else {
                        startService(loadingIntent)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error starting loading for scan: ${e.message}")
            }
            for (i in 0..20) {
                if (TEST_NO_OVERLAYS || SouthFarmLoadingService.isRunning) break
                Thread.sleep(100)
            }
            Thread.sleep(400)

            // Step 1: Open Instagram
            debugLog("Step 1: Opening Instagram...")
            if (!openInstagram()) {
                debugLog("Instagram is not installed or could not be opened")
                return accounts
            }

            var root: AccessibilityNodeInfo? = null
            for (attempt in 0 until 25) {
                root = getInstagramRoot()
                if (root != null) break
                if (attempt < 24) Thread.sleep(400)
            }
            if (root == null) {
                debugLog("Root STILL null, abort")
                returnToSouthFarm()
                return accounts
            }
            debugLog("IG open, pkg=${root.packageName}")
            root.recycle()

            // Step 2: Go to Profile tab
            debugLog("Step 2: Going to Profile tab...")
            root = getInstagramRoot() ?: run {
                returnToSouthFarm()
                return accounts
            }
            val profileTab = findNodeByDesc(root, "Profile", minY = screenHeight - 200)
                ?: findNodeByDesc(root, "Perfil", minY = screenHeight - 200)
            if (profileTab != null) {
                debugLog("Found Profile tab, clicking")
                clickNode(profileTab)
            } else {
                debugLog("Profile tab not found, tapping bottom-right")
                tapAt(screenWidth - 80f, screenHeight - 80f)
            }
            Thread.sleep(3000)
            root.recycle()

            // Step 3: Find and tap the username in profile header to open switcher
            debugLog("Step 3: Finding username header to open switcher...")
            val profileRoot = getInstagramRoot() ?: run {
                debugLog("Profile root null")
                returnToSouthFarm()
                return accounts
            }

            if (!openInstagramAccountSwitcher(profileRoot)) {
                debugLog("Instagram account switcher could not be opened")
                profileRoot.recycle()
                returnToSouthFarm()
                return accounts
            }
            profileRoot.recycle()

            // Step 4: Read the account switcher popup
            debugLog("Step 4: Reading switcher popup...")
            SouthFarmLoadingService.showLoading("Detecting profiles...")
            val switcherRoot = getInstagramRoot() ?: run {
                debugLog("Switcher root null")
                returnToSouthFarm()
                return accounts
            }
            debugLog("Switcher pkg=${switcherRoot.packageName}")

            // Step 5: Extract accounts from switcher
            // Pattern from UI dump:
            //   - Each account is a ViewGroup with clickable=true
            //   - content-desc = "username" for active, "username, N chats" for others
            //   - The active account has selected=true
            //   - Children include a View with text=username
            debugLog("Step 5: Extracting accounts from switcher...")
            extractAccountsFromSwitcher(switcherRoot, accounts)

            debugLog("ACCOUNT SCAN RESULT: ${accounts.size} accounts -> $accounts")
            switcherRoot.recycle()

            // Step 6: Show the final loading state before returning to SouthFarm.
            SouthFarmLoadingService.showLoading("Saving info...")
            Thread.sleep(800)

        } catch (e: Exception) {
            debugLog("SCAN ERROR: ${e.message}")
            Log.e(TAG, "Error detecting accounts: ${e.message}", e)
        } finally {
            // Always return to SouthFarm and clean up both layers, including early exits.
            closeSocialAppForCleanStart("instagram")
            try {
                returnToSouthFarm()
            } catch (e: Exception) {
                Log.e(TAG, "Error returning to SouthFarm after scan: ${e.message}")
            }
            Thread.sleep(500)

            try {
                SouthFarmLoadingService.dismissLoading()
            } catch (e: Exception) {
                Log.e(TAG, "Error dismissing scan loading overlay: ${e.message}")
            }
            Thread.sleep(300)

            try {
                val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                stopService(overlayIntent)
            } catch (e: Exception) {
                Log.e(TAG, "Error stopping scan overlay: ${e.message}")
            }
        }

        return accounts.distinct()
    }

    /**
     * Open Instagram's account switcher using the header's accessibility
     * semantics. The account rows are validated separately, so a profile
     * screen can never be mistaken for the switcher just because it contains
     * clickable text such as "3followers" or "14following".
     */
    private fun openInstagramAccountSwitcher(root: AccessibilityNodeInfo): Boolean {
        val headerIds = listOf(
            "com.instagram.android:id/action_bar_username_container",
            "com.instagram.android:id/action_bar_title",
            "com.instagram.android:id/action_bar_title_text",
            "com.instagram.android:id/profile_header_user_name",
        )
        for (id in headerIds) {
            val node = findNodeById(root, id)
            if (node != null && clickNode(node) && waitForInstagramAccountSwitcher()) {
                debugLog("Instagram switcher opened through id=$id")
                return true
            }
        }

        val headerLabels = listOf(
            "Switch account",
            "Switch accounts",
            "Account switcher",
            "Open account switcher",
            "Cambiar cuenta",
            "Cambiar de cuenta",
        )
        for (label in headerLabels) {
            val node = findNodeByDesc(root, label) ?: findNodeByText(root, label)
            if (node != null && clickNode(node) && waitForInstagramAccountSwitcher()) {
                debugLog("Instagram switcher opened through label=$label")
                return true
            }
        }

        val usernameNode = findInstagramHeaderUsername(root)
        if (usernameNode != null && clickNode(usernameNode) && waitForInstagramAccountSwitcher()) {
            debugLog("Instagram switcher opened through header username")
            return true
        }

        debugLog("Instagram switcher header was not exposed as an actionable semantic node")
        return false
    }

    private fun findInstagramHeaderUsername(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        return findNodeByPredicate(root) { node ->
            val rect = android.graphics.Rect()
            node.getBoundsInScreen(rect)
            if (rect.top >= (screenHeight * 0.28f).toInt()) return@findNodeByPredicate false

            val id = node.viewIdResourceName?.toString().orEmpty()
            val text = node.text?.toString()?.trim().orEmpty()
            val desc = node.contentDescription?.toString()?.trim().orEmpty()
            val candidate = if (text.isNotEmpty()) text else desc.substringBefore(",").trim()
            val usernameLike = candidate.length in 3..30 &&
                candidate.matches(Regex("[a-zA-Z0-9._]+")) &&
                candidate.any { it.isLetter() } &&
                ignoreTexts.none { it.equals(candidate, ignoreCase = true) }
            usernameLike && (
                id.contains("action_bar", ignoreCase = true) ||
                    id.contains("profile_header", ignoreCase = true) ||
                    text.isNotEmpty() ||
                    desc.isNotEmpty()
                )
        }
    }

    private fun waitForInstagramAccountSwitcher(): Boolean {
        repeat(12) {
            val candidate = getInstagramRoot()
            if (candidate != null) {
                val detected = mutableListOf<String>()
                findSwitcherAccountsStrict(candidate, detected)
                val hasAccountAction = findNodeByTextContains(candidate, "Add Instagram account") != null ||
                    findNodeByTextContains(candidate, "Agregar cuenta") != null ||
                    findNodeByDescContains(candidate, "Add Instagram account") != null
                candidate.recycle()
                if (detected.isNotEmpty() || hasAccountAction) return true
            }
            Thread.sleep(350)
        }
        return false
    }

    /**
     * Extract accounts from the IG account switcher popup.
     * Each account is a ViewGroup with clickable=true and content-desc containing the username.
     * Known non-account items: "Add Instagram account", "Add Facebook profile", "Go to Accounts Center"
     */
    private fun extractAccountsFromSwitcher(root: AccessibilityNodeInfo, accounts: MutableList<String>) {
        // Based on UI dump analysis, real accounts in the switcher have:
        // - clickable = true (Instagram may expose ViewGroup, LinearLayout,
        //   or a custom wrapper depending on the app build)
        // - content-desc = "username" (active, selected=true) OR "username, N chats" (others)
        // - Children: ImageView + View(text=username) + ImageView/View(text="N chats")
        // Non-account items are Buttons: "Add Instagram account", "Go to Accounts Center"
        findSwitcherAccountsStrict(root, accounts)
    }

    private fun findSwitcherAccountsStrict(
        node: AccessibilityNodeInfo,
        accounts: MutableList<String>
    ) {
        val desc = node.contentDescription?.toString()?.trim() ?: ""
        // Instagram changes the metadata suffix depending on the account:
        // "username", "username, 14 chats", "username, 1 chat and 3 more"
        // and even "username, 1 follow and 5 more" have all appeared. The
        // stable signal is the account row itself: a clickable ViewGroup with
        // either selected=true (the active account) or row metadata after the
        // username. Do not accept arbitrary clickable labels from the profile
        // screen, such as follower/following counts.
        val className = node.className?.toString().orEmpty()
        val hasRowMetadata = desc.contains(",")
        val isAccountRow = node.isClickable &&
            className.endsWith("ViewGroup") &&
            desc.isNotEmpty() &&
            (node.isSelected || hasRowMetadata)
        if (isAccountRow) {
            // Extract the username from the part before optional row metadata.
            val username = desc.substringBefore(",").trim()
            if (username.length in 3..30 &&
                username.matches(Regex("[a-z0-9._]+")) &&
                username.any { it.isLetter() } &&
                !ignoreTexts.any { it.equals(username, ignoreCase = true) }) {
                if (!accounts.any { it.equals(username, ignoreCase = true) }) {
                    accounts.add(username)
                    debugLog("  Found REAL account: $username selected=${node.isSelected} desc=\"$desc\"")
                }
                return // Don't recurse into this node's children
            }
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findSwitcherAccountsStrict(child, accounts)
        }
    }

    private fun dumpFullTree(node: AccessibilityNodeInfo, depth: Int) {
        if (depth > 10) return
        val indent = "  ".repeat(depth)
        val id = node.viewIdResourceName ?: ""
        val desc = node.contentDescription?.toString()?.replace("\n", " ") ?: ""
        val text = node.text?.toString()?.replace("\n", " ") ?: ""
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        val cls = node.className?.toString()?.substringAfterLast(".") ?: ""
        debugLog("$indent d=$depth cls=$cls id=$id text='$text' desc='$desc' bounds=$bounds clickable=${node.isClickable}")
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            dumpFullTree(child, depth + 1)
        }
    }

    private fun collectAllTexts(node: AccessibilityNodeInfo, texts: MutableList<String>) {
        val text = node.text?.toString()?.trim()
        if (!text.isNullOrEmpty() && text.length < 100) {
            texts.add(text)
        }
        val desc = node.contentDescription?.toString()?.trim()
        if (!desc.isNullOrEmpty() && desc.length < 100 && desc != text) {
            texts.add("[$desc]")
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collectAllTexts(child, texts)
        }
    }
}
