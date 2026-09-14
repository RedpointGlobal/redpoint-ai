/**
 * #27897 task 5 — the CSS-var inlining that keeps chart exports colour-correct.
 *
 * The whole point: a serialized/rasterized SVG can't see the document's custom
 * properties, so every var(--…) must be replaced with its resolved literal before
 * export. These lock that pure transform (the DOM-dependent serialize/rasterize
 * paths are covered by manual verification, noted in chart-export.ts).
 */
import { describe, it, expect } from "bun:test";
import { inlineCssVars, exportFilename, EXPORT_TOKENS } from "../chart-export.js";

const resolved = {
  "--dataviz-1": "#0072b2",
  "--dataviz-2": "#e69f00",
  "--foreground": "oklch(0.24 0 0)",
  "--border": "#cccccc",
  "--background": "#ffffff",
};

describe("inlineCssVars", () => {
  it("replaces a series colour var with its resolved literal", () => {
    expect(inlineCssVars('<rect fill="var(--dataviz-1)"/>', resolved)).toBe(
      '<rect fill="#0072b2"/>',
    );
  });

  it("replaces every occurrence across the markup", () => {
    const markup = 'fill="var(--dataviz-1)" stroke="var(--border)" color="var(--foreground)"';
    expect(inlineCssVars(markup, resolved)).toBe(
      'fill="#0072b2" stroke="#cccccc" color="oklch(0.24 0 0)"',
    );
  });

  it("resolves oklch (non-hex) values too — no colour space assumption", () => {
    expect(inlineCssVars('fill="var(--foreground)"', resolved)).toContain("oklch(0.24 0 0)");
  });

  it("leaves an unknown token untouched (degrades, never corrupts markup)", () => {
    expect(inlineCssVars('fill="var(--not-a-token)"', resolved)).toBe('fill="var(--not-a-token)"');
  });

  it("no-op when there are no vars", () => {
    expect(inlineCssVars('<rect fill="#123456"/>', resolved)).toBe('<rect fill="#123456"/>');
  });

  it("covers every token the charts actually use", () => {
    // Guards drift: if agent-chart.tsx starts using a token, it must be added to
    // EXPORT_TOKENS or the export won't resolve it.
    for (const t of ["--dataviz-1", "--dataviz-8", "--muted-foreground", "--border", "--foreground", "--background"]) {
      expect(EXPORT_TOKENS).toContain(t);
    }
  });
});

describe("exportFilename", () => {
  it("slugifies the title", () => {
    expect(exportFilename("Revenue by Region 2026", "png")).toBe("revenue-by-region-2026.png");
  });

  it("collapses punctuation/spacing and trims edges", () => {
    expect(exportFilename("  Q1 — Sales!! ", "svg")).toBe("q1-sales.svg");
  });

  it("falls back to 'chart' for empty/undefined/symbol-only titles", () => {
    expect(exportFilename(undefined, "png")).toBe("chart.png");
    expect(exportFilename("   ", "svg")).toBe("chart.svg");
    expect(exportFilename("!!!", "png")).toBe("chart.png");
  });
});
