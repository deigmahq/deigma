/**
 * Contract of the areas of work: a snapshot may carry `history.domains` — where the person's work was,
 * by area of a closed vocabulary, counted — and an episode may carry the `evidence.areas` it is
 * counted from. Three promises are held here, in the style of landing-contract.test.ts:
 *
 *   1. A snapshot scored before the areas were read still parses and carries NO `domains` — not an
 *      empty list, which would say "no area" about a person nobody has looked at.
 *   2. The field is the owner's: it is not carried by `measuredFactsFromSnapshot` or `publicFacts`,
 *      so no public projection built from them can show it. Planted needles, and a leaky
 *      projection that the same detector must catch (the rule of mutation for public-surface tests).
 *   3. The vocabulary is closed and the shape is strict: an area outside `AREAS`, a level word, a
 *      zero-piece item or a timestamp for a week is refused, in zod here and in Pydantic on the
 *      data plane's side.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AREAS } from "../src/vocabulary";
import { Episode } from "../src/episode";
import {
  AREAS_RULES_VERSION,
  HistoryDomains,
  Snapshot,
  measuredFactsFromSnapshot,
  publicFacts,
} from "../src/snapshot";

const read = (relative: string): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as Record<string, any>;

const fixture = read("../fixtures/valid/snapshot/draft.json");
const episodeFixture = read("../fixtures/valid/episode/pr.final.json");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the golden snapshot's history.domains", () => {
  const snapshot = Snapshot.parse(fixture);
  const domains = snapshot.history.domains!;

  it("is there, under the rules the data plane stamps", () => {
    // Precondition: the input is not empty, so every comparison below compares something.
    expect(domains).toBeDefined();
    expect(domains.items.length).toBeGreaterThan(1);
    expect(domains.version).toBe(AREAS_RULES_VERSION);
  });

  it("lists areas of the vocabulary, once each, in the vocabulary's order and never in an order of counts", () => {
    const order = domains.items.map((item) => AREAS.indexOf(item.area));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
    // The golden scenario has more pieces in an area that comes LATER than in one that comes first,
    // so an order of counts and the order of the vocabulary cannot be the same list.
    const counts = domains.items.map((item) => item.pieces);
    expect(counts).not.toEqual([...counts].sort((a, b) => b - a));
  });

  it("counts landings the timeline draws, in weeks the timeline has", () => {
    const weeks = new Set(snapshot.history.weeks.map((w) => w.week_start.slice(0, 10)));
    const witnessed = snapshot.history.landings.filter((dot) => dot.witnessed).length;
    for (const item of domains.items) {
      expect(item.pieces).toBeGreaterThanOrEqual(1);
      expect(item.pieces).toBeLessThanOrEqual(snapshot.history.landings.length);
      expect(item.checked_by_ci).toBeLessThanOrEqual(item.pieces);
      expect(item.checked_by_ci).toBeLessThanOrEqual(witnessed);
      expect(item.reverted).toBeLessThanOrEqual(item.pieces);
      expect(weeks.has(item.last_week), item.last_week).toBe(true);
      expect(new Date(`${item.last_week}T00:00:00Z`).getUTCDay(), `${item.last_week} is a Monday`).toBe(1);
    }
  });
});

describe("a snapshot scored before the areas were read", () => {
  it("parses and carries no domains, not even an empty list", () => {
    const body = clone(fixture);
    expect(body.history.domains).toBeDefined();
    delete body.history.domains;
    const parsed = Snapshot.parse(body);
    expect("domains" in parsed.history).toBe(false);
    expect(parsed.history.domains).toBeUndefined();
    // ... and what it does carry is untouched by the field's absence.
    expect(parsed.history.landings.length).toBeGreaterThan(0);
  });

  it("is a different statement from paths that were read and touch no area", () => {
    const body = clone(fixture);
    body.history.domains = { version: AREAS_RULES_VERSION, items: [] };
    const parsed = Snapshot.parse(body);
    expect(parsed.history.domains).toEqual({ version: AREAS_RULES_VERSION, items: [] });
    expect("domains" in parsed.history).toBe(true);
  });

  it("refuses an explicit null: absent is the only way to say 'not read'", () => {
    const body = clone(fixture);
    body.history.domains = null;
    expect(Snapshot.safeParse(body).success).toBe(false);
  });
});

describe("the shape is strict and the vocabulary is closed", () => {
  const good = { area: "payments", pieces: 3, checked_by_ci: 2, reverted: 0, last_week: "2026-08-17" };
  const parse = (item: Record<string, unknown>) =>
    HistoryDomains.safeParse({ version: AREAS_RULES_VERSION, items: [item] }).success;

  it("accepts the item the tests below break one fault at a time", () => {
    expect(parse(good)).toBe(true);
    for (const area of AREAS) expect(parse({ ...good, area }), area).toBe(true);
  });

  it.each([
    ["an area outside the vocabulary", { area: "gardening" }],
    ["a level word (levels are read from counts, never stored)", { level: "deep" }],
    ["a repository", { repository: "github:812345678" }],
    ["a count of files", { files: 40 }],
    ["an area with no piece (it is left out, not listed with a zero)", { pieces: 0 }],
    ["a fraction of a piece", { pieces: 2.5 }],
    ["a negative count of checked pieces", { checked_by_ci: -1 }],
    ["a negative count of reverts", { reverted: -1 }],
    ["a timestamp where a week stands", { last_week: "2026-08-17T09:30:00Z" }],
    ["a day written the other way round", { last_week: "17-08-2026" }],
  ])("refuses %s", (_name, fault) => {
    expect(parse({ ...good, ...fault })).toBe(false);
  });

  it("refuses a version that is not a version of the rules, and a missing one", () => {
    for (const version of ["areas-1", "1.0", "areas-1.0-beta", "domains-1.0", ""]) {
      expect(HistoryDomains.safeParse({ version, items: [good] }).success, version).toBe(false);
    }
    expect(HistoryDomains.safeParse({ items: [good] }).success).toBe(false);
    expect(HistoryDomains.safeParse({ version: AREAS_RULES_VERSION, items: [good], levels: {} }).success).toBe(false);
  });
});

describe("history.domains is the owner's and no public projection built from the facts carries it", () => {
  /** Values nothing else in a snapshot can hold: a count, a week far outside any window. */
  const NEEDLES = ["4242", "2031-01-06"];
  const planted = clone(fixture);
  planted.history.domains = {
    version: AREAS_RULES_VERSION,
    items: [{ area: "payments", pieces: 4242, checked_by_ci: 4000, reverted: 7, last_week: "2031-01-06" }],
  };
  const snapshot = Snapshot.parse(planted);

  /** The detector: the planted values, the field's name, or the area it names, anywhere in the text. */
  const leaks = (value: unknown): boolean => {
    const text = JSON.stringify(value);
    return NEEDLES.some((needle) => text.includes(needle)) || text.includes('"domains"') || text.includes('"payments"');
  };

  it("is present on the owner's snapshot, so the checks below look for something that exists", () => {
    expect(snapshot.history.domains?.items[0]?.pieces).toBe(4242);
    expect(leaks(snapshot.history)).toBe(true);
  });

  it("is not in the owner's facts or in what a stranger may see of them", () => {
    const owner = measuredFactsFromSnapshot(snapshot);
    expect(leaks(owner)).toBe(false);
    for (const claimProven of [false, true]) {
      expect(leaks(publicFacts(owner, { claimProven })), `claimProven=${claimProven}`).toBe(false);
    }
  });

  it("would be caught if a projection carried it (the guard on the guard)", () => {
    const owner = measuredFactsFromSnapshot(snapshot);
    const leaky = { ...publicFacts(owner, { claimProven: true }), domains: snapshot.history.domains };
    expect(leaks(leaky)).toBe(true);
    const leakyByValue = { ...publicFacts(owner, { claimProven: true }), note: "pieces 4242" };
    expect(leaks(leakyByValue)).toBe(true);
  });
});

