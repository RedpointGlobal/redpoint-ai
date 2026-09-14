"use client";

import { signIn } from "next-auth/react";
import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Brand-free SSO label so the OSS build reads correctly for any org deploying
// against its own Keycloak. Plain generic string — no brand, no config.
const SSO_LABEL = "Single Sign-On";

function LoginForm() {
  // SSO (Keycloak) — the PRIMARY path (top). Native RPI stays below.
  const [ssoUsername, setSsoUsername] = useState("");
  const [ssoPassword, setSsoPassword] = useState("");
  const [rpiUsername, setRpiUsername] = useState("");
  const [rpiPassword, setRpiPassword] = useState("");
  const [error, setError] = useState("");
  // Which path is active (or null) — disables all controls during any of them.
  const [pending, setPending] = useState<null | "redirect" | "kc" | "rpi">(null);

  // Autofill hardening. Chrome ignores autocomplete="section-*" on credential
  // fields and pre-fills its one saved Keycloak credential into EVERY
  // username/password pair on load. Fix: render every field readOnly until it's
  // focused — browsers don't autofill readonly fields — so all fields are
  // guaranteed EMPTY on load/reload; focusing one unlocks just that field for
  // typing and never populates the others. (Chrome may still show its autofill
  // dropdown once a field is focused — separate, unsuppressable — but the
  // pre-fill, which is the actual bug, is gone.)
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const unlock = (id: string) =>
    setUnlocked((s) => (s.has(id) ? s : new Set(s).add(id)));

  // Phase 1b — "Environment Location" field (rendered at the top of the form,
  // above the auth chooser). Shown ONLY when the deployment configured
  // RPI_URL_ALLOWLIST (server signal via
  // /api/rpi-location); otherwise the login is the unchanged single-instance
  // form. The env default URL is shown as PLACEHOLDER (the allowlist contents are
  // never sent to the browser — just an is-enabled flag + the default).
  const [rpiLocation, setRpiLocation] = useState("");
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [locationPlaceholder, setLocationPlaceholder] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/rpi-location")
      .then((r) => (r.ok ? r.json() : { enabled: false, placeholder: "" }))
      .then((d: { enabled?: boolean; placeholder?: string }) => {
        if (cancelled) return;
        setLocationEnabled(d.enabled === true);
        setLocationPlaceholder(typeof d.placeholder === "string" ? d.placeholder : "");
      })
      .catch(() => {
        /* feature stays off on fetch error — unchanged login */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const searchParams = useSearchParams();
  const rawCallbackUrl = searchParams.get("callbackUrl") || "/";
  const callbackUrl =
    rawCallbackUrl.startsWith("/") && !rawCallbackUrl.startsWith("//")
      ? rawCallbackUrl
      : "/";

  // SSO — the CORRECT path: authorization_code + PKCE redirect to
  // the OIDC IdP (provider id "sso"). Full-page redirect (no redirect:false).
  // NOTE: until OUR redirect URI is registered on the realm's `rpi` client this
  // 400s "invalid redirect_uri" — expected/deferred. The password paths below
  // work today meanwhile.
  //
  // Environment Location: the redirect can't pass a credential, so we first POST
  // the entered location to /api/rpi-location/select, which SSRF-validates it and
  // sets the short-TTL carrier cookie the jwt callback reads on the OIDC callback.
  // Binary: a rejected location shows the explicit red message and does NOT
  // redirect; blank clears any stale carrier (env default). A transient POST
  // failure with a blank location still proceeds (no carrier → default); with a
  // non-blank location we block, since we couldn't confirm it's permitted.
  async function redirectSso() {
    setError("");
    setPending("redirect");
    const loc = rpiLocation.trim();
    try {
      const r = await fetch("/api/rpi-location/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: loc }),
      });
      if (!r.ok) {
        setError(
          "That Environment Location isn't permitted. Check the URL, or leave it blank to use the default.",
        );
        setPending(null);
        return;
      }
    } catch {
      // Network error setting the carrier. Blank → safe to proceed (default);
      // non-blank → block, since we can't confirm the location is permitted.
      if (loc) {
        setError(
          "Couldn't set the Environment Location. Try again, or leave it blank to use the default.",
        );
        setPending(null);
        return;
      }
    }
    void signIn("sso", { callbackUrl });
  }

  // Interim password paths — OAuth2 password grants forwarded as X-RPI-Token
  // (Mechanism B): "keycloak-sso" hits the realm's Keycloak endpoint (public
  // client), "rpi-native" hits RPI's /connect/token. Wiring: lib/auth.ts;
  // Keycloak discovery/grants: lib/keycloak-sso.ts.
  async function submit(
    provider: "keycloak-sso" | "rpi-native",
    which: "kc" | "rpi",
    username: string,
    password: string,
    // Native RPI only — the entered Environment Location (blank → env default).
    rpiUrl?: string,
  ) {
    if (!username || !password) return;
    setPending(which);
    setError("");

    // If a location was entered, verify it's permitted BEFORE signing in, so a
    // rejected location gets an EXPLICIT message distinct from a credential
    // failure. (The server authorize() also rejects it — this is for the UX.)
    const loc = rpiUrl?.trim();
    if (which === "rpi" && loc) {
      try {
        const r = await fetch(`/api/rpi-location?url=${encodeURIComponent(loc)}`);
        const d = (await r.json()) as { urlAllowed?: boolean | null };
        if (d.urlAllowed === false) {
          setError(
            "That Environment Location isn't permitted. Check the URL, or leave it blank to use the default.",
          );
          setPending(null);
          return;
        }
      } catch {
        /* probe failed — fall through; authorize() still rejects a bad URL */
      }
    }

    const result = await signIn(provider, {
      username,
      password,
      ...(which === "rpi" ? { rpiUrl: loc ?? "" } : {}),
      redirect: false,
    });
    if (result?.error) {
      setError(
        which === "kc"
          ? "SSO password sign-in failed. Check your username and password."
          : "RPI login failed. Check your username and password.",
      );
      setPending(null);
    } else {
      window.location.href = callbackUrl;
    }
  }

  const busy = pending !== null;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign In</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Environment Location — top of the form, above the auth chooser
            (mirrors the RPI desktop client). Renders ONLY when RPI_URL_ALLOWLIST
            is configured. State lives in LoginForm, so it works outside the
            native <form>; native submit still passes rpiLocation from state. */}
        {locationEnabled && (
          <div className="space-y-2">
            <Label htmlFor="rpi-location">Environment Location</Label>
            <Input
              id="rpi-location"
              type="text"
              inputMode="url"
              autoComplete="off"
              placeholder={locationPlaceholder || undefined}
              value={rpiLocation}
              onChange={(e) => setRpiLocation(e.target.value)}
              disabled={busy}
            />
          </div>
        )}

        {/* PRIMARY — SSO redirect (authorization_code + PKCE) */}
        <Button
          type="button"
          className="w-full"
          onClick={() => void redirectSso()}
          disabled={busy}
        >
          {pending === "redirect" ? "Redirecting…" : `Sign in with ${SSO_LABEL}`}
        </Button>

        {/* divider */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or sign in with a password
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* INTERIM — SSO via password grant (works before our redirect
            URI is registered on the realm client) */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit("keycloak-sso", "kc", ssoUsername, ssoPassword);
          }}
          className="flex flex-col gap-3"
        >
          <div className="space-y-2">
            <Label htmlFor="sso-username">{SSO_LABEL} username</Label>
            <Input
              id="sso-username"
              type="text"
              autoComplete="section-sso username"
              readOnly={!unlocked.has("sso-username")}
              onFocus={() => unlock("sso-username")}
              value={ssoUsername}
              onChange={(e) => setSsoUsername(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sso-password">Password</Label>
            <Input
              id="sso-password"
              type="password"
              autoComplete="section-sso current-password"
              readOnly={!unlocked.has("sso-password")}
              onFocus={() => unlock("sso-password")}
              value={ssoPassword}
              onChange={(e) => setSsoPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            className="w-full"
            disabled={busy || !ssoUsername || !ssoPassword}
          >
            {pending === "kc" ? "Signing in…" : `Sign in with ${SSO_LABEL} password`}
          </Button>
        </form>

        {/* divider */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or sign in with native RPI credentials
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* native RPI */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit("rpi-native", "rpi", rpiUsername, rpiPassword, rpiLocation);
          }}
          className="flex flex-col gap-3"
        >
          <div className="space-y-2">
            <Label htmlFor="rpi-username">RPI username</Label>
            <Input
              id="rpi-username"
              type="text"
              autoComplete="section-rpi username"
              readOnly={!unlocked.has("rpi-username")}
              onFocus={() => unlock("rpi-username")}
              value={rpiUsername}
              onChange={(e) => setRpiUsername(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rpi-password">Password</Label>
            <Input
              id="rpi-password"
              type="password"
              autoComplete="section-rpi current-password"
              readOnly={!unlocked.has("rpi-password")}
              onFocus={() => unlock("rpi-password")}
              value={rpiPassword}
              onChange={(e) => setRpiPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            className="w-full"
            disabled={busy || !rpiUsername || !rpiPassword}
          >
            {pending === "rpi" ? "Signing in…" : "Sign in with RPI"}
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
