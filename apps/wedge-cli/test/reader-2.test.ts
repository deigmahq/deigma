/**
 * Session reader cc-reader-2: the four defects SR2 found by measuring the first reader on real
 * transcripts (2026-10-09), each held by an oracle on planted truth.
 *
 * The fixture (fixtures/cc-reader-2/) repeats, record for record, the KEY SETS a probe read off
 * 137 088 real records — `promptSource`, `origin.kind`, `interruptedMessageId`, attachments of type
 * `hook_system_message` and `instructions`, the frames Claude Code wraps around what it injects —
 * with synthetic values. Every piece of text in it is a `CANARY_*`; none was copied from a real
 * log. What each record IS (typed, a notification, a local command, …) is planted, and the
 * counts below are that planting, not a reading of the code.
 */
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTranscript, READER_VERSION, userTurnKind, type Rec } from "../src/journals/claude-code";
import { forEachLine } from "../src/journals/lines";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "cc-reader-2", "0b6f0c1e-1111-4a2b-9c3d-000000000001.jsonl");
const SESSION = "0b6f0c1e-1111-4a2b-9c3d-000000000001";

/** The planted truth of the fixture. */
const PLANTED = {
  /** u-1 and u-5b (`promptSource: typed`), u-12 (`origin.kind: human`, no promptSource). NOT
   *  u-13: a record with neither field and plain text, inside a transcript whose other records
   *  carry `promptSource` — measured on real transcripts (SWE-chat canary, 2026-10-10), such a
   *  record is the machine's injected prose, not a turn. The fixture first planted it as typed
   *  ("a 2.0 record"); a 2.0 record is the frame rule only in a 2.0 transcript (the `legacy`
   *  case below). */
  typed: 3,
  /** u-9. */
  suggestions: 1,
  /** u-4 (the tool's frame AND `interruptedMessageId`, one interruption) and u-19 (frame only). */
  interrupts: 2,
  /** u-5b follows u-4; nothing typed follows u-19. */
  followupsAfterInterrupt: 1,
  /** a-3 after a test (verified); a-5 after a Write and no check (not); a-6 `pnpm test && git
   *  commit` (verified — the check precedes the commit in the same command). */
  commits: 3,
  commitsVerified: 2,
  /** What the first rule counted: every user record with text that is neither meta nor
   *  sidechain — 16 of them, four of which a person typed. */
  firstRuleCount: 16,
};

function project(lines: string[] | null, from: string = FIXTURE): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "deigma-reader2-"));
  const dir = join(root, "-home-dev-repo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${SESSION}.jsonl`);
  if (lines) writeFileSync(file, lines.join("\n"));
  else copyFileSync(from, file);
  return { root, file };
}

function fixtureRecords(): Rec[] {
  const out: Rec[] = [];
  forEachLine(FIXTURE, (line) => {
    try {
      out.push(JSON.parse(line) as Rec);
    } catch {
      // the fixture ends in a truncated line on purpose
    }
  });
  return out;
}

