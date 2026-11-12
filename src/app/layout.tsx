import type { Metadata } from "next";
import { Inter, Oswald, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./crew.css";
import "./sources.css";
import "./settlement.css";
import "./tour.css";
import "./disruptions.css";
import "./rental-closeout.css";
import "./supplier-recovery.css";
import { THEME_BOOT_SCRIPT } from "@/components/theme";
import { ThemeRoute } from "@/components/theme-toggle";
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const oswald = Oswald({ subsets: ["latin"], variable: "--font-oswald", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
export const metadata: Metadata = { title: "Opening Night — Make tonight happen", description: "A production console for the people, plans, and promises behind a live show. Controlled sandbox rehearsal." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The stored theme is applied before first paint by a static inline script (no cookie or header read, so static
  // routes stay static). suppressHydrationWarning covers only the attribute that script may change on <html>.
  return <html lang="en" data-theme="dark" suppressHydrationWarning className={`${inter.variable} ${oswald.variable} ${mono.variable}`}><head><script id="opening-night-theme" dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} /></head><body><a className="skip-link" href="#main">Skip to production</a><ThemeRoute />{children}</body></html>;
}
