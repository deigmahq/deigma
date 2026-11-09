/**
 * B4.1 — the Claude Code journal parser, against fixtures shaped like the real thing.
 *
 * The fixtures are synthetic: no prompt text, no code, no file paths from anybody's machine. What
 * they reproduce is the SHAPE, and every part of that shape was read off 291 real transcripts
 * (2026-09-07) rather than remembered — which matters, because the reader this replaces was
 * written from an imagined format and found zero sessions on a machine that had seven.
 *
 * Each test below is a mistake that shape actually invited.
 */
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseSession, readClaudeCodeSessions, sessionFiles } from "../src/journals/claude-code";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function rec(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

/** An assistant turn: a request, an iteration count, usage, and one tool call. */
function turn(
  at: string,
  tool: string,
  opts: { iterations?: number; cacheRead?: number; input?: Record<string, unknown> } = {},
): string {
  return rec({
    type: "assistant",
    timestamp: at,
    sessionId: SESSION,
    requestId: `req_${at}`,
    cwd: "/w",
    gitBranch: "main",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: opts.cacheRead ?? 50_000,
        // Confirmed on real files: an ARRAY of per-iteration usage records, not a number.
        iterations: Array.from({ length: opts.iterations ?? 1 }, () => ({ output_tokens: 1 })),
      },
      content: [{ type: "tool_use", name: tool, input: opts.input ?? {} }],
    },
  });
}

/** One session, no subagents: for the tests whose subject is arithmetic on a single turn. */
function bare(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "deigma-journal-"));
  const project = join(root, "-w-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${SESSION}.jsonl`), lines.join("\n"));
  return root;
}

function stand(): string {
  const root = mkdtempSync(join(tmpdir(), "deigma-journal-"));
  const project = join(root, "-w-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${SESSION}.jsonl`),
    [
      turn("2026-09-01T10:00:00.000Z", "Bash"),
      turn("2026-09-01T10:30:00.000Z", "mcp__acme__lookup"),
      turn("2026-09-01T11:00:00.000Z", "Skill"),
      // How instructions actually ARRIVE: the injection names itself. Reading or editing the same
      // file looks nothing like this, and must not count — see the test below.
      rec({
        type: "user",
        timestamp: "2026-09-01T10:00:01.000Z",
        sessionId: SESSION,
        isMeta: true,
        message: {
          role: "user",
          content:
            "<system-reminder>Contents of /w/project/CLAUDE.md (project instructions, checked into the codebase)</system-reminder>",
        },
      }),
      "", // journals end with a newline, and sometimes with half a line
    ].join("\n"),
  );
  // Both real layouts: an agent directly under subagents/, and agents a workflow spawned.
  const plain = join(project, SESSION, "subagents");
  const wf = join(project, SESSION, "subagents", "workflows", "wf_1234");
  mkdirSync(plain, { recursive: true });
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(plain, "agent-1.jsonl"), turn("2026-09-01T10:05:00.000Z", "Read"));
  writeFileSync(join(wf, "agent-2.jsonl"), turn("2026-09-01T10:06:00.000Z", "Grep"));
  writeFileSync(join(wf, "agent-3.jsonl"), turn("2026-09-01T10:07:00.000Z", "mcp__acme__write"));
  // Things that live beside sessions and are NOT sessions.
  writeFileSync(join(project, "journal.jsonl"), rec({ type: "note" }));
  writeFileSync(join(project, "agent-loose.jsonl"), turn("2026-09-01T10:08:00.000Z", "Bash"));
  return root;
}

describe("what counts as a session", () => {
  it("is the uuid transcript, and neither the workflow journal nor a subagent", () => {
    /** 273 of this machine's 291 transcripts were subagents. Reading them as sessions would have
     *  multiplied its volume by sixteen — an error that reaches a passport as a number. */
    const files = sessionFiles(stand());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\.jsonl$/);
  });
});

