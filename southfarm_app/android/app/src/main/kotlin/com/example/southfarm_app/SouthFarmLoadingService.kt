package com.example.southfarm_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.*
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import kotlin.math.sin

/**
 * SouthFarmLoadingService — [Loading Overlay] UI layer
 *
 * Shows the professional loading screen ON TOP of the overlay layers:
 *   - Logo sprout (breathing animation)
 *   - Status text (changes per step)
 *   - Circular spinner (CircularProgressView)
 *   - 3-step progress bar with bubbles (StepProgressBar)
 *
 * USED BY:
 *   - Warmup: "Preparing warmup" → "Setting up account" → "Launching warmup"
 *   - Scan: "Scanning app" → "Detecting profiles" → "Saving info"
 *
 * FLOWS:
 *   - Warmup: Loading → Running (transitionToRunning keeps overlay, swaps layers)
 *   - Scan: Loading → Done (overlay fully removed, returns to app)
 */
class SouthFarmLoadingService : Service() {

    companion object {
        var isRunning = false
            private set
        private var instance: SouthFarmLoadingService? = null
        private var initialTextOverride: String? = null

        fun setInitialText(text: String) {
            initialTextOverride = text
        }

        fun showLoading(text: String) {
            instance?.updateLoadingText(text)
        }

        fun dismissLoading() {
            instance?.dismissLoadingOverlay()
        }
    }

