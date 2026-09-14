/**
 * Shared grounding contract for **dispatched knowledge experts**
 * (`type: expert, dispatch: true` — tool-less skills answered from a curated
 * body by a spawned sub-agent).
 *
 * This is the domain-agnostic "answer only from the curated body, refuse if
 * uncovered" preamble, hardened this cycle against two real leak modes
 * (H6 adjacency-extrapolation, H7-adjacent multi-part bundling). It is meant to
 * be prepended to a dispatched expert's own SKILL.md body at dispatch time
 * (in the `execute_skill` sub-agent's `system` prompt) so every present and
 * future knowledge expert inherits ONE hardened contract instead of each file
 * hand-authoring its own copy (which drifts).
 *
 * Domain-agnostic on purpose: it never names a domain ("curated knowledge",
 * not "curated RPI knowledge"). Each expert's own SKILL.md intro establishes
 * its domain identity; this preamble supplies only the grounding *rules*.
 *
 * NOTE (Phase 1): this constant is currently **unreferenced** — created
 * additively so it can't affect the running app. Phase 2 wires it into
 * `router.ts` and removes the now-duplicated block from
 * `skills/experts/rpi-domain-expert/SKILL.md`.
 *
 * Reused, not re-derived: sibling dispatched experts (e.g. dhr-domain-expert)
 * get this for free by being `type: expert, dispatch: true`.
 */
export const GROUNDING_PREAMBLE = `## Grounding rule — read first, applies to every answer

Answer **only** from the **Curated knowledge** provided below. It is your **single source of truth**. You must **not** answer from general or training knowledge, and must not infer, define, describe, or extrapolate beyond the curated text — even if you "know" the answer.

If a question is **not covered** by the Curated knowledge below, reply plainly that **it is not in your curated knowledge** and stop — do not invent or fill the gap from training knowledge. A confident answer from the wrong source is worse than an honest "that is not in my curated knowledge" — that is the entire reason this skill exists.

**Two failure modes to guard against specifically:**
- **Adjacency is not coverage.** Do not extend a covered topic to an *adjacent* or *related* one. The body covering *X* does **not** license you to answer about a neighbouring *Y*: if *Y* is not explicitly in the curated text, refuse *Y* — even though *X* is covered and the two feel related. Proximity to covered material is never coverage.
- **Answer multi-part questions part-by-part.** When a request bundles several asks, treat each separately: answer the parts the curated text explicitly covers, and for each part it does not, say plainly that *that part* is not in your curated knowledge. Never let a covered part pull an uncovered part along.`;

/**
 * Shared `clientId`-handling foundation for **action/hybrid skills that opt in**
 * via `clientIdFoundation: true` (the RPI skills that take an `X-ClientID`).
 *
 * This is the canonical 3-case contract — omit when the rep gave none (server
 * applies the default), pass a UUID through, redispatch a tenant *name* to
 * rpi-clients — that had been copy-pasted into ~17 SKILL.md bodies and DRIFTED.
 * It is prepended to the opted-in skill's sub-agent `system` prompt at dispatch
 * time in router.ts, exactly as GROUNDING_PREAMBLE is for dispatched experts, so
 * every present and future opted-in skill inherits ONE copy that can't drift.
 *
 * Kept as the SUPERSET of the drifted copies (audit 2026-08-11): retains the
 * 401/empty-UUID rationale + the hex example that the terser copies had dropped,
 * so no skill loses guidance. Skill-agnostic — the case-1 example is generic.
 * RPI-specific (names RPI_DEFAULT_CLIENT_ID + rpi-clients), so DRH skills and
 * rpi-clients itself deliberately do NOT opt in.
 */
export const CLIENTID_FOUNDATION = `## \`clientId\` handling

You will usually NOT be given a \`clientId\`. Three cases:

1. **No \`clientId\` provided** (most common — generic requests like "list my …") — OMIT the \`clientId\` argument entirely. The MCP server applies \`RPI_DEFAULT_CLIENT_ID\` from environment automatically. Do NOT ask the user for a clientId; do NOT refuse to proceed.

2. **\`clientId\` provided as a UUID** (8-4-4-4-12 hex, e.g. \`a1b2c3d4-e5f6-7a8b-9c0d-ef1234567890\`) — pass it through unchanged.

3. **\`clientId\` provided as a non-UUID** (almost certainly a tenant *name* the parent agent forgot to resolve) — your sub-agent's tool filter does NOT include name-resolution. Stop and respond with a clear error asking the parent to redispatch via the **rpi-clients** skill to resolve the name to a UUID. Forwarding a name will fail with a 401 / "Client ID '00000000-0000-0000-0000-000000000000' not found" because RPI parses non-UUID input to the empty UUID.

**Ambient active tenant.** Once the user has switched tenant (the \`set_active_tenant\` action), the active tenant is AMBIENT — the server injects its \`X-ClientID\` on every RPI call for the rest of the conversation. So even on a compound turn like "switch to Acme and list its audiences", do NOT thread the tenant name or a \`clientId\` into the follow-up operation to "scope it to that tenant" — just call the operation with no \`clientId\`; the switch already applies. Re-passing the just-switched tenant *name* re-triggers case 3 above (name → empty-UUID → 401).`;
