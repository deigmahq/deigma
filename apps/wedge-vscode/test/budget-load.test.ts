/**
 * D10 — the wedge's budget, measured rather than promised.
 *
 * CLAUDE.md states three numbers: at most 2 % CPU, at most 300 MB RAM, at most 50 MB a day on
 * the wire. The first two had an enforcing guard whose readings nobody ever looked at, and the
 * third had nothing at all — no counter, no cap, no test. A budget nobody measures is a wish,
 * and this one matters more than most: the proxy and the extension sit in the middle of
 * somebody's working day, and a wedge that costs them anything they can feel is uninstalled
 * the same day.
 *
 * So this drives the real collector through a heavy working day and measures what comes out.
 * "Heavy" is deliberate: 120 accepted drafts is far more curation than a person does, so the
 * numbers here are an upper bound rather than a typical one.
 *
 * The traffic figure is measured here rather than reported in `wedge.status` on purpose. Adding
 * a field to WedgeStatusPayload means bumping SCHEMA_VERSION, and that literal sits in the
 * envelope of EVERY event type — a wire-wide version change for a diagnostic counter, days
 * before the first user. The checklist accepts either a load test or a counter; this is the load
 * test, and the counter stays a tracked follow-up (NOTES, D10).
 */
import type { Event } from "@mentat/schemas";
import { newDeviceSalt } from "@mentat/wedge-core";
import { describe, expect, it } from "vitest";

import { Collector } from "../src/collector";
import { FakeDocument, FakeHost } from "./helpers/fake-host";

const USER = "11111111-1111-4111-8111-111111111111";

/** A day of real work: more drafts than a person accepts, each a plausible size. */
const DRAFTS_PER_DAY = 120;
const BYTES_PER_DAY_BUDGET = 50 * 1024 * 1024;
const RSS_BUDGET_BYTES = 300 * 1024 * 1024;
const CPU_BUDGET_SHARE = 0.02;

function draftOfLines(n: number, seed: number): string {
  // Plausible code rather than filler: the payload carries counts and hashes, not content, but
  // the Kc ladder does real work over whatever it is given, and its cost depends on the shape.
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      i % 5 === 0
        ? `export function step${seed}_${i}(items: Item[]): number {`
        : i % 5 === 4
          ? "}"
          : `  const value${i} = items.reduce((sum, item) => sum + item.price * ${i + seed}, 0);`,
    );
  }
  return lines.join("\n");
}

function workingDay(): { events: Event[]; wallMs: number; cpuMs: number; rssBytes: number } {
  const host = new FakeHost();
  const events: Event[] = [];
  let clock = 1_700_000_000_000;
  const collector = new Collector(host, {
    userId: USER,
    salt: newDeviceSalt(),
    emit: (e: Event) => events.push(e),
    now: () => clock,
  });
  collector.activate();

  const cpuBefore = process.cpuUsage();
  const wallBefore = Date.now();

  for (let i = 0; i < DRAFTS_PER_DAY; i++) {
    const doc = new FakeDocument(`// file-${i}.ts\n`);
    host.active = doc;
    host.edit(doc, 1, 1, draftOfLines(30 + (i % 40), i));
    clock += 15_000; // the draft sits and is read
    host.scroll(doc);
    host.edit(doc, 2, 3, `  // reviewed pass ${i}`);
    clock += 5_000;
    host.run("deigma.acceptDraft");
    host.save(doc);
    clock += 60_000; // and then the person does something else for a minute
  }

  const cpu = process.cpuUsage(cpuBefore);
  return {
    events,
    wallMs: Math.max(1, Date.now() - wallBefore),
    cpuMs: (cpu.user + cpu.system) / 1000,
    rssBytes: process.memoryUsage().rss,
  };
}

describe("the wedge stays inside the budget it promises", () => {
  const day = workingDay();

  it("produces the events it should — otherwise the measurement is of nothing", () => {
    const drafts = day.events.filter((e) => e.type === "draft.curation");
    expect(drafts.length).toBe(DRAFTS_PER_DAY);
  });

  it("sends far less than 50 MB in a heavy day", () => {
    const bytes = Buffer.byteLength(JSON.stringify({ events: day.events }), "utf8");
    const perDraft = Math.round(bytes / DRAFTS_PER_DAY);
    // Reported so a regression is legible as a number rather than as a red cross.
    console.log(
      `wedge traffic: ${bytes} bytes for ${DRAFTS_PER_DAY} accepted drafts ` +
        `(${perDraft} B/draft, ${((bytes / BYTES_PER_DAY_BUDGET) * 100).toFixed(2)} % of the daily budget)`,
    );
    expect(bytes).toBeLessThan(BYTES_PER_DAY_BUDGET);
    // The real guard: an event carries counts and hashes, never content. A payload that grew to
    // kilobytes would mean something of the draft itself had started travelling.
    expect(perDraft).toBeLessThan(2048);
  });

  it("costs a fraction of one core while it does that work", () => {
    const modelledDayMs = DRAFTS_PER_DAY * 80_000;
    console.log(
      `wedge cpu: ${day.cpuMs.toFixed(0)} ms of CPU for a modelled ` +
        `${(modelledDayMs / 3_600_000).toFixed(1)} h working day ` +
        `(${((day.cpuMs / modelledDayMs) * 100).toFixed(4)} % — the budget is ${CPU_BUDGET_SHARE * 100} %)`,
    );
    // The work of a whole simulated day must finish in a small fraction of the time that day
    // takes: 120 drafts spread over ~2.5 hours of editing, done here in well under a second of
    // CPU. Anything approaching the wall clock of the test would mean the ladder had become the
    // dominant cost of typing.
    expect(day.cpuMs).toBeLessThan(2_000);
    // and the budget as CLAUDE.md states it: CPU spent against the day being modelled, not
    // against this test's own wall clock — the latter says nothing about what a person feels.
    expect(day.cpuMs / modelledDayMs).toBeLessThan(CPU_BUDGET_SHARE);
  });

  it("holds its memory budget", () => {
    console.log(`wedge rss: ${(day.rssBytes / 1024 / 1024).toFixed(0)} MB`);
    expect(day.rssBytes).toBeLessThan(RSS_BUDGET_BYTES);
  });
});
