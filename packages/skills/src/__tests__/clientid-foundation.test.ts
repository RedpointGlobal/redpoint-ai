/**
 * Guard for the clientId-foundation dedup (2026-08-11).
 *
 * The canonical 3-case `clientId` contract lives ONCE in CLIENTID_FOUNDATION and
 * is prepended centrally in router.ts to skills that opt in with
 * `clientIdFoundation: true` — NOT copy-pasted into SKILL.md bodies (which drifted
 * across 17 skills). These assertions lock that in:
 *   - the opted-in set is exactly the 18 RPI action skills (explicit opt-in);
 *   - no opted-in body still carries the block (no re-drift);
 *   - DRH skills + rpi-clients did NOT accidentally opt in;
 *   - the canonical constant is the SUPERSET (keeps the 401/empty-UUID rationale).
 */
import { describe, it, expect } from "bun:test";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { loadSkillsFromDirectory } from "../loader.js";
import { CLIENTID_FOUNDATION } from "../grounding-preamble.js";

const __testsDir = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__testsDir, "../../../../skills");

const EXPECTED_OPTED_IN = [
  "rpi-admin",
  "rpi-analysis",
  "rpi-attributes",
  "rpi-audiences",
  "rpi-cluster-infra",
  "rpi-cluster-users",
  "rpi-content",
  "rpi-databases",
  "rpi-decision-rules",
  "rpi-folders",
  "rpi-health",
  "rpi-integrations",
  "rpi-interactions",
  "rpi-operations",
  "rpi-selection-rules",
  "rpi-single-customer-view",
  "rpi-users-permissions",
  "rpi-workflows",
].sort();

describe("clientId-foundation dedup", () => {
  it("exactly the 18 RPI action skills opt in via clientIdFoundation", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const optedIn = skills
      .filter((s) => s.clientIdFoundation === true)
      .map((s) => s.name)
      .sort();
    expect(optedIn).toEqual(EXPECTED_OPTED_IN);
  });

  it("no opted-in skill still carries the clientId block in its body (dedup complete)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    for (const s of skills.filter((k) => k.clientIdFoundation === true)) {
      // The block's unmistakable markers must be gone from the body — the
      // canonical copy is injected centrally, not inlined.
      expect(s.instructions).not.toContain("`clientId` handling.");
      expect(s.instructions).not.toContain("RPI_DEFAULT_CLIENT_ID");
    }
  });

  it("DRH skills and rpi-clients did NOT opt in (no implicit carve-out drift)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    for (const s of skills) {
      if (s.name.startsWith("drh-") || s.name === "rpi-clients") {
        expect(s.clientIdFoundation ?? false).toBe(false);
      }
    }
  });

  it("CLIENTID_FOUNDATION is the SUPERSET — keeps the 401/empty-UUID rationale + the redispatch + default", () => {
    expect(CLIENTID_FOUNDATION).toContain("RPI_DEFAULT_CLIENT_ID");
    expect(CLIENTID_FOUNDATION).toContain("rpi-clients");
    expect(CLIENTID_FOUNDATION).toContain("empty UUID");
    expect(CLIENTID_FOUNDATION).toContain("401");
  });

  it("dateGrounding is set ONLY on rpi-interactions (targeted date injection #27897)", async () => {
    const skills = await loadSkillsFromDirectory(SKILLS_DIR);
    const grounded = skills.filter((s) => s.dateGrounding === true).map((s) => s.name).sort();
    // Blanket date injection regressed list-clients; only the runs-date-math skill opts in.
    expect(grounded).toEqual(["rpi-interactions"]);
  });

  it("carries the ambient-active-tenant guidance (compound-turn #27828 fix)", () => {
    expect(CLIENTID_FOUNDATION).toContain("Ambient active tenant");
    expect(CLIENTID_FOUNDATION).toContain("set_active_tenant");
    // The core instruction: don't re-thread the tenant on a compound turn.
    expect(CLIENTID_FOUNDATION.toLowerCase()).toContain("do not thread the tenant");
  });
});