    private var windowManager: WindowManager? = null
    private var loadingView: View? = null
    private var statusText: TextView? = null
    private var logoView: ImageView? = null
    private var progressBar: StepProgressBar? = null
    private var spinner: CircularProgressView? = null
    private var currentStep = 0
    private var waveHelper: LoadingWaveHelper? = null
    private val handler = Handler(Looper.getMainLooper())
    private var animOffset = 0f
    private var running = true

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        instance = this
        val initialText = initialTextOverride ?: SfStrings.s(this, "Preparing warmup...")
        initialTextOverride = null
        createNotificationChannel()
        val notification = Notification.Builder(this, "southfarm_loading")
            .setContentTitle("SouthFarm")
            .setContentText(initialText)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .build()
        startForeground(1002, notification)
        showLoadingOverlay(initialText)
    }

    private fun showLoadingOverlay(initialText: String) {
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels

        // Create a solid color bitmap for the background
        val bgBitmap = Bitmap.createBitmap(screenWidth, screenHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bgBitmap)
        canvas.drawColor(Color.BLACK) // Solid black
        val bgImageView = ImageView(this)
        bgImageView.setImageBitmap(bgBitmap)
        bgImageView.scaleType = ImageView.ScaleType.FIT_XY
        val bgParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        )

        // Full screen container
        val container = FrameLayout(this)
        container.addView(bgImageView, bgParams)

        // Wave border view
        val waveView = LoadingWaveBorderView(this, screenWidth, screenHeight, 24)
        waveHelper = LoadingWaveHelper(waveView)

        // Logo
        val logo = ImageView(this)
        val logoBitmap = BitmapFactory.decodeResource(resources, R.drawable.sprout_logo)
        logo.setImageBitmap(logoBitmap)
        val logoSize = (Math.min(screenWidth, screenHeight) * 0.2).toInt()
        val logoParams = FrameLayout.LayoutParams(logoSize, logoSize)
        logoParams.gravity = Gravity.CENTER_HORIZONTAL
        logo.scaleType = ImageView.ScaleType.FIT_CENTER
        logoView = logo

        // Status text
        val text = TextView(this)
        text.text = initialText
        text.setTextColor(Color.WHITE)
        text.textSize = 16f
        text.setTypeface(null, android.graphics.Typeface.BOLD)
        text.gravity = Gravity.CENTER
        val textParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        )
        textParams.gravity = Gravity.CENTER_HORIZONTAL
        textParams.topMargin = logoSize + 32
        statusText = text

        // Circular progress spinner
        val spinnerSize = (Math.min(screenWidth, screenHeight) * 0.12).toInt()
        val spinnerView = CircularProgressView(this)
        val spinnerParams = FrameLayout.LayoutParams(spinnerSize, spinnerSize)
        spinnerParams.gravity = Gravity.CENTER_HORIZONTAL
        spinnerParams.topMargin = logoSize + 72

        // Progress bar (3-step)
        val barWidth = (screenWidth * 0.6).toInt()
        val barHeight = 6
        val progressView = StepProgressBar(this, barWidth, barHeight)
        currentStep = 0
        // Step 1 delayed 500ms after screen appears
        handler.postDelayed({
            currentStep = 1
            progressView.setStep(1)
        }, 500)
        val barParams = FrameLayout.LayoutParams(barWidth, 80)
        barParams.gravity = Gravity.CENTER_HORIZONTAL
        barParams.topMargin = logoSize + 72 + spinnerSize + 20

        // Assemble
        val contentWrapper = FrameLayout(this)
        contentWrapper.addView(logo, logoParams)
        contentWrapper.addView(text, textParams)
        contentWrapper.addView(spinnerView, spinnerParams)
        contentWrapper.addView(progressView, barParams)
        val wrapperParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        )
        wrapperParams.gravity = Gravity.CENTER

        container.addView(waveView)
        container.addView(contentWrapper, wrapperParams)
        // Keep the custom loading window out of the accessibility tree so the
        // service can continue reading Instagram behind the visual overlay.
        container.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        container.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        // Window params — full screen, on top of everything
        val params = WindowManager.LayoutParams(
            screenWidth, screenHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.OPAQUE
        )
        params.gravity = Gravity.TOP or Gravity.START

        loadingView = container
        windowManager?.addView(container, params)

        this.progressBar = progressView
        this.spinner = spinnerView

        // Start animations
        startAnimations(logo, waveView)
    }

    fun updateLoadingText(text: String) {
        handler.post {
            statusText?.text = text
            currentStep++
            android.util.Log.e("SouthFarmLoading", "updateLoadingText: step=$currentStep text=$text progressBar=${progressBar != null}")
            progressBar?.setStep(currentStep)
        }
    }

    fun dismissLoadingOverlay() {
        handler.post {
            try {
                loadingView?.let { view ->
                    try { windowManager?.removeView(view) } catch (_: Exception) {}
                    loadingView = null
                    stopSelf()
                }
            } catch (_: Exception) {}
        }
    }

    private fun startAnimations(logo: ImageView, waveView: LoadingWaveBorderView) {
        // Breathing animation for logo
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (!running) return
                val scale = 1.0f + 0.06f * sin(animOffset * 0.8).toFloat()
                logo.scaleX = scale
                logo.scaleY = scale
                handler.postDelayed(this, 16)
            }
        }, 16)

        // Wave animation
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (!running) return
                animOffset += 0.06f
                waveView.updateOffset(animOffset)
                handler.postDelayed(this, 16)
            }
        }, 16)
    }

    override fun onDestroy() {
        super.onDestroy()
        running = false
        handler.removeCallbacksAndMessages(null)
        try { loadingView?.let { windowManager?.removeView(it) } } catch (_: Exception) {}
        loadingView = null
        isRunning = false
        instance = null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            "southfarm_loading",
            "SouthFarm Loading",
            NotificationManager.IMPORTANCE_LOW
        )
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }
}

class LoadingWaveHelper(private val view: LoadingWaveBorderView) {
    fun update(offset: Float) = view.updateOffset(offset)
}

