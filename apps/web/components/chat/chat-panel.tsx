"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  DevToolsProviderApi,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessagePartText,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { Bot, SendHorizontal, Square, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";
import { getChatUrl } from "@/lib/api";

const DEFAULT_SUGGESTIONS = [
  "Check my RPI connection",
  "List my clients",
  "List my selection rules",
  "List my audiences",
  "List my interactions",
  "List my folders",
];

interface ChatPanelProps {
  workspaceId: string;
  suggestions?: string[];
}

// Root component. Owns the assistant-ui runtime and wires it to the workspace
// chat endpoint. All child primitives read state from the runtime via context.
export function ChatPanel({ workspaceId, suggestions }: ChatPanelProps) {
  const { data: session } = useSession();

  // Transport is memoized so it isn't recreated on every render. The headers
  // callback is evaluated lazily per-request, so a fresh session token is
  // always used even though the transport object itself is stable.
  //
  // Only the app-identity Authorization header is attached client-side:
  //
  //   - Authorization: Bearer <apiKey>
  //       App-identity for apps/server. Gates access to /api/v1/* via the
  //       API-key Credentials provider in lib/auth.ts.
  //
  // Per-user RPI identity is NO LONGER attached here. `getChatUrl()` now
  // returns the apps/web proxy URL (/api/proxy/chat/<id>); the proxy reads
  // the HttpOnly session cookie server-side, decodes the JWT, and attaches
  // X-RPI-Token to apps/server itself. Browser code never sees the raw RPI
  // access_token — closes the XSS exfil surface flagged in an earlier
  // security review (the JS-visible session.rpi.accessToken is gone).
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: getChatUrl(workspaceId),
        headers: (): Record<string, string> => {
          const apiKey = (session as { apiKey?: string } | null)?.apiKey;
          return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        },
      }),
    [workspaceId, session],
  );

  const runtime = useChatRuntime({ transport });

  // Register the runtime with assistant-ui's DevToolsHooks event bus so the
  // Traffic tab in <InfoPanel> can subscribe to live runtime events. The
  // provider tree does not auto-register — registration is one explicit call.
  // The DevTools API types are over-narrow (Partial<AssistantClient>) but
  // accept the AssistantRuntime structurally — cast through unknown.
  useEffect(() => {
    const unregister = DevToolsProviderApi.register(
      runtime as unknown as Parameters<typeof DevToolsProviderApi.register>[0],
    );
    return unregister;
  }, [runtime]);

  const chips = suggestions?.length ? suggestions : DEFAULT_SUGGESTIONS;

  // Avoid an SSR/first-paint flash: server-side the thread store reports
  // isEmpty=false (no state yet), so the docked composer renders briefly before
  // the client store resolves to empty and shows the hero — the chips/bar visibly
  // jump from the bottom to center. Gate the runtime-driven branches on a client
  // mount so the first paint is already the centered hero. useSyncExternalStore
  // returns false during SSR/hydration and true on the client (no hydration
  // mismatch, and no setState-in-effect).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* ThreadPrimitive.Root manages scroll position and running state */}
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col bg-background">
        <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {!mounted ? (
            // Stable first paint — matches the settled empty state (the hero),
            // so there's no jump from a server-rendered docked bar.
            <EmptyHero suggestions={chips} />
          ) : (
            <>
              {/* Empty welcome: a centered hero — robot head, greeting, chips,
                  and the composer stacked together. Only with no messages. */}
              <ThreadPrimitive.Empty>
                <EmptyHero suggestions={chips} />
              </ThreadPrimitive.Empty>
              {/* Conversation view: messages scroll here once the thread starts. */}
              <ThreadPrimitive.If empty={false}>
                <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
                  <ThreadPrimitive.Messages>
                    {({ message }) =>
                      message.role === "user" ? (
                        <UserMessage />
                      ) : (
                        <AssistantMessage />
                      )
                    }
                  </ThreadPrimitive.Messages>
                </div>
              </ThreadPrimitive.If>
            </>
          )}
        </ThreadPrimitive.Viewport>
        {/* Once chatting, the chips + composer dock to the bottom (the chips stay
            persistent so they can be clicked throughout the session). Gated on
            mount so the docked bar never flashes during the empty welcome. */}
        {mounted && (
          <ThreadPrimitive.If empty={false}>
            <SuggestionBar suggestions={chips} />
            <Composer />
          </ThreadPrimitive.If>
        )}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

