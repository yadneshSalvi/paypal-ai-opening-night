/**
 * Operational theme: pure rules shared by the pre-paint boot script, the route guard and the toggle.
 *
 * Dark is the default and the art direction. Light is an explicit, per-browser choice and applies only to the
 * production console views. Crew, attendee, supplier, approval and evaluation pages keep their own themes.
 * The theme is one attribute on <html>; globals.css maps it to `color-scheme`, which switches every
 * `light-dark()` colour in the console and in the Bryntum 8 Svalbard theme together.
 */
export type ThemeName = "dark" | "light";
export const THEME_STORAGE_KEY = "opening-night:theme";
export const THEME_ATTRIBUTE = "data-theme";
export const THEME_EVENT = "opening-night:theme";
/** Console views served by the catch-all route. `/crew/access` and other access pages do not match. */
export const THEMED_ROUTE = /^\/(?:show|plan|sources|resources|calendar|recovery|disruptions|execution|crew|box-office|rentals|wrap|evidence|tour)?\/?$/;

export const themedRoute = (pathname: string) => THEMED_ROUTE.test(pathname);
export const parseTheme = (value: unknown): ThemeName => value === "light" ? "light" : "dark";
/** A stored preference never applies outside the console, and anything unreadable means dark. */
export function resolveTheme(stored: unknown, pathname: string): ThemeName { return themedRoute(pathname) ? parseTheme(stored) : "dark"; }

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const browserStorage = (): Storage | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };
/** When storage refuses the write, the choice still holds for this page load. */
let unsaved: ThemeName | null = null;
/** Private browsing and blocked storage throw; the console then stays dark unless a choice was made on this page. */
export function readStoredTheme(storage: Storage | null = browserStorage()): ThemeName {
  try { const saved = storage?.getItem(THEME_STORAGE_KEY); if (saved !== null && saved !== undefined) return parseTheme(saved); } catch { /* fall through to the in-page choice */ }
  return unsaved ?? "dark";
}
/** Returns whether the choice was persisted. */
export function storeTheme(theme: ThemeName, storage: Storage | null = browserStorage()): boolean {
  try { if (!storage) throw new Error("unavailable"); storage.setItem(THEME_STORAGE_KEY, theme); unsaved = null; return true; } catch { unsaved = theme; return false; }
}
export function applyTheme(theme: ThemeName, root: HTMLElement = document.documentElement) {
  if (root.getAttribute(THEME_ATTRIBUTE) !== theme) root.setAttribute(THEME_ATTRIBUTE, theme);
}
export function currentTheme(root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): ThemeName {
  return parseTheme(root?.getAttribute(THEME_ATTRIBUTE));
}

/**
 * Runs in <head> before first paint. It only ever adds the light attribute, so a blocked or failed script leaves
 * the server-rendered dark page untouched and ThemeRoute applies the preference after hydration instead.
 * The text is static: its hash below can be listed in a nonce-based script-src.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="light"&&${THEMED_ROUTE.toString()}.test(location.pathname))document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},"light")}catch(e){}})()`;
/** CSP source expression for THEME_BOOT_SCRIPT. tests/theme.test.tsx fails if the script changes without this. */
export const THEME_BOOT_SCRIPT_CSP_HASH = "sha256-DVl9xPFL5SYaV2amQw/6Q6LFSpGOutNUJwdKIjFw15Q=";
