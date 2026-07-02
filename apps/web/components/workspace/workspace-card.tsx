import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MessageSquare } from "lucide-react";
import type { Workspace } from "@/lib/api";

interface WorkspaceCardProps {
  workspace: Workspace;
}

export function WorkspaceCard({ workspace }: WorkspaceCardProps) {
  const config = JSON.parse(workspace.config);

  return (
    <Link href={`/workspace/${workspace.id}`} className="h-full">
      <Card className="h-full transition-colors hover:bg-muted/50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{workspace.name}</CardTitle>
            <Badge variant="outline">{config.provider?.type}</Badge>
          </div>
          {workspace.description && (
            <CardDescription>{workspace.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="size-4" />
            <span>{config.provider?.model}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
