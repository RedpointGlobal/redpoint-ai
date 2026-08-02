"use client";

import { useEffect, useState } from "react";
import { getWorkspaceRuntimeStatus, type RuntimeStatus } from "@/lib/api";

type McpEntry = RuntimeStatus["mcp"][number];

/**
 * The one-line "why isn't this working" note on a workspace card.
 *
 * Deliberately CLIENT-SIDE and fetched after paint. The landing page is a
 * server component doing a single cheap listWorkspaces(); probing MCP servers
 * in that path would stall the whole page on a dead server — precisely the case
 * this line exists to report. Render first, explain a moment later.
 *
 * The server owns the classification (`status`); this component owns only the
 * wording. It never inspects `error`, so no string-matching on error text can
 * creep in here.
 */
function copyFor(mcp: McpEntry, product: string): string | null {
  switch (mcp.status) {
    case "not_configured":
      // missingVar is the first name only; the full list stays in the server log.
      return `${mcp.missingVar ?? "Configuration"} is not set.`;
    case "unreachable":
      return `The ${product} MCP server is not available.`;
    case "unauthorized":
      // Generic on purpose: a 401 can come from the MCP server's own inbound
      // auth OR from the backend rejecting the service account. Naming the
      // wrong layer sends a rep to the wrong knob; the log says which.
      return `The ${product} MCP server could not authenticate.`;
    case "no_tools":
      return `The ${product} MCP server returned no tools.`;
    case "ok":
      return null;
  }
}

export function WorkspaceStatusLine({
  workspaceId,
  product,
}: {
  workspaceId: string;
  product: string;
}) {
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWorkspaceRuntimeStatus(workspaceId)
      .then((status) => {
        if (cancelled) return;
        // Most obstructive wins. The server already reduced each connection to
        // one state; with several connections, surface the first unhealthy one.
        const unhealthy = status.mcp?.find((m) => m.status !== "ok");
        setLine(unhealthy ? copyFor(unhealthy, product) : null);
      })
      .catch(() => {
        // Status unavailable is not itself a workspace fault — say nothing
        // rather than accuse a healthy workspace.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, product]);

  if (!line) return null;
  return <p className="mt-1 text-sm text-muted-foreground">{line}</p>;
}
