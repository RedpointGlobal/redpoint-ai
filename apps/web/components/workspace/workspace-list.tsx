import type { Workspace } from "@/lib/api";
import { WorkspaceCard } from "@/components/workspace/workspace-card";
import { CreateWorkspaceForm } from "@/components/workspace/create-workspace-dialog";

interface WorkspaceListProps {
  workspaces: Workspace[];
}

export function WorkspaceList({ workspaces }: WorkspaceListProps) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {workspaces.map((ws) => (
          <WorkspaceCard key={ws.id} workspace={ws} />
        ))}
        <CreateWorkspaceForm />
      </div>

      {workspaces.length === 0 && (
        <p className="mt-8 text-center text-muted-foreground">
          No workspaces yet. Create one to get started.
        </p>
      )}
    </>
  );
}
