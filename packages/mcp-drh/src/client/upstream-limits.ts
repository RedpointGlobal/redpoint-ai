/**
 * Bounded upstream requests — every call to DRH gets a per-request timeout and a
 * response-size cap, so a stalled or misbehaving instance can't hang a tool or
 * exhaust memory. Both cover the whole exchange (headers AND body) and surface as
 * clean errors: "DRH request timed out after 60s", "DRH request response
 * exceeded 16777216 bytes". Constants of the server, not configuration.
 *
 * 60 s sits under the 220 s long-running tool budget (tool 220 s < transport 240 s
 * < the listener's 255 s), so a polling tool still reports its own clean timeout.
 * A caller's own AbortSignal still aborts the request; only the timeout's abort is
 * reported as "timed out".
 */
export const UPSTREAM_TIMEOUT_MS = 60_000;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface BoundedResponse {
  response: Response;
  /** The body as text, within the size cap and the same timeout. */
  text(): Promise<string>;
  /** Drop the body unread (frees the connection). */
  discard(): void;
}

export async function boundedFetch(
  input: string | URL,
  init: RequestInit,
  label = "DRH request",
  limits = { timeoutMs: UPSTREAM_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES },
): Promise<BoundedResponse> {
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const timedOut = () => new Error(`${label} timed out after ${limits.timeoutMs / 1000}s`);
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal });
  } catch (e) {
    if (timeout.aborted) throw timedOut();
    throw e;
  }
  return {
    response,
    discard: () => void response.body?.cancel().catch(() => {}),
    text: async () => {
      try {
        return await readCapped(response, limits.maxBytes, label);
      } catch (e) {
        if (timeout.aborted) throw timedOut();
        throw e;
      }
    },
  };
}

async function readCapped(response: Response, maxBytes: number, label: string): Promise<string> {
  const tooLarge = () => new Error(`${label} response exceeded ${maxBytes} bytes`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
