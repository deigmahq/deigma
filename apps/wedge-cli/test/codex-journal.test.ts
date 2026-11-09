/**
 * Schema 2.10 — the Codex journal reader, on SYNTHETIC rollouts in the real shape
 * (./helpers/two-agents.ts says where the shape comes from). No content of anybody's session is
 * in this file: every prompt, path and command is invented.
 */
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEVICE_PRACTICES, expressible, SessionSummaryEvent } from "@mentat/schemas";
import { newDeviceSalt } from "@mentat/wedge-core";
import { describe, expect, it } from "vitest";

import { parseTranscript } from "../src/journals/claude-code";
import {
  changedLines,
  codexHome,
  codexMode,
  codexSessionFiles,
  CODEX_READER_VERSION,
  commandText,
  parseRollout,
  readCodexSessions,
} from "../src/journals/codex";
import { journalSessionEvent } from "../src/local-backfill";
import { claudeTranscript, CODEX_ID, codexHomeWith, codexRolloutLines, WORK, type Step } from "./helpers/two-agents";

const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";

describe("where Codex keeps its sessions", () => {
  it("$CODEX_HOME wins over ~/.codex", () => {
    expect(codexHome("/h", { CODEX_HOME: "/elsewhere" })).toBe("/elsewhere");
    expect(codexHome("/h", {})).toBe(join("/h", ".codex"));
  });
  it("finds .jsonl and .jsonl.zst rollouts in the dated tree, and nothing on a machine without Codex", () => {
    const plain = codexHomeWith(codexRolloutLines(WORK));
    const packed = codexHomeWith(codexRolloutLines(WORK), { zst: true });
    expect(codexSessionFiles(plain.home)).toEqual([plain.file]);
    expect(codexSessionFiles(packed.home)).toEqual([packed.file]);
    expect(codexSessionFiles("/nonexistent/codex")).toEqual([]);
  });
});

