"use client";
import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Moon, Sun } from "lucide-react";
import { THEME_ATTRIBUTE, THEME_EVENT, THEME_STORAGE_KEY, applyTheme, currentTheme, readStoredTheme, resolveTheme, storeTheme, themedRoute, type ThemeName } from "./theme";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });
  return () => observer.disconnect();
}
/** The theme currently painted. Charts and other canvas renderers re-read their colours when it changes. */
export function useThemeName(): ThemeName { return useSyncExternalStore(subscribe, () => currentTheme(), () => "dark"); }

/**
 * Mounted once in the root layout. Keeps <html> in step with the stored choice across client navigation and
 * other tabs, and returns non-console pages to their own theme.
 */
export function ThemeRoute() {
  const pathname = usePathname() ?? "/";
  useEffect(() => {
    const sync = () => applyTheme(resolveTheme(readStoredTheme(), pathname));
    const stored = (event: StorageEvent) => { if (event.key === null || event.key === THEME_STORAGE_KEY) sync(); };
    sync(); window.addEventListener("storage", stored); window.addEventListener(THEME_EVENT, sync);
    return () => { window.removeEventListener("storage", stored); window.removeEventListener(THEME_EVENT, sync); };
  }, [pathname]);
  return null;
}

/** A two-state switch. The choice is saved in this browser only; when storage is unavailable it lasts for the page. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useThemeName(), pathname = usePathname() ?? "/", available = themedRoute(pathname), light = theme === "light";
  const choose = () => {
    const next: ThemeName = light ? "dark" : "light";
    storeTheme(next); applyTheme(resolveTheme(next, pathname)); window.dispatchEvent(new Event(THEME_EVENT));
  };
  return <button type="button" role="switch" aria-checked={light} className={`theme-toggle ${className}`.trim()} onClick={choose} disabled={!available} title={available ? "Switch between the dark and light operational themes" : "This page keeps its own theme"}>
    <span className="theme-toggle-track" aria-hidden="true"><span className="theme-toggle-thumb">{light ? <Sun size={11} /> : <Moon size={11} />}</span></span>
    <span className="theme-toggle-label">Light theme</span>
    <span className="theme-toggle-state" aria-hidden="true">{light ? "On" : "Off"}</span>
  </button>;
}
