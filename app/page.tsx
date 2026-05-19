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

  if (!mounted) return null;

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center px-6">
      {/* Logo / Brand */}
      <div className="mb-8 text-center">
        <h1 className="text-5xl font-bold tracking-tight mb-2">
          <span className="text-green-400">South</span>Farm
        </h1>
        <p className="text-zinc-400 text-lg">Automatización móvil, simplificada.</p>
      </div>

      {/* Android */}
      {isAndroid && (
        <div className="flex flex-col items-center gap-6 animate-fade-in">
          <p className="text-zinc-300 text-center max-w-md">
            Descargá la app y empezá a automatizar en segundos.
          </p>
          <a
            href="/southfarm.apk"
            download
            className="bg-green-500 hover:bg-green-400 text-black font-semibold text-lg px-10 py-4 rounded-2xl transition-all shadow-lg shadow-green-500/20 active:scale-95"
          >
            ↓ Descargar APK
          </a>
          <p className="text-zinc-500 text-sm text-center max-w-xs">
            Si tu navegador bloquea la descarga, tocá los 3 puntos → "Descargar de todos modos"
          </p>
          <InstallGuide />
        </div>
      )}

      {/* iOS */}
      {isIOS && (
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          <p className="text-zinc-300 text-center max-w-md">
            iOS está en camino. Dejanos tu email y te avisamos.
          </p>
          <WaitlistForm />
        </div>
      )}

      {/* Desktop */}
      {!isAndroid && !isIOS && (
        <div className="flex flex-col items-center gap-6 animate-fade-in">
          <p className="text-zinc-300 text-center max-w-md">
            Escaneá este QR desde tu celular Android para descargar la app.
          </p>
          <div className="bg-white p-4 rounded-2xl">
            <QRCode size={200} />
          </div>
          <p className="text-zinc-500 text-sm">O visitá <span className="text-green-400">southfarm.tech</span> desde tu celular</p>
        </div>
      )}

      {/* Footer */}
      <footer className="absolute bottom-6 text-zinc-600 text-sm">
        © 2026 SouthFarm
      </footer>
    </main>
  );
}

function InstallGuide() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-4 w-full max-w-sm">
      <button
        onClick={() => setOpen(!open)}
        className="text-zinc-400 text-sm underline underline-offset-4 hover:text-zinc-300"
      >
        ¿No podés instalar? Guía rápida ↓
      </button>
      {open && (
        <div className="mt-3 bg-zinc-900 rounded-xl p-4 text-sm text-zinc-300 space-y-2">
          <p><strong>1.</strong> Abrí el APK descargado</p>
          <p><strong>2.</strong> Si te dice "instalación bloqueada", tocá <em>Configuración</em></p>
          <p><strong>3.</strong> Activá <em>"Permitir desde esta fuente"</em></p>
          <p><strong>4.</strong> Volvé atrás e instalá ✓</p>
        </div>
      )}
    </div>
  );
}

function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  return sent ? (
    <p className="text-green-400 font-medium">¡Anotado! Te avisamos cuando esté listo 🎉</p>
  ) : (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSent(true);
      }}
      className="flex gap-2"
    >
      <input
        type="email"
        required
        placeholder="tu@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-green-500"
      />
      <button
        type="submit"
        className="bg-green-500 hover:bg-green-400 text-black font-semibold px-6 py-3 rounded-xl transition-all"
      >
        Avisame
      </button>
    </form>
  );
}

function QRCode({ size }: { size: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <QRCodeSVG value="https://southfarm.tech" size={size} bgColor="white" fgColor="#0a0a0a" />;
}