class LoadingWaveBorderView(
    context: android.content.Context,
    private val screenWidth: Int,
    private val screenHeight: Int,
    private val borderWidth: Int
) : View(context) {

    private val greenPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.FILL
    }

    private val greenPaint2 = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.FILL
        alpha = 60
    }

    private val greenGlow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.FILL
        maskFilter = BlurMaskFilter(20f, BlurMaskFilter.Blur.NORMAL)
    }

    private var offset = 0f
    private val waveAmplitude = 14f
    private val waveFrequency = 0.02f

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
        // Draw waves on all 4 edges (matching warmup overlay style)
        drawEdge(canvas, greenPaint, greenPaint2, greenGlow, isTop = true)
        drawEdge(canvas, greenPaint, greenPaint2, greenGlow, isTop = false)
        drawEdgeSide(canvas, greenPaint, greenPaint2, greenGlow, isLeft = true)
        drawEdgeSide(canvas, greenPaint, greenPaint2, greenGlow, isLeft = false)
    }

    private fun drawEdge(canvas: Canvas, paint: Paint, paint2: Paint, glow: Paint, isTop: Boolean) {
        val yBase = if (isTop) 0f else screenHeight.toFloat()
        val yDir = if (isTop) 1f else -1f
        val off = if (isTop) offset else offset + 1.5f

        val path = Path()
        path.moveTo(0f, yBase)
        for (x in 0..screenWidth step 2) {
            path.lineTo(x.toFloat(), yBase + yDir * (borderWidth + multiWave(x.toFloat(), off)))
        }
        path.lineTo(screenWidth.toFloat(), yBase)
        path.close()
        canvas.drawPath(path, glow)
        canvas.drawPath(path, paint)

        val path2 = Path()
        path2.moveTo(0f, yBase)
        for (x in 0..screenWidth step 2) {
            path2.lineTo(x.toFloat(), yBase + yDir * (borderWidth + multiWave(x.toFloat(), off + 0.5f)))
        }
        path2.lineTo(screenWidth.toFloat(), yBase)
        path2.close()
        canvas.drawPath(path2, paint2)
    }

    private fun drawEdgeSide(canvas: Canvas, paint: Paint, paint2: Paint, glow: Paint, isLeft: Boolean) {
        val xBase = if (isLeft) 0f else screenWidth.toFloat()
        val xDir = if (isLeft) 1f else -1f
        val off = if (isLeft) offset + 3f else offset + 4.5f

        val path = Path()
        path.moveTo(xBase, 0f)
        for (y in 0..screenHeight step 2) {
            path.lineTo(xBase + xDir * (borderWidth + multiWave(y.toFloat(), off)), y.toFloat())
        }
        path.lineTo(xBase, screenHeight.toFloat())
        path.close()
        canvas.drawPath(path, glow)
        canvas.drawPath(path, paint)

        val path2 = Path()
        path2.moveTo(xBase, 0f)
        for (y in 0..screenHeight step 2) {
            path2.lineTo(xBase + xDir * (borderWidth + multiWave(y.toFloat(), off + 0.5f)), y.toFloat())
        }
        path2.lineTo(xBase, screenHeight.toFloat())
        path2.close()
        canvas.drawPath(path2, paint2)
    }
}

class CircularProgressView(context: android.content.Context) : View(context) {
    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 6f
        strokeCap = Paint.Cap.ROUND
    }
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x3334d399.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 6f
    }
    private var angle = 0f
    private val handler = Handler(Looper.getMainLooper())
    private var running = true

    init {
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (!running) return
                angle = (angle + 6f) % 360f
                invalidate()
                handler.postDelayed(this, 16)
            }
        }, 16)
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        running = false
        handler.removeCallbacksAndMessages(null)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val r = Math.min(cx, cy) - 8f
        // Background circle
        canvas.drawCircle(cx, cy, r, bgPaint)
        // Animated arc
        val sweep = 120f
        canvas.drawArc(cx - r, cy - r, cx + r, cy + r, angle, sweep, false, arcPaint)
    }
}

