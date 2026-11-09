// Copy v4 in the terminal: what `init`, `history`, `status` and `pulse` print.
//
// Two kinds of test. The first pins the sentences the copy deck approved (the CLI table). The
// second is the word rule over EVERYTHING the CLI can print — the rendered output of every
// state, and every string literal main.ts hands to the console: no "passport", none of the inside
// of the program ("landing", "carrier", "witness", "applicable set", "wedge"), and no setup
// imperative. Code identifiers are exempt; the rule is about what a person reads. Held by
// mutation: the word put back must fail this.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderPulse, weeklyPulse } from "@mentat/coach";
import type { PassportView, Snapshot } from "@mentat/schemas";
import { PassportView as PassportViewSchema } from "@mentat/schemas";
import { describe, expect, it } from "vitest";

import {
  ALREADY_SIGNED_OUT_LINE,
  connectedLines,
  historyLines,
  HISTORY_CONSENT_LINE,
  historyConsentLine,
  NOTIFY_ADDED_LINE,
  NOTIFY_PRESENT_LINE,
  NOTIFY_TAKEN_LINE,
  PROXY_SESSION_ENDED_LINE,
  PROXY_SIGNED_OUT_LINE,
  queuedSentLine,
  SESSION_ENDED_LINE,
  SIGNED_OUT_DONE_LINE,
  SIGNED_OUT_LINE,
  signedInLine,
  USAGE_LINE,
  webBaseUrlFor,
  type HistoryOutcome,
} from "../src/messages";
import { renderStatus } from "../src/status";

const WEB = "https://deigma.net";

describe("npx deigma init, after the code is approved (copy v4)", () => {
  it("says what was read, how new sessions count, and where to see it", () => {
    const lines = connectedLines({
      handle: "octocat",
      history: { kind: "read", sessions: 42, outside: 3, sent: true },
      webBaseUrl: WEB,
    });
    expect(lines).toEqual([
      "Connected as @octocat. Read 42 Claude Code sessions. New sessions count when run through `deigma proxy -- <your MCP server>`, or after `npx deigma sync`.",
      "3 were in repositories Deigma doesn't read.",
      "See it: https://deigma.net/dashboard · Your week: npx deigma pulse",
    ]);
  });

  it("never says 'Read 0': a pass that found nothing or was skipped says that instead", () => {
    for (const history of [
      { kind: "nothing", reason: "nothing_found" },
      { kind: "skipped" },
      { kind: "unreachable" },
    ] as HistoryOutcome[]) {
      const text = connectedLines({ handle: "octocat", history, webBaseUrl: WEB }).join("\n");
      expect(text).toContain("Connected as @octocat.");
      expect(text).not.toMatch(/Read 0/);
      expect(text).toContain("See it: https://deigma.net/dashboard");
    }
  });

  it("says when the sessions read could not be sent yet", () => {
    const text = historyLines({ kind: "read", sessions: 1, outside: 0, sent: false }).join("\n");
    expect(text).toContain("Read 1 Claude Code session.");
    expect(text).toContain("couldn't be sent yet");
  });

  it("says how many older sessions the prompt history alone knows, and how many of them stay on this machine", () => {
    const line = (older: number, olderSent: number) =>
      historyLines({ kind: "read", sessions: 1, outside: 0, sent: true, older, olderSent }).at(-1);
    expect(line(39, 0)).toBe("39 older sessions are known only from your prompt history; they stay on this machine.");
    expect(line(1, 0)).toBe("1 older session is known only from your prompt history; it stays on this machine.");
    expect(line(3, 2)).toBe("3 older sessions are known only from your prompt history; 1 of them stays on this machine.");
    expect(line(2, 2)).toBe("2 older sessions are known only from your prompt history.");
  });

  it("names what is read before it is read, and what never leaves", () => {
    expect(HISTORY_CONSENT_LINE).toMatch(/counts, timings and tool names only/);
    expect(HISTORY_CONSENT_LINE).toMatch(/no prompts, no code, no file paths/);
  });

  it("names the agents a person has, with counts — and no agent they do not have (schema 2.10)", () => {
    const read = (byAgent?: Record<string, number>, sessions = 45) =>
      historyLines({ kind: "read", sessions, outside: 0, sent: true, ...(byAgent ? { byAgent } : {}) } as HistoryOutcome)[0];
    expect(read(undefined, 42)).toBe("Read 42 Claude Code sessions.");
    expect(read({ claude_code: 42 }, 42)).toBe("Read 42 Claude Code sessions.");
    expect(read({ codex: 3 }, 3)).toBe("Read 3 Codex sessions.");
    expect(read({ claude_code: 42, codex: 3 })).toBe("Read 45 sessions: 42 in Claude Code, 3 in Codex.");
    expect(historyConsentLine(["claude_code"])).toBe(HISTORY_CONSENT_LINE);
    expect(historyConsentLine(["codex"])).toMatch(/^Reading your Codex sessions on this machine/);
    expect(historyConsentLine(["claude_code", "codex"])).toMatch(/^Reading your Claude Code and Codex sessions and prompt history/);
    expect(historyConsentLine([])).not.toMatch(/Claude|Codex/);
    for (const agents of [[], ["codex"], ["claude_code", "codex"]] as const) {
      expect(historyConsentLine(agents)).toMatch(/no prompts, no code, no file paths/);
    }
  });

  it("says what it did with Codex's notify in one line, and leaves a taken one alone (decision 4)", () => {
    const lines = (notify: "added" | "present" | "taken" | "none") =>
      connectedLines({ handle: "octocat", history: { kind: "skipped" }, webBaseUrl: WEB, notify });
    expect(lines("added")).toContain(NOTIFY_ADDED_LINE);
    expect(lines("present")).toContain(NOTIFY_PRESENT_LINE);
    expect(lines("taken")).toContain(NOTIFY_TAKEN_LINE);
    expect(lines("none").join("\n")).not.toMatch(/Codex/);
  });

  it("points at the site, not at the API", () => {
    expect(webBaseUrlFor("https://api.deigma.net")).toBe("https://deigma.net");
    expect(webBaseUrlFor("http://localhost:4000", "http://localhost:3000/")).toBe("http://localhost:3000");
  });
});

