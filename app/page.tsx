"use client";

import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";

export default function Home() {
  const [isAndroid, setIsAndroid] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    setIsAndroid(ua.includes("android"));
    setIsIOS(/iphone|ipad|ipod/.test(ua));
    setMounted(true);
  }, []);

  if (!mounted)
    return (
      <main className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
      </main>
    );

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white flex flex-col">
      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="text-center mb-10 animate-fade-in">
          {/* Icon */}
          <div className="w-20 h-20 bg-green-500/10 rounded-3xl flex items-center justify-center mx-auto mb-6 border border-green-500/20">
            <svg className="w-10 h-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
            </svg>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-3">
            <span className="text-green-400">South</span>Farm
          </h1>
          <p className="text-zinc-400 text-lg max-w-md mx-auto">
            Automatizá tu teléfono. Sin root. Sin complicaciones.
          </p>
        </div>

        {/* Platform-specific CTA */}
        {isAndroid && <AndroidDownload />}
        {isIOS && <IOSWaitlist />}
        {!isAndroid && !isIOS && <DesktopQR />}
      </section>

      {/* Features */}
      <section className="border-t border-zinc-800/50 px-6 py-12">
        <div className="max-w-2xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
          <Feature icon="⚡" title="Rápido" desc="3 taps y listo" />
          <Feature icon="🔒" title="Seguro" desc="Sin root, sin riesgos" />
          <Feature icon="🤖" title="Automático" desc="Configurá y olvidate" />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 px-6 py-6 text-center">
        <p className="text-zinc-600 text-sm">© 2026 SouthFarm · southfarm.tech</p>
      </footer>
    </main>
  );
}

function AndroidDownload() {
  const [showGuide, setShowGuide] = useState(false);

  return (
    <div className="flex flex-col items-center gap-6 animate-fade-in">
      <a
        href="/southfarm.apk"
        download
        className="bg-green-500 hover:bg-green-400 text-black font-bold text-lg px-12 py-4 rounded-2xl transition-all shadow-lg shadow-green-500/25 active:scale-95 flex items-center gap-2"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
        Descargar App
      </a>
      <p className="text-zinc-500 text-sm">v0.1 · ~2 MB · Android 8+</p>
      <button
        onClick={() => setShowGuide(!showGuide)}
        className="text-zinc-500 text-sm hover:text-zinc-300 transition-colors"
      >
        ¿Problemas para instalar? {showGuide ? "↑" : "↓"}
      </button>
      {showGuide && (
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-5 text-sm text-zinc-300 space-y-3 max-w-sm animate-fade-in">
          <p className="font-medium text-zinc-100">Guía de instalación:</p>
          <Step n={1} text="Tocá el botón para descargar el APK" />
          <Step n={2} text="Abrí el archivo descargado" />
          <Step n={3} text="Si te pide permiso, activá «Permitir desde esta fuente»" />
          <Step n={4} text="Instalá y abrí la app ✓" />
        </div>
      )}
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="bg-green-500/20 text-green-400 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shrink-0">
        {n}
      </span>
      <p>{text}</p>
    </div>
  );
}

function IOSWaitlist() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  return sent ? (
    <div className="animate-fade-in text-center">
      <p className="text-green-400 font-medium text-lg">¡Anotado! Te avisamos cuando esté listo 🎉</p>
    </div>
  ) : (
    <form
      onSubmit={(e) => { e.preventDefault(); setSent(true); }}
      className="flex flex-col sm:flex-row gap-3 animate-fade-in"
    >
      <input
        type="email"
        required
        placeholder="tu@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:border-green-500 transition-colors w-full sm:w-64"
      />
      <button
        type="submit"
        className="bg-green-500 hover:bg-green-400 text-black font-semibold px-6 py-3 rounded-xl transition-all"
      >
        Avisame cuando salga
      </button>
    </form>
  );
}

function DesktopQR() {
  return (
    <div className="flex flex-col items-center gap-5 animate-fade-in">
      <p className="text-zinc-400 text-center">
        Escaneá con tu celular Android
      </p>
      <div className="bg-white p-4 rounded-2xl shadow-lg shadow-black/20">
        <QRCodeSVG value="https://southfarm.tech" size={180} bgColor="white" fgColor="#0a0a0a" />
      </div>
      <p className="text-zinc-600 text-sm">O visitá <span className="text-green-400 font-medium">southfarm.tech</span> desde tu celular</p>
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-2xl">{icon}</span>
      <h3 className="font-medium text-zinc-200">{title}</h3>
      <p className="text-zinc-500 text-sm">{desc}</p>
    </div>
  );
}
