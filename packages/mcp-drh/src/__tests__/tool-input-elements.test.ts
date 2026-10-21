/**
 * One tools/call may carry at most MAX_TOOL_INPUT_ELEMENTS array elements plus object
 * members in its arguments (GHSA-46jr-4wx8-v453 / CVE-2026-111768: without a ceiling, one
 * request inside the body limit could exhaust memory during validation). The SDK's check
 * is opt-in, so this holds the server to setting it: a real client → server call over the
 * in-memory transport, one element over the ceiling is refused for its size, exactly at
 * the ceiling it isn't.
 */
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDrhMcpServer, MAX_TOOL_INPUT_ELEMENTS } from "../server.js";

const TOO_MANY = /more than the maximum of \d+ elements/;

async function connect() {
  // A stand-in client: the tools register; a call that gets through to one fails on it, not on its size.
  const { server } = createDrhMcpServer({} as never);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "elements-test", version: "0" });
  await client.connect(clientSide);
  return client;
}

/** Arguments with exactly `n` elements + members: one key holding an array of n - 1. */
const argsOf = (n: number) => ({ padding: Array.from({ length: n - 1 }, () => 0) });

/** The call's outcome as text, whether the SDK answers with an error result or throws. */
async function callText(client: Client, args: Record<string, unknown>): Promise<string> {
  try {
    const res = (await client.callTool({ name: "drh_list_sources", arguments: args })) as { content?: Array<{ text?: string }> };
    return (res.content ?? []).map((c) => c.text ?? "").join("\n");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("tool-call argument size", () => {
  it("is capped at 10,000 elements", () => {
    expect(MAX_TOOL_INPUT_ELEMENTS).toBe(10_000);
  });

  it("a call one element over the ceiling is refused for its size; at the ceiling it is not", async () => {
    const client = await connect();
    expect(await callText(client, argsOf(MAX_TOOL_INPUT_ELEMENTS + 1))).toMatch(TOO_MANY);
    expect(await callText(client, argsOf(MAX_TOOL_INPUT_ELEMENTS))).not.toMatch(TOO_MANY);
    await client.close();
  });
});
