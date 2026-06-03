package com.example.southfarm_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.*
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Button
import android.widget.TextView
import kotlin.math.sin
import android.graphics.BitmapFactory

/**
 * SouthFarmOverlayService — Manages the overlay layers during warmup and scan.
 *
 * OVERLAY STAGES:
 *   [Loading Overlay] — Black/green/white/black2 layers + bubble. Used during:
 *     - Warmup: account selection phase (before reaching Reels)
 *     - Scan: account detection phase
 *   [Running Overlay] — Wave borders + bubble. Used during:
 *     - Warmup: Reels scrolling phase
 *
 * TRANSITION: Loading → Running happens via transitionToRunning()
 * Called by SouthFarmAccessibilityService after navigateToReels()
 */
class SouthFarmOverlayService : Service() {

    companion object {
        private const val TAG = "SouthFarmOverlay"
        var isShowing = false
            private set
        var isPaused = false
            private set

        fun setPaused(paused: Boolean) {
            isPaused = paused
        }

        // Loading overlay state
        fun showLoading(text: String) {
            SouthFarmLoadingService.showLoading(text)
        }

        fun dismissLoading() {
            SouthFarmLoadingService.dismissLoading()
        }

        // Transition from loading overlays (black/green/white/black2) to running mode (waves + bubble)
        fun transitionToRunning() {
            val svc = _instance ?: return
            svc.doTransitionToRunning()
        }

        private var _instance: SouthFarmOverlayService? = null
    }

    private var windowManager: WindowManager? = null
    private var waveView: WaveBorderView? = null
    private var blackOverlay: View? = null
    private var greenOverlay: View? = null
    private var whiteOverlay: View? = null
    private var blackOverlay2: View? = null
    private var controlButton: View? = null
    private var popupView: View? = null
    private val handler = Handler(Looper.getMainLooper())
    private var animOffset = 0f
    private var running = true

    override fun onCreate() {
        super.onCreate()
        _instance = this
        createNotificationChannel()
        val notification = Notification.Builder(this, "southfarm_overlay")
            .setContentTitle("SouthFarm")
            .setContentText("Warmup en progreso...")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .build()
        startForeground(1001, notification)
        showOverlay()
    }

    // ═══════════════════════════════════════════════════════════════
    // [Loading Overlay] — Full screen color layers + floating bubble
    // Used during warmup (account selection) and scan (account detection)
    // Layers: Instagram → Black → Green → White → Black2 → Bubble
    // ═══════════════════════════════════════════════════════════════
    private fun showOverlay() {
        if (isShowing) return
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager

        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        val borderWidth = 20

        // [DISABLED] Wave borders — kept for future re-activation
        // val waveParams = WindowManager.LayoutParams(
        //     screenWidth, screenHeight,
        //     WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        //     WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        //             WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        //             WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        //             WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        //     PixelFormat.TRANSLUCENT
        // )
        // waveParams.gravity = Gravity.TOP or Gravity.START
        // val wave = WaveBorderView(this, screenWidth, screenHeight, borderWidth)
        // waveView = wave
        // windowManager?.addView(wave, waveParams)

        // Black overlay — covers entire screen, NOT touchable
        val blackParams = WindowManager.LayoutParams(
            screenWidth, screenHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )
        blackParams.gravity = Gravity.TOP or Gravity.START

        val black = View(this)
        black.setBackgroundColor(Color.BLACK)
        black.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        blackOverlay = black
        windowManager?.addView(black, blackParams)

        // Green overlay — above black, below white
        val greenParams = WindowManager.LayoutParams(
            screenWidth, screenHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )
        greenParams.gravity = Gravity.TOP or Gravity.START

        val green = View(this)
        green.setBackgroundColor(0xFF34d399.toInt())
        green.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        greenOverlay = green
        windowManager?.addView(green, greenParams)

        // White overlay — above green, below bubble, fully opaque
        val whiteParams = WindowManager.LayoutParams(
            screenWidth, screenHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.OPAQUE
        )
        whiteParams.gravity = Gravity.TOP or Gravity.START

        val white = View(this)
        white.setBackgroundColor(Color.WHITE)
        white.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        whiteOverlay = white
        windowManager?.addView(white, whiteParams)

        // Second black overlay — above white, below bubble
        val black2Params = WindowManager.LayoutParams(
            screenWidth, screenHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.OPAQUE
        )
        black2Params.gravity = Gravity.TOP or Gravity.START

        val black2 = View(this)
        black2.setBackgroundColor(Color.BLACK)
        black2.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        blackOverlay2 = black2
        windowManager?.addView(black2, black2Params)

        // Small floating control button — IS touchable
        val btnSize = 120
        val btnParams = WindowManager.LayoutParams(
            btnSize, btnSize,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        )
        btnParams.gravity = Gravity.TOP or Gravity.END
        btnParams.y = 60

        val btn = ControlButtonView(this)
        btn.setOnClickListener { showControlPopup() }
        controlButton = btn
        windowManager?.addView(btn, btnParams)

        // Ensure bubble stays on top — re-add after all overlays settle
        handler.postDelayed({
            try {
                controlButton?.let { b ->
                    windowManager?.removeView(b)
                    windowManager?.addView(b, btnParams)
                }
            } catch (_: Exception) {}
        }, 500)

        isShowing = true
        // startAnimation(wave) // disabled with waves
    }

