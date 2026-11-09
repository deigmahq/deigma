/**
 * Agent sessions by week, for the line on the card (founder, 2026-10-29: the work alone read as a
 * sparse card). Two things are held here: the weeks land in the SAME columns as the work — matched
 * by the week's Monday, not by position — and what a stranger gets is week counts and nothing finer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Snapshot, measuredFactsFromSnapshot, publicFacts } from "../src/snapshot";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/valid/snapshot/draft.json", import.meta.url)), "utf8"),
) as Record<string, any>;

/** Sessions planted in weeks 0, 5 and 25 of the history axis, the agents list SHUFFLED so a
 *  positional reading cannot pass, and one week the history does not hold. */
function planted(): ReturnType<typeof Snapshot.parse> {
  const body = JSON.parse(JSON.stringify(fixture));
  const axis: string[] = body.history.weeks.map((w: { week_start: string }) => w.week_start);
  const at = (i: number, sessions: number) => ({ week_start: axis[i], sessions, live: 0 });
  body.agents.weeks = [
    at(25, 9),
    ...axis.map((_: string, i: number) => i).filter((i: number) => i !== 0 && i !== 5 && i !== 25).map((i: number) => at(i, 0)),
    at(5, 2),
    at(0, 4),
    // A Monday a week before the axis begins: outside the line, drawn nowhere.
    { week_start: "2026-02-16", sessions: 7, live: 0 },
  ];
  return Snapshot.parse(body);
}

describe("sessions on the line", () => {
  it("land in the week columns of the work, by Monday, and a week outside the axis is not drawn", () => {
    const s = planted();
    expect(s.history.weeks).toHaveLength(26);
    const weeks = measuredFactsFromSnapshot(s).sessionWeeks!;
    expect(weeks).toHaveLength(26);
    expect(weeks[0]).toBe(4);
    expect(weeks[5]).toBe(2);
    expect(weeks[25]).toBe(9);
    expect(weeks.reduce((a, n) => a + n, 0), "the week before the axis is not shifted onto week 0").toBe(15);
  });

  it("are empty when nothing was read, so the card draws no row", () => {
    const body = JSON.parse(JSON.stringify(fixture));
    body.agents.weeks = body.agents.weeks.map((w: Record<string, unknown>) => ({ ...w, sessions: 0, live: 0 }));
    expect(measuredFactsFromSnapshot(Snapshot.parse(body)).sessionWeeks).toEqual([]);
  });

  it("reach a stranger as week counts and nothing finer", () => {
    const facts = measuredFactsFromSnapshot(planted());
    const shown = publicFacts(facts, { claimProven: false }).sessionWeeks!;
    expect(shown).toEqual(facts.sessionWeeks);
    expect(shown.every((n) => Number.isInteger(n) && n >= 0), "a count per week, never a day or a record").toBe(true);
  });
});
