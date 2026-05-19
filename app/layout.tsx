import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SouthFarm — Automatización Móvil",
  description: "Automatizá tu teléfono. Sin root. Sin complicaciones. Descargá la app.",
  openGraph: {
    title: "SouthFarm — Automatización Móvil",
    description: "Automatizá tu teléfono. Sin root. Sin complicaciones.",
    url: "https://southfarm.tech",
    siteName: "SouthFarm",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
