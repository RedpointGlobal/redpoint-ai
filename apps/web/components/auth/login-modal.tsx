/**
 * "Connect RPI Account" modal.
 *
 * Triggered from the header affordance (RpiHeaderAffordance component).
 * Submits username/password to NextAuth via signIn("rpi-native", ...),
 * which routes the credentials to the rpi-native provider's authorize()
 * function in apps/web/lib/auth.ts — that function calls RPI's
 * /connect/token (OAuth2 password grant) and returns the resulting tokens.
 *
 * Discovery contract: on open, the modal queries
 * /api/auth/rpi-login-settings (a thin proxy to RPI's
 * /api/v2/authentication/login-settings) and inspects the providers.
 *   - If only native auth is configured: render the username/password form.
 *   - If any external IdP provider is present: render the form AND a notice
 *     telling the user that interactive IdP redirect (Keycloak / Microsoft /
 *     etc.) isn't yet wired in this UI — they'll either need to use a native
 *     account or wait for the OIDC IdP UI to land.
 *
 * The IdP redirect button itself is deliberately NOT rendered here — that's
 * out of scope. This modal honors the discovery contract by surfacing the
 * tenant's actual auth shape.
 */

"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Feature flag for the "Tenant uses external authentication" amber notice
 * that warns users their SSO account won't work in the native form.
 *
 * Currently OFF per UX direction — flip to `true` to restore the notice
 * (e.g., once the OIDC redirect work lands and we want users to know
 * the IdP path exists). The supporting discovery (state + useEffect that
 * fetches /api/rpi/login-settings) stays active either way, so the only
 * change to re-enable is this one boolean.
 */
const SHOW_EXTERNAL_AUTH_NOTICE = false;

interface LoginModalProps {
  /** Modal visibility — controlled by the parent so the trigger button can manage state. */
  open: boolean;
  /** Called by the modal to request open/close state changes (e.g. backdrop click, Cancel). */
  onOpenChange: (open: boolean) => void;
}

interface LoginSetting {
  authenticationType: string;
  isExternal: boolean;
}

export function LoginModal({ open, onOpenChange }: LoginModalProps) {
  // Local form state — wiped on a successful login so re-opening the modal
  // (e.g. after sign-out + reconnect) starts blank instead of showing the
  // previous user's username. Password is also wiped on success defensively.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Discovery state — fetched on each modal open. Quietly fails closed: if
  // RPI is unreachable or returns garbage, we just hide the IdP notice and
  // let the user try the native form. Better UX than blocking the modal
  // entirely on a discovery hiccup.
  const [externalProviders, setExternalProviders] = useState<string[]>([]);

  // Fetch discovery on every open. /api/rpi/login-settings is a thin proxy
  // that hits RPI's /api/v2/authentication/login-settings server-side
  // (browser can't call RPI directly — CORS). Lives outside /api/auth/
  // because NextAuth owns that prefix.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/rpi/login-settings")
      .then((res) => (res.ok ? res.json() : { settings: [] }))
      .then((data: { settings?: LoginSetting[] }) => {
        if (cancelled) return;
        const externals = (data.settings ?? [])
          .filter((s) => s.isExternal)
          .map((s) => s.authenticationType);
        setExternalProviders(externals);
      })
      .catch(() => {
        // Discovery failure shouldn't block native login attempts.
        if (!cancelled) setExternalProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Belt + suspenders — the input `required` attrs gate this in modern
    // browsers, but the empty check below catches programmatic submits.
    if (!username || !password) return;
    setError("");
    setLoading(true);
    try {
      // redirect: false keeps us on the current page; we handle the post-success
      // navigation ourselves below. Without this, NextAuth would do a full-page
      // navigation to its own callbackUrl on success.
      const result = await signIn("rpi-native", {
        username,
        password,
        redirect: false,
      });
      if (result?.error) {
        // Don't echo the underlying error — could be "CredentialsSignin" or a
        // network detail. The user-facing message stays generic.
        setError("Login failed. Check your username and password.");
      } else {
        onOpenChange(false);
        setPassword("");
        // Hard reload so server components (the dashboard page) re-render
        // with the new session AND useSession() picks up the fresh JWT cookie.
        // Without the reload, server-rendered chrome would lag behind the
        // client until the next navigation.
        window.location.reload();
      }
    } catch {
      // Network failure or thrown error — same generic message.
      setError("Login failed. Check your username and password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect RPI Account</DialogTitle>
          <DialogDescription>
            Sign in with your RPI credentials. Tool calls will run as your RPI user
            instead of the shared service account, applying your RBAC permissions.
          </DialogDescription>
        </DialogHeader>
        {/* External-auth amber notice — gated OFF per UX direction. Flip
            SHOW_EXTERNAL_AUTH_NOTICE (top of file) to true to restore.
            JSX stays live so TypeScript still validates it; no DOM
            presence at all when the flag is false. */}
        {SHOW_EXTERNAL_AUTH_NOTICE && externalProviders.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">Tenant uses external authentication</p>
            <p className="mt-1 text-muted-foreground">
              This tenant is configured for{" "}
              <span className="font-mono">
                {externalProviders.join(", ")}
              </span>{" "}
              login. Interactive IdP sign-in isn&apos;t wired in this UI yet —
              the form below will only accept native RPI accounts. If you only
              have an SSO account, use the proxy user fallback (chat will run as
              the configured service account, not as you).
            </p>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rpi-username">Username</Label>
            <Input
              id="rpi-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              disabled={loading}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rpi-password">Password</Label>
            <Input
              id="rpi-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={loading}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !username || !password}>
              {loading ? "Signing in…" : "Sign In"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
