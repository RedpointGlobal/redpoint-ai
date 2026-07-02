import { describe, it, expect } from "bun:test";
import { FolderCache, type FolderNode } from "../client/folder-cache.js";

const sample: FolderNode[] = [
  { id: "1", name: "Root", fullPath: "\\Root", parentFolderId: null },
];

describe("FolderCache", () => {
  it("returns set values within TTL", () => {
    const cache = new FolderCache(60_000);
    cache.set("k", sample);
    expect(cache.get("k")).toEqual(sample);
  });

  it("expires entries past TTL", async () => {
    const cache = new FolderCache(10);
    cache.set("k", sample);
    await new Promise((r) => setTimeout(r, 25));
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("invalidates a single key", () => {
    const cache = new FolderCache(60_000);
    cache.set("a", sample);
    cache.set("b", sample);
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual(sample);
  });

  it("invalidates all keys with a fingerprint prefix", () => {
    const cache = new FolderCache(60_000);
    cache.set("fp1:client-x", sample);
    cache.set("fp1:client-y", sample);
    cache.set("fp2:client-x", sample);
    cache.invalidate("fp1:");
    expect(cache.get("fp1:client-x")).toBeUndefined();
    expect(cache.get("fp1:client-y")).toBeUndefined();
    expect(cache.get("fp2:client-x")).toEqual(sample);
  });

  it("fingerprint produces a stable 16-char hex digest", () => {
    const a = FolderCache.fingerprint("token-abc");
    const b = FolderCache.fingerprint("token-abc");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keyFor combines fingerprint and clientId", () => {
    const key = FolderCache.keyFor("tok", "client-1");
    expect(key.endsWith(":client-1")).toBe(true);
    expect(key.split(":")[0]).toHaveLength(16);
  });
});
