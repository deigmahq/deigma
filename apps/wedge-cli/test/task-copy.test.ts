// The word rule of the terminal (test/copy-v4.test.ts) over everything `deigma task submit` can say:
// none of the inside of the program reaches a person, and no setup order. Every export of
// src/task/messages.ts is checked, and a message function added without a sample fails here, so the
// rule cannot quietly stop covering the command.
import { describe, expect, it } from "vitest";

import * as messages from "../src/task/messages";
import type { SecretHit } from "../src/task/prepare";

// The same list as copy-v4.test.ts (which keeps its own, unexported).
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bpassports?\b/i, "passport"],
  [/\blandings?\b/i, "landing"],
  [/\bcarriers?\b/i, "carrier"],
  [/\bwitness/i, "witness"],
  [/\bapplicable set\b/i, "applicable set"],
  [/\bwedge\b/i, "wedge"],
  [/\b(install|required|set up|configure)\b/i, "setup imperative"],
];
const violations = (text: string) => FORBIDDEN.filter(([re]) => re.test(text)).map(([, name]) => name);

const SESSION = { agent: "claude_code", startedAt: "2026-11-05T13:02:00.000Z", events: 41 } as const;
const HIT: SecretHit = { agent: "codex", startedAt: "2026-11-05T15:20:00.000Z", kinds: ["github_token", "assigned_secret", "unheard_of_kind"] };

/** One call of every function the module exports, by name. */
const SAMPLES: Record<string, () => string | string[]> = {
  noTaskLine: () => messages.noTaskLine("alex/demo-service"),
  severalTasksLine: () => messages.severalTasksLine("alex/demo-service"),
  alreadySubmittedLine: () => messages.alreadySubmittedLine("2026-11-05"),
  repoMismatchLine: () => messages.repoMismatchLine("a/b", "c/d"),
  pullNoneLine: () => messages.pullNoneLine("alex/demo-service", "fix/loader"),
  pullSeveralLine: () => messages.pullSeveralLine([3, 5]),
  agentName: () => [messages.agentName("claude_code"), messages.agentName("codex")],
  whenUtc: () => messages.whenUtc("2026-11-05T13:02:00.000Z"),
  megabytes: () => [messages.megabytes(1), messages.megabytes(2_400_000), messages.megabytes(9_999_999)],
  sessionLine: () => messages.sessionLine(SESSION),
  shareLine: () => [
    messages.shareLine({ sessions: 1, events: 1, bytes: 10, company: "Northwind AI" }),
    messages.shareLine({ sessions: 2, events: 253, bytes: 400_000, company: "Northwind AI" }),
  ],
  finalLine: () => messages.finalLine(1),
  askWithSession: () => messages.askWithSession("Northwind AI", 1),
  noSessionLines: () => messages.noSessionLines("Northwind AI"),
  withoutSessionLines: () => messages.withoutSessionLines("Northwind AI"),
  askWithoutSession: () => messages.askWithoutSession(1),
  unreadableLine: () => [messages.unreadableLine(1), messages.unreadableLine(3)],
  secretBlockedLines: () => messages.secretBlockedLines([HIT]),
  tooLargeLines: () => [...messages.tooLargeLines(14_300_000), ...messages.tooLargeLines(null)],
  tooManyLines: () => [...messages.tooManyLines("sessions", 22), ...messages.tooManyLines("events", 60_000)],
  refusedLines: () => [
    "rate_limited",
    "github_unavailable",
    "already_submitted",
    "session_window_closed",
    "session_too_large",
    "secret_found",
    "pull_not_found",
    "no_repo",
    "repo_not_found",
    "repo_not_from_template",
    "not_found",
    "something_new",
  ].flatMap((code) => messages.refusedLines(code, null, 7)).concat(messages.refusedLines(null, null, null), messages.refusedLines("rate_limited", null, null)),
  submittedLines: () => [
    ...messages.submittedLines({ company: "Northwind AI", pr: 1, sessionAttached: true, releaseDay: "2026-11-19", taskUrl: "https://deigma.net/tasks/3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c" }),
    ...messages.submittedLines({ company: "Northwind AI", pr: 1, sessionAttached: false, releaseDay: null, taskUrl: "https://deigma.net/tasks/3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c" }),
  ],
};

function everythingSaid(): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(messages)) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) out.push(...(value as string[]));
    else if (typeof value === "function") {
      const sample = SAMPLES[name];
      expect(sample, `${name} has no sample: add one in test/task-copy.test.ts`).toBeDefined();
      const said = sample!();
      out.push(...(Array.isArray(said) ? said : [said]));
    }
  }
  return out;
}

describe("what `deigma task submit` prints carries none of the inside of the program", () => {
  it("is checked over real output: every constant and every function of the messages", () => {
    const said = everythingSaid();
    expect(said.filter((t) => t.trim().length > 0).length).toBeGreaterThan(60);
    expect(new Set(said).size).toBeGreaterThan(50);
  });

  it("never says passport, landing, carrier, witness, applicable set or wedge, and gives no setup orders", () => {
    for (const text of everythingSaid()) expect(violations(text), text).toEqual([]);
  });

  it("trips on the words it forbids", () => {
    for (const sentence of ["Passport", "Wedge telemetry", "3 landings", "a carrier", "witness", "Please install the extension", "required step"]) {
      expect(violations(sentence), sentence).not.toEqual([]);
    }
  });

  it("states a secret by its kind and never otherwise, including a kind it has no words for", () => {
    const lines = messages.secretBlockedLines([HIT]);
    expect(lines.join("\n")).toContain("Codex · 2026-11-05 15:20 UTC · a GitHub token, a value assigned to a name like a password or a key, a secret");
    expect(lines.join("\n")).not.toMatch(/unheard_of_kind|github_token/);
  });

  it("states the size in megabytes with one decimal, never as zero for something that is there, and the limit as ten", () => {
    expect(messages.megabytes(1)).toBe("0.1 MB");
    expect(messages.megabytes(104_857)).toBe("0.1 MB");
    expect(messages.megabytes(104_858)).toBe("0.2 MB");
    expect(messages.megabytes(2_400_000)).toBe("2.3 MB");
    expect(messages.megabytes(10 * 1024 * 1024)).toBe("10.0 MB");
  });

  it("says the contract's line in the contract's words", () => {
    expect(messages.shareLine({ sessions: 1, events: 1, bytes: 10, company: "Northwind AI" })).toBe(
      "1 session · 1 event · 0.1 MB will be shared with Northwind AI: your prompts, the agent's replies and tool calls in this folder",
    );
  });
});
