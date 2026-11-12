/** Synthetic DOM for design-core component tests. No native widget, license, network or browser-geometry claim. */
import { JSDOM } from "jsdom";
export const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://controlled.invalid/design-core", pretendToBeVisual: true });
for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLDivElement", "HTMLButtonElement", "HTMLInputElement", "HTMLAnchorElement", "SVGElement", "Element", "Node", "DocumentFragment", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "MutationObserver", "location", "history", "sessionStorage", "localStorage"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
for (const name of ["addEventListener", "removeEventListener", "dispatchEvent", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name].bind(dom.window) });
/** Tests flip this to exercise the reduced-motion path explicitly. */
export const motion = { reduced: false };
const media = (query: string) => ({ media: query, get matches() { return query.includes("reduced-motion") ? motion.reduced : false; }, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true });
Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: media }); Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: media });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Parses server markup for exact structural assertions. */
export function parse(html: string) { const host = document.createElement("div"); host.innerHTML = html; return host; }
