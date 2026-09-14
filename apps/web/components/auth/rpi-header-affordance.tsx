/**
 * RPI auth header affordance — lives next to <ThemeToggle> in the dashboard.
 *
 * Two visual states based on session.rpi.username (set by the session
 * callback in apps/web/lib/auth.ts when the user has logged in via the
 * rpi-native provider):
 *
 *   - SIGNED OUT  → "Connect RPI" button → opens <LoginModal>
 *   - SIGNED IN   → "<username>" button → click signs out (full NextAuth signOut)
 *
 * MVP simplification: one click = full sign-out. A future PR will add a
 * dropdown that distinguishes "Disconnect RPI Account" (clear rpi.* from
 * JWT, keep web-app session) from "Sign out" (full NextAuth signOut).
 * Today, full sign-out is fine because the
 * web app's only auth IS the RPI auth — there's no separate "web-app
 * session" to preserve when disconnecting RPI.
 */

"use client";

import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { LogIn, LogOut } from "lucide-react";
import { LoginModal } from "@/components/auth/login-modal";

export function RpiHeaderAffordance() {
  // useSession() returns the augmented Session shape declared in
  // apps/web/types/next-auth.d.ts — which includes the optional `rpi`
  // sub-object populated by the session callback in lib/auth.ts.
  const { data: session } = useSession();

  // Modal visibility — only meaningful in the signed-out branch, but
  // declared at top level because hooks must be called unconditionally.
  const [open, setOpen] = useState(false);

  // Runtime auth mode. Under AUTH_REQUIRED=false there is no login (everything
  // runs as the service account), so this whole affordance — the "Connect RPI"
  // button AND its modal — is dead/misleading and must not render. Gate on the
  // runtime /api/auth-mode signal (server reads process.env live), NOT the
  // build-inlined client env, so a .env flip takes effect on restart without a
  // rebuild. `null` = still loading → render nothing (no flash of the button
  // before the mode is known). On fetch error, default to showing it: auth=true
  // is the secure default, and hiding a working login control is the worse miss.
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth-mode")
      .then((r) => (r.ok ? r.json() : { authRequired: true }))
      .then((d: { authRequired?: boolean }) => {
        if (!cancelled) setAuthRequired(d.authRequired !== false);
      })
      .catch(() => {
        if (!cancelled) setAuthRequired(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (authRequired !== true) return null;

  const rpiUsername = session?.rpi?.username;

  // === Signed-in state — show username, click to sign out ================
  if (rpiUsername) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => signOut({ callbackUrl: "/" })}
        title={`Logged in to RPI as ${rpiUsername} — click to sign out`}
      >
        <LogOut data-icon="inline-start" />
        {rpiUsername}
      </Button>
    );
  }

  // === Signed-out state — show Connect button, modal renders on click ====
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <LogIn data-icon="inline-start" />
        Connect RPI
      </Button>
      <LoginModal open={open} onOpenChange={setOpen} />
    </>
  );
}
