import { listWorkspaces, type Workspace } from "@/lib/api";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let workspaces: Workspace[] = [];
  try {
    workspaces = await listWorkspaces();
  } catch {
    // Backend not running yet -- fall through to the empty-state message.
  }

  // Single-workspace product: skip the workspace picker and land directly in
  // the chat. Prefer the RedpointAI workspace; otherwise take the first one.
  // (redirect() throws, so it must run outside the try/catch above.)
  const target =
    workspaces.find((w) => w.name === "RedpointAI") ?? workspaces[0];
  if (target) redirect(`/workspace/${target.id}`);

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <p className="text-muted-foreground">
        No workspace available — start the server and reload.
      </p>
    </main>
  );
}
