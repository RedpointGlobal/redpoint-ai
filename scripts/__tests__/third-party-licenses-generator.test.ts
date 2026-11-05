/**
 * The license generator lists every package@version installed in Bun's store,
 * not just the one version bun hoists per name — and the list doesn't depend on
 * which version bun hoisted.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectPackages, renderLicenses } from "../generate-third-party-licenses";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function pkg(dir: string, name: string, version: string, license: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, license }));
}

/** A store with two versions of `dup` (one hoisted), a scoped package, and a dependency link. */
function store(hoisted: "1.0.0" | "2.0.0"): string {
  const root = mkdtempSync(join(tmpdir(), "tpl-store-"));
  roots.push(root);
  const bun = join(root, ".bun");
  pkg(join(bun, "dup@1.0.0", "node_modules", "dup"), "dup", "1.0.0", "MIT");
  pkg(join(bun, "dup@2.0.0", "node_modules", "dup"), "dup", "2.0.0", "ISC");
  pkg(join(bun, "@scope+lib@3.1.0", "node_modules", "@scope", "lib"), "@scope/lib", "3.1.0", "Apache-2.0");
  pkg(join(bun, "uses-dup@1.0.0", "node_modules", "uses-dup"), "uses-dup", "1.0.0", "MIT");
  // An entry's node_modules also links its dependencies (other store entries).
  symlinkSync(join(bun, "dup@1.0.0", "node_modules", "dup"), join(bun, "uses-dup@1.0.0", "node_modules", "dup"));
  // The hoisted links: ONE version per name.
  mkdirSync(join(bun, "node_modules", "@scope"), { recursive: true });
  symlinkSync(join(bun, `dup@${hoisted}`, "node_modules", "dup"), join(bun, "node_modules", "dup"));
  symlinkSync(join(bun, "@scope+lib@3.1.0", "node_modules", "@scope", "lib"), join(bun, "node_modules", "@scope", "lib"));
  return bun;
}

const ids = (bun: string) => collectPackages(bun).map((p) => `${p.name}@${p.version}`);

describe("collectPackages (Bun store)", () => {
  it("lists every installed version of a package, not only the hoisted one", () => {
    expect(ids(store("2.0.0"))).toEqual(["@scope/lib@3.1.0", "dup@1.0.0", "dup@2.0.0", "uses-dup@1.0.0"]);
  });

  it("the list doesn't depend on which version bun hoisted", () => {
    expect(ids(store("1.0.0"))).toEqual(ids(store("2.0.0")));
    expect(renderLicenses(collectPackages(store("1.0.0"))).content).toBe(
      renderLicenses(collectPackages(store("2.0.0"))).content,
    );
  });

  it("keeps each version's own license", () => {
    const byId = Object.fromEntries(collectPackages(store("2.0.0")).map((p) => [`${p.name}@${p.version}`, p.license]));
    expect(byId["dup@1.0.0"]).toBe("MIT");
    expect(byId["dup@2.0.0"]).toBe("ISC");
    expect(byId["@scope/lib@3.1.0"]).toBe("Apache-2.0");
  });
});