describe("one rollout, read", () => {
  for (const zst of [false, true]) {
    it(`${zst ? ".jsonl.zst" : ".jsonl"}: counts, durations, tools, model, tokens, typed turns`, () => {
      const { file } = codexHomeWith(codexRolloutLines(WORK), { zst });
      const sessions = parseRollout(file)!;
      expect(sessions).toHaveLength(1);
      const s = sessions[0]!;
      expect(s.agent).toBe("codex");
      expect(s.sessionId).toBe(`codex-${CODEX_ID}`);
      expect(s.transcriptId).toBe(CODEX_ID);
      expect(s.humanPrompts).toBe(2);
      // One response per tool step: 13 non-prompt steps.
      expect(s.requests).toBe(13);
      expect(s.toolCalls).toEqual({ exec: 13 });
      expect(s.tokensIn).toBe(13 * 10); // input minus the cached part
      expect(s.tokensOut).toBe(13 * 5);
      expect(s.model).toBe("gpt-5.5-sol");
      expect(s.durationMs).toBe(14 * 30_000);
      expect(s.commits).toBe(2);
      expect(s.verificationRuns).toEqual({ test: 2, build: 0, lint: 0, review: 0 });
      expect(s.transcript).toMatch(/^codex\//);
    });
  }

  it("the idle gap splits a thread into sessions, as for Claude Code", () => {
    const morning = codexRolloutLines(WORK.slice(0, 3));
    const evening = codexRolloutLines(WORK.slice(0, 3), { t0: Date.parse("2026-10-01T20:00:00Z") }).slice(2);
    const { file } = codexHomeWith([...morning, ...evening]);
    const sessions = parseRollout(file)!;
    expect(sessions.map((s) => s.sessionId)).toEqual([`codex-${CODEX_ID}-1`, `codex-${CODEX_ID}-2`]);
  });

  it("an empty or broken file holds no session; a partial last line is skipped", () => {
    const { file } = codexHomeWith([...codexRolloutLines(WORK.slice(0, 2)), '{"timestamp": "2026-10-01T10:']);
    expect(parseRollout(file)!).toHaveLength(1);
    expect(parseRollout(codexHomeWith([]).file)).toEqual([]);
  });

  it("a compressed file that cannot be decompressed is counted as not read, never a crash", () => {
    const { home, file } = codexHomeWith(["not zstd at all"], { name: "rollout-bad.jsonl" });
    // a plain text file named .zst: neither decoder accepts it
    const bad = `${file}.zst`;
    renameSync(file, bad);
    const read = readCodexSessions(home);
    expect(read).toMatchObject({ files: 1, unreadable: 1, sessions: [] });
  });
});

describe("what the rules read from Codex records", () => {
  it("the shell script of `[shell, -lc, script]`, else the argv", () => {
    expect(commandText(["/bin/zsh", "-lc", "npm test"])).toBe("npm test");
    expect(commandText(["bash", "-c", "ls"])).toBe("ls");
    expect(commandText(["git", "status"])).toBe("git status");
  });
  it("bypass is no approval AND no sandbox; a granular policy can ask", () => {
    expect(codexMode({ approval_policy: "never", sandbox_policy: { type: "danger-full-access" } })).toBe("bypassPermissions");
    expect(codexMode({ approval_policy: "never", sandbox_policy: { type: "workspace-write" } })).toBe("default");
    expect(codexMode({ approval_policy: "on-request", sandbox_policy: { type: "danger-full-access" } })).toBe("default");
    expect(codexMode({ approval_policy: { granular: { sandbox_approval: true } }, sandbox_policy: { type: "workspace-write" } })).toBe("default");
    expect(codexMode({})).toBeNull();
  });
  it("lines changed: a new file's length, an update's larger side per hunk", () => {
    expect(changedLines({ type: "add", content: "a\nb\nc" })).toBe(3);
    expect(changedLines({ type: "update", unified_diff: "--- a\n+++ b\n@@ -1,2 +1,3 @@\n x\n-y\n+y1\n+y2\n@@ -9 +10 @@\n-z\n" })).toBe(3);
  });
  it("bypass mode makes permissions_on a miss and a risky command an unconfirmed one", () => {
    const s = parseRollout(codexHomeWith(codexRolloutLines(WORK, { bypass: true })).file)![0]!;
    expect(s.habits.permissions_on).toEqual({ opportunities: 1, hits: 0 });
    expect(s.habits.risky_confirmed).toEqual({ opportunities: 1, hits: 0 });
  });
  it("a plan mode, when Codex names one, is a plan before the first edit", () => {
    const s = parseRollout(codexHomeWith(codexRolloutLines(WORK, { plan: true })).file)![0]!;
    expect(s.habits.plan_complex).toEqual({ opportunities: 1, hits: 1 });
  });
  it("an aborted turn is an interruption; the next typed turn follows it", () => {
    const steps: Step[] = [{ kind: "prompt", text: "fix it" }, { kind: "interrupt" }, { kind: "prompt", text: "fix the other thing" }];
    const s = parseRollout(codexHomeWith(codexRolloutLines(steps)).file)![0]!;
    expect([s.interrupts, s.followupsAfterInterrupt]).toEqual([1, 1]);
  });
});

describe("decision 2: a practice Codex cannot express is no occasion, never a miss", () => {
  it("security_review and independent_review are null on a Codex session that edited 257 lines of code", () => {
    const s = parseRollout(codexHomeWith(codexRolloutLines(WORK)).file)![0]!;
    for (const key of DEVICE_PRACTICES) {
      if (!expressible("codex", key)) expect(s.habits[key], key).toBeNull();
    }
    // The same work in Claude Code IS an occasion of both (and a miss).
    const c = parseTranscript(claudeTranscript(WORK).file)[0]!;
    expect(c.habits.security_review).toEqual({ opportunities: 1, hits: 0 });
    expect(c.habits.independent_review).toEqual({ opportunities: 1, hits: 0 });
  });
});

describe("parity (plan rule 3): the same work in both agents gives the same habit counts", () => {
  it("every practice expressible in both agrees, occasion for occasion and hit for hit", () => {
    const claude = parseTranscript(claudeTranscript(WORK).file)[0]!;
    const codex = parseRollout(codexHomeWith(codexRolloutLines(WORK)).file)![0]!;
    const compared: string[] = [];
    for (const key of DEVICE_PRACTICES) {
      if (!expressible("codex", key) || !expressible("claude_code", key)) continue;
      expect(codex.habits[key], key).toEqual(claude.habits[key]);
      if (claude.habits[key]) compared.push(key);
    }
    // The planted work must actually exercise the rules: a parity over nulls proves nothing.
    expect(compared.length).toBeGreaterThanOrEqual(12);
    expect(compared).toEqual(
      expect.arrayContaining([
        "permissions_on",
        "risky_confirmed",
        "dependency_audit",
        "tests_after_edit",
        "tests_with_code",
        "saw_diff_before_commit",
        "explore_before_edit",
        "plan_complex",
        "names_files",
        "clear_goal",
        "gives_context",
        "located_corrections",
      ]),
    );
  });
  it("and so does the same work done with permissions off", () => {
    const claude = parseTranscript(claudeTranscript(WORK, { mode: "bypassPermissions" }).file)[0]!;
    const codex = parseRollout(codexHomeWith(codexRolloutLines(WORK, { bypass: true })).file)![0]!;
    for (const key of ["permissions_on", "risky_confirmed"] as const) expect(codex.habits[key], key).toEqual(claude.habits[key]);
  });
});

describe("the wire", () => {
  it("a Codex session travels as session.summary with agent codex and reader codex-reader-1, counts only", () => {
    const s = parseRollout(codexHomeWith(codexRolloutLines(WORK)).file)![0]!;
    const built = journalSessionEvent(s, { userId: USER, salt: newDeviceSalt(), connectedRepos: [], origin: "backfill" })!;
    const e = SessionSummaryEvent.parse(built.event);
    expect(e.payload.agent).toBe("codex");
    expect(e.payload.reader_version).toBe(CODEX_READER_VERSION);
    expect(e.payload.transcript_id).toBe(CODEX_ID);
    expect(e.payload.session_id).toBe(`codex-${CODEX_ID}`);
    expect(e.model).toEqual({ family: "gpt", name: "gpt-5.5-sol", generation_tag: "gpt-5.5" });
    const wire = JSON.stringify(e);
    for (const word of ["parser.ts", "parseLine", "left-pad", "npm audit", "/nonexistent", "empty input"]) {
      expect(wire, word).not.toContain(word);
    }
  });
  it("its event id never meets a Claude Code session's", () => {
    const salt = newDeviceSalt();
    const c = parseTranscript(claudeTranscript(WORK).file)[0]!;
    const x = parseRollout(codexHomeWith(codexRolloutLines(WORK, { threadId: "aaaaaaaa-1111-4222-8333-444444444444" })).file)![0]!;
    const a = journalSessionEvent(c, { userId: USER, salt, connectedRepos: [], origin: "backfill" })!.event;
    const b = journalSessionEvent(x, { userId: USER, salt, connectedRepos: [], origin: "backfill" })!.event;
    expect(a.event_id).not.toBe(b.event_id);
  });
});

// Local only: the founder's own Codex sessions, if this machine has them. COUNTS ONLY — nothing of
// a session's content is printed, asserted against or kept. Skipped where there is no ~/.codex.
const real = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
const hasReal = existsSync(real) && statSync(real).isDirectory() && readdirSync(real).length > 0;
describe.skipIf(!hasReal)("local only: this machine's real Codex sessions (counts only)", () => {
  it("every rollout is read, and the counts are consistent", () => {
    const read = readCodexSessions(process.env.CODEX_HOME || join(homedir(), ".codex"));
    expect(read.files).toBeGreaterThan(0);
    expect(read.unreadable).toBe(0);
    expect(read.sessions.length).toBeGreaterThanOrEqual(read.files - read.unreadable > 0 ? 1 : 0);
    for (const s of read.sessions) {
      expect(s.agent).toBe("codex");
      expect(s.endedAt >= s.startedAt).toBe(true);
      expect(s.humanPrompts).toBeGreaterThanOrEqual(0);
      for (const [k, v] of Object.entries(s.habits)) {
        if (k === "rules_version" || !v) continue;
        const c = v as { opportunities: number; hits: number };
        expect(c.hits).toBeLessThanOrEqual(c.opportunities);
      }
    }
    // Counts only.
    console.log(`codex local: ${read.files} files, ${read.unreadable} unreadable, ${read.sessions.length} sessions`);
  });
});
