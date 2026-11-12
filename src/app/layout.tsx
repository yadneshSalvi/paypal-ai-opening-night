import type { Metadata } from "next";
import { Inter, Oswald, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./crew.css";
import "./sources.css";
import "./settlement.css";
import "./tour.css";
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const oswald = Oswald({ subsets: ["latin"], variable: "--font-oswald", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
export const metadata: Metadata = { title: "Opening Night — Make tonight happen", description: "A production console for the people, plans, and promises behind a live show. Controlled sandbox rehearsal." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={`${inter.variable} ${oswald.variable} ${mono.variable}`}><body><a className="skip-link" href="#main">Skip to production</a>{children}</body></html>;
}
