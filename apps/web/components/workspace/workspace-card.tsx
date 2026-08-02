import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { MessageSquare } from "lucide-react";
import type { Workspace } from "@/lib/api";
import { WorkspaceStatusLine } from "@/components/workspace/workspace-status-line";

interface WorkspaceCardProps {
  workspace: Workspace;
}

export function WorkspaceCard({ workspace }: WorkspaceCardProps) {
  const config = JSON.parse(workspace.config);

  return (
    <Link href={`/workspace/${workspace.id}`} className="h-full">
      <Card className="h-full transition-colors hover:bg-muted/50">
        <CardHeader>
          {/* Product name followed by its short code in parens — one bold
              title, e.g. "Redpoint Interaction (RPI)". The header carries the
              product alone; runtime details sit on the footer line below. */}
          <CardTitle className="text-lg">
            {config.shortName
              ? `${workspace.name} (${config.shortName})`
              : workspace.name}
          </CardTitle>
          {workspace.description && (
            <CardDescription>{workspace.description}</CardDescription>
          )}
          {/* Resolves after paint; renders nothing when the workspace is healthy.
              The card stays a working link in every state — disabling it would
              lock the user out of the Config tab, which is where the detail is. */}
          <WorkspaceStatusLine
            workspaceId={workspace.id}
            product={config.shortName ?? workspace.name}
          />
        </CardHeader>
        {/* Model status strip. CardFooter gives it a top rule + muted band, so
            the line is anchored to the card instead of floating in the card's
            gap-4. Order: icon, model, provider — the chat icon primes "what answers",
            so the model leads and the provider trails as its qualifier. "on"
            rather than a middot: it states the relationship (the model runs on
            the provider) instead of leaving a reader to infer it.
            Both values share weight and colour on purpose: the outline Badge
            renders at text-foreground while a bare span inherits
            text-muted-foreground, and that contrast gap reads as one being bold. */}
        <CardFooter className="flex flex-wrap items-center gap-1 text-sm">
          <MessageSquare className="mr-1 size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium text-foreground">
            {config.provider?.model}
          </span>
          <span className="text-muted-foreground">on</span>
          <span className="font-medium text-foreground">
            {config.provider?.type}
          </span>
        </CardFooter>
      </Card>
    </Link>
  );
}
