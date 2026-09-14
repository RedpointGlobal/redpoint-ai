import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAY } from "../tools/overlay.js";

// Static assertions on the COMMITTED generator output — no live spec fetch. Guards
// the emit contract + that the committed files match the overlay (drift beyond this
// is caught by `generate:tools:check`).
const genDir = resolve(dirname(fileURLToPath(import.meta.url)), "../tools/generated");

describe("generated tool output (#27634)", () => {
  it("emits a DO-NOT-EDIT category file for the seed's category", () => {
    const seed = OVERLAY.GetAttributeLists;
    const file = resolve(genDir, `${seed.category}.ts`);
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src.startsWith("// AUTO-GENERATED")).toBe(true);
    expect(src).toContain("DO NOT EDIT");
  });

  it("emits the seed tool: name, hand-written description, read-only, _meta.endpoints", () => {
    const src = readFileSync(resolve(genDir, "configuration.ts"), "utf8");
    expect(src).toContain('"list_attribute_lists"');
    expect(src).toContain(OVERLAY.GetAttributeLists.description);
    expect(src).toContain('_meta: { endpoints: ["/client/configuration/attribute-lists"] }');
    expect(src).toContain("READ_ONLY_ANNOTATIONS"); // readOnlyHint:true guaranteed
    expect(src).toContain('from "../generated-shared.js"');
    // generated files never carry a non-GET verb
    expect(src).not.toContain("rpiClient.post");
    expect(src).not.toContain("rpiClient.patch");
  });

  it("barrel exports registerGeneratedTools and wires the category register", () => {
    const barrel = readFileSync(resolve(genDir, "index.ts"), "utf8");
    expect(barrel).toContain("export function registerGeneratedTools");
    expect(barrel).toContain("GeneratedTools(server, rpiClient)");
    expect(barrel).toContain('from "./configuration.js"');
  });
});