// ---- the word rule ---------------------------------------------------------------------------

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bpassports?\b/i, "passport"],
  [/\blandings?\b/i, "landing"],
  [/\bcarriers?\b/i, "carrier"],
  [/\bwitness/i, "witness"],
  [/\bapplicable set\b/i, "applicable set"],
  [/\bwedge\b/i, "wedge"],
  [/\b(install|required|set up|configure)\b/i, "setup imperative"],
];

function violations(text: string): string[] {
  return FORBIDDEN.filter(([re]) => re.test(text)).map(([, name]) => name);
}

const draftView = PassportViewSchema.parse(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../packages/schemas/fixtures/valid/passport_view/draft.json"),
      "utf8",
    ),
  ),
) as PassportView;

/** Every state the terminal can be in, from the fixture: as scored, nothing counted yet, proven,
 *  and a Deigma not scored yet. */
function views(): PassportView[] {
  const asScored = JSON.parse(JSON.stringify(draftView)) as PassportView;
  const nothing = JSON.parse(JSON.stringify(draftView)) as PassportView;
  if (nothing.status === "init") throw new Error("fixture");
  nothing.snapshot.claims.decisions_by_others = {
    ...nothing.snapshot.claims.decisions_by_others,
    proven: false,
    value: null,
    ci90: null,
    n_observations: 0,
    blocked_by: "no_observations",
    progress: { have: 0, need: 45, unit: "pull requests decided by other people", approximate: true },
    preliminary: null,
  };
  const proven = JSON.parse(JSON.stringify(draftView)) as PassportView;
  if (proven.status === "init") throw new Error("fixture");
  proven.status = "verified";
  proven.snapshot.status = "verified";
  proven.snapshot.claims.decisions_by_others = {
    ...proven.snapshot.claims.decisions_by_others,
    proven: true,
    value: 0.86,
    ci90: { lo: 0.77, hi: 0.92 },
    blocked_by: null,
    progress: null,
    preliminary: null,
  };
  const init: PassportView = { status: "init", backfill: "running", backfill_progress: null, metadata_collected: [] };
  return [asScored, nothing, proven, init];
}

/** The string literals the process gives to its two streams, comments stripped: `console.*` in
 *  main.ts and `deps.out` / `deps.err` in cli.ts, where the commands live. */
