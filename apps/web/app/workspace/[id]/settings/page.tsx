"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getWorkspace, updateWorkspace } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Save, Loader2 } from "lucide-react";
import Link from "next/link";

interface McpConnectionShape {
  name: string;
  url?: string;
  transport?: "http" | "stdio";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  allowedTools?: string[];
}

interface ProviderConfigShape {
  type?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  azureDeployment?: string;
}

type ProviderExtras = Omit<ProviderConfigShape, "type" | "model">;

interface WorkspaceConfig {
  provider?: ProviderConfigShape;
  agent?: { systemPrompt?: string; maxSteps?: number };
  mcp?: McpConnectionShape[];
  skills?: string[];
  suggestions?: string[];
}

export default function WorkspaceSettingsPage() {
  const params = useParams();
  const workspaceId = params.id as string;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerType, setProviderType] = useState("");
  const [model, setModel] = useState("");
  const [providerExtras, setProviderExtras] = useState<ProviderExtras>({});
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxSteps, setMaxSteps] = useState(20);
  const [mcpConnections, setMcpConnections] = useState<McpConnectionShape[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const ws = await getWorkspace(workspaceId);
        setName(ws.name);
        setDescription(ws.description || "");
        const config: WorkspaceConfig = JSON.parse(ws.config);
        const provider = config.provider ?? {};
        setProviderType(provider.type || "");
        setModel(provider.model || "");
        setProviderExtras({
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          azureDeployment: provider.azureDeployment,
        });
        setSystemPrompt(config.agent?.systemPrompt || "");
        setMaxSteps(config.agent?.maxSteps ?? 20);
        setMcpConnections(config.mcp || []);
        setSkills(config.skills || []);
        setSuggestions(config.suggestions || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load workspace");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await updateWorkspace(workspaceId, {
        name,
        description: description || undefined,
        provider: {
          ...(providerExtras.apiKey ? { apiKey: providerExtras.apiKey } : {}),
          ...(providerExtras.baseUrl ? { baseUrl: providerExtras.baseUrl } : {}),
          ...(providerExtras.azureDeployment
            ? { azureDeployment: providerExtras.azureDeployment }
            : {}),
          type: providerType,
          model,
        },
        agent: { systemPrompt, maxSteps },
        mcp: mcpConnections,
        skills,
        suggestions,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save workspace");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center [&_svg]:size-6">
        <Loader2 className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link href={`/workspace/${workspaceId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft data-icon />
          </Button>
        </Link>
        <h1 className="text-lg font-semibold">Workspace Settings</h1>
      </header>

      <main className="flex-1 p-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {error && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
              Settings saved successfully.
            </div>
          )}

          {/* General */}
          <Card>
            <CardHeader>
              <CardTitle>General</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="ws-name">Name</Label>
                <Input
                  id="ws-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Workspace name"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="ws-desc">Description</Label>
                <Textarea
                  id="ws-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                  rows={2}
                />
              </div>
            </CardContent>
          </Card>

          {/* Provider */}
          <Card>
            <CardHeader>
              <CardTitle>Provider</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="provider-type">Provider Type</Label>
                <Input
                  id="provider-type"
                  value={providerType}
                  onChange={(e) => setProviderType(e.target.value)}
                  placeholder="e.g. openai, anthropic"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="provider-model">Model</Label>
                <Input
                  id="provider-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gpt-4o, claude-sonnet-4-20250514"
                />
              </div>
            </CardContent>
          </Card>

          {/* System Prompt */}
          <Card>
            <CardHeader>
              <CardTitle>System Prompt</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Enter system prompt..."
                rows={6}
              />
            </CardContent>
          </Card>

          {/* MCP Connections */}
          <Card>
            <CardHeader>
              <CardTitle>MCP Connections</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {mcpConnections.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No MCP connections configured.
                </p>
              )}
              {mcpConnections.map((conn, i) => (
                <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={conn.name}
                    onChange={(e) => {
                      const updated = [...mcpConnections];
                      updated[i] = { ...updated[i], name: e.target.value };
                      setMcpConnections(updated);
                    }}
                    placeholder="Connection name"
                    className="flex-1"
                  />
                  <Input
                    value={conn.url ?? ""}
                    onChange={(e) => {
                      const updated = [...mcpConnections];
                      updated[i] = { ...updated[i], url: e.target.value };
                      setMcpConnections(updated);
                    }}
                    placeholder="URL"
                    className="flex-1"
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setMcpConnections(mcpConnections.filter((_, j) => j !== i));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setMcpConnections([
                    ...mcpConnections,
                    { name: "", url: "", transport: "http" },
                  ])
                }
              >
                Add Connection
              </Button>
            </CardContent>
          </Card>

          {/* Skills */}
          <Card>
            <CardHeader>
              <CardTitle>Skills</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {skills.map((skill, i) => (
                  <Badge key={i} variant="secondary" className="gap-1">
                    {skill}
                    <button
                      type="button"
                      className="ml-1 text-xs hover:text-destructive"
                      onClick={() => setSkills(skills.filter((_, j) => j !== i))}
                    >
                      x
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  id="new-skill"
                  placeholder="Add a skill..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (val && !skills.includes(val)) {
                        setSkills([...skills, val]);
                        (e.target as HTMLInputElement).value = "";
                      }
                    }
                  }}
                />
              </div>
            </CardContent>
          </Card>

          {/* Suggestions */}
          <Card>
            <CardHeader>
              <CardTitle>Suggestions</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {suggestions.map((sug, i) => (
                  <Badge key={i} variant="outline" className="gap-1">
                    {sug}
                    <button
                      type="button"
                      className="ml-1 text-xs hover:text-destructive"
                      onClick={() =>
                        setSuggestions(suggestions.filter((_, j) => j !== i))
                      }
                    >
                      x
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  id="new-suggestion"
                  placeholder="Add a suggestion..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (val && !suggestions.includes(val)) {
                        setSuggestions([...suggestions, val]);
                        (e.target as HTMLInputElement).value = "";
                      }
                    }
                  }}
                />
              </div>
            </CardContent>
          </Card>

          {/* Save */}
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
              ) : (
                <Save className="size-4" data-icon="inline-start" />
              )}
              Save Settings
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