describe("D1 — a turn the person typed", () => {
  it("counts the typed turns and nothing the tool injected in the user role (oracle on planted truth)", () => {
    const { file } = project(null);
    const sessions = parseTranscript(file);
    expect(sessions, "input: the fixture is one session").toHaveLength(1);
    const s = sessions[0]!;
    expect(s.humanPrompts).toBe(PLANTED.typed);
    expect(s.suggestionsAccepted).toBe(PLANTED.suggestions);
  });

  it("the planted truth differs from what the first rule counted — the oracle can fail", () => {
    // The first reader's rule, verbatim: any user record with text, not meta, not sidechain.
    const firstRule = (rec: Rec): boolean => {
      const r = rec as Record<string, unknown>;
      if (rec.type !== "user" || r.isMeta === true || r.isSidechain === true) return false;
      const c = rec.message?.content;
      if (typeof c === "string") return c.trim().length > 0;
      return Array.isArray(c) && c.some((b) => !!b && typeof b === "object" && (b as { type?: string }).type === "text");
    };
    const records = fixtureRecords();
    expect(records.length, "input: records were read").toBeGreaterThan(30);
    expect(records.filter(firstRule)).toHaveLength(PLANTED.firstRuleCount);
    expect(PLANTED.firstRuleCount).not.toBe(PLANTED.typed);
  });

  it("decides by system/suggestion, then origin.kind, then promptSource, then the transcript — never by the words", () => {
    const user = (extra: Record<string, unknown>, content: unknown = "please fix it"): Rec =>
      ({ type: "user", timestamp: "2026-05-04T09:00:00Z", message: { role: "user", content }, ...extra }) as Rec;
    expect(userTurnKind(user({ promptSource: "typed" }))).toBe("typed");
    expect(userTurnKind(user({ promptSource: "system", origin: { kind: "human" } }))).toBeNull();
    expect(userTurnKind(user({ promptSource: "suggestion_accepted" }))).toBe("suggestion");
    expect(userTurnKind(user({ origin: { kind: "human" } }))).toBe("typed");
    expect(userTurnKind(user({ origin: { kind: "task-notification" } }))).toBeNull();
    expect(userTurnKind(user({ origin: { kind: "coordinator" } }))).toBeNull();
    expect(userTurnKind(user({}))).toBe("typed");
    expect(userTurnKind(user({}), true), "untagged prose in a tagged transcript").toBeNull();
    // A machine frame is never typed, whatever the fields claim.
    for (const frame of ["<task-notification>x", "<command-name>/clear", "<local-command-stdout>", "<bash-input>ls", "  [Request interrupted by user]"]) {
      expect(userTurnKind(user({ promptSource: "typed" }, frame)), frame).toBeNull();
      expect(userTurnKind(user({}, [{ type: "text", text: frame }])), frame).toBeNull();
    }
    // A tool result wears the user role and is not a turn.
    expect(userTurnKind(user({}, [{ type: "tool_result", content: "ok" }]))).toBeNull();
    expect(userTurnKind(user({ isCompactSummary: true }))).toBeNull();
  });

  it("volume is not skill: background work and tool retries do not move the count (T22d style)", () => {
    /** The first rule rose with how much background work somebody ran — every finished task
     *  posted a notification in the user role. Ten times the machinery, the same person. */
    const base = parseTranscript(project(null).file)[0]!;
    const noise: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const at = new Date(Date.UTC(2026, 4, 4, 9, 10, 10 + i)).toISOString();
      noise.push(JSON.stringify({ type: "user", message: { role: "user", content: `<task-notification>CANARY_${i}</task-notification>` }, promptSource: "system", origin: { kind: "task-notification" }, uuid: `n-${i}`, timestamp: at, sessionId: SESSION }));
      noise.push(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content: [{ type: "text", text: "CANARY" }], usage: { input_tokens: 1, output_tokens: 1 } }, requestId: `retry-${i}`, uuid: `r-${i}`, timestamp: at, sessionId: SESSION }));
      noise.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "CANARY" }] }, uuid: `tr-${i}`, timestamp: at, sessionId: SESSION }));
    }
    const lines = [...fixtureRecords().map((r) => JSON.stringify(r)), ...noise];
    const noisy = parseTranscript(project(lines).file)[0]!;
    expect(noisy.requests, "input: the machinery really grew").toBeGreaterThan(base.requests + 40);
    expect(noisy.humanPrompts).toBe(base.humanPrompts);
    expect(noisy.followupsAfterInterrupt).toBe(base.followupsAfterInterrupt);
  });
});

describe("D3 — instructions by their real shape", () => {
  it("instructions loaded: an instructions attachment naming a Project file; the tool's own memory is not one", () => {
    // The fixture loads only AutoMem — not the project's instructions.
    expect(parseTranscript(project(null).file)[0]!.projectInstructionsLoaded).toBe(false);
    const loaded = [
      JSON.stringify({ type: "attachment", attachment: { type: "instructions", files: [{ type: "AutoMem", path: "CANARY" }, { type: "Project", path: "CANARY", content: "CANARY" }] }, timestamp: "2026-05-04T09:00:00Z", sessionId: SESSION }),
    ];
    expect(parseTranscript(project(loaded).file)[0]!.projectInstructionsLoaded).toBe(true);
  });
});

describe("steering and verify-before-commit", () => {
  it("counts interruptions once each, and the typed turns that answered them", () => {
    const s = parseTranscript(project(null).file)[0]!;
    expect(s.interrupts).toBe(PLANTED.interrupts);
    expect(s.followupsAfterInterrupt).toBe(PLANTED.followupsAfterInterrupt);
  });

  it("a commit is verified only by a check after the agent's last edit", () => {
    const s = parseTranscript(project(null).file)[0]!;
    expect(s.commits).toBe(PLANTED.commits);
    expect(s.commitsVerified).toBe(PLANTED.commitsVerified);
  });
});

