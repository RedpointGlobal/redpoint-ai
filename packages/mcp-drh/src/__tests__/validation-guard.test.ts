/**
 * The token-mode validation budgets (../validation-guard.ts): a NEW remote
 * validation is admitted only while the caller's address is under its failure
 * budget (validations still waiting on DRH count) and the server under its
 * remote-validation ceiling.
 */
import { describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { ValidationGuard, MAX_REMOTE_VALIDATIONS } from "../validation-guard.js";
import { MAX_AUTH_FAILURES_PER_PEER, RATE_WINDOW_MS } from "../rate-limit.js";

const peer = (address: string) => ({ address }) as unknown as Context;
function guardAt() {
  let t = 1_000_000;
  const guard = new ValidationGuard(() => t, (c) => (c as unknown as { address: string }).address);
  return { guard, advance: (ms: number) => void (t += ms) };
}
const settleAll = (admissions: ReturnType<ValidationGuard["admit"]>[], result: "valid" | "invalid" | "unavailable") => {
  for (const a of admissions) if (a.ok) a.settle(result);
};

describe("ValidationGuard", () => {
  it(`the server-wide ceiling: ${MAX_REMOTE_VALIDATIONS} remote validations per window, from any number of addresses`, () => {
    const { guard, advance } = guardAt();
    for (let i = 0; i < MAX_REMOTE_VALIDATIONS; i++) {
      const a = guard.admit(peer(`10.0.${i >> 8}.${i & 255}`));
      expect(a.ok).toBe(true);
      settleAll([a], "valid");
    }
    const refused = guard.admit(peer("10.9.9.9"));
    expect(refused).toEqual({ ok: false, retryAfterSec: 60 });
    advance(RATE_WINDOW_MS);
    expect(guard.admit(peer("10.9.9.9")).ok).toBe(true);
  });

  it(`an address at ${MAX_AUTH_FAILURES_PER_PEER} failures is refused for the rest of the window; another address is not`, () => {
    const { guard, advance } = guardAt();
    for (let i = 0; i < MAX_AUTH_FAILURES_PER_PEER; i++) settleAll([guard.admit(peer("a"))], "invalid");
    const refused = guard.admit(peer("a"));
    expect(refused).toEqual({ ok: false, retryAfterSec: 60 });
    expect(guard.admit(peer("b")).ok).toBe(true);
    advance(RATE_WINDOW_MS);
    expect(guard.admit(peer("a")).ok).toBe(true);
  });

  it(`a concurrent burst can't overshoot: ${MAX_AUTH_FAILURES_PER_PEER} pending validations fill the address's budget`, () => {
    const { guard } = guardAt();
    const burst = Array.from({ length: 100 }, () => guard.admit(peer("a")));
    expect(burst.filter((a) => a.ok).length).toBe(MAX_AUTH_FAILURES_PER_PEER);
    // Refused only because answers are pending → retry shortly.
    expect(burst.find((a) => !a.ok)).toEqual({ ok: false, retryAfterSec: 1 });
    // Valid answers free the slots; failures spend them.
    settleAll(burst, "valid");
    expect(guard.admit(peer("a")).ok).toBe(true);
  });

  it("an unreachable DRH frees the slot without counting a failure; settle is idempotent", () => {
    const { guard } = guardAt();
    const a = guard.admit(peer("a"));
    settleAll([a, a], "unavailable");
    for (let i = 0; i < MAX_AUTH_FAILURES_PER_PEER; i++) expect(guard.admit(peer("a")).ok).toBe(true);
  });

  it("failed() counts a failure on an answer the request didn't ask DRH for", () => {
    const { guard } = guardAt();
    for (let i = 0; i < MAX_AUTH_FAILURES_PER_PEER; i++) guard.failed(peer("a"));
    expect(guard.admit(peer("a")).ok).toBe(false);
  });

  it("a refusal for failures spends none of the server's ceiling", () => {
    const { guard } = guardAt();
    for (let i = 0; i < MAX_AUTH_FAILURES_PER_PEER; i++) guard.failed(peer("a"));
    for (let i = 0; i < 100; i++) guard.admit(peer("a"));
    expect(guard.remoteValidations.trackedKeys).toBe(0);
  });
});
