import { listWorkspaces, type Workspace } from "@/lib/api";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { buildForwardHeaders } from "@/lib/server-forward";
import { WorkspaceList } from "@/components/workspace/workspace-list";
import { ThemeToggle } from "@/components/theme-toggle";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Under AUTH_REQUIRED=true, listWorkspaces hits the gated apps/server and
  // 401s without a credential — which blanked this picker ("No workspace
  // available") after login. Derive the logged-in session's credential
  // server-side (raw token never touches the browser) and forward it. Under
  // auth=false the cookie carries nothing forwardable and this is a no-op.
  let workspaces: Workspace[] = [];
  let unauthorized = false;
  try {
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const hdrs = await headers();
    const proto = hdrs.get("x-forwarded-proto") ?? "http";
    const host =
      hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "localhost:3001";
    const { headers: forward } = await buildForwardHeaders(
      cookieHeader,
      `${proto}://${host}`,
    );
    workspaces = await listWorkspaces(forward);
  } catch (e) {
    // A 401 means the forwarded credential is present but no longer valid at
    // apps/server (e.g. a revoked/deleted API key) — the middleware gate lets
    // it through because the cred is present, but the read is rejected. Send
    // the user to re-authenticate rather than dead-ending on the empty state.
    // Any other error (backend down) falls through to the empty-state message.
    if (e instanceof Error && e.message.includes("401")) unauthorized = true;
  }
  // redirect() throws NEXT_REDIRECT, so it must run OUTSIDE the try/catch.
  if (unauthorized) redirect("/login");

  // Multi-domain platform: show the picker when more than one workspace exists
  // (e.g. RPI + DRH, each its own domain). With a single workspace this stays
  // a single-workspace product — land directly in its chat, no picker to click
  // through. Dormant until a second workspace is seeded/created.
  if (workspaces.length > 1) {
    return (
      <main className="flex flex-1 flex-col">
        {/* Header mirrors the workspace-page header exactly — same element,
            padding, bottom rule and title/subtitle type — so the two pages line
            up at identical height and the rule doesn't jump when you click into
            a workspace and back. Keep the two in sync when either changes. */}
        <header className="flex flex-col gap-3 border-b border-border px-6 py-4 min-[800px]:flex-row min-[800px]:items-start min-[800px]:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-bold tracking-tight">
              RedpointAI
            </h1>
            <p className="mt-1 text-muted-foreground">
              Redpoint Global · Agentic AI Platform
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Build stamp — the first thing to ask for when a rep reports an
                issue, so it's visible without opening the Config tab. Muted and
                out of the tagline: a support detail, not brand copy. */}
            <span className="text-sm text-muted-foreground">
              build {APP_VERSION}
            </span>
            <ThemeToggle />
          </div>
        </header>
        <div className="px-6 py-6">
          <WorkspaceList workspaces={workspaces} />
        </div>
      </main>
    );
  }

  // Single workspace: skip the picker and land directly in the chat. Prefer the
  // Redpoint Interaction workspace; otherwise take the first one. ("RedpointAI"
  // is the pre-rename name — still matched so an un-migrated DB behaves.
  // redirect() throws, so it must run outside the try/catch above.)
  const target =
    workspaces.find(
      (w) => w.name === "Redpoint Interaction" || w.name === "RedpointAI",
    ) ?? workspaces[0];
  if (target) redirect(`/workspace/${target.id}`);

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <p className="text-muted-foreground">
        No workspace available — start the server and reload.
      </p>
    </main>
  );
}
