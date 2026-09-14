"use client";

/**
 * #27897 — placeholder shown while a render_chart / render_stats / render_dashboard
 * tool call is still STREAMING its args. Without it the tool-UIs ran their spec
 * guard against partial args and flashed the "malformed spec" fallback before the
 * complete args arrived. The renders show this while status.type !== "complete";
 * the malformed fallback is reserved for a genuinely invalid COMPLETE spec.
 */
export function AgentToolSkeleton({ label = "Preparing…" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="my-3 flex h-[120px] w-full animate-pulse items-center justify-center rounded-2xl border border-border bg-card font-dash-mono text-xs text-muted-foreground shadow-dash"
    >
      {label}
    </div>
  );
}
