"use client";

import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { ChatPanel } from "@/components/chat/chat-panel";
import { InfoPanel } from "@/components/chat/info-panel";
import { Button } from "@/components/ui/button";
import { ArrowLeft, PanelRightClose, PanelRightOpen } from "lucide-react";
import Link from "next/link";
import { getWorkspace } from "@/lib/api";
import { ThemeToggle } from "@/components/theme-toggle";
import { RpiHeaderAffordance } from "@/components/auth/rpi-header-affordance";

// useSearchParams() (here and in InfoPanel) requires a Suspense boundary above
// it or Next.js prerendering of this route's shell fails the build.
export default function WorkspaceChatPage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceChatPageInner />
    </Suspense>
  );
}

function WorkspaceChatPageInner() {
  const params = useParams();
  const workspaceId = params.id as string;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [suggestions, setSuggestions] = useState<string[] | undefined>();
  const [title, setTitle] = useState("RedpointAI");
  // Whether this workspace actually talks to RPI — drives the RPI-specific header
  // affordance below. Keyed off the workspace's MCP connections (Redpoint
  // Interaction has `rpi`, Data Readiness Hub has `drh`) rather than the
  // workspace name, which is editable.
  // Defaults false so the control never flashes in before the config resolves.
  const [usesRpi, setUsesRpi] = useState(false);
  // Product short code (RPI / DRH) — drives the header subline, which names the
  // product rather than repeating the platform tagline the landing page shows.
  const [shortName, setShortName] = useState<string | null>(null);

  // URL-synced panel state. `?panel=open` opens; `?panel=closed` closes; absent
  // falls through to the responsive default (closed under 800px, open above).
  const panelParam = searchParams.get("panel");
  const panelOpen =
    panelParam === "open"
      ? true
      : panelParam === "closed"
        ? false
        : true; // default until the post-mount viewport check overrides

  const setPanelOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(panelOpen) : next;
      const params = new URLSearchParams(searchParams);
      params.set("panel", value ? "open" : "closed");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [panelOpen, pathname, router, searchParams],
  );

  useEffect(() => {
    getWorkspace(workspaceId).then((ws) => {
      try {
        const config = JSON.parse(ws.config);
        if (config.suggestions?.length) setSuggestions(config.suggestions);
        setShortName(
          typeof config.shortName === "string" ? config.shortName : null,
        );
        setUsesRpi(
          Array.isArray(config.mcp) &&
            config.mcp.some((m: { name?: string }) => m?.name === "rpi"),
        );
      } catch {}
      if (ws.name) setTitle(ws.name);
    }).catch(() => {});
  }, [workspaceId]);

  // Auto-close the panel when crossing into drawer mode (e.g. landscape→portrait
  // rotation) so the drawer doesn't unexpectedly cover the chat after resize.
  // Also runs once on mount with no panel param set, so first paint on a narrow
  // viewport doesn't have the drawer covering the chat.
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 799px)");
    if (panelParam === null && mql.matches) setPanelOpen(false);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setPanelOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [panelParam, setPanelOpen]);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4 min-[800px]:flex-row min-[800px]:items-start min-[800px]:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" aria-label="Back to workspaces">
            <Button variant="ghost" size="icon">
              <ArrowLeft data-icon />
            </Button>
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-bold tracking-tight" title={title}>{title}</h1>
            <p className="mt-1 text-muted-foreground">
              {shortName
                ? `Redpoint Global · AI Agent for ${shortName}`
                : "Redpoint Global · Agentic AI Platform"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {usesRpi && <RpiHeaderAffordance />}
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon"
            aria-label={panelOpen ? "Close info panel" : "Open info panel"}
            onClick={() => setPanelOpen((v) => !v)}
          >
            {panelOpen ? (
              <PanelRightClose data-icon />
            ) : (
              <PanelRightOpen data-icon />
            )}
          </Button>
        </div>
      </header>

      {/* Side-by-side above 800px; below 800px the InfoPanel overlays the chat as a drawer.
          overflow-hidden clips the closed drawer, which sits off-screen via
          translate-x-full at full w-80 and would otherwise add ~320px of
          horizontal scroll on narrow viewports. Children scroll internally. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ChatPanel workspaceId={workspaceId} suggestions={suggestions} />
        <InfoPanel
          workspaceId={workspaceId}
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
        />
      </div>
    </div>
  );
}
