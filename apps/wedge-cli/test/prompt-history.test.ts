/**
 * The prompt history (`~/.claude/history.jsonl`) read on the device, schema 2.5.
 *
 * The records repeat the shape read off a real file on 2026-10-09 — `{display, pastedContents:
 * {<n>: {id, type, content?, contentHash?}}, timestamp (ms), project, sessionId}` — with synthetic
 * values; every piece of text is a CANARY. What each prompt IS (typed, a slash command, a paste of
 * so many lines, a correction) is planted, and the expected features are that planting.
 *
 * The same home also holds the cc-reader-2 transcript fixture, so the join is tested on the shape
 * it meets in the field: one session with both a transcript and history (the transcript wins),
 * sessions whose transcripts are gone (history fills them), old records with no session id.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Event, PromptHistoryEvent, SessionSummaryEvent } from "@mentat/schemas";
import { describe, expect, it } from "vitest";

import { historyFeatures, historyPrompt, PH_RULES, readPromptHistory } from "../src/journals/prompt-history";
import { DESCRIPTIVE_ON_WIRE, localBackfill } from "../src/local-backfill";

const here = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT_FIXTURE = join(here, "fixtures", "cc-reader-2", "0b6f0c1e-1111-4a2b-9c3d-000000000001.jsonl");
const SALT = "cHJvbXB0LWhpc3Rvcnktc2FsdC0zMi1ieXRlcy1sb25nLQ==";
const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";
const A = "0b6f0c1e-1111-4a2b-9c3d-000000000001"; // has a transcript
const B = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"; // transcript gone
const E = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60"; // still going
const NOW = Date.parse("2026-10-10T12:00:00Z");
const REMOTE = ["git", "@github.com:acme-fixture/widgets.git"].join("");
const CONNECTED = [{ repo_id: 123456, full_name: "acme-fixture/widgets" }];

const t = (iso: string) => Date.parse(iso);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `CANARY_PASTE_LINE_${i}`).join("\n");

function rec(display: string, at: number, project: string | null, sessionId: string | null, pasted: Record<string, unknown> = {}) {
  return {
    display,
    pastedContents: pasted,
    timestamp: at,
    ...(project ? { project } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function home(): { home: string; checkout: string } {
  const h = mkdtempSync(join(tmpdir(), "deigma-ph-"));
  const checkout = join(h, "work", "CANARY_PATH_widgets");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  writeFileSync(join(checkout, ".git", "config"), `[remote "origin"]\n\turl = ${REMOTE}\n`);
  const projects = join(h, ".claude", "projects", "-home-dev-repo");
  mkdirSync(projects, { recursive: true });
  copyFileSync(TRANSCRIPT_FIXTURE, join(projects, `${A}.jsonl`));
  const old = "/home/dev/CANARY_PATH_old";
  const history = [
    // A — the session that still has its transcript (2026-05-04 09:00–09:10).
    rec("Fix the parser CANARY_A1", t("2026-05-04T09:00:12Z"), "/home/dev/CANARY_PATH_repo", A),
    rec("no, keep the old signature CANARY_A2", t("2026-05-04T09:03:20Z"), "/home/dev/CANARY_PATH_repo", A),
    rec("/clear", t("2026-05-04T09:08:10Z"), "/home/dev/CANARY_PATH_repo", A),
    rec("!CANARY_A3_SHELL", t("2026-05-04T09:08:30Z"), "/home/dev/CANARY_PATH_repo", A),
    // D — old records that name no session: one project, one day.
    rec("CANARY_D1 hi", t("2026-01-15T08:41:00Z"), old, null),
    rec("/compact", t("2026-01-15T09:00:00Z"), old, null),
    // B — transcript gone; its first stretch (2026-02-11 14:03–14:48).
    rec("CANARY_B1 refactor the cache", t("2026-02-11T14:03:00Z"), checkout, B),
    rec("CANARY_B2 look at this [Pasted text #1 +30 lines]", t("2026-02-11T14:04:30Z"), checkout, B, { "1": { id: 1, type: "text", content: lines(30) } }),
    rec("wrong, use the LRU CANARY_B3", t("2026-02-11T14:05:00Z"), checkout, B),
    rec(`CANARY_B4 ${"x".repeat(600)}`, t("2026-02-11T14:20:00Z"), checkout, B),
    rec("/review", t("2026-02-11T14:21:00Z"), checkout, B),
    rec("/deploy-acme CANARY_B_SLASH", t("2026-02-11T14:22:00Z"), checkout, B),
    rec(`No, that's not it CANARY_B5 ${"y".repeat(70)}`, t("2026-02-11T14:45:00Z"), checkout, B),
    rec("[Image #1] CANARY_B6", t("2026-02-11T14:46:00Z"), checkout, B, { "1": { id: 1, type: "image", content: "CANARY_IMAGE_BASE64" } }),
    rec("CANARY_B7 [Pasted text #2 +250 lines]", t("2026-02-11T14:47:00Z"), checkout, B, { "2": { id: 2, type: "text", contentHash: "c0ffee00c0ffee00" } }),
    rec("CANARY_B8 here", t("2026-02-11T14:48:00Z"), checkout, B, { "3": { id: 3, type: "text", contentHash: "c0ffee11c0ffee11" } }),
    // B — a second stretch the next day.
    rec("CANARY_C1 again", t("2026-02-12T10:00:00Z"), checkout, B),
    // E — still going an hour ago: left for later.
    rec("CANARY_E1 now", NOW - 3600_000, checkout, E),
  ];
  writeFileSync(join(h, ".claude", "history.jsonl"), `${history.map((r) => JSON.stringify(r)).join("\n")}\n{"display":"CANARY_TRUNC`);
  return { home: h, checkout };
}

async function run() {
  const { home: h, checkout } = home();
  // The wire's shape once the descriptive fields travel (local-backfill `DESCRIPTIVE_ON_WIRE`);
  // what leaves while they do not is tested on its own below.
  const result = await localBackfill({ userId: USER, home: h, consent: true, salt: SALT, connectedRepos: CONNECTED, now: () => new Date(NOW), descriptiveOnWire: true });
  return { result, checkout, h };
}

const summaries = (events: Event[]) => events.filter((e): e is SessionSummaryEvent => e.type === "session.summary");
const histories = (events: Event[]) => events.filter((e): e is PromptHistoryEvent => e.type === "prompt.history");

describe("ph-1.0 — the features of a run of prompts (oracle on planted truth)", () => {
  it("a session known only from its history: every feature as planted", async () => {
    const { result } = await run();
    const first = histories(result.events).find((e) => e.payload.transcript_id === B && e.payload.duration_ms > 0);
    expect(first, "input: B's first stretch was emitted").toBeDefined();
    expect(first!.payload.features).toEqual({
      rules_version: "ph-1.0",
      typed_prompts: 8,
      slash_commands: [
        { name: "other", count: 1 },
        { name: "review", count: 1 },
      ],
      shell_commands: 0,
      pastes: { text_small: 0, text_medium: 1, text_large: 1, text_unknown: 1, images: 1 },
      prompt_length: { short: 6, medium: 1, long: 1 },
      gap_seconds: { p50: 60, p90: 1500 },
      corrective_followups: 1,
    });
    expect(first!.payload.duration_ms).toBe(45 * 60_000);
    expect(first!.payload.grouping).toBe("session");
    expect(first!.payload.repo_id).toBe(123456); // the project directory IS a connected repository
    expect(first!.payload.project_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(first!.origin).toBe("backfill");
    expect(first!.model).toMatchObject({ known: false });
    expect(first!.occurred_at).toBe("2026-02-11T14:03:00.000Z");
  });

  it("the corrective rule needs all three: a word from the list, a short prompt, a quick follow-up", () => {
    const p = (display: string, at: number) => historyPrompt({ display, timestamp: at, pastedContents: {} })!.prompt;
    const base = t("2026-02-11T14:00:00Z");
    const f = (second: string, gapMs: number) => historyFeatures([p("first CANARY", base), p(second, base + gapMs)]).corrective_followups;
    expect(f("no, the other one", 60_000)).toBe(1);
    expect(f("Нет, не так", 60_000)).toBe(1);
    expect(f("no, the other one", PH_RULES.correctiveMaxGapMs + 1000)).toBe(0); // too slow
    expect(f(`no ${"z".repeat(PH_RULES.correctiveMaxChars)}`, 60_000)).toBe(0); // too long
    expect(f("now the other one", 60_000)).toBe(0); // "now" is not "no"
    // The first prompt of a session corrects nothing.
    expect(historyFeatures([p("no, start over", base)]).corrective_followups).toBe(0);
  });

  it("a single prompt has no gap — null, not zero", () => {
    const one = historyPrompt({ display: "CANARY", timestamp: t("2026-02-11T14:00:00Z"), pastedContents: {} })!.prompt;
    expect(historyFeatures([one]).gap_seconds).toBeNull();
  });
});

describe("joining the history with the transcripts", () => {
  it("a session with a transcript travels once, as a session.summary carrying its history features", async () => {
    const { result } = await run();
    const a = summaries(result.events).filter((e) => e.payload.transcript_id === A);
    expect(a, "input: A was read from its transcript").toHaveLength(1);
    expect(histories(result.events).filter((e) => e.payload.transcript_id === A)).toHaveLength(0);
    expect(a[0]!.payload.prompt_history).toEqual({
      rules_version: "ph-1.0",
      typed_prompts: 2,
      slash_commands: [{ name: "clear", count: 1 }],
      shell_commands: 1,
      pastes: { text_small: 0, text_medium: 0, text_large: 0, text_unknown: 0, images: 0 },
      prompt_length: { short: 2, medium: 0, long: 0 },
      gap_seconds: { p50: 188, p90: 188 },
      corrective_followups: 1,
    });
    // The transcript wins: the typed count that PtR reads is the transcript's, not the history's.
    // The fixture's planted typed turns (reader-2.test.ts PLANTED.typed: u-1, u-5b, u-12).
    expect(a[0]!.payload.human_prompts).toBe(3);
    expect(a[0]!.payload.reader_version).toBe("cc-reader-4");
    expect(a[0]!.payload.steering).toEqual({ interrupts: 2, followups_after_interrupt: 1 });
    expect(a[0]!.payload.commit_checks).toEqual({ commits: 3, verified_after_last_edit: 2 });
    expect(a[0]!.payload.suggestions_accepted).toBe(1);
  });

  it("history fills what the transcripts no longer hold — split by the idle gap, the open stretch left for later", async () => {
    const { result } = await run();
    const h = histories(result.events);
    expect(h.filter((e) => e.payload.transcript_id === B)).toHaveLength(2);
    expect(h.filter((e) => e.payload.transcript_id === E)).toHaveLength(0);
    // D's project is not a connected repository: counted on the device, never sent (below).
    expect(h.filter((e) => e.payload.grouping === "project_day")).toHaveLength(0);
    expect(result.historyOnly).toBe(3);
    expect(result.historyOnlySent).toBe(2);
    expect(result.sessions).toBe(1);
  });

  it("no prompt.history event leaves for a project that is not a connected repository (review 2026-10-10)", async () => {
    const { home: h } = home();
    // Nothing connected: every history-only session binds to nothing, and none of them travels —
    // not its date, not its duration, not its project hash.
    const none = await localBackfill({ userId: USER, home: h, consent: true, salt: SALT, connectedRepos: [], now: () => new Date(NOW), descriptiveOnWire: true });
    expect(none.historyOnly, "input: the history knows sessions the transcripts no longer hold").toBe(3);
    expect(histories(none.events)).toEqual([]);
    // Connected: exactly the connected project's sessions travel, each naming its repository.
    const some = await localBackfill({ userId: USER, home: h, consent: true, salt: SALT, connectedRepos: CONNECTED, now: () => new Date(NOW), descriptiveOnWire: true });
    const sent = histories(some.events);
    expect(sent).toHaveLength(2);
    for (const e of sent) {
      expect(e.payload.repo_id).toBe(123456);
      expect(e.payload.project_hash).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("while the descriptive fields wait for a server consumer, none of them leaves (DESCRIPTIVE_ON_WIRE off)", async () => {
    expect(DESCRIPTIVE_ON_WIRE, "the shipped default").toBe(false);
    const { home: h } = home();
    const r = await localBackfill({ userId: USER, home: h, consent: true, salt: SALT, connectedRepos: CONNECTED, now: () => new Date(NOW) });
    const s = summaries(r.events);
    expect(s, "input: the transcript was read").toHaveLength(1);
    expect(r.historyOnly, "input: the history knows older sessions").toBe(3);
    expect(histories(r.events)).toEqual([]);
    expect(r.historyOnlySent).toBe(0);
    const p = s[0]!.payload;
    // The reader's identity travels — the server reads it to supersede the old reading...
    expect(p.reader_version).toBe("cc-reader-4");
    expect(p.transcript_id).toBe(A);
    // ...and the descriptive fields are null: not sent, never zero.
    expect([p.prompt_history, p.steering, p.commit_checks, p.suggestions_accepted]).toEqual([null, null, null, null]);
    // The count PtR reads does not depend on the flag.
    expect(p.human_prompts).toBe(3);
  });

  it("a second history pass is a no-op: the same ids", async () => {
    const { home: h } = home();
    const pass = () =>
      localBackfill({ userId: USER, home: h, consent: true, salt: SALT, connectedRepos: CONNECTED, now: () => new Date(NOW), descriptiveOnWire: true });
    const once = await pass();
    const twice = await pass();
    expect(once.events.length, "input: events were built").toBeGreaterThanOrEqual(3);
    expect(twice.events.map((e) => e.event_id)).toEqual(once.events.map((e) => e.event_id));
  });

  it("no history file: sessions are read as before, with prompt_history null — not read, not zero", async () => {
    const h = mkdtempSync(join(tmpdir(), "deigma-ph-none-"));
    const projects = join(h, ".claude", "projects", "-home-dev-repo");
    mkdirSync(projects, { recursive: true });
    copyFileSync(TRANSCRIPT_FIXTURE, join(projects, `${A}.jsonl`));
    const r = await localBackfill({ userId: USER, home: h, consent: true, salt: SALT, now: () => new Date(NOW) });
    const s = summaries(r.events);
    expect(s, "input: the transcript was read").toHaveLength(1);
    expect(s[0]!.payload.prompt_history).toBeNull();
    expect(histories(r.events)).toHaveLength(0);
  });
});

describe("what leaves the machine (Zero Content Leakage)", () => {
  /** Every text in the fixture home — transcript and history — is a CANARY_* token. */
  const CANARIES = [
    "CANARY_A1", "CANARY_A2", "CANARY_A3_SHELL", "CANARY_B1", "CANARY_B2", "CANARY_B3", "CANARY_B4", "CANARY_B5",
    "CANARY_B6", "CANARY_B7", "CANARY_B8", "CANARY_C1", "CANARY_D1", "CANARY_E1", "CANARY_B_SLASH", "CANARY_PASTE_LINE_0",
    "CANARY_IMAGE_BASE64", "CANARY_PATH_widgets", "CANARY_PATH_old", "CANARY_PATH_repo", "CANARY_PROMPT_7f3",
    "CANARY_OLD", "CANARY_NEW_LINE_A", "CANARY_FILE_BODY", "CANARY_TEST_NAME", "CANARY_STDERR", "CANARY_COMMIT_MSG_1",
    "CANARY_TASK_1", "CANARY_HOOK_OUT", "CANARY_HOOK", "CANARY_TITLE", "CANARY_LAST", "CANARY_EMAIL", "CANARY_ORG",
    "CANARY_ACCOUNT", "CANARY_OWNER", "CANARY_REPO", "CANARY_MEMORY", "CANARY_ARGS", "CANARY_SHELL", "CANARY_QUEUED",
    "c0ffee00c0ffee00", "deploy-acme",
  ];

  it("no canary, no path, no hash of any of them is in what is sent", async () => {
    const { result, checkout } = await run();
    const wire = JSON.stringify(result.events);
    expect(result.events.length, "input: events were built").toBeGreaterThanOrEqual(3);
    expect(wire).not.toMatch(/CANARY/);
    for (const c of CANARIES) expect(wire, c).not.toContain(c);
    expect(wire).not.toContain(checkout);
    // No 64-hex anywhere — a session/history event carries no content hash at all.
    expect(wire).not.toMatch(/[0-9a-f]{64}/);
    // And not a hash of a canary either: unsalted, or salted with this device's salt.
    for (const c of CANARIES) {
      for (const h of [createHash("sha256").update(c).digest("hex"), createHash("sha256").update(SALT).update(c).digest("hex")]) {
        expect(wire).not.toContain(h.slice(0, 12));
      }
    }
  });

  it("reads only the record's own keys, and of a paste only its id, type and text — never its hash", () => {
    const seen = new Set<string>();
    const watched = <T extends object>(v: T): T =>
      new Proxy(v, {
        get(target, key, receiver) {
          if (typeof key === "string") seen.add(key);
          const out = Reflect.get(target, key, receiver) as unknown;
          return out && typeof out === "object" ? watched(out as object) : out;
        },
      });
    historyPrompt(
      watched({
        display: "CANARY [Pasted text #1 +3 lines]",
        pastedContents: { "1": { id: 1, type: "text", contentHash: "c0ffee", content: "a\nb\nc" } },
        timestamp: 1,
        project: "/CANARY",
        sessionId: A,
        somethingElse: "CANARY_NEVER",
      }),
    );
    expect(seen.size, "input: the record was read").toBeGreaterThan(3);
    expect(seen.has("contentHash")).toBe(false);
    expect(seen.has("somethingElse")).toBe(false);
  });
});

describe("fail-open", () => {
  it("a broken line, a truncated tail and records of another shape leave the rest", () => {
    const h = mkdtempSync(join(tmpdir(), "deigma-ph-broken-"));
    const file = join(h, "history.jsonl");
    writeFileSync(
      file,
      [
        "{not json",
        JSON.stringify({ display: "CANARY ok", timestamp: t("2026-02-11T14:00:00Z"), sessionId: B }),
        JSON.stringify({ unrelated: true }),
        JSON.stringify({ display: "CANARY no time", sessionId: B }),
        JSON.stringify({ display: "", pastedContents: {}, timestamp: 5, sessionId: B }),
        '{"display":"CANARY_TRUNC',
      ].join("\n"),
    );
    const groups = readPromptHistory(file);
    expect(groups.get(B)?.prompts).toHaveLength(1);
    expect(readPromptHistory(join(h, "missing.jsonl")).size).toBe(0);
  });
});
