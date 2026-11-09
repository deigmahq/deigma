/**
 * RD-19 contract: a landing carries what the Timeline's fill and the reading screen need —
 * `landed_at`, `kind`, `final`, `mode`, `grade`, `number` — and three of them are owner-only.
 *
 * Two promises are held here before any producer writes the fields:
 *   1. A snapshot scored before RD-19 still parses, and its dots carry NONE of the new fields —
 *      no default fills them in, because "final: false" or "mode: unattributed" invented for an
 *      old dot would be a fact nobody observed.
 *   2. The public projection drops the day, the grade and the PR number outright. A per-day public
 *      trail reads as presence monitoring; the dot keeps its week.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Landing, Snapshot, measuredFactsFromSnapshot, publicFacts } from "../src/snapshot";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/valid/snapshot/draft.json", import.meta.url)), "utf8"),
) as Record<string, any>;

const RD19_FIELDS = ["landed_at", "kind", "final", "mode", "grade", "number"] as const;
const OWNER_ONLY = ["landed_at", "grade", "number"] as const;

describe("RD-19 landing contract", () => {
  it("the golden snapshot carries every new field, final and provisional both", () => {
    const snapshot = Snapshot.parse(fixture);
    const dots = snapshot.history!.landings;
    // Precondition: the input is not empty, and it plants both sides of every distinction.
    expect(dots.length).toBe(snapshot.history!.n_episodes);
    for (const field of RD19_FIELDS) {
      expect(dots.some((d) => d[field] !== undefined && d[field] !== null), field).toBe(true);
    }
    expect(dots.some((d) => d.final === true)).toBe(true);
    expect(dots.some((d) => d.final === false)).toBe(true);
    expect(dots.some((d) => d.grade === null)).toBe(true);
    expect(dots.some((d) => d.grade && d.grade.y_lo !== d.grade.y_hi)).toBe(true);
  });

  it("a pre-RD-19 dot parses and gains no field it did not carry", () => {
    const old = { week: 3, lines: 90, ai: false, witnessed: true, reverted: false, repository: null };
    const parsed = Landing.parse(old);
    for (const field of RD19_FIELDS) expect(field in parsed, field).toBe(false);

    const body = JSON.parse(JSON.stringify(fixture));
    body.history.landings = body.history.landings.map((d: Record<string, unknown>) => {
      const copy = { ...d };
      for (const field of RD19_FIELDS) delete copy[field];
      return copy;
    });
    const dots = Snapshot.parse(body).history!.landings;
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) for (const field of RD19_FIELDS) expect(field in dot, field).toBe(false);
  });

  it("a day is a date, not a timestamp; a grade is an interval of categories", () => {
    const base = { week: 0, lines: 1, ai: false, witnessed: false, reverted: false, repository: null };
    expect(Landing.safeParse({ ...base, landed_at: "2026-08-11T09:30:00Z" }).success).toBe(false);
    expect(Landing.safeParse({ ...base, grade: { y_lo: 2 } }).success).toBe(false);
    expect(Landing.safeParse({ ...base, grade: { y_lo: 2, y_hi: 4 } }).success).toBe(false);
  });

  it("the public projection drops the day, the grade and the number, and keeps the rest", () => {
    const owner = measuredFactsFromSnapshot(Snapshot.parse(fixture));
    expect(owner.landingDots.length).toBeGreaterThan(0);
    expect(owner.landingDots.some((d) => d.landed_at && d.grade && d.number)).toBe(true);

    {
      const dots = publicFacts(owner, { claimProven: false }).landingDots;
      expect(dots.length).toBe(owner.landingDots.length);
      for (const dot of dots) {
        for (const field of OWNER_ONLY) expect(field in dot, field).toBe(false);
        expect(dot.repository).toBeNull();
      }
      dots.forEach((dot, i) => {
        const src = owner.landingDots[i]!;
        expect(dot.week).toBe(src.week);
        expect(dot.kind).toBe(src.kind);
        expect(dot.final).toBe(src.final);
        expect(dot.mode).toBe(src.mode);
      });
    }
  });
});