describe("what a session carries about where it came from", () => {
  it("the transcript's own id and the reader's version", () => {
    const s = parseTranscript(project(null).file)[0]!;
    expect(s.transcriptId).toBe(SESSION);
    expect(READER_VERSION).toBe("cc-reader-4");
  });
});

describe("fail-open", () => {
  it("a truncated tail, an unknown record type and a broken line leave the rest of the session", () => {
    const lines = fixtureRecords().map((r) => JSON.stringify(r));
    lines.splice(5, 0, "{not json", "", '{"type":');
    const s = parseTranscript(project(lines).file)[0]!;
    expect(s.humanPrompts).toBe(PLANTED.typed);
    expect(s.commits).toBe(PLANTED.commits);
  });
});

describe("D4 — reading a large transcript in bounded memory", () => {
  it("a 200 MB transcript is read under the 300 MB budget, and every typed turn in it is counted", () => {
    /**
     * Built from the fixture's shapes: tool results carrying ~200 KB of non-ASCII text each (the
     * real largest file was 111 MB, mostly tool output). Read whole, such a file is a 200 MB
     * UTF-16 string plus an array of its lines — past the budget before a single record is
     * parsed. The measurement runs in a child process so the test runner's own memory is not in it.
     */
    const { root, file } = project([]);
    const fd = openSync(file, "w");
    const blob = "ж".repeat(100_000); // 200 KB of UTF-8, 200 KB as a JS string
    let bytes = 0;
    let typed = 0;
    let i = 0;
    try {
      while (bytes < 200 * 1024 * 1024) {
        const at = new Date(Date.UTC(2026, 4, 4, 9, 0, 0) + i * 1000).toISOString();
        const line =
          i % 100 === 0
            ? JSON.stringify({ type: "user", promptSource: "typed", origin: { kind: "human" }, message: { role: "user", content: `CANARY_${i}` }, timestamp: at, sessionId: SESSION })
            : JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: blob }] }, timestamp: at, sessionId: SESSION });
        if (i % 100 === 0) typed += 1;
        bytes += writeSync(fd, `${line}\n`);
        i += 1;
      }
    } finally {
      closeSync(fd);
    }
    try {
      const run = spawnSync(process.execPath, ["--import", "tsx", join(here, "helpers", "parse-large.ts"), file], {
        cwd: join(here, ".."),
        encoding: "utf8",
        maxBuffer: 1 << 20,
      });
      expect(run.status, run.stderr).toBe(0);
      const out = JSON.parse(run.stdout) as { sessions: number; humanPrompts: number; peakMb: number };
      expect(out.sessions, "input: the large file is one session").toBe(1);
      expect(out.humanPrompts).toBe(typed);
      expect(out.peakMb).toBeLessThan(300);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * The typed-turn rule on the record shapes the SWE-chat study measured (2026-10-10). Each case is a
 * small transcript in Claude Code's real record shape with synthetic values and a planted count of
 * typed turns; the reader must count exactly that. The same cases are the study's canary
 * (validity/swechat reader_entry.ts), which also checks that the study's list of machine frames is
 * this reader's `MACHINE_FRAMES` and that both refuse any record carrying a tool result — so the
 * product and the study read one rule, held on every bundle the study builds, not only by this
 * comment (review 2026-10-10).
 */
describe("D1 — the typed-turn rule on measured record shapes (SWE-chat canary)", () => {
  type J = Record<string, unknown>;
  function transcript(build: (u: (extra: J, content: unknown, over?: J) => J, a: () => J, sys: () => J) => J[]): J[] {
    const base = { sessionId: SESSION, cwd: "/w", gitBranch: "main", version: "2.1.0", isSidechain: false };
    let n = 0;
    const at = (): string => new Date(Date.UTC(2026, 4, 4, 10, 0, n)).toISOString();
    const u = (extra: J, content: unknown, over: J = {}): J => {
      n += 1;
      return { ...base, type: "user", uuid: `u${n}`, parentUuid: n > 1 ? `x${n - 1}` : null, timestamp: at(), ...extra, ...over, message: { role: "user", content } };
    };
    const a = (): J => {
      n += 1;
      return { ...base, type: "assistant", uuid: `x${n}`, parentUuid: `u${n - 1}`, timestamp: at(), requestId: `r${n}`, message: { model: "claude-x", role: "assistant", content: [{ type: "text", text: "CANARY" }], usage: { input_tokens: 1, output_tokens: 1 } } };
    };
    const sys = (): J => {
      n += 1;
      return { ...base, type: "system", uuid: `s${n}`, parentUuid: null, timestamp: at(), content: "CANARY", level: "info" };
    };
    return build(u, a, sys);
  }
  const typed = { promptSource: "typed", origin: { kind: "human" } };
  const legacy = { version: "2.0.10" };
  const CASES: { name: string; planted: number; lines: J[] }[] = [
    {
      name: "typed baseline: a typed turn, a task notification, a local command",
      planted: 1,
      lines: transcript((u, a) => [
        u(typed, "CANARY_PROMPT"), a(),
        u({ promptSource: "system", origin: { kind: "task-notification" } }, "<task-notification>CANARY</task-notification>"),
        u({}, "<command-name>/clear</command-name>"),
      ]),
    },
    {
      name: "vscode_sdk: promptSource sdk with origin.kind human (the VS Code extension) is typed",
      planted: 2,
      lines: transcript((u, a) => [
        u({ promptSource: "sdk", origin: { kind: "human" }, entrypoint: "claude-vscode" }, "CANARY_PROMPT"), a(),
        u({ promptSource: "sdk", origin: { kind: "human" }, entrypoint: "claude-vscode" }, [{ type: "text", text: "CANARY_PROMPT" }]), a(),
      ]),
    },
    {
      name: "queued: a prompt typed while the agent was busy is typed, with or without an origin",
      planted: 3,
      lines: transcript((u, a) => [
        u(typed, "CANARY_PROMPT"), a(),
        u({ promptSource: "queued", origin: { kind: "human" } }, "CANARY_PROMPT"), a(),
        u({ promptSource: "queued" }, "CANARY_PROMPT"), a(),
      ]),
    },
    {
      name: "untagged_prose: untagged prose inside a tagged transcript is the machine's",
      planted: 1,
      lines: transcript((u, a, sys) => [
        u(typed, "CANARY_PROMPT"), a(), sys(),
        u({}, "CANARY machine-injected prose of some length"), a(),
      ]),
    },
    {
      name: "legacy: a transcript with neither field anywhere falls back to the frame rule",
      planted: 2,
      lines: transcript((u, a) => [
        u({}, "CANARY_PROMPT", legacy), a(),
        u({}, [{ type: "text", text: "[Request interrupted by user]" }], legacy),
        u({}, "CANARY_PROMPT", legacy), a(),
      ]),
    },
    {
      name: "teammate: a message from another agent of a team, in an untagged transcript, is not the person",
      planted: 1,
      lines: transcript((u, a) => [
        u({}, "CANARY_PROMPT", legacy), a(),
        u({}, '<teammate-message teammate_id="CANARY" color="blue">\nCANARY\n</teammate-message>', { ...legacy, teamName: "CANARY", agentName: "CANARY" }), a(),
      ]),
    },
    {
      name: "tool_result: a user record carrying a tool result is never typed, whatever text rides beside it",
      planted: 1,
      lines: transcript((u, a) => [
        u({}, "CANARY_PROMPT", legacy), a(),
        u({}, [{ type: "tool_result", tool_use_id: "t1", content: "CANARY" }, { type: "text", text: "Tool loaded." }], legacy), a(),
      ]),
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const { root, file } = project(c.lines.map((l) => JSON.stringify(l)));
      try {
        const sessions = parseTranscript(file);
        expect(sessions, "input: the transcript is one session").toHaveLength(1);
        expect(sessions[0]!.humanPrompts).toBe(c.planted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("explicit system and non-human origins are not the person; an accepted suggestion stays apart", () => {
    const lines = transcript((u, a) => [
      u(typed, "CANARY_PROMPT"), a(),
      u({ promptSource: "system" }, "CANARY prose the tool wrote"),
      u({ promptSource: "sdk", origin: { kind: "coordinator" } }, "CANARY coordinator"),
      u({ promptSource: "queued", origin: { kind: "peer" } }, "CANARY peer"),
      u({ promptSource: "sdk" }, "CANARY sdk without an origin"),
      u({ promptSource: "suggestion_accepted", origin: { kind: "human" } }, "CANARY_PROMPT suggested"), a(),
    ]);
    const { root, file } = project(lines.map((l) => JSON.stringify(l)));
    try {
      const s = parseTranscript(file)[0]!;
      expect(s.humanPrompts).toBe(1);
      expect(s.suggestionsAccepted).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
