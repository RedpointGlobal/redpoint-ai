/**
 * A2A Express server wiring.
 *
 * Uses `@a2a-js/sdk/server/express` middleware:
 *   - agentCardHandler — serves /.well-known/agent-card.json (PUBLIC, no auth)
 *   - jsonRpcHandler   — handles A2A JSON-RPC 2.0 operations (AUTHENTICATED)
 *
 * Phase 1 auth: a single Bearer token from config, checked in a small middleware.
 * The discovery endpoint remains public (standard A2A practice — clients need
 * the card to know what auth scheme to use).
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

export interface ServerDeps extends ExecutorDeps {
  agentCard: AgentCard;
  port: number;
  bearerToken: string;
}

export interface RunningServer {
  stop: () => Promise<void>;
  port: number;
}

const AGENT_CARD_PATH = "/.well-known/agent-card.json";

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
  const { agentCard, port, bearerToken, workspaceId, skillRegistry } = deps;

  const executor = new WorkspaceExecutor({ workspaceId, skillRegistry });
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

  app.use(
    "/",
    requireBearer(bearerToken),
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

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
