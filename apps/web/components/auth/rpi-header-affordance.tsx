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

import { useState } from "react";
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
