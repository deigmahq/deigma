/**
 * A number the card prints as a count of landings is COUNTED, not reconstructed from a share.
 *
 * The passport used to say "16 of 23 landings were co-authored by an agent" where 16 was
 * `round(ai_attribution_mix * n_episodes)` — a freshness-MASS share multiplied by a headcount.
 * The mix is right for what it is for ("what is your recent work made of"): an episode from last
 * week says more about how somebody works today than one from five months ago. It is not a count,
 * and the product of a weighted share and a headcount is an estimate of a quantity nobody ever
 * had to estimate.
 *
 * Measured on the sixteen dumped snapshots the day this was found: the reconstruction disagreed
 * with the count for three accounts, once by two landings — and once UPWARDS, 107 of 107 landings
 * "with an agent" on an account where one of the 107 had no agent in it anywhere. On the live
 * passport that same day it read 16 while the timeline beside it drew 19 filled dots, because the
 * older half of that history is AI-heavy and carries less freshness mass.
 *
 * So `withAi` and `byKind` read `history.n_with_ai` and `history.kind_counts`, which the scorer
 * counts the same way it counts `witness_counts`. The planted snapshot below is built so that the
 * two derivations CANNOT agree — otherwise this file would pass against the bug it exists for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Snapshot, measuredFactsFromSnapshot } from "../src/snapshot";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/valid/snapshot/draft.json", import.meta.url)), "utf8"),
) as Record<string, any>;

/** Ten landings: seven pull requests and three commit runs, five of them with an agent. The
 *  mixes beside them are deliberately the shares of a history weighted towards its recent, less
 *  AI-heavy end — which is what a real six months looks like and what made this visible. */
function planted(): ReturnType<typeof Snapshot.parse> {
  const body = JSON.parse(JSON.stringify(fixture));
  body.volumes.n_episodes = 10;
  body.carrier_mix = { pr: 0.55, commit_run: 0.45 };
  body.ai_attribution_mix = { wedge: 0.5, carrier_marked: 0.25, none: 0.25 };
  body.history.kind_counts = { pr: 7, commit_run: 3 };
  body.history.n_with_ai = 5;
  body.history.n_episodes = 10;
  return Snapshot.parse(body);
}

/** What the card used to do, kept here as the thing being refuted. */
const reconstructed = (snapshot: ReturnType<typeof Snapshot.parse>): number =>
  Math.round(
    ((Number(snapshot.ai_attribution_mix?.wedge ?? 0) || 0) +
      (Number(snapshot.ai_attribution_mix?.carrier_marked ?? 0) || 0)) *
      snapshot.volumes.n_episodes,
  );

describe("facts the card prints as counts are counts", () => {
  it("reads AI participation from the count, not from the mass share", () => {
    const snapshot = planted();
    const facts = measuredFactsFromSnapshot(snapshot);
    // The planted snapshot separates the two answers by three landings; if this ever becomes an
    // equality the test has stopped being able to fail.
    expect(reconstructed(snapshot)).toBe(8);
    expect(facts.withAi).toBe(5);
    expect(facts.withAi).not.toBe(reconstructed(snapshot));
  });

  it("reads the carrier composition from counts that add up to the landings", () => {
    const facts = measuredFactsFromSnapshot(planted());
    expect(facts.byKind).toEqual([
      { kind: "pr", landings: 7 },
      { kind: "commit_run", landings: 3 },
    ]);
    // The reconstruction could not do this: round(0.55*10) + round(0.45*10) = 6 + 5 = 11 for ten
    // landings, a composition with one more landing in it than the history it describes.
    expect(facts.byKind.reduce((n, k) => n + k.landings, 0)).toBe(facts.landings);
  });

  it("never claims more landings with an agent than there are landings", () => {
    const facts = measuredFactsFromSnapshot(planted());
    expect(facts.withAi).toBeLessThanOrEqual(facts.landings);
  });

  it("says nothing rather than guessing when a snapshot predates the counts", () => {
    // Snapshots written before this change carry no `kind_counts`. The honest answer is an empty
    // composition until the scorer runs again — not the old reconstruction, which is the number
    // this file exists to remove. Absence of data is not a zero and is not an estimate either.
    const body = JSON.parse(JSON.stringify(fixture));
    body.volumes.n_episodes = 10;
    body.carrier_mix = { pr: 1.0 };
    delete body.history.kind_counts;
    const facts = measuredFactsFromSnapshot(Snapshot.parse(body));
    expect(facts.byKind).toEqual([]);
    expect(facts.landings).toBe(10);
  });
});
