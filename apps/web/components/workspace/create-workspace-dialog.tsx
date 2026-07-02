"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createWorkspace } from "@/lib/api";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  "azure-openai": "gpt-5",
  google: "gemini-2.5-flash",
  ollama: "llama3.1",
};

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerType, setProviderType] = useState("anthropic");
  const [model, setModel] = useState("claude-sonnet-4-20250514");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      await createWorkspace({
        name: name.trim(),
        description: description.trim() || undefined,
        provider: { type: providerType, model },
      });
      setName("");
      setDescription("");
      setOpen(false);
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="flex h-full items-center relative">
        <div className="group items-centerx relative">
          <Button
            onClick={() => setOpen(true)}
            variant="outline"
            className="px-1 py-5"
          >
            <Plus className="size-8" />
          </Button>
          <div className="opacity-0 transition-opacity group-hover:opacity-100 absolute top-3/4 left-3/4 rounded-md bg-card px-2 py-1 text-sm text-muted-foreground ring-1 ring-foreground/10 whitespace-nowrap">
            New Workspace
          </div>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Create Workspace</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-4 py-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-ws-name">Name</Label>
                <Input
                  id="new-ws-name"
                  placeholder="Workspace name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="new-ws-desc">Description</Label>
                <Textarea
                  id="new-ws-desc"
                  placeholder="Optional"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </div>

              <div className="flex gap-4">
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="new-ws-provider">Provider</Label>
                  <Select
                    value={providerType}
                    onValueChange={(val) => {
                      if (!val) return;
                      setProviderType(val);
                      setModel(DEFAULT_MODELS[val] || "");
                    }}
                  >
                    <SelectTrigger id="new-ws-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="azure-openai">Azure OpenAI</SelectItem>
                      <SelectItem value="google">Google AI</SelectItem>
                      <SelectItem value="ollama">Ollama</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="new-ws-model">Model</Label>
                  <Input
                    id="new-ws-model"
                    placeholder="Model ID"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="flex-1"
                  />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={loading || !name.trim()}>
                {loading ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
