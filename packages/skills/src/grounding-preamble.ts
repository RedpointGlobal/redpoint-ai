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
