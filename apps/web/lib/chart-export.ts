/**
 * #27897 task 5 — export an agent chart as SVG or PNG.
 *
 * THE GOTCHA (task 3 theming): series colours are `var(--dataviz-N)` and the
 * chart chrome reads `var(--muted-foreground)` / `var(--border)` / etc. Those
 * custom properties are defined on the DOCUMENT (:root / .dark) and inherited by
 * the live SVG. But a serialized SVG — whether saved standalone or rasterized via
 * `new Image()` → `drawImage` — renders in an ISOLATED context with no access to
 * the document's custom properties, so every `var(--…)` resolves to nothing and
 * the export comes out black/blank.
 *
 * Fix: before serializing, resolve each token to its COMPUTED value for the
 * current theme (getComputedStyle on the live element) and inline those literals
 * into the markup. Both exports go through the same buildExportSvg() so SVG and
 * PNG are always colour-correct and theme-correct.
 *
 * Known limitation (noted, not a bug): Recharts renders the legend as sibling
 * HTML, not inside the <svg>, so it is not part of the export. Axis, gridlines,
 * series and a solid background ARE included.
 */

/** The exact custom properties the charts use (task 3). Resolved per theme. */
export const EXPORT_TOKENS = [
  "--dataviz-1",
  "--dataviz-2",
  "--dataviz-3",
  "--dataviz-4",
  "--dataviz-5",
  "--dataviz-6",
  "--dataviz-7",
  "--dataviz-8",
  "--foreground",
  "--muted-foreground",
  "--border",
  "--popover",
  "--background",
] as const;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Replace every `var(--token)` occurrence in serialized SVG markup with its
 * resolved literal. Pure string transform — the unit-testable core of the fix.
 * An unknown token is left as-is (so it degrades to the same missing-var
 * behaviour rather than corrupting the markup).
 */
export function inlineCssVars(markup: string, resolved: Record<string, string>): string {
  return markup.replace(/var\((--[a-z0-9-]+)\)/gi, (whole, name: string) => {
    const value = resolved[name];
    return value ? value : whole;
  });
}

/** Filesystem-safe slug for the download name, from the chart title. */
export function exportFilename(title: string | undefined, ext: string): string {
  const base = (title ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || "chart"}.${ext}`;
}

/** Resolve the export tokens to their computed values for `el`'s current theme. */
function resolveTokens(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const token of EXPORT_TOKENS) out[token] = cs.getPropertyValue(token).trim();
  return out;
}

/**
 * Serialize the live SVG into standalone, colour-inlined markup: clone it, add
 * the xmlns, prepend an opaque background rect (so the export isn't transparent —
 * which would leave light-theme text invisible on light viewers and vice versa),
 * serialize, then inline the resolved custom properties.
 */
function buildExportSvg(svg: SVGSVGElement): string {
  const resolved = resolveTokens(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);

  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", resolved["--background"] || "#ffffff");
  clone.insertBefore(bg, clone.firstChild);

  const raw = new XMLSerializer().serializeToString(clone);
  return inlineCssVars(raw, resolved);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Export the SVG element as a standalone .svg file (colours inlined). */
export function exportChartAsSvg(svg: SVGSVGElement, title?: string): void {
  const markup = buildExportSvg(svg);
  triggerDownload(
    new Blob([markup], { type: "image/svg+xml;charset=utf-8" }),
    exportFilename(title, "svg"),
  );
}

/**
 * Export the SVG element as a .png, rasterized at `scale`× for crispness on
 * hi-dpi displays. Rejects if the browser can't load the SVG image or produce a
 * PNG blob (caller surfaces the failure rather than silently no-op'ing).
 */
export async function exportChartAsPng(
  svg: SVGSVGElement,
  title?: string,
  scale = 2,
): Promise<void> {
  const { width, height } = svg.getBoundingClientRect();
  const markup = buildExportSvg(svg);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("failed to load chart image for PNG export"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable for PNG export");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!pngBlob) throw new Error("failed to encode PNG");
    triggerDownload(pngBlob, exportFilename(title, "png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}