function mainLiterals(): string[] {
  return ["../src/main.ts", "../src/cli.ts"].flatMap((file) => {
    const src = readFileSync(join(import.meta.dirname, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const calls = [...src.matchAll(/(?:console\.(?:log|error)|deps\.(?:out|err)|\berr)\(([\s\S]*?)\);/g)].map((m) => m[1]!);
    return calls.flatMap((call) => [...call.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!));
  });
}

/** Everything the CLI can print. Asserted non-empty first: a rule checked over nothing passes. */
function everythingPrinted(): string[] {
  const out: string[] = [];
  for (const view of views()) {
    out.push(renderStatus({ view, telemetryDays: 9 }));
    out.push(
      renderPulse(
        weeklyPulse({ view, week: { episodes: 3, finalised: 2, from: "2026-09-28", to: "2026-10-04" }, telemetryDays: 9 }),
      ),
    );
  }
  for (const history of [
    { kind: "read", sessions: 5, outside: 2, sent: false },
    { kind: "read", sessions: 7, outside: 0, sent: true, byAgent: { claude_code: 4, codex: 3 }, unreadable: 2 },
    { kind: "read", sessions: 1, outside: 0, sent: true, byAgent: { codex: 1 } },
    { kind: "nothing", reason: "nothing_found" },
    { kind: "nothing", reason: "no_consent" },
    { kind: "skipped" },
    { kind: "unreachable" },
  ] as HistoryOutcome[]) {
    out.push(...connectedLines({ handle: "octocat", history, webBaseUrl: WEB }));
    out.push(...historyLines(history));
  }
  out.push(HISTORY_CONSENT_LINE, ...mainLiterals());
  out.push(
    historyConsentLine([]),
    historyConsentLine(["codex"]),
    historyConsentLine(["claude_code", "codex"]),
    NOTIFY_ADDED_LINE,
    NOTIFY_PRESENT_LINE,
    NOTIFY_TAKEN_LINE,
  );
  // Signed in or not: every line the account states can print.
  out.push(
    SIGNED_OUT_LINE,
    SESSION_ENDED_LINE,
    PROXY_SIGNED_OUT_LINE,
    PROXY_SESSION_ENDED_LINE,
    SIGNED_OUT_DONE_LINE,
    ALREADY_SIGNED_OUT_LINE,
    USAGE_LINE,
    signedInLine("octocat", "https://api.deigma.net"),
    signedInLine(null, "https://api.deigma.net"),
    queuedSentLine(1),
    queuedSentLine(3),
  );
  return out;
}

describe("what the CLI prints carries none of the inside of the program", () => {
  it("is checked over real output: every state renders, and main.ts hands literals to the console", () => {
    const printed = everythingPrinted();
    expect(printed.filter((t) => t.trim().length > 0).length).toBeGreaterThan(20);
    // Most sentences are messages.ts constants now (pushed above by name); the literals left in
    // cli.ts are the few error lines, and the scan must still find them.
    expect(mainLiterals().length).toBeGreaterThan(2);
    // the states differ, so the rule sees more than one rendering
    expect(new Set(printed).size).toBeGreaterThan(15);
  });

  it("never says passport, landing, carrier, witness, applicable set or wedge, and gives no setup orders", () => {
    for (const text of everythingPrinted()) {
      expect(violations(text), text).toEqual([]);
    }
  });

  it("the rule trips on the words it forbids", () => {
    // a guard on the guard: a rule nobody can trip is not a rule
    for (const sentence of [
      "Passport: draft in progress",
      "Connected. Wedge telemetry is on.",
      "12 landings this week",
      "3 carriers",
      "the outside witness",
      "not in the applicable set",
      "Please install the extension",
    ]) {
      expect(violations(sentence), sentence).not.toEqual([]);
    }
  });
});

import { deviceReadLine as dl } from "../src/messages";
describe("the line status adds about this machine", () => {
  it("says when, whether the hook reads, and what is still open — no orders", () => {
    const now = Date.parse("2026-10-18T22:00:00Z");
    expect(dl({ lastRunAt: "2026-10-18T19:00:00Z", now, hook: true, open: 2 })).toBe(
      "This machine: sessions last read 3 h ago · new ones are read when a Claude Code session ends · 2 still open — a session counts after 4 h idle",
    );
    expect(dl({ lastRunAt: null, now, hook: false, open: 0 })).toBe(
      "This machine: no session read from this machine yet · new ones are read on `deigma sync`, `status` or `pulse`",
    );
    for (const l of [dl({ lastRunAt: null, now, hook: false, open: 1 })]) expect(violations(l), l).toEqual([]);
    // Codex (decision 4): said only where Codex is on this machine.
    expect(dl({ lastRunAt: null, now, hook: true, open: 0, codexNotify: true })).toMatch(/new Codex sessions are read as you work, at most hourly$/);
    expect(dl({ lastRunAt: null, now, hook: true, open: 0, codexNotify: "taken" })).toMatch(/new Codex sessions are read on `deigma sync`/);
    expect(dl({ lastRunAt: null, now, hook: true, open: 0, codexNotify: null })).not.toMatch(/Codex/);
  });
});