class StepProgressBar(
    context: android.content.Context,
    private val barWidth: Int,
    private val barHeight: Int
) : View(context) {
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x33FFFFFF.toInt()
        style = Paint.Style.FILL
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.FILL
    }
    private val dotR = 20f
    private val dotBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        style = Paint.Style.FILL
    }
    private val dotBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF34d399.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }
    private val dotEmptyBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x66FFFFFF.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }
    private var step = 0
    private var pendingStep = 0
    // Progress: 0..1
    private var animProgress = 0f
    private val handler = Handler(Looper.getMainLooper())
    private var running = true

    private fun targetForStep(s: Int): Float = when (s) {
        0 -> 0f
        1 -> 0.3f
        2 -> 0.7f
        else -> 1.0f
    }

    init {
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (!running) return
                // Only advance, never go back
                if (pendingStep > step) {
                    step = pendingStep
                }
                val target = targetForStep(step)
                if (animProgress < target) {
                    animProgress = (animProgress + 0.015f).coerceAtMost(target)
                    invalidate()
                }
                handler.postDelayed(this, 16)
            }
        }, 16)
    }

    fun setStep(s: Int) {
        android.util.Log.e("StepProgressBar", "setStep: pendingStep=$s current step=$step animProgress=$animProgress")
        pendingStep = s
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        running = false
        handler.removeCallbacksAndMessages(null)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val padding = 40f
        val effectiveWidth = barWidth - padding * 2
        // Center vertically in the view — use dotR as top padding so nothing clips
        val y = dotR + 4f

        // 3 dot positions
        val x0 = padding
        val x1 = padding + effectiveWidth * 0.5f
        val x2 = padding + effectiveWidth
        val dots = floatArrayOf(x0, x1, x2)

        // Background line segments between dots
        for (i in 0..1) {
            val left = dots[i] + dotR + 2f
            val right = dots[i + 1] - dotR - 2f
            if (right > left) {
                val rect = android.graphics.RectF(left, y - barHeight / 2f, right, y + barHeight / 2f)
                canvas.drawRoundRect(rect, barHeight / 2f, barHeight / 2f, bgPaint)
            }
        }

        // Fill line — from dot0 to animProgress position along the full bar
        if (animProgress > 0f) {
            val fillEnd = padding + effectiveWidth * animProgress
            // Segment 0->1
            val left0 = dots[0] + dotR + 2f
            val right0 = dots[1] - dotR - 2f
            if (fillEnd > left0) {
                val fillRight0 = fillEnd.coerceAtMost(right0)
                if (fillRight0 > left0) {
                    val rect = android.graphics.RectF(left0, y - barHeight / 2f, fillRight0, y + barHeight / 2f)
                    canvas.drawRoundRect(rect, barHeight / 2f, barHeight / 2f, fillPaint)
                }
            }
            // Segment 1->2
            if (animProgress > 0.5f) {
                val left1 = dots[1] + dotR + 2f
                val right1 = dots[2] - dotR - 2f
                val fillRight1 = fillEnd.coerceAtMost(right1)
                if (fillRight1 > left1) {
                    val rect = android.graphics.RectF(left1, y - barHeight / 2f, fillRight1, y + barHeight / 2f)
                    canvas.drawRoundRect(rect, barHeight / 2f, barHeight / 2f, fillPaint)
                }
            }
        }

        // 3 dots — opaque black bg + colored border
        for (i in 0..2) {
            val x = dots[i]
            val filled = i < step
            canvas.drawCircle(x, y, dotR, dotBgPaint)
            canvas.drawCircle(x, y, dotR, if (filled) dotBorderPaint else dotEmptyBorderPaint)
            if (filled) {
                val checkPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = 0xFF34d399.toInt()
                    style = Paint.Style.STROKE
                    strokeWidth = 3f
                    strokeCap = Paint.Cap.ROUND
                }
                canvas.drawLine(x - 6f, y, x - 1.5f, y + 6f, checkPaint)
                canvas.drawLine(x - 1.5f, y + 6f, x + 7f, y - 6f, checkPaint)
            }
        }
    }
}