    private fun showControlPopup() {
        if (popupView?.isAttachedToWindow == true) {
            windowManager?.removeView(popupView)
            popupView = null
            return
        }

        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels

        // Semi-transparent background
        val container = FrameLayout(this)
        container.setBackgroundColor(0x99000000.toInt())

        // Popup card
        val card = LinearLayout(this)
        card.orientation = LinearLayout.VERTICAL
        card.setPadding(40, 36, 40, 36)
        card.gravity = Gravity.CENTER

        // Rounded card background
        val cardBg = android.graphics.drawable.GradientDrawable()
        cardBg.setColor(0xFF1a1a1a.toInt())
        cardBg.cornerRadius = 28f
        cardBg.setStroke(1, 0xFF333333.toInt())
        card.background = cardBg

        val cardParams = FrameLayout.LayoutParams(
            (screenWidth * 0.78).toInt(),
            FrameLayout.LayoutParams.WRAP_CONTENT
        )
        cardParams.gravity = Gravity.CENTER
        card.layoutParams = cardParams

        // Title
        val title = TextView(this)
        title.text = "SouthFarm"
        title.setTextColor(0xFF34d399.toInt())
        title.textSize = 18f
        title.setTypeface(null, android.graphics.Typeface.BOLD)
        title.gravity = Gravity.CENTER
        card.addView(title)

        // Status text
        val statusText = TextView(this)
        statusText.text = if (isPaused) "⏸ Pausado" else "▶️ En progreso"
        statusText.setTextColor(Color.WHITE)
        statusText.textSize = 14f
        statusText.gravity = Gravity.CENTER
        statusText.setPadding(0, 16, 0, 24)
        card.addView(statusText)

        // Buttons
        val btnRow = LinearLayout(this)
        btnRow.orientation = LinearLayout.HORIZONTAL
        btnRow.gravity = Gravity.CENTER
        val btnLayoutParam = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)

        // Pause/Resume button (left)
        val pauseBtn = if (isPaused) {
            createButton("▶ Reanudar", 0xFF3b82f6.toInt(), Color.WHITE) {
                isPaused = false
                SouthFarmAccessibilityService.resumeWarmupStatic()
                hideControlPopup()
            }
        } else {
            createButton("⏸ Pausar", 0xFFf97316.toInt(), Color.WHITE) {
                isPaused = true
                SouthFarmAccessibilityService.pauseWarmupStatic()
                hideControlPopup()
            }
        }
        pauseBtn.layoutParams = btnLayoutParam
        btnRow.addView(pauseBtn)

        // Stop button (right)
        val stopBtn = createButton("⏹ Detener", 0xFFef4444.toInt(), Color.WHITE) {
            SouthFarmAccessibilityService.stopWarmupStatic()
            hideControlPopup()
            stopSelf()
        }
        val stopParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        stopParams.setMargins(12, 0, 0, 0)
        stopBtn.layoutParams = stopParams
        btnRow.addView(stopBtn)

        card.addView(btnRow)

        // Tap outside to dismiss
        container.addView(card)
        container.setOnClickListener { hideControlPopup() }

        val params = WindowManager.LayoutParams(
            screenWidth, screenHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        )
        params.gravity = Gravity.TOP or Gravity.START

