package com.example.southfarm_app

import android.content.Context
import java.util.Locale

/**
 * Kotlin-side strings for the overlay surfaces (control bubble popup,
 * loading screen, warmup notifications). These views are drawn directly by
 * Android services, so they cannot use the Flutter t() helper.
 *
 * The language choice is read from the same SharedPreferences entry the
 * Flutter side writes (flutter.app_language: 'system' | 'en' | 'es' | 'pt').
 * 'system' resolves against the device locale, falling back to English when
 * the system language is not shipped.
 */
object SfStrings {
    private const val PREFS_NAME = "FlutterSharedPreferences"
    private const val PREF_KEY = "flutter.app_language"

    private fun resolve(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val choice = prefs.getString(PREF_KEY, "system") ?: "system"
        if (choice != "system") return choice
        val sys = Locale.getDefault().language.lowercase()
        return if (sys == "es" || sys == "pt") sys else "en"
    }

    /** Translates [key] (English source) for the active language. {n} slots
     *  are filled from [args] in order; missing keys fall back to English. */
    fun s(context: Context, key: String, vararg args: String): String {
        val lang = resolve(context)
        val table = translations[lang]
        var text = table?.get(key) ?: key
        for (arg in args) {
            text = text.replaceFirst("{n}", arg)
        }
        return text
    }

    private val translations = mapOf(
        "es" to mapOf(
            // Loading overlay
            "Preparing warmup..." to "Preparando warmup...",
            "Setting up account..." to "Configurando cuenta...",
            "Launching warmup..." to "Lanzando warmup...",
            "Resuming Instagram warmup..." to "Reanudando warmup de Instagram...",
            "Resuming TikTok warmup..." to "Reanudando warmup de TikTok...",
            "Resuming YouTube warmup..." to "Reanudando warmup de YouTube...",
            "Preparing TikTok warmup..." to "Preparando warmup de TikTok...",
            "Setting up TikTok account..." to "Configurando cuenta de TikTok...",
            "Launching TikTok warmup..." to "Lanzando warmup de TikTok...",
            "Preparing YouTube warmup..." to "Preparando warmup de YouTube...",
            "Setting up YouTube channel..." to "Configurando canal de YouTube...",
            "Launching YouTube Shorts warmup..." to "Lanzando warmup de YouTube Shorts...",
            "Checking {n}..." to "Verificando {n}...",
            "Detecting profiles..." to "Detectando perfiles...",
            "Detecting TikTok profiles..." to "Detectando perfiles de TikTok...",
            "Detecting YouTube channels..." to "Detectando canales de YouTube...",
            "Scanning app..." to "Escaneando app...",
            "Scanning TikTok..." to "Escaneando TikTok...",
            "Scanning YouTube channels..." to "Escaneando canales de YouTube...",
            "Saving info..." to "Guardando información...",
            "Could not open Instagram" to "No se pudo abrir Instagram",
            "Could not switch account" to "No se pudo cambiar de cuenta",
            "Could not open TikTok" to "No se pudo abrir TikTok",
            "Could not switch TikTok account" to "No se pudo cambiar de cuenta de TikTok",
            "Could not open For You" to "No se pudo abrir For You",
            "Could not open Shorts" to "No se pudo abrir Shorts",
            "Could not open YouTube" to "No se pudo abrir YouTube",
            "Could not switch YouTube channel" to "No se pudo cambiar de canal de YouTube",
            // Control bubble popup
            "Warmup in progress..." to "Warmup en progreso...",
            "⏸ Paused" to "⏸ Pausado",
            "▶️ In progress" to "▶️ En progreso",
            "▶ Resume" to "▶ Reanudar",
            "⏸ Pause" to "⏸ Pausar",
            "⏹ Stop" to "⏹ Detener",
        ),
        "pt" to mapOf(
            // Loading overlay
            "Preparing warmup..." to "Preparando warmup...",
            "Setting up account..." to "Configurando conta...",
            "Launching warmup..." to "Iniciando warmup...",
            "Resuming Instagram warmup..." to "Retomando warmup do Instagram...",
            "Resuming TikTok warmup..." to "Retomando warmup do TikTok...",
            "Resuming YouTube warmup..." to "Retomando warmup do YouTube...",
            "Preparing TikTok warmup..." to "Preparando warmup do TikTok...",
            "Setting up TikTok account..." to "Configurando conta do TikTok...",
            "Launching TikTok warmup..." to "Iniciando warmup do TikTok...",
            "Preparing YouTube warmup..." to "Preparando warmup do YouTube...",
            "Setting up YouTube channel..." to "Configurando canal do YouTube...",
            "Launching YouTube Shorts warmup..." to "Iniciando warmup do YouTube Shorts...",
            "Checking {n}..." to "Verificando {n}...",
            "Detecting profiles..." to "Detectando perfis...",
            "Detecting TikTok profiles..." to "Detectando perfis do TikTok...",
            "Detecting YouTube channels..." to "Detectando canais do YouTube...",
            "Scanning app..." to "Escaneando app...",
            "Scanning TikTok..." to "Escaneando TikTok...",
            "Scanning YouTube channels..." to "Escaneando canais do YouTube...",
            "Saving info..." to "Salvando informações...",
            "Could not open Instagram" to "Não foi possível abrir o Instagram",
            "Could not switch account" to "Não foi possível trocar de conta",
            "Could not open TikTok" to "Não foi possível abrir o TikTok",
            "Could not switch TikTok account" to "Não foi possível trocar de conta do TikTok",
            "Could not open For You" to "Não foi possível abrir o For You",
            "Could not open Shorts" to "Não foi possível abrir o Shorts",
            "Could not open YouTube" to "Não foi possível abrir o YouTube",
            "Could not switch YouTube channel" to "Não foi possível trocar de canal do YouTube",
            // Control bubble popup
            "Warmup in progress..." to "Warmup em andamento...",
            "⏸ Paused" to "⏸ Pausado",
            "▶️ In progress" to "▶️ Em andamento",
            "▶ Resume" to "▶ Retomar",
            "⏸ Pause" to "⏸ Pausar",
            "⏹ Stop" to "⏹ Parar",
        ),
    )
}
