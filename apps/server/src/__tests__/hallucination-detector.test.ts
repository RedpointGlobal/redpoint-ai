/**
 * hallucination-detector.ts — unit tests.
 *
 * Pure function, no mocks needed. Validates the action-claim pattern against
 * real LLM outputs observed in v3 testing.
 *
 * Ported from RP-Vercel-Agent v3 concepts.
 */

import { describe, it, expect } from "bun:test";
import { detectHallucination } from "../agents/hallucination-detector.js";

describe("detectHallucination", () => {
  describe("true positives (should be flagged)", () => {
    it('flags "stored successfully" with no tool calls', () => {
      expect(
        detectHallucination("Stored the client successfully.", []),
      ).toBe(true);
    });

    it('flags "created" + "success" with no tool calls', () => {
      expect(
        detectHallucination("Created the rule. Success!", undefined),
      ).toBe(true);
    });

    it('flags "selected" + "complete"', () => {
      expect(
        detectHallucination("Selected the definition — operation complete.", []),
      ).toBe(true);
    });

    it('flags "updated" + "successfully"', () => {
      expect(
        detectHallucination("Rule updated successfully.", undefined),
      ).toBe(true);
    });

    it('flags "deleted" + "success"', () => {
      expect(
        detectHallucination("Deleted the rule. Success.", []),
      ).toBe(true);
    });

    it("is case insensitive", () => {
      expect(
        detectHallucination("STORED THE CLIENT SUCCESSFULLY", []),
      ).toBe(true);
    });
  });

  describe("true negatives (should NOT be flagged)", () => {
    it("does not flag action claims when tools WERE called", () => {
      const toolCalls = [{ toolName: "create_audience", args: {} }];
      expect(
        detectHallucination("Created the audience successfully.", toolCalls),
      ).toBe(false);
    });

    it("does not flag future-tense statements", () => {
      expect(
        detectHallucination("I will store this client for you.", []),
      ).toBe(false);
    });

    it("does not flag action words without success claim", () => {
      expect(
        detectHallucination("I stored the following: abc123", []),
      ).toBe(false);
    });

    it("does not flag success words without action claim", () => {
      expect(
        detectHallucination("That was a successful query.", []),
      ).toBe(false);
    });

    it("does not flag conversational responses", () => {
      expect(
        detectHallucination("Sure, I can help you with that.", []),
      ).toBe(false);
    });

    it("does not flag empty text", () => {
      expect(detectHallucination("", [])).toBe(false);
    });

    it("does not flag undefined toolCalls when no action claim", () => {
      expect(detectHallucination("Here are the clients:", undefined)).toBe(
        false,
      );
    });
  });

  describe("edge cases", () => {
    it("handles text with multiple sentences", () => {
      expect(
        detectHallucination(
          "Looking at your request. Stored the client successfully. What next?",
          [],
        ),
      ).toBe(true);
    });

    it("treats empty toolCalls array as 'no tools called'", () => {
      expect(
        detectHallucination("Created the rule successfully.", []),
      ).toBe(true);
    });
  });
});
