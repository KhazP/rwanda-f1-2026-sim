import type { Metadata } from "next";
import { Titillium_Web, Orbitron, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const titillium = Titillium_Web({
  subsets: ["latin"],
  weight: ["400", "600", "700", "900"],
  style: ["normal", "italic"],
  variable: "--font-titillium",
});

const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["700", "800", "900"],
  variable: "--font-orbitron",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "FORMULA 1 VISIT RWANDA GRAND PRIX 2029 — F1TV 2026 Simulator",
  description:
    "Interactive 3D Formula 1 2026 simulator for the FIA Grade 1 Rwanda International Circuit (5.302 km, 18 turns, 50m elevation delta, 1,400m altitude, ≈330 km/h top speed).",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${titillium.variable} ${orbitron.variable} ${jetbrainsMono.variable}`}
    >
      <body className="antialiased selection:bg-[#E10600] selection:text-white">
        {children}
      </body>
    </html>
  );
}