// Welcome hero shown before the first message: a centered vertical stack of the
// robot head, greeting, suggestion chips, and the composer — grouped together.
// Once the first message is sent, the thread switches to the conversation view
// and the chips + composer dock to the bottom (see ChatPanel).
function EmptyHero({ suggestions }: { suggestions: string[] }) {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col items-center justify-center gap-6 px-4 py-8 text-center">
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted text-foreground">
          <Bot className="size-7" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">
          Start a conversation
        </h2>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <ThreadPrimitive.Suggestion key={s} prompt={s} asChild>
            <Button variant="outline" size="sm">
              {s}
            </Button>
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
      <ComposerPrimitive.Root className="w-full">
        <ComposerRow />
      </ComposerPrimitive.Root>
    </div>
  );
}

// Persistent suggestion chips, rendered above the composer and ALWAYS available
// (not just on the empty/welcome state) so they can be clicked throughout a
// session. ThreadPrimitive.Suggestion sets the composer text and submits on click.
function SuggestionBar({ suggestions }: { suggestions: string[] }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-2 px-4 pb-2">
      {suggestions.map((s) => (
        <ThreadPrimitive.Suggestion key={s} prompt={s} asChild>
          <Button variant="outline" size="sm">
            {s}
          </Button>
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-row-reverse gap-3">
      <Avatar className="[&_svg]:size-4 [&_svg]:shrink-0">
        <AvatarFallback className="bg-primary text-primary-foreground">
          <User />
        </AvatarFallback>
      </Avatar>
      <div className="max-w-[80%] rounded-lg bg-primary px-4 py-2 text-base text-primary-foreground whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

// AssistantMessage renders two part types: text (via Markdown) and tool calls
// (via ToolFallback). MessagePrimitive.Parts dispatches to the right renderer.
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-row gap-3">
      <Avatar className="[&_svg]:size-4 [&_svg]:shrink-0">
        <AvatarFallback className="bg-muted">
          <Bot />
        </AvatarFallback>
      </Avatar>
      <div className="flex max-w-[80%] flex-col gap-1 rounded-lg bg-muted px-4 py-2 text-base text-foreground">
        <MessagePrimitive.Parts
          components={{
            Text: AssistantText,
            tools: { Fallback: ToolFallback },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

// MessagePartPrimitive.InProgress renders while this part's status is "running".
// The runtime injects a synthetic empty text part before the first token arrives,
// so the dots appear immediately on request — not just during streaming.
function AssistantText() {
  const part = useMessagePartText();
  const text = "text" in part ? part.text : "";
  return (
    <>
      {text && <Markdown>{text}</Markdown>}
      <MessagePartPrimitive.InProgress>
        <span className="flex items-center gap-1 py-0.5">
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
        </span>
      </MessagePartPrimitive.InProgress>
    </>
  );
}

// Generic tool call renderer. Shows tool name in a collapsible summary with
// args and result as formatted JSON. Per-tool custom UIs can be registered via
// makeAssistantToolUI() when richer rendering is needed (e.g. execute_skill).
function ToolFallback({
  toolName,
  args,
  result,
}: {
  toolName: string;
  args: unknown;
  result?: unknown;
}) {
  return (
    <details className="rounded border border-border bg-background/50">
      <summary className="cursor-pointer px-2 py-1 text-xs font-medium">
        {toolName}
      </summary>
      <div className="border-t border-border px-3 py-2 text-xs">
        {args != null && (
          <div className="mb-1">
            <span className="font-medium text-muted-foreground">Args: </span>
            <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap text-foreground/70">
              {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
            </pre>
          </div>
        )}
        {result != null && (
          <div>
            <span className="font-medium text-muted-foreground">Result: </span>
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap text-foreground/70">
              {typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

// The input row — composer textarea + send/stop button. Rendered both in the
// welcome hero and in the docked bottom bar; each caller wraps it in its own
// ComposerPrimitive.Root (both bind to the same thread composer state, and only
// one is mounted at a time depending on whether the thread is empty).
// ThreadPrimitive.If swaps between send and stop based on whether a response is
// currently streaming.
function ComposerRow() {
  return (
    <div className="mx-auto flex max-w-3xl items-stretch gap-2">
      <ComposerPrimitive.Input
        asChild
        autoFocus
        placeholder="Type a message…"
        aria-label="Message"
      >
        <textarea
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </ComposerPrimitive.Input>
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild>
          <Button type="submit" aria-label="Send message" className="aspect-square h-auto shrink-0">
            <SendHorizontal data-icon />
          </Button>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel asChild>
          <Button variant="destructive" aria-label="Stop" className="aspect-square h-auto shrink-0">
            <Square data-icon />
          </Button>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </div>
  );
}

// Docked composer — the bottom input bar shown during a conversation.
function Composer() {
  return (
    <ComposerPrimitive.Root className="border-t border-border bg-background px-4 py-4">
      <ComposerRow />
    </ComposerPrimitive.Root>
  );
}
