"use client";

import { useEffect, useState } from "react";
import { listProviders } from "@/lib/api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";

interface Provider {
  type: string;
  name: string;
  configured: boolean;
}

const ENV_VAR_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cohere: "COHERE_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
};

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await listProviders();
        setProviders(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load providers");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <main className="flex-1 p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center gap-3">
          <Link href="/admin">
            <Button variant="ghost" size="icon">
              <ArrowLeft data-icon />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Providers</h1>
            <p className="mt-1 text-muted-foreground">
              AI provider configuration status
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {providers.length === 0 && !error && (
          <p className="text-center text-muted-foreground">
            No providers found. Make sure the backend is running.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((provider) => (
            <Card key={provider.type}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{provider.name}</CardTitle>
                  <Badge
                    variant={provider.configured ? "default" : "destructive"}
                  >
                    {provider.configured ? "Configured" : "Not Configured"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 text-sm text-muted-foreground">
                  <div>
                    <span className="font-medium">Type:</span> {provider.type}
                  </div>
                  {!provider.configured && (
                    <div className="mt-2 rounded border border-border bg-muted/50 px-2 py-1 font-mono text-xs">
                      Set{" "}
                      <span className="font-semibold text-foreground">
                        {ENV_VAR_MAP[provider.type] || `${provider.type.toUpperCase()}_API_KEY`}
                      </span>{" "}
                      to configure
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </main>
  );
}
