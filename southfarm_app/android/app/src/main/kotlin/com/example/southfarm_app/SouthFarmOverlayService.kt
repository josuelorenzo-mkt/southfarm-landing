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
    }

    private var windowManager: WindowManager? = null
    private var waveView: WaveBorderView? = null
    private var controlButton: View? = null
    private var popupView: View? = null
    private val handler = Handler(Looper.getMainLooper())
    private var animOffset = 0f
    private var running = true

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notification = Notification.Builder(this, "southfarm_overlay")
            .setContentTitle("SouthFarm")
            .setContentText("Warmup en progreso...")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .build()
        startForeground(1001, notification)
        showOverlay()
    }

    private fun showOverlay() {
        if (isShowing) return
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager

        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        val borderWidth = 20

        // Wave borders — NOT touchable, purely visual
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

        isShowing = true
        startAnimation(wave)
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
        card.setPadding(48, 40, 48, 40)
        card.setBackgroundColor(0xFF1a1a1a.toInt())
        card.gravity = Gravity.CENTER

        val cardParams = FrameLayout.LayoutParams(
            (screenWidth * 0.75).toInt(),
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

        // Continue button
        val continueBtn = createButton("Continuar", 0xFF34d399.toInt(), Color.BLACK) {
            hideControlPopup()
            if (isPaused) {
                isPaused = false
                SouthFarmAccessibilityService.resumeWarmupStatic()
            }
        }
        btnRow.addView(continueBtn)

        // Pause/Resume button
        val pauseBtn = if (isPaused) {
            createButton("Reanudar", 0xFF3b82f6.toInt(), Color.WHITE) {
                isPaused = false
                SouthFarmAccessibilityService.resumeWarmupStatic()
                hideControlPopup()
            }
        } else {
            createButton("Pausar", 0xFFf97316.toInt(), Color.WHITE) {
                isPaused = true
                SouthFarmAccessibilityService.pauseWarmupStatic()
                hideControlPopup()
            }
        }
        val pauseParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
        pauseParams.setMargins(12, 0, 0, 0)
        pauseBtn.layoutParams = pauseParams
        btnRow.addView(pauseBtn)

        // Stop button
        val stopBtn = createButton("Detener", 0xFFef4444.toInt(), Color.WHITE) {
            SouthFarmAccessibilityService.stopWarmupStatic()
            hideControlPopup()
            stopSelf()
        }
        val stopParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
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
            setBackgroundColor(bgColor.toInt())
            textSize = 14f
            setPadding(24, 12, 24, 12)
            setOnClickListener { onClick() }
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

    override fun onDestroy() {
        super.onDestroy()
        running = false
        isPaused = false
        handler.removeCallbacksAndMessages(null)
        hideControlPopup()
        try { waveView?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        try { controlButton?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        waveView = null
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
    private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 4f
        strokeCap = Paint.Cap.ROUND
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val r = Math.min(cx, cy) - 4f

        // Dark circle background
        canvas.drawCircle(cx, cy, r, circlePaint)

        // Small SouthFarm icon (play-like triangle)
        val s = r * 0.5f
        val path = Path()
        path.moveTo(cx - s * 0.4f, cy - s)
        path.lineTo(cx + s * 0.7f, cy)
        path.lineTo(cx - s * 0.4f, cy + s)
        path.close()
        canvas.drawPath(path, iconPaint)
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