        popupView = container
        windowManager?.addView(container, params)
    }

    private fun hideControlPopup() {
        try {
            popupView?.let { windowManager?.removeView(it) }
        } catch (_: Exception) {}
        popupView = null
    }

    private fun createButton(text: String, bgColor: Int, textColor: Int, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setTextColor(textColor)
            textSize = 13f
            setPadding(20, 10, 20, 10)
            isAllCaps = false
            setOnClickListener { onClick() }
            // Rounded background
            val shape = android.graphics.drawable.GradientDrawable()
            shape.setColor(bgColor.toInt())
            shape.cornerRadius = 28f
            background = shape
            // Minimum width for consistent sizing
            minWidth = 0
            minimumWidth = 0
        }
    }

    private fun startAnimation(view: WaveBorderView) {
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (!running || !isShowing) return
                animOffset += 0.06f
                // Change color based on pause state
                view.setPaused(isPaused)
                view.updateOffset(animOffset)
                handler.postDelayed(this, 16)
            }
        }, 16)
    }

    // ═══════════════════════════════════════════════════════════════
    // [Loading → Running Transition]
    // Removes Loading Overlay layers, activates Running Overlay (waves + bubble)
    // Called by A11y Service after reaching Reels
    // ═══════════════════════════════════════════════════════════════
    private fun doTransitionToRunning() {
        handler.post {
            // Remove loading overlays (black, green, white, black2)
            try { blackOverlay?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
            try { greenOverlay?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
            try { whiteOverlay?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
            try { blackOverlay2?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
            blackOverlay = null
            greenOverlay = null
            whiteOverlay = null
            blackOverlay2 = null

            // Activate wave borders
            val screenWidth = resources.displayMetrics.widthPixels
            val screenHeight = resources.displayMetrics.heightPixels
            val borderWidth = 20

            val waveParams = WindowManager.LayoutParams(
                screenWidth, screenHeight,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT
            )
            waveParams.gravity = Gravity.TOP or Gravity.START

            val wave = WaveBorderView(this, screenWidth, screenHeight, borderWidth)
            waveView = wave
            windowManager?.addView(wave, waveParams)
            startAnimation(wave)

            // Re-add control button on top of waves
            controlButton?.let { btn ->
                try { windowManager?.removeView(btn) } catch (_: Exception) {}
                val btnSize = 120
                val btnParams = WindowManager.LayoutParams(
                    btnSize, btnSize,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                    PixelFormat.TRANSLUCENT
                )
                btnParams.gravity = Gravity.TOP or Gravity.END
                btnParams.y = 60
                windowManager?.addView(btn, btnParams)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        _instance = null
        running = false
        isPaused = false
        handler.removeCallbacksAndMessages(null)
        hideControlPopup()
        try { waveView?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        try { blackOverlay?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        try { greenOverlay?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        try { whiteOverlay?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        try { blackOverlay2?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        try { controlButton?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        waveView = null
        blackOverlay = null
        // greenOverlay removed
        whiteOverlay = null
        blackOverlay2 = null
        controlButton = null
        isShowing = false
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            "southfarm_overlay",
            "SouthFarm Overlay",
            NotificationManager.IMPORTANCE_LOW
        )
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }
}

class ControlButtonView(context: android.content.Context) : View(context) {
    private val circlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xDD1a1a1a.toInt()
        style = Paint.Style.FILL
    }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }
    private val logoBitmap: Bitmap

    init {
        // Load the PNG from drawable resources
        logoBitmap = BitmapFactory.decodeResource(context.resources, R.drawable.sprout_logo)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val r = Math.min(cx, cy) - 4f

        // Dark circle background
        canvas.drawCircle(cx, cy, r, circlePaint)
        // Green border
        canvas.drawCircle(cx, cy, r, borderPaint)

        // Draw the bitmap logo centered and scaled
        val scale = r * 2 / logoBitmap.width.toFloat() * 0.7f // scale to fit inside the circle
        canvas.save()
        canvas.translate(cx - logoBitmap.width * scale / 2, cy - logoBitmap.height * scale / 2)
        canvas.scale(scale, scale)
        canvas.drawBitmap(logoBitmap, 0f, 0f, null)
        canvas.restore()
    }
}

class WaveBorderView(
    context: android.content.Context,
    private val screenWidth: Int,
    private val screenHeight: Int,
    private val borderWidth: Int
) : View(context) {

    private var paused = false

    private val greenPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val greenPaint2 = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.FILL
        isAntiAlias = true
        alpha = 80
    }

    private val orangePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFf97316.toInt()
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val greenGlow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.FILL
        isAntiAlias = true
        maskFilter = BlurMaskFilter(18f, BlurMaskFilter.Blur.NORMAL)
    }

    private val orangeGlow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFf97316.toInt()
        style = Paint.Style.FILL
        isAntiAlias = true
        maskFilter = BlurMaskFilter(18f, BlurMaskFilter.Blur.NORMAL)
    }

    private var offset = 0f
    private val waveAmplitude = 12f
    private val waveFrequency = 0.02f

    fun setPaused(p: Boolean) {
        if (paused != p) {
            paused = p
        }
    }

    fun updateOffset(newOffset: Float) {
        offset = newOffset
        invalidate()
    }

    private fun multiWave(pos: Float, baseOffset: Float): Float {
        return (sin((pos * waveFrequency + baseOffset).toDouble()).toFloat() * waveAmplitude +
                sin((pos * waveFrequency * 1.7f + baseOffset * 0.8f).toDouble()).toFloat() * waveAmplitude * 0.4f)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (paused) {
            drawWave(canvas, orangePaint, null, orangeGlow)
        } else {
            drawWave(canvas, greenPaint, greenPaint2, greenGlow)
        }
    }

    private fun drawWave(canvas: Canvas, paint: Paint, paint2: Paint?, glow: Paint) {
        // Top
        val path = Path()
        path.moveTo(0f, 0f)
        for (x in 0..screenWidth step 2) {
            path.lineTo(x.toFloat(), borderWidth.toFloat() + multiWave(x.toFloat(), offset))
        }
        path.lineTo(screenWidth.toFloat(), 0f)
        path.close()
        canvas.drawPath(path, glow)
        canvas.drawPath(path, paint)
        if (paint2 != null) {
            val path2 = Path()
            path2.moveTo(0f, 0f)
            for (x in 0..screenWidth step 2) {
                path2.lineTo(x.toFloat(), borderWidth.toFloat() + multiWave(x.toFloat(), offset + 0.5f))
            }
            path2.lineTo(screenWidth.toFloat(), 0f)
            path2.close()
            canvas.drawPath(path2, paint2)
        }

        // Bottom
        val bpath = Path()
        bpath.moveTo(0f, screenHeight.toFloat())
        for (x in 0..screenWidth step 2) {
            bpath.lineTo(x.toFloat(), screenHeight.toFloat() - borderWidth - multiWave(x.toFloat(), offset + 1.5f))
        }
        bpath.lineTo(screenWidth.toFloat(), screenHeight.toFloat())
        bpath.close()
        canvas.drawPath(bpath, glow)
        canvas.drawPath(bpath, paint)
        if (paint2 != null) {
            val bpath2 = Path()
            bpath2.moveTo(0f, screenHeight.toFloat())
            for (x in 0..screenWidth step 2) {
                bpath2.lineTo(x.toFloat(), screenHeight.toFloat() - borderWidth - multiWave(x.toFloat(), offset + 2.0f))
            }
            bpath2.lineTo(screenWidth.toFloat(), screenHeight.toFloat())
            bpath2.close()
            canvas.drawPath(bpath2, paint2)
        }

        // Left
        val lpath = Path()
        lpath.moveTo(0f, 0f)
        for (y in 0..screenHeight step 2) {
            lpath.lineTo(borderWidth.toFloat() + multiWave(y.toFloat(), offset + 3f), y.toFloat())
        }
        lpath.lineTo(0f, screenHeight.toFloat())
        lpath.close()
        canvas.drawPath(lpath, glow)
        canvas.drawPath(lpath, paint)
        if (paint2 != null) {
            val lpath2 = Path()
            lpath2.moveTo(0f, 0f)
            for (y in 0..screenHeight step 2) {
                lpath2.lineTo(borderWidth.toFloat() + multiWave(y.toFloat(), offset + 3.5f), y.toFloat())
            }
            lpath2.lineTo(0f, screenHeight.toFloat())
            lpath2.close()
            canvas.drawPath(lpath2, paint2)
        }

        // Right
        val rpath = Path()
        rpath.moveTo(screenWidth.toFloat(), 0f)
        for (y in 0..screenHeight step 2) {
            rpath.lineTo(screenWidth.toFloat() - borderWidth - multiWave(y.toFloat(), offset + 4.5f), y.toFloat())
        }
        rpath.lineTo(screenWidth.toFloat(), screenHeight.toFloat())
        rpath.close()
        canvas.drawPath(rpath, glow)
        canvas.drawPath(rpath, paint)
        if (paint2 != null) {
            val rpath2 = Path()
            rpath2.moveTo(screenWidth.toFloat(), 0f)
            for (y in 0..screenHeight step 2) {
                rpath2.lineTo(screenWidth.toFloat() - borderWidth - multiWave(y.toFloat(), offset + 5.0f), y.toFloat())
            }
            rpath2.lineTo(screenWidth.toFloat(), screenHeight.toFloat())
            rpath2.close()
            canvas.drawPath(rpath2, paint2)
        }
    }
}
