/**
 * The scenarios of reading two agents, on the device: only Claude Code, only Codex,
 * both, a switch from one to the other, and an older CLI that never had the Codex reader. All
 * journals are SYNTHETIC (./helpers/two-agents.ts); the index itself is pooled and capped on the
 * server.
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionSummaryEvent } from "@mentat/schemas";
import { describe, expect, it } from "vitest";

import { markSent, planSync, type SyncState } from "../src/journal-sync";
import { agentsOnThisMachine, localBackfill } from "../src/local-backfill";
import { historyConsentLine } from "../src/messages";
import { codexRolloutLines, WORK } from "./helpers/two-agents";

const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";
const SALT = "c3luYy10ZXN0LXNhbHQtMzItYnl0ZXMtbG9uZy0tLS0tLQ==";
const HOUR = 3600_000;
const T0 = Date.UTC(2026, 9, 5, 12, 0); // the device went live
const NOW = T0 + 30 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const ENV = {} as NodeJS.ProcessEnv; // no $CODEX_HOME: ~/.codex under the test's home

function claude(home: string, id: string, at: number[]): void {
  const dir = join(home, ".claude", "projects", "-w-repo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(
    file,
    at
      .map((t, i) =>
        JSON.stringify({
          type: "assistant",
          timestamp: iso(t),
          sessionId: id,
          requestId: `req-${id}-${i}`,
          cwd: "/w/repo",
          message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
        }),
      )
      .join("\n"),
  );
  utimesSync(file, new Date(at.at(-1)!), new Date(at.at(-1)!));
}

function codex(home: string, thread: string, t0: number): void {
  const dir = join(home, ".codex", "sessions", "2026", "10", "05");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${thread}.jsonl`);
  const lines = codexRolloutLines(WORK.slice(0, 6), { t0, threadId: thread });
  writeFileSync(file, `${lines.join("\n")}\n`);
  const last = new Date(t0 + 5 * 30_000);
  utimesSync(file, last, last);
}

const CC = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"];
const CX = ["0199aaaa-0000-7000-8000-000000000001", "0199aaaa-0000-7000-8000-000000000002"];

/** The state THIS CLI's sign-in leaves. */
const fresh = (): SyncState => ({
  version: 1,
  user_id: USER,
  live_since: iso(T0),
  last_run_at: null,
  files: {},
  sent: {},
  reader_version: "cc-reader-4",
  reader_versions: { codex: "codex-reader-1" },
});
const plan = (home: string, state: SyncState, now = NOW) =>
  planSync({ state, userId: USER, salt: SALT, home, connectedRepos: [], now, env: ENV });
const agentsOf = (p: ReturnType<typeof plan>) => p.ready.map((r) => (r.event as SessionSummaryEvent).payload.agent).sort();
const newHome = () => mkdtempSync(join(tmpdir(), "deigma-two-"));

describe("scenario: only Claude Code", () => {
  it("reads as before; Codex is mentioned nowhere", async () => {
    const home = newHome();
    claude(home, CC[0]!, [T0 + HOUR, T0 + 2 * HOUR]);
    const p = plan(home, fresh());
    expect(agentsOf(p)).toEqual(["claude_code"]);
    expect(p.byAgent).toEqual({ claude_code: 1 });
    expect(agentsOnThisMachine(home, ENV)).toEqual(["claude_code"]);
    expect(historyConsentLine(agentsOnThisMachine(home, ENV))).not.toMatch(/Codex/);
    const h = await localBackfill({ userId: USER, home, consent: true, salt: SALT, env: ENV, now: () => new Date(NOW) });
    expect(h.byAgent).toEqual({ claude_code: 1 });
  });
});

