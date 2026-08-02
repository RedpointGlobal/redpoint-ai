/**
 * Content pins for the shared GROUNDING_PREAMBLE — the domain-agnostic
 * "answer only from the curated body, refuse if uncovered" contract that
 * (Phase 2) will be injected into every dispatched knowledge expert's prompt.
 *
 * These assertions are the durable home for the grounding guarantee that used
 * to live as string-pins on rpi-domain-expert's raw SKILL.md text. Pinning the
 * shared constant proves the hardened contract (H6 adjacency, multi-part
 * bundling) survives edits, once, for all present + future dispatched experts.
 */
import { describe, it, expect } from "bun:test";
import { GROUNDING_PREAMBLE } from "../grounding-preamble.js";

describe("GROUNDING_PREAMBLE", () => {
  it("is a non-empty string", () => {
    expect(typeof GROUNDING_PREAMBLE).toBe("string");
    expect(GROUNDING_PREAMBLE.length).toBeGreaterThan(0);
  });

  it("carries the answer-only-from-curated-knowledge contract", () => {
    expect(GROUNDING_PREAMBLE).toContain(
      "Answer **only** from the **Curated knowledge**",
    );
    // Refusal instruction, phrased domain-agnostically (no literal domain name)
    expect(GROUNDING_PREAMBLE).toContain("not in your curated knowledge");
  });

  it("is domain-agnostic (never names a specific domain like RPI)", () => {
    expect(GROUNDING_PREAMBLE).not.toContain("RPI");
    expect(GROUNDING_PREAMBLE).not.toContain("curated RPI knowledge");
  });

  it("guards the two hardened leak modes (H6 adjacency + multi-part bundling)", () => {
    expect(GROUNDING_PREAMBLE).toContain("Adjacency is not coverage");
    expect(GROUNDING_PREAMBLE).toContain("part-by-part");
  });
});
