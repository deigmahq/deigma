// Rules hb-2.2 (solo review 2026-10-18, wave 2): what the person did, not what was pasted or what
// the harness did. The rule tables live in habits2/habits3; these are the new boundaries, and the
// reader-level paths the review found broken (the newer slash-command frame, a permission-mode
// record with no time, a failing test piped through `tail`).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseTranscript } from "../src/journals/claude-code";
import { commandIsReview, commandIsSecurity, habitsOf, ownWords, promptFacts, type HabitMoment } from "../src/journals/habits";

const T0 = Date.parse("2026-10-01T10:00:00Z");
const at = (min: number) => T0 + min * 60_000;
const base: Omit<HabitMoment, "at"> = { prompt: null, touched: null, agentEdit: false, commit: false, planMode: false };

describe("own words (communication traces read only what the person wrote)", () => {
  it("pasted plans, headings, fences, logs and long pastes are not own words", () => {
    const pasted = [
      "# Plan\n\n1. add the cache\n2. fix the test",
      "Implement the following plan:\n\nAdd retries to fetch.ts so that it returns the cached value",
      "fix this\n```\nconst x = 1\n```",
      "fix this error\nERROR something broke\nERROR again\n    at foo (a.ts:1:2)\n    at bar (b.ts:3:4)",
      `fix ${"the parser and the lexer ".repeat(30)}`,
      "<command-message>review</command-message>",
    ];
    for (const t of pasted) {
      expect(ownWords(t), t.slice(0, 40)).toBe(false);
      const f = promptFacts(t);
      expect(f.work, t.slice(0, 40)).toBe(false); // so no clear_goal / gives_context / one_task occasion
      expect(f.own).toBe(false);
    }
    for (const t of ["fix the parser so that it returns an empty list", "add a retry to fetch.ts; the error is `ECONNRESET`"]) {
      expect(ownWords(t), t).toBe(true);
      expect(promptFacts(t).work, t).toBe(true);
    }
  });

  it("a pasted prompt opens no names_files occasion; a typed one does", () => {
    const touched = (min: number, file: string): HabitMoment => ({ ...base, at: at(min), touched: file });
    const pasted = habitsOf([{ ...base, at: at(0), prompt: promptFacts("# Plan\nedit fetch.ts") }, touched(1, "fetch.ts")]);
    expect(pasted.names_files).toBeNull();
    const typed = habitsOf([{ ...base, at: at(0), prompt: promptFacts("edit fetch.ts") }, touched(1, "fetch.ts")]);
    expect(typed.names_files).toEqual({ opportunities: 1, hits: 1 });
  });

  it("a URL is not a file", () => {
    expect(promptFacts("see https://github.com/acme/api.git and example.org").files).toEqual([]);
  });
});

describe("review and security command names", () => {
  it("plugin and newer names", () => {
    for (const n of ["review", "code-review:code-review", "pr-review-toolkit:review-pr", "codex:adversarial-review", "simplify", "ultrareview"]) {
      expect(commandIsReview(n), n).toBe(true);
    }
    for (const n of ["clear", "compact", "preview", "reviewed-notes"]) expect(commandIsReview(n), n).toBe(false);
    for (const n of ["security-review", "acme:security-scan", "audit-security"]) expect(commandIsSecurity(n), n).toBe(true);
    for (const n of ["review", "audit", "scan"]) expect(commandIsSecurity(n), n).toBe(false);
  });
});

describe("the reader (hb-2.2 paths)", () => {
  const ID = "33333333-4444-4555-8666-777777777777";
  const write = (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "hb22-"));
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(file, lines.join("\n") + "\n");
    const [s] = parseTranscript(file);
    expect(s, "input: the transcript parses").toBeTruthy();
    return s!;
  };
  const rec = (min: number, r: Record<string, unknown>) =>
    JSON.stringify({ timestamp: new Date(at(min)).toISOString(), sessionId: ID, cwd: "/nope", ...r });
  let n = 0;
  const use = (min: number, name: string, input: Record<string, unknown>, id = `t${++n}`) =>
    rec(min, { type: "assistant", requestId: `r${n}`, message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (min: number, id: string, text: string) =>
    rec(min, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });

  it("a permission-mode record with no time sets the mode of what follows", () => {
    const s = write([
      JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: ID }),
      rec(0, { type: "user", message: { content: "fix the parser" } }),
      use(1, "Read", { file_path: "/p/a.ts" }),
    ]);
    expect(s.habits.permissions_on).toEqual({ opportunities: 1, hits: 0 });
  });

  it("a slash command in the newer frame (<command-message> first) is a review", () => {
    const s = write([
      rec(0, { type: "user", permissionMode: "default", message: { content: "add the cache" } }),
      use(1, "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: Array.from({ length: 210 }, (_, i) => `l${i}`).join("\n") }),
      rec(2, { type: "user", message: { content: "<command-message>code-review:code-review</command-message>\n<command-name>/code-review:code-review</command-name>" } }),
    ]);
    expect(s.habits.independent_review).toEqual({ opportunities: 1, hits: 1 });
  });

  it("hb-2.3: a review asked of an agent or a workflow counts; a general agent asked to build does not", () => {
    const big = Array.from({ length: 210 }, (_, i) => `l${i}`).join("\n");
    const session = (review: string) =>
      write([
        rec(0, { type: "user", permissionMode: "default", message: { content: "add the cache" } }),
        use(1, "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: big }),
        review,
      ]);
    expect(session(use(2, "Agent", { subagent_type: "general-purpose", description: "Review the cache change", prompt: "x" })).habits.independent_review).toEqual({ opportunities: 1, hits: 1 });
    expect(session(use(2, "Agent", { subagent_type: "general-purpose", description: "Проверь изменения", prompt: "x" })).habits.independent_review).toEqual({ opportunities: 1, hits: 1 });
    expect(session(use(2, "Workflow", { script: "export const meta = { name: 'review-changes', description: 'Review changed files' }" })).habits.independent_review).toEqual({ opportunities: 1, hits: 1 });
    expect(session(use(2, "Agent", { subagent_type: "general-purpose", description: "Build the loader", prompt: "x" })).habits.independent_review).toEqual({ opportunities: 1, hits: 0 });
  });

  it("a failing test piped through tail is not a passing check", () => {
    const failing = write([
      rec(0, { type: "user", permissionMode: "default", message: { content: "fix the parser" } }),
      use(1, "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }),
      use(2, "Bash", { command: "npx vitest run | tail -5" }, "tv"),
      result(2, "tv", " Test Files  1 failed (1)\n      Tests  2 failed | 10 passed (12)"),
      use(3, "Bash", { command: "git commit -m x" }, "tc"),
      result(3, "tc", "[main abc1234] x"),
    ]);
    expect(failing.habits.tests_after_edit).toEqual({ opportunities: 1, hits: 0 });
    const passing = write([
      rec(0, { type: "user", permissionMode: "default", message: { content: "fix the parser" } }),
      use(1, "Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }),
      use(2, "Bash", { command: "npx vitest run | tail -5" }, "tv2"),
      result(2, "tv2", " Test Files  1 passed (1)\n      Tests  12 passed (12)"),
      use(3, "Bash", { command: "git commit -m x" }, "tc2"),
      result(3, "tc2", "[main abc1234] x"),
    ]);
    expect(passing.habits.tests_after_edit).toEqual({ opportunities: 1, hits: 1 });
  });
});
