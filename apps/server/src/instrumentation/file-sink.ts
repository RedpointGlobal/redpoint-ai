import { appendFile, mkdir, access, constants } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  InstrumentationEvent,
  InstrumentationSink,
} from "@redpoint-ai/shared";

/**
 * Development instrumentation sink: append one JSON object per line to a local
 * `.jsonl` file. Fire-and-forget append; a write error is swallowed (instrumentation
 * must never break a request) but the FIRST failure emits a one-shot, actionable
 * stderr warning so a broken sink isn't silent.
 *
 * This local JSONL capture is the complete deliverable — a rough cost-estimate
 * probe for eyeballing roughly what the platform costs to run. Hand-collected
 * files suffice at this scale; there is no further phase or central pipeline.
 */
export class FileJsonlSink implements InstrumentationSink {
  private warned = false;

  constructor(private readonly filePath: string) {}

  async write(event: InstrumentationEvent): Promise<void> {
    try {
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      // Swallow so the request is never broken — but warn ONCE (rate-limited to
      // one line, not per event) with path + cause so the operator can act:
      // ENOENT = dir deleted mid-run, EACCES = read-only mount/perms, ENOSPC = disk full.
      if (!this.warned) {
        this.warned = true;
        const code = (err as { code?: string }).code ?? "unknown";
        process.stderr.write(
          `[instrumentation] sink not writable: ${this.filePath} (${code}) — events dropped\n`,
        );
      }
    }
  }

  /** Cheap health probe: ensure the sink dir exists and is writable. */
  async isWritable(): Promise<boolean> {
    try {
      const dir = dirname(this.filePath);
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