describe("what one session amounts to", () => {
  it("folds in its subagents from both layouts, and counts the workflows", () => {
    const s = readClaudeCodeSessions(stand());
    expect(s).toHaveLength(1);
    expect(s[0]!.subagents).toBe(3);
    expect(s[0]!.workflows).toBe(1);
    // A session that ran agents used the tool surface those agents used.
    expect(Object.keys(s[0]!.toolCalls).sort()).toEqual([
      "Bash",
      "Grep",
      "Read",
      "Skill",
      "mcp__acme__lookup",
      "mcp__acme__write",
    ]);
    expect(s[0]!.mcpTools).toEqual(["mcp__acme__lookup", "mcp__acme__write"]);
  });

  it("reads iterations as the length of the array, not as a number", () => {
    /** `usage.iterations` is a list of per-iteration usage records. Summing it as a number gave 0
     *  for 7 588 real records — a session that plainly iterated, reporting that it never did. */
    const s = readClaudeCodeSessions(bare([turn("2026-09-01T10:00:00.000Z", "Bash", { iterations: 9 })]));
    expect(s[0]!.iterations).toBe(9);
  });

  it("does not count cache reads as input tokens", () => {
    /** Every request re-reads the same context, so adding cache reads counts one conversation
     *  thousands of times: 3.5 billion "input tokens" for seven real sessions. */
    const s = readClaudeCodeSessions(
      bare([turn("2026-09-01T10:00:00.000Z", "Bash", { cacheRead: 9_000_000 })]),
    );
    expect(s[0]!.tokensIn).toBe(110); // input 10 + cache creation 100, and nothing re-read
  });

  it("survives an unreadable subagent, and not an unreadable session", () => {
    const root = stand();
    const project = join(root, "-w-project");
    const doomed = join(project, SESSION, "subagents", "agent-1.jsonl");
    chmodSync(doomed, 0o000);
    const s = readClaudeCodeSessions(root);
    expect(s).toHaveLength(1); // the session is still there
    chmodSync(doomed, 0o644);
    expect(parseSession(join(project, "does-not-exist.jsonl"))).toBeNull();
  });

  it("reads the environment E-1.0 asks about, from what the session USED", () => {
    const s = readClaudeCodeSessions(stand())[0]!;
    expect(s.mcpTools).toHaveLength(2);
    expect(s.reusableSkillCalls).toBe(1);
    expect(s.projectInstructionsLoaded).toBe(true);
    expect(s.branch).toBe("main");
    expect(s.requests).toBe(6); // one per turn, parent and subagents alike
    expect(s.durationMs).toBe(60 * 60 * 1000);
  });

  it("counts instructions as LOADED, and a read of the same file as not", () => {
    /**
     * The first detector matched any attachment naming CLAUDE.md, which is what happens when
     * somebody opens or edits their instructions — working ON them rather than UNDER them. On a
     * real machine it answered 6 of 33 for a person whose main project has had the file the whole
     * time; the count of sessions in that project was 17. Two different questions, one signal.
     */
    const read = readClaudeCodeSessions(
      bare([
        turn("2026-09-01T10:00:00.000Z", "Read"),
        rec({
          type: "attachment",
          timestamp: "2026-09-01T10:00:01.000Z",
          sessionId: SESSION,
          attachment: { type: "file", path: "/w/CLAUDE.md" },
        }),
      ]),
    );
    expect(read[0]!.projectInstructionsLoaded).toBe(false);

    /** A memory file below the project root arrives as its own attachment kind, and IS a load. */
    const nested = readClaudeCodeSessions(
      bare([
        turn("2026-09-01T10:00:00.000Z", "Read"),
        rec({
          type: "attachment",
          timestamp: "2026-09-01T10:00:01.000Z",
          sessionId: SESSION,
          attachment: { type: "nested_memory", path: "/w/sub/CLAUDE.md" },
        }),
      ]),
    );
    expect(nested[0]!.projectInstructionsLoaded).toBe(true);
  });

  it("counts the turns the person typed, not the calls the tool made", () => {
    /**
     * PtR-1.1's unit. Measured on this machine: 8163 API calls against a median of 6 typed turns
     * per session. A tool result wears the user role and a subagent's own conversation is not the
     * person typing, so neither counts.
     */
    const s = readClaudeCodeSessions(
      bare([
        rec({ type: "user", timestamp: "2026-09-01T10:00:00.000Z", sessionId: SESSION, message: { role: "user", content: "do the thing" } }),
        rec({ type: "user", timestamp: "2026-09-01T10:01:00.000Z", sessionId: SESSION, isMeta: true, message: { role: "user", content: "machinery" } }),
        rec({ type: "user", timestamp: "2026-09-01T10:02:00.000Z", sessionId: SESSION, isSidechain: true, message: { role: "user", content: "a subagent's own turn" } }),
        rec({ type: "user", timestamp: "2026-09-01T10:03:00.000Z", sessionId: SESSION, message: { role: "user", content: [{ type: "tool_result", content: "…" }] } }),
        rec({ type: "user", timestamp: "2026-09-01T10:04:00.000Z", sessionId: SESSION, message: { role: "user", content: [{ type: "text", text: "and now this" }] } }),
        turn("2026-09-01T10:05:00.000Z", "Bash"),
      ]),
    );
    expect(s[0]!.humanPrompts).toBe(2);
  });

  it("classifies verification runs on the device, and carries only the counts", () => {
    /** PtL-1.0. The command is read here and nowhere else; four category names travel. */
    const s = readClaudeCodeSessions(
      bare([
        turn("2026-09-01T10:00:00.000Z", "Bash", { input: { command: "uv run pytest -q" } }),
        turn("2026-09-01T10:01:00.000Z", "Bash", { input: { command: "npm run build" } }),
        turn("2026-09-01T10:02:00.000Z", "Bash", { input: { command: "ruff check ." } }),
        turn("2026-09-01T10:03:00.000Z", "Bash", { input: { command: "git status" } }),
      ]),
    );
    expect(s[0]!.verificationRuns).toEqual({ test: 1, build: 1, lint: 1, review: 0 });
  });
});

