/**
 * Chart colours follow the operational theme. AG Charts paints to a canvas and cannot read CSS, so the
 * `--chart-*` tokens from globals.css are resolved through a probe element (which also resolves light-dark()).
 */
export interface ChartPalette { surface: string; text: string; axis: string; grid: string; baseline: string; plan: string; preview: string; hold: string }
/** The dark values, used when styles cannot be read (tests, a detached document). */
export const DARK_CHART_PALETTE: ChartPalette = { surface: "#16161a", text: "#c6c4c0", axis: "#a4a29e", grid: "#303037", baseline: "#8f8f99", plan: "#ffb000", preview: "#91b9de", hold: "#c6a5dd" };
const TOKENS: Record<keyof ChartPalette, string> = { surface: "--chart-surface", text: "--chart-text", axis: "--chart-axis", grid: "--chart-grid", baseline: "--chart-baseline", plan: "--chart-plan", preview: "--chart-preview", hold: "--chart-hold" };

export function chartPalette(root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): ChartPalette {
  if (!root || typeof getComputedStyle !== "function") return DARK_CHART_PALETTE;
  const probe = root.ownerDocument.createElement("span"); probe.style.display = "none"; root.appendChild(probe);
  try {
    const palette = { ...DARK_CHART_PALETTE };
    for (const key of Object.keys(TOKENS) as (keyof ChartPalette)[]) {
      probe.style.color = ""; probe.style.color = `var(${TOKENS[key]})`;
      const value = getComputedStyle(probe).color;
      if (/^(rgb|color|oklch|oklab|#)/.test(value)) palette[key] = value;
    }
    return palette;
  } catch { return DARK_CHART_PALETTE; } finally { probe.remove(); }
}