describe("an episode's evidence.areas", () => {
  const withAreas = (areas: unknown) => {
    const body = clone(episodeFixture);
    if (areas === undefined) delete body.evidence.areas;
    else body.evidence.areas = areas;
    return body;
  };

  it("is on the golden episode, so both stacks validate the shape", () => {
    expect(episodeFixture.evidence.areas).toBeDefined();
    const parsed = Episode.parse(episodeFixture);
    expect(parsed.evidence.areas?.version).toBe(AREAS_RULES_VERSION);
    expect(parsed.evidence.areas?.touched.length).toBeGreaterThan(0);
  });

  it("has three states that stay three: a list, a list with nothing in it, and not read", () => {
    const listed = Episode.parse(withAreas({ version: AREAS_RULES_VERSION, touched: ["payments", "data_sql"] }));
    expect(listed.evidence.areas?.touched).toEqual(["payments", "data_sql"]);
    const none = Episode.parse(withAreas({ version: AREAS_RULES_VERSION, touched: [] }));
    expect(none.evidence.areas).toEqual({ version: AREAS_RULES_VERSION, touched: [] });
    for (const unread of [undefined, null]) {
      expect(Episode.parse(withAreas(unread)).evidence.areas ?? null, String(unread)).toBeNull();
    }
    expect("areas" in Episode.parse(withAreas(undefined)).evidence).toBe(false);
  });

  it.each([
    ["an area outside the vocabulary", { version: AREAS_RULES_VERSION, touched: ["gardening"] }],
    ["a path where an area stands", { version: AREAS_RULES_VERSION, touched: ["src/payments/charge.py"] }],
    ["a count of files", { version: AREAS_RULES_VERSION, touched: [], files: 3 }],
    ["a version that is not one", { version: "v1", touched: [] }],
    ["no version", { touched: [] }],
  ])("refuses %s", (_name, areas) => {
    expect(Episode.safeParse(withAreas(areas)).success).toBe(false);
  });
});
