import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Settings, Activity, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

interface HealthResponse {
  version?: string;
  runtime?: string;
  status?: string;
}

async function fetchHealth(): Promise<HealthResponse | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
  try {
    const res = await fetch(`${apiUrl}/api/v1/health`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function AdminPage() {
  const health = await fetchHealth();

  return (
    <main className="flex-1 p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft data-icon />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Admin Panel</h1>
            <p className="mt-1 text-muted-foreground">
              System overview and configuration
            </p>
          </div>
        </div>

        {/* System Health */}
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="size-5 text-muted-foreground" />
              <CardTitle>System Health</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {health ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Status:</span>
                  <Badge variant="default">
                    {health.status || "OK"}
                  </Badge>
                </div>
                {health.version && (
                  <div className="flex items-center gap-2">
                    <span className="font-medium">Version:</span>
                    <span className="text-muted-foreground">{health.version}</span>
                  </div>
                )}
                {health.runtime && (
                  <div className="flex items-center gap-2">
                    <span className="font-medium">Runtime:</span>
                    <span className="text-muted-foreground">{health.runtime}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Unable to reach backend. Make sure the server is running.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Navigation Cards */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Link href="/admin/providers">
            <Card className="transition-colors hover:bg-muted/50">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Settings className="size-5 text-muted-foreground" />
                  <CardTitle>Providers</CardTitle>
                </div>
                <CardDescription>
                  Manage AI provider configurations and API keys
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        </div>
      </div>
    </main>
  );
}
