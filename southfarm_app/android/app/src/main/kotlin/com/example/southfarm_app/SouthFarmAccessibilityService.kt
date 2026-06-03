package com.example.southfarm_app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Random

class SouthFarmAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "SouthFarmA11y"
        private const val API_BASE = "https://api.southfarm.tech/api"
        var isRunning = false
            private set
        var currentStatus: String = "idle"
            internal set
        var warmupMetrics: String = "{}"
            private set
        var detectedAccounts: String = "[]"
        var instance: SouthFarmAccessibilityService? = null
            private set

        fun startWarmupStatic(username: String, durationMinutes: Int): Boolean {
            val svc = instance ?: return false
            svc.startWarmup(username, durationMinutes)
            return true
        }

        fun stopWarmupStatic() {
            val svc = instance ?: return
            svc.stopWarmup()
        }

        fun pauseWarmupStatic() {
            val svc = instance ?: return
            svc.pauseWarmup()
        }

        fun resumeWarmupStatic() {
            val svc = instance ?: return
            svc.resumeWarmup()
        }

        private var detectCallback: ((String) -> Unit)? = null

        fun detectAccountsStatic(callback: (String) -> Unit) {
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
                    val accounts = svc.detectInstagramAccounts()
                    val json = org.json.JSONArray(accounts).toString()
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
    }

    private var isWarmupRunning = false
    private var isWarmupPaused = false
    private var warmupThread: Thread? = null
    private var random = Random()
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

    private fun checkPendingTasks() {
        if (isProcessingRemoteTask || isWarmupRunning) return
        Thread {
            try {
                val prefs = getSharedPreferences("FlutterSharedPreferences", MODE_PRIVATE)
                val token = prefs.getString("flutter.auth_token", null)
                Log.e(TAG, "Poll: token=${if (token != null) token.take(20) + "..." else "NULL"}")
                if (token == null) return@Thread

                val url = URL("$API_BASE/tasks/runs?status=pending&limit=1")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = 5000
                conn.readTimeout = 5000

                val responseCode = conn.responseCode
                Log.e(TAG, "Poll: response=$responseCode")

                if (responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val json = JSONObject(body)
                    val runs = json.optJSONArray("runs")
                    Log.e(TAG, "Poll: runs count=${runs?.length() ?: 0}")
                    if (runs != null && runs.length() > 0) {
                        val task = runs.getJSONObject(0)
                        Log.e(TAG, "Poll: found task id=${task.getInt("id")} type=${task.getString("task_type")} status=${task.getString("status")}")
                        if (task.getString("task_type") == "warmup_ig" && task.getString("status") == "pending") {
                            isProcessingRemoteTask = true
                            executeRemoteTask(task, token)
                        }
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                Log.e(TAG, "Poll error: ${e.message}")
            }
        }.start()
    }

    private fun executeRemoteTask(task: JSONObject, token: String) {
        try {
            val paramsStr = task.optString("params", "{}")
            val params = JSONObject(paramsStr)
            val account = params.optString("account", "")
            val duration = params.optInt("duration_minutes", 2)
            val taskId = task.getInt("id")

            if (account.isEmpty()) {
                isProcessingRemoteTask = false
                return
            }

            Log.i(TAG, "[Remote] Starting warmup: @$account for ${duration}m (task $taskId)")

            // Mark as running
            updateTaskStatus(taskId, "running", token, null)

            // Start overlay
            try {
                val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                overlayIntent.putExtra("username", account)
                overlayIntent.putExtra("duration", duration)
                startService(overlayIntent)
            } catch (e: Exception) {
                Log.e(TAG, "Error starting overlay: ${e.message}")
            }

            // Start warmup
            startWarmup(account, duration)

            // Wait for completion
            Thread {
                while (isWarmupRunning) {
                    Thread.sleep(3000)
                }

                // Stop overlay
                try {
                    val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                    stopService(overlayIntent)
                } catch (e: Exception) {
                    Log.e(TAG, "Error stopping overlay: ${e.message}")
                }

                // Get metrics and mark as completed
                val metrics = warmupMetrics
                updateTaskStatus(taskId, "completed", token, metrics)
                Log.i(TAG, "[Remote] Task $taskId completed")
                isProcessingRemoteTask = false
            }.start()
        } catch (e: Exception) {
            Log.e(TAG, "[Remote] Error: ${e.message}")
            val taskId = task.optInt("id", -1)
            if (taskId > 0) updateTaskStatus(taskId, "error", token, null)
            isProcessingRemoteTask = false
        }
    }

    private fun updateTaskStatus(taskId: Int, status: String, token: String, metrics: String?) {
        try {
            val url = URL("$API_BASE/tasks/runs/$taskId")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "PATCH"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 5000

            val body = JSONObject()
            body.put("status", status)
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

    fun startWarmup(username: String, durationMinutes: Int) {
        if (isWarmupRunning) {
            currentStatus = "already_running"
            return
        }

        isWarmupRunning = true
        currentStatus = "starting"

        // Start loading overlay (Service-based — can draw over other apps)
        try {
            val loadingIntent = Intent(applicationContext, SouthFarmLoadingService::class.java)
            startForegroundService(loadingIntent)
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
                if (currentStatus != "finished") currentStatus = "finished"
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
                returnToSouthFarm()
            }
        }
        warmupThread?.start()
    }

    fun stopWarmup() {
        isWarmupRunning = false
        isWarmupPaused = false
        warmupThread?.interrupt()
        currentStatus = "stopped"
        warmupMetrics = "{}"
    }

    fun pauseWarmup() {
        isWarmupPaused = true
        currentStatus = "paused"
        debugLog("Warmup paused")
    }

    fun resumeWarmup() {
        isWarmupPaused = false
        currentStatus = "warming_up"
        debugLog("Warmup resumed")
    }

    // ─── Main Warmup Loop (based on v6.py do_reels_session) ───

    private fun updateLoadingText(text: String) {
        SouthFarmLoadingService.showLoading(text)
    }

    private fun runWarmupLoop(username: String, durationMinutes: Int) {
        val durationSec = durationMinutes * 60L
        resetMetrics()

        Log.e(TAG, "Starting warmup: username=$username, duration=${durationMinutes}min, screen=${screenWidth}x${screenHeight}")

        // Step 1: Open Instagram
        currentStatus = "opening_instagram"
        updateLoadingText("Preparando warmup...")
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
        updateLoadingText("Configurando cuenta...")
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
        val endTime = startTime + (durationSec * 1000)

        currentStatus = "warming_up"
        var loopCount = 0

        while (System.currentTimeMillis() < endTime && isWarmupRunning) {
            try {
                // Check for pause
                if (isWarmupPaused) {
                    Thread.sleep(500)
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

                // Step 3d: Like (35% chance from v6.py)
                if (random.nextDouble() < 0.35) {
                    if (likeCurrentContent(root)) {
                        likesGiven++
                    }
                    dismissUnexpectedPopup()
                }

                // Step 3e: Save (8% chance from v6.py)
                if (random.nextDouble() < 0.08) {
                    if (saveCurrentContent(root)) {
                        savesGiven++
                    }
                    dismissUnexpectedPopup()
                }

                // Step 3f: Scroll to next reel
                scrollToNextReel()

                // Update metrics
                val elapsed = (System.currentTimeMillis() - startTime) / 1000
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

        val totalElapsed = (System.currentTimeMillis() - startTime) / 1000
        warmupMetrics = buildMetricsJson(totalElapsed, durationSec)
        currentStatus = "finished"
        Log.i(TAG, "Warmup finished: $warmupMetrics")

        // Close Instagram and return to SouthFarm
        returnToSouthFarm()
    }

    private fun returnToSouthFarm() {
        try {
            // Go back to SouthFarm (don't force-stop IG, just bring our app to front)
            val intent = packageManager.getLaunchIntentForPackage("com.example.southfarm_app")
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                intent.putExtra("warmup_finished", true)
                startActivity(intent)
            }
            Log.i(TAG, "Returned to SouthFarm")
        } catch (e: Exception) {
            Log.e(TAG, "Error returning to SouthFarm: ${e.message}")
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

    private fun navigateToReels() {
        Thread.sleep(1000)
        val root = rootInActiveWindow ?: return

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
        val root = rootInActiveWindow ?: run {
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
        val profileRoot = rootInActiveWindow ?: return false
        val currentUsername = readProfileUsername(profileRoot)
        profileRoot.recycle()

        debugLog("ensureCorrectAccount: current=$currentUsername, target=$targetUsername")

        // Step 3: If already correct, we're done
        if (currentUsername.equals(cleanTarget, ignoreCase = true)) {
            debugLog("ensureCorrectAccount: already on correct account")
            return true
        }

        // Step 4: Open the account switcher by tapping the username header
        debugLog("ensureCorrectAccount: switching from $currentUsername to $cleanTarget")
        tapAt(170f, 120f)
        Thread.sleep(2500)

        // Step 5: Find and tap the target account in the switcher
        val switcherRoot = rootInActiveWindow ?: return false
        val switched = tapAccountInSwitcher(switcherRoot, cleanTarget)
        switcherRoot.recycle()

        if (!switched) {
            debugLog("ensureCorrectAccount: could not find $cleanTarget in switcher")
            return false
        }

        // Step 6: Wait for account switch to complete
        Thread.sleep(3000)

        // Step 7: Verify the switch worked by reading the profile again
        val verifyRoot = rootInActiveWindow ?: return true // Assume success if can't verify
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
        if (isSponsoredContent(root)) return false

        var saveBtn = findNodeById(root, "com.instagram.android:id/save_button")
        if (saveBtn == null) saveBtn = findNodeByDesc(root, "Save")
        if (saveBtn == null) return false

        if (saveBtn.isSelected) return false // Already saved

        // Get exact bounds to avoid hitting nav bar
        val bounds = android.graphics.Rect()
        saveBtn.getBoundsInScreen(bounds)
        if (bounds.bottom > 1400) return false

        clickNode(saveBtn)
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
        val cx = screenWidth * 0.5f + (random.nextFloat() - 0.5f) * 80f
        val startY = screenHeight * 0.6f + random.nextFloat() * 80f  // ~980-1060
        val endY = screenHeight * 0.2f + random.nextFloat() * 80f  // ~320-400
        val duration = 250L + random.nextInt(100) // Smooth

        swipe(cx, startY, cx, endY, duration)

        try { Thread.sleep(150 + random.nextInt(200).toLong()) } catch (_: InterruptedException) {}
    }

    private fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, duration: Long) {
        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }
        val gesture = GestureDescription.StrokeDescription(path, 0, duration)
        val builder = GestureDescription.Builder()
        builder.addStroke(gesture)

        dispatchGesture(builder.build(), null, null)
    }

    private fun tapAt(x: Float, y: Float) {
        val path = Path().apply {
            moveTo(x, y)
        }
        val gesture = GestureDescription.StrokeDescription(path, 0, 50)
        val builder = GestureDescription.Builder()
        builder.addStroke(gesture)

        dispatchGesture(builder.build(), null, null)
    }

    // ─── UI Tree Helpers ───

    private fun findNodeById(root: AccessibilityNodeInfo, resourceId: String): AccessibilityNodeInfo? {
        val nodes = root.findAccessibilityNodeInfosByViewId(resourceId)
        return nodes.firstOrNull()
    }

    private fun findNodeByText(root: AccessibilityNodeInfo, text: String): AccessibilityNodeInfo? {
        val nodes = root.findAccessibilityNodeInfosByText(text)
        return nodes.firstOrNull { it.text?.toString()?.equals(text, ignoreCase = true) == true }
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
        if (node.isClickable) {
            return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }
        // Try parent
        val parent = node.parent ?: return false
        return if (parent.isClickable) {
            parent.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        } else false
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

    private fun dismissUnexpectedPopup() {
        try {
            val root = rootInActiveWindow ?: return

            // Only look for close patterns that are small dialogs (not full screen elements)
            // Don't use GLOBAL_ACTION_BACK — it can exit Reels
            for (text in listOf("Not now", "Not Now", "No ahora", "Skip", "Omitir", "Maybe later")) {
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
            r < 0.50 -> 1.0 + random.nextDouble() * 1.5   // 1.0-2.5s (50%)
            r < 0.85 -> 2.5 + random.nextDouble() * 1.5   // 2.5-4.0s (35%)
            else -> 4.0 + random.nextDouble() * 1.0       // 4.0-5.0s (15%)
        }
        return (seconds * 1000).toLong()
    }

    // ─── Metrics ───

    private fun resetMetrics() {
        reelsViewed = 0
        likesGiven = 0
        savesGiven = 0
        adsDetected = 0
        adsDismissed = 0
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
        return """{"reels_viewed":$reelsViewed,"likes":$likesGiven,"saves":$savesGiven,"ads_detected":$adsDetected,"ads_dismissed":$adsDismissed,"elapsed_sec":$elapsedSec,"total_sec":$totalSec,"status":"$currentStatus"}"""
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

    fun detectInstagramAccounts(): List<String> {
        val accounts = mutableListOf<String>()
        try {
            debugLog("=== ACCOUNT SCAN v3 START ===")

            // Start overlay (same as warmup loading)
            try {
                val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
                startService(overlayIntent)
            } catch (e: Exception) {
                Log.e(TAG, "Error starting overlay for scan: ${e.message}")
            }
            Thread.sleep(500) // Wait for overlay to appear

            // Start loading screen
            try {
                SouthFarmLoadingService.setInitialText("Escaneando aplicación...")
                val loadingIntent = Intent(applicationContext, SouthFarmLoadingService::class.java)
                startForegroundService(loadingIntent)
            } catch (e: Exception) {
                Log.e(TAG, "Error starting loading for scan: ${e.message}")
            }
            Thread.sleep(800) // Wait for loading screen to show + step 1 delay

            // Step 1: Open Instagram
            debugLog("Step 1: Opening Instagram...")
            openInstagram()
            Thread.sleep(4000)

            var root = rootInActiveWindow
            if (root == null) {
                debugLog("Root null after open, retrying...")
                Thread.sleep(2000)
                root = rootInActiveWindow
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
            root = rootInActiveWindow ?: run {
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
            val profileRoot = rootInActiveWindow ?: run {
                debugLog("Profile root null")
                returnToSouthFarm()
                return accounts
            }

            // Strategy: tap the top-left area of the action bar where the username lives
            // Verified on POCO C71 (720x1640): username header is at x=170, y=120
            debugLog("Tapping username header area (170, 120)...")
            tapAt(170f, 120f)
            Thread.sleep(2500) // Wait for switcher popup
            profileRoot.recycle()

            // Step 4: Read the account switcher popup
            debugLog("Step 4: Reading switcher popup...")
            SouthFarmLoadingService.showLoading("Detectando perfiles...")
            Thread.sleep(1000) // Let user see the text
            val switcherRoot = rootInActiveWindow ?: run {
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

            // Step 6: Saving
            if (accounts.isNotEmpty()) {
                SouthFarmLoadingService.showLoading("Guardando información...")
                Thread.sleep(1200) // Let user see completion
            }

        } catch (e: Exception) {
            debugLog("SCAN ERROR: ${e.message}")
            Log.e(TAG, "Error detecting accounts: ${e.message}", e)
        }

        // Stop loading + overlay
        try {
            SouthFarmLoadingService.dismissLoading()
        } catch (_: Exception) {}
        try {
            val overlayIntent = Intent(applicationContext, SouthFarmOverlayService::class.java)
            stopService(overlayIntent)
        } catch (_: Exception) {}

        returnToSouthFarm()
        return accounts.distinct()
    }

    /**
     * Extract accounts from the IG account switcher popup.
     * Each account is a ViewGroup with clickable=true and content-desc containing the username.
     * Known non-account items: "Add Instagram account", "Add Facebook profile", "Go to Accounts Center"
     */
    private fun extractAccountsFromSwitcher(root: AccessibilityNodeInfo, accounts: MutableList<String>) {
        // Based on UI dump analysis, real accounts in the switcher have:
        // - class = ViewGroup (not Button)
        // - clickable = true
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
        val className = node.className?.toString() ?: ""

        // Only consider clickable ViewGroups (not Buttons, not ImageViews, etc.)
        if (node.isClickable && className.endsWith("ViewGroup") && desc.isNotEmpty()) {
            // Active account: content-desc = "username" + selected=true
            // Other accounts: content-desc = "username, N chats"
            val hasChats = desc.contains(",") && desc.lowercase().contains("chats")
            val isActive = node.isSelected

            if (hasChats || isActive) {
                // Extract username (part before comma)
                val username = desc.split(",")[0].trim()
                if (username.length in 3..30 &&
                    username.matches(Regex("[a-z0-9._]+")) &&
                    username.any { it.isLetter() }) {
                    accounts.add(username)
                    debugLog("  Found REAL account: $username active=$isActive desc=\"$desc\"")
                    return // Don't recurse into this node's children
                }
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
