/**
 * What waits for the claim on a stranger's surface (Core 7, `publicFacts`): what the landings'
 * record rests on (`byEvidence`) and how much of the acceptance count is a lower bound
 * (`mergerUnrecorded`) describe the claim's own population, so they are published only once the
 * claim is proven. Everything else in the facts layer is the numerator of no claim and is public
 * either way.
 *
 * Nothing held this rule. The persona oracle checks it on the stand, but every public passport it
 * walks proves the claim, so the gate had no oracle on any path (found porting the oracle to
 * Core 7, 2026-11-10).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Snapshot, measuredFactsFromSnapshot, publicFacts } from "../src/snapshot";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/valid/snapshot/draft.json", import.meta.url)), "utf8"),
);

describe("the facts that wait for the claim", () => {
  const owner = {
    ...measuredFactsFromSnapshot(Snapshot.parse(fixture)),
    byEvidence: [
      { evidence: "accepted_by_other" as const, landings: 7 },
      { evidence: "machine_checked" as const, landings: 3 },
    ],
    mergerUnrecorded: 2,
  };

  it("the input is real: the owner's facts carry both", () => {
    expect(owner.byEvidence).toHaveLength(2);
    expect(owner.mergerUnrecorded).toBe(2);
  });

  it("are withheld from a stranger while the claim is unproven", () => {
    const shown = publicFacts(owner, { claimProven: false });
    expect(shown.byEvidence).toBeNull();
    expect(shown.mergerUnrecorded).toBeNull();
  });

  it("are published as they are once it is proven", () => {
    const shown = publicFacts(owner, { claimProven: true });
    expect(shown.byEvidence).toEqual(owner.byEvidence);
    expect(shown.mergerUnrecorded).toBe(2);
  });

  it("and nothing else in the facts layer depends on the claim", () => {
    const before = { ...publicFacts(owner, { claimProven: false }), byEvidence: null, mergerUnrecorded: null };
    const after = { ...publicFacts(owner, { claimProven: true }), byEvidence: null, mergerUnrecorded: null };
    expect(before).toEqual(after);
  });
});