describe("where one session ends and the next begins", () => {
  it("splits a transcript where the person stopped, not where the file did", () => {
    /**
     * A transcript is not a session. Measured on 45 days of real ones: taking the file at face
     * value gives 7 sessions where the idle gap gives 27, one file spanned fifteen days, and the
     * process claims (floor: 10 sessions) would wait months instead of four weeks.
     */
    const root = bare([
      turn("2026-09-01T09:00:00.000Z", "Bash"),
      turn("2026-09-01T09:30:00.000Z", "Bash"),
      // five hours later: a different sitting
      turn("2026-09-01T14:30:00.000Z", "Read"),
      turn("2026-09-01T15:00:00.000Z", "Read"),
      // and the next day
      turn("2026-09-02T10:00:00.000Z", "Edit"),
    ]);
    const s = readClaudeCodeSessions(root);
    expect(s).toHaveLength(3);
    expect(s.map((x) => Object.keys(x.toolCalls))).toEqual([["Bash"], ["Read"], ["Edit"]]);
    // Durations are of the sitting, not of the file: half an hour each, not a day and a half.
    expect(s.slice(0, 2).map((x) => x.durationMs)).toEqual([1_800_000, 1_800_000]);
  });

  it("leaves a transcript that is one sitting with its own id", () => {
    /** Nothing re-identifies because somebody worked without a long break: an unsplit transcript
     *  keeps the session id it had. */
    const s = readClaudeCodeSessions(
      bare([turn("2026-09-01T09:00:00.000Z", "Bash"), turn("2026-09-01T09:30:00.000Z", "Bash")]),
    );
    expect(s).toHaveLength(1);
    expect(s[0]!.sessionId).toBe(SESSION);
  });

  it("gives every split stretch a distinct, stable id", () => {
    const root = bare([
      turn("2026-09-01T09:00:00.000Z", "Bash"),
      turn("2026-09-01T20:00:00.000Z", "Bash"),
    ]);
    const first = readClaudeCodeSessions(root).map((x) => x.sessionId);
    const again = readClaudeCodeSessions(root).map((x) => x.sessionId);
    expect(first).toEqual([`${SESSION}-1`, `${SESSION}-2`]);
    expect(again).toEqual(first); // re-reading the same disk gives the same ids
  });

  it("the gap is a parameter, so the definition lives in one place", () => {
    const lines = [turn("2026-09-01T09:00:00.000Z", "Bash"), turn("2026-09-01T12:00:00.000Z", "Bash")];
    expect(readClaudeCodeSessions(bare(lines), 4)).toHaveLength(1); // 3 h < 4 h: one sitting
    expect(readClaudeCodeSessions(bare(lines), 2)).toHaveLength(2); // 3 h > 2 h: two
  });

  it("counts a multi-tool turn as one request, not as several", () => {
    /** The same shape of error as summing cache reads: a turn that called three tools is one
     *  request and one set of tokens, and counting it three times inflates every rate. */
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-01T09:00:00.000Z",
      sessionId: SESSION,
      requestId: "req-1",
      gitBranch: "main",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, iterations: [{}] },
        content: [
          { type: "tool_use", name: "Bash", input: {} },
          { type: "tool_use", name: "Read", input: {} },
          { type: "tool_use", name: "Edit", input: {} },
        ],
      },
    });
    const s = readClaudeCodeSessions(bare([line]))[0]!;
    expect(s.requests).toBe(1);
    expect(s.iterations).toBe(1);
    expect(s.tokensIn).toBe(110);
    expect(s.toolCalls).toEqual({ Bash: 1, Read: 1, Edit: 1 });
  });
});
