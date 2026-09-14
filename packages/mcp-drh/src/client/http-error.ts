/**
 * Client-safe HTTP error detail.
 *
 * SECURITY: never put the upstream response BODY into a client-facing error.
 * A failed DRH API or signon response body can carry internal URLs, HTML error
 * pages, stack traces, or credential-adjacent detail, and these errors reach
 * retail + agent callers. Status + statusText is enough to troubleshoot; the
 * raw body is a leak. Do NOT reintroduce `response.text()` into a thrown
 * message — the error-leak guard test asserts the body never appears.
 */
export function safeErrorDetail(status: number, statusText: string): string {
  return `${status} ${statusText}`;
}
