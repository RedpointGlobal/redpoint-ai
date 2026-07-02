import { createHash } from "crypto";

export interface FolderNode {
  id: string;
  name: string;
  fullPath: string;
  parentFolderId: string | null;
}

interface Entry {
  value: FolderNode[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * In-process TTL cache for the flattened folder tree, keyed by
 * `${tokenFingerprint}:${clientId}`. The fingerprint is a 16-char SHA-256
 * prefix so we never hold raw auth tokens as map keys.
 *
 * The cache stores only the normalized node list. Callers that need raw RPI
 * responses (`verbose: true`) bypass the cache entirely.
 */
export class FolderCache {
  private store = new Map<string, Entry>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  static fingerprint(token: string | undefined): string {
    return createHash("sha256")
      .update(token ?? "__no_token__")
      .digest("hex")
      .slice(0, 16);
  }

  static keyFor(token: string | undefined, clientId: string): string {
    return `${FolderCache.fingerprint(token)}:${clientId}`;
  }

  get(key: string): FolderNode[] | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: FolderNode[]): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Drop a single key, or every key whose fingerprint prefix matches when
   * passed `${fingerprint}:` (no clientId). Used by `create_folder` to clear
   * the user's cached tree after a mutation.
   */
  invalidate(keyOrPrefix: string): void {
    if (this.store.has(keyOrPrefix)) {
      this.store.delete(keyOrPrefix);
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(keyOrPrefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export const folderCache = new FolderCache();
