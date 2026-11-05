/**
 * The web UI's Content-Security-Policy (served on every route by next.config.ts).
 *
 * img-src 'self' data: blob: — the browser loads images only from the app itself and
 * from in-page data (chart exports are data:/blob: URLs). A model answer is untrusted
 * text: an image it names on another host would be fetched the moment it renders,
 * carrying whatever the URL encodes (data the turn read, say) to that host. The chat's
 * markdown never renders an image (components/chat/markdown.tsx); this is the second
 * lock, for any <img> that reaches the page another way.
 */
export const CONTENT_SECURITY_POLICY = "img-src 'self' data: blob:";

/** next.config headers(): the policy on every route. */
export const securityHeaders = [
  {
    source: "/:path*",
    headers: [{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY }],
  },
];