describe("scenario: only Codex", () => {
  it("init's history and the sync read Codex; every event says agent codex", async () => {
    const home = newHome();
    codex(home, CX[0]!, T0 - 48 * HOUR); // history, before the sign-in
    codex(home, CX[1]!, T0 + HOUR); // after it
    const h = await localBackfill({ userId: USER, home, consent: true, salt: SALT, env: ENV, now: () => new Date(NOW) });
    expect(h.sessions).toBe(2);
    expect(h.byAgent).toEqual({ codex: 2 });
    expect(historyConsentLine(agentsOnThisMachine(home, ENV))).toMatch(/^Reading your Codex sessions/);
    const p = plan(home, fresh());
    expect(agentsOf(p)).toEqual(["codex"]); // the one after going live; the history pass read the other
    expect(p.ready[0]!.key.startsWith("codex/")).toBe(true);
  });
  it("$CODEX_HOME is where Codex lives when it is set", () => {
    const home = newHome();
    const elsewhere = newHome();
    codex(elsewhere, CX[0]!, T0 + HOUR);
    const p = planSync({ state: fresh(), userId: USER, salt: SALT, home, connectedRepos: [], now: NOW, env: { CODEX_HOME: join(elsewhere, ".codex") } });
    expect(agentsOf(p)).toEqual(["codex"]);
  });
});

describe("scenario: both in parallel", () => {
  it("both are read in one pass, each under its own reader, and their ids never meet", () => {
    const home = newHome();
    claude(home, CC[0]!, [T0 + HOUR, T0 + 2 * HOUR]);
    codex(home, CX[0]!, T0 + HOUR);
    const p = plan(home, fresh());
    expect(agentsOf(p)).toEqual(["claude_code", "codex"]);
    expect(p.byAgent).toEqual({ claude_code: 1, codex: 1 });
    const events = p.ready.map((r) => r.event as SessionSummaryEvent);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(2);
    expect(events.map((e) => e.payload.reader_version).sort()).toEqual(["cc-reader-4", "codex-reader-1"]);
  });
});

describe("scenario: Claude Code first, then a switch to Codex", () => {
  it("no reset: what was sent stays sent, and the new agent's sessions add to it", () => {
    const home = newHome();
    claude(home, CC[0]!, [T0 + HOUR, T0 + 2 * HOUR]);
    const first = plan(home, fresh(), T0 + 8 * HOUR);
    expect(agentsOf(first)).toEqual(["claude_code"]);
    const after = markSent(first.state, first.ready, T0 + 8 * HOUR);
    codex(home, CX[0]!, T0 + 10 * HOUR);
    const second = plan(home, after);
    expect(agentsOf(second)).toEqual(["codex"]);
    expect(second.counts.alreadySent).toBe(0); // the Claude file is unchanged: not even re-read
    expect(Object.keys(second.state.sent).some((k) => !k.startsWith("codex/"))).toBe(true);
  });
});

describe("scenario: an older CLI without the Codex reader", () => {
  const older = (): SyncState => {
    const { reader_versions: _, ...rest } = fresh();
    return rest;
  };
  it("after the update, the Codex history is read once, whole — and then not again", () => {
    const home = newHome();
    claude(home, CC[0]!, [T0 - 50 * HOUR, T0 - 49 * HOUR]); // read by the old CLI's history pass
    codex(home, CX[0]!, T0 - 48 * HOUR); // never read: the old CLI had no Codex reader
    const state = older();
    // the old CLI marked its Claude transcript as read
    const first = plan(home, state);
    expect(agentsOf(first)).toEqual(["codex"]);
    const next = markSent(first.state, first.ready, NOW);
    expect(next.reader_versions).toEqual({ codex: "codex-reader-1" });
    expect(plan(home, next, NOW + HOUR).ready).toHaveLength(0);
  });
  it("unless the person declined history: then nothing before going live is read, for any agent", () => {
    const home = newHome();
    codex(home, CX[0]!, T0 - 48 * HOUR);
    expect(plan(home, { ...older(), history_declined: true }).ready).toHaveLength(0);
  });
});

describe("scenario: Codex installed but never used", () => {
  it("no session, no line: the consent names only what is there", () => {
    const home = newHome();
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    claude(home, CC[0]!, [T0 + HOUR]);
    expect(agentsOnThisMachine(home, ENV)).toEqual(["claude_code"]);
    expect(plan(home, fresh()).byAgent).toEqual({ claude_code: 1 });
  });
});
