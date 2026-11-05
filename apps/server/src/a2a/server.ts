/**
 * A2A Express server wiring.
 *
 * Uses `@a2a-js/sdk/server/express` middleware:
 *   - agentCardHandler — serves /.well-known/agent-card.json (PUBLIC, no auth)
 *   - jsonRpcHandler   — handles A2A JSON-RPC 2.0 operations (AUTHENTICATED)
 *
 * Auth is declared by A2A_AUTH_MODE (./auth.ts): "bearer" — a single Bearer token
 * from config, checked in a small middleware; "oidc" — a per-user token (JWT, or RPI-validated) verified by
 * requireOidcUser before the JSON-RPC handler runs. The discovery endpoint remains
 * public (standard A2A practice — clients need the card to know what auth scheme
 * to use).
 *
 * Ported from RP-Vercel-Agent v3 (src/a2a/server/server.ts).
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import type { AgentCard } from "@a2a-js/sdk";
import { WorkspaceExecutor, type ExecutorDeps } from "./executor.js";
import { turnBudget } from "../lib/web-limits.js";
import { isDevMode } from "../auth/caller.js";

/**
 * Each A2A message is a turn (LLM + tool calls): it spends the caller's turn budget —
 * the SAME budget as their web chat turns (lib/web-limits.ts), keyed on the verified
 * user (oidc) or the one bearer identity. Over it → 429 + Retry-After. Off in dev mode.
 */
export function a2aTurnLimit(keyOf: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "POST" || isDevMode()) return next();
    const admission = turnBudget.take(keyOf(req));
    if (admission.ok) return next();
    res.setHeader("Retry-After", String(admission.retryAfterSec));
    res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests — retry later" }, id: null });
  };
}
import { AGENT_CARD_PATH, oidcUserBuilder, requireOidcUser, type A2AAuth } from "./auth.js";

export interface ServerDeps extends Omit<ExecutorDeps, "authMode"> {
  agentCard: AgentCard;
  port: number;
  auth: A2AAuth;
}

export interface RunningServer {
  stop: () => Promise<void>;
  port: number;
}

/**
 * Require a Bearer token. The agent card discovery endpoint is exempted
 * explicitly so discovery stays public per A2A spec convention.
 *
 * Exported for unit testing.
 */
export function requireBearer(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === AGENT_CARD_PATH) {
      return next();
    }
    const authHeader = req.header("authorization") ?? "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1] !== expectedToken) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized: missing or invalid Bearer token",
        },
        id: null,
      });
      return;
    }
    next();
  };
}

export async function runA2AServer(deps: ServerDeps): Promise<RunningServer> {
  const { agentCard, port, auth, workspaceId, skillRegistry } = deps;

  const executor = new WorkspaceExecutor({ workspaceId, skillRegistry, authMode: auth.mode });
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );

  const app: Express = express();
  app.use(express.json({ limit: "2mb" }));

  app.use(
    AGENT_CARD_PATH,
    agentCardHandler({ agentCardProvider: requestHandler }),
  );

  if (auth.mode === "bearer") {
    app.use(
      "/",
      requireBearer(auth.bearerToken),
      a2aTurnLimit(() => "a2a-bearer"),
      jsonRpcHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication,
      }),
    );
  } else {
    app.use(
      "/",
      requireOidcUser(auth),
      a2aTurnLimit((req) => `rpi:${(req as Request & { a2aUser?: { sub: string } }).a2aUser?.sub ?? "unknown"}`),
      jsonRpcHandler({ requestHandler, userBuilder: oidcUserBuilder }),
    );
  }

  const httpServer = await new Promise<ReturnType<typeof app.listen>>(
    (resolve) => {
      const server = app.listen(port, () => resolve(server));
    },
  );

  return {
    port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
