import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstrumentationEvent } from "@redpoint-ai/shared";
import { FileJsonlSink } from "../instrumentation/file-sink.js";

function ev(): InstrumentationEvent {
  return {
    eventId: "e",
    timestamp: "2026-08-05T00:00:00.000Z",
    userId: "u",
    idempotencyKey: "k",
    clientId: "web",
    model: "m",
    provider: "p",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 2,
    workspaceId: "w",
    runId: "r",
    role: "parent",
  };
}

describe("FileJsonlSink", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("isWritable returns true for a good (nested) dir, creating it", async () => {
    const base = mkdtempSync(join(tmpdir(), "instr-"));
    dirs.push(base);
    const sink = new FileJsonlSink(
      join(base, "nested", "instrumentation-events.jsonl"),
    );
    expect(await sink.isWritable()).toBe(true);
  });

  it("appends JSONL lines once the dir exists (writes succeed)", async () => {
    const base = mkdtempSync(join(tmpdir(), "instr-"));
    dirs.push(base);
    const p = join(base, "sub", "events.jsonl");
    const sink = new FileJsonlSink(p);
    await sink.isWritable(); // mkdir the dir, as startup does
    await sink.write(ev());
    await sink.write(ev());
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).role).toBe("parent");
  });

  it("isWritable returns false when the dir can't be created", async () => {
    const base = mkdtempSync(join(tmpdir(), "instr-"));
    dirs.push(base);
    const filePath = join(base, "afile");
    writeFileSync(filePath, "x"); // a FILE where a dir is expected
    const sink = new FileJsonlSink(join(filePath, "sub", "events.jsonl"));
    expect(await sink.isWritable()).toBe(false);
  });

  it("swallows a write failure (no throw) and warns exactly once", async () => {
    const base = mkdtempSync(join(tmpdir(), "instr-"));
    dirs.push(base);
    const filePath = join(base, "afile");
    writeFileSync(filePath, "x");
    const sink = new FileJsonlSink(join(filePath, "sub", "events.jsonl")); // unwritable

    const warnings: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error minimal test spy
    process.stderr.write = (s: string) => {
      warnings.push(String(s));
      return true;
    };
    try {
      await sink.write(ev()); // must not throw
      await sink.write(ev()); // must not throw, must not warn again
    } finally {
      process.stderr.write = orig;
    }

    const instr = warnings.filter((w) =>
      w.includes("[instrumentation] sink not writable"),
    );
    expect(instr).toHaveLength(1);
    expect(instr[0]).toContain(filePath);
  });
});
