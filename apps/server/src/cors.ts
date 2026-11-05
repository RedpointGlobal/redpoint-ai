/**
 * The app server's CORS allowlist: the web UI's origin ONLY — never "*".
 *
 * The browser never calls the app server cross-origin: every browser request goes
 * to the web UI, whose same-origin /api/proxy/* routes call the server server-side
 * (which CORS doesn't govern). So the allowlist only has to admit the web UI itself,
 * and refusing every other origin costs nothing: a page on another site can't read
 * a response from this server, even where the server is reachable.
 *
 * The web UI's origin: the origin of RPI_AI_AGENT_REDIRECT_URL (the web app's
 * registered SSO callback, so its public origin) when set, and the local web UI
 * (http://localhost:3001) always.
 */
import { cors } from "hono/cors";

export const LOCAL_WEB_ORIGIN = "http://localhost:3001";

/** The origins allowed to read this server's responses cross-origin. */
export function corsOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const origins = [LOCAL_WEB_ORIGIN];
  const redirect = env.RPI_AI_AGENT_REDIRECT_URL?.trim();
  if (redirect) {
    try {
      const { origin } = new URL(redirect);
      if (origin !== "null" && !origins.includes(origin)) origins.push(origin);
    } catch {
      /* not a URL: the local origin only */
    }
  }
  return origins;
}

/** The CORS middleware: an origin not on the list gets no Access-Control-Allow-Origin. */
export function appCors(env: Record<string, string | undefined> = process.env) {
  return cors({ origin: corsOrigins(env) });
}
