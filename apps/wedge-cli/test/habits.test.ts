// Core 7 §4: habit traces by the public rules hb-1.0, read from a Claude Code journal on the device.
// A truth table for each rule, then the whole path on a planted transcript — and the one promise
// that matters most: the words of a prompt and the names of files never reach the wire.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type HabitMoment, habitsOf, promptFacts, touchedFile } from "../src/journals/habits";
import { parseTranscript } from "../src/journals/claude-code";

const T0 = Date.parse("2026-10-01T10:00:00Z");
const at = (min: number) => T0 + min * 60_000;
const quiet = { prompt: null, touched: null, agentEdit: false, commit: false, planMode: false };
const typed = (min: number, text: string): HabitMoment => ({ ...quiet, at: at(min), prompt: promptFacts(text) });
const tool = (min: number, over: Partial<HabitMoment>): HabitMoment => ({ ...quiet, at: at(min), ...over });

describe("promptFacts", () => {
  it("reads what the rules need and nothing else", () => {
    const f = promptFacts("Fix the parser in src/journals/claude-code.ts, then show me the diff");
    expect(f.files).toEqual(["claude-code.ts"]);
    expect(f.asksDiff).toBe(true);
    expect(f.asksPlan).toBe(false);
    expect(promptFacts("Make a plan first, then implement").asksPlan).toBe(true);
    expect(promptFacts("сначала план, потом код").asksPlan).toBe(true);
    expect(promptFacts("no, not that — line 42 of app.ts").correctiveWord).toBe(true);
    expect(promptFacts("no, not that — line 42 of app.ts").located).toBe(true);
    expect(promptFacts("no, wrong approach").located).toBe(false);
    expect(promptFacts("Please refactor the whole module carefully and with tests").correctiveWord).toBe(false);
  });

  it("names a file only by its basename", () => {
    expect(touchedFile("Read", { file_path: "/Users/x/proj/src/App.tsx" })).toBe("app.tsx");
    expect(touchedFile("Bash", { command: "cat a.ts" })).toBeNull();
  });
});

describe("habitsOf", () => {
  it("T1 (hb-2.3): the first work prompt of a task names a file the agent then opened", () => {
    const h = habitsOf([
      typed(0, "fix the parser in config.py"),
      tool(1, { touched: "config.py" }),
      typed(5, "now improve it"), // a reply inside the task: not an occasion any more
      tool(6, { touched: "config.py" }),
      typed(9, "thanks"),
    ]);
    expect(h.names_files).toEqual({ opportunities: 1, hits: 1 });
    // After /clear a new task begins, and its first work prompt is asked again.
    const two = habitsOf([
      typed(0, "fix the parser in config.py"),
      tool(1, { touched: "config.py" }),
      { ...quiet, at: at(2), clear: true },
      typed(3, "update the loader so it retries"),
      tool(4, { touched: "fetcher.ts" }), // the loader lives in fetcher.ts: not named
    ]);
    expect(two.names_files).toEqual({ opportunities: 2, hits: 1 });
  });

  it("T1 (hb-2.3): a file named without its extension counts; a short stem does not", () => {
    expect(habitsOf([typed(0, "fix the habits rules"), tool(1, { touched: "habits.ts" })]).names_files).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([typed(0, "поправь habits, там ошибка"), tool(1, { touched: "habits.ts" })]).names_files).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([typed(0, "fix the api"), tool(1, { touched: "api.ts" })]).names_files).toEqual({ opportunities: 1, hits: 0 });
  });

  it("T3: one occasion per session with an edit; plan mode or a plan request before the first edit", () => {
    expect(habitsOf([typed(0, "make a plan for this"), tool(1, { agentEdit: true })]).plan_before_edit).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([tool(0, { planMode: true }), tool(1, { agentEdit: true })]).plan_before_edit).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([tool(0, { agentEdit: true }), typed(1, "make a plan")]).plan_before_edit).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([typed(0, "make a plan")]).plan_before_edit).toBeNull(); // no edit, no occasion
  });

  it("T4: per agent commit, whether the changes were asked for since the previous commit", () => {
    const h = habitsOf([
      tool(0, { agentEdit: true }),
      typed(1, "show me the changes"),
      tool(2, { commit: true }),
      tool(3, { agentEdit: true }),
      tool(4, { commit: true }),
    ]);
    expect(h.diff_before_commit).toEqual({ opportunities: 2, hits: 1 });
  });

  it("T7: a short correction soon after the previous prompt, and whether it names a place", () => {
    const h = habitsOf([
      typed(0, "add pagination to the list"),
      typed(2, "no, wrong — the bug is in api.ts line 40"),
      typed(4, "no, still not it"),
      typed(60, "no, that is old"), // too long after: not a correction by ph-1.0
    ]);
    expect(h.located_corrections).toEqual({ opportunities: 2, hits: 1 });
  });

  it("a trace with no occasion is null, never 0 of 0", () => {
    const h = habitsOf([]);
    expect([h.names_files, h.plan_before_edit, h.diff_before_commit, h.located_corrections]).toEqual([null, null, null, null]);
    expect(h.rules_version).toBe("hb-2.3");
  });
});

describe("the whole path, on a planted transcript", () => {
  const SECRET_WORDS = "zebrafish quantum marmalade";
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  const file = join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  const rec = (min: number, r: Record<string, unknown>) =>
    JSON.stringify({ timestamp: new Date(at(min)).toISOString(), sessionId: "11111111-2222-4333-8444-555555555555", ...r });
  writeFileSync(
    file,
    [
      rec(0, { type: "user", permissionMode: "plan", message: { content: `make a plan for ${SECRET_WORDS} in billing.ts` } }),
      rec(1, { type: "assistant", requestId: "r1", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/p/src/billing.ts" } }] } }),
      rec(2, { type: "assistant", requestId: "r2", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/p/src/billing.ts", old_string: "a", new_string: "b" } }] } }),
      rec(3, { type: "user", message: { content: "no, wrong — fix line 12 in billing.ts" } }),
      rec(4, { type: "assistant", requestId: "r3", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/p/src/billing.ts", old_string: "b", new_string: "c" } }] } }),
      rec(5, { type: "user", message: { content: "show me the diff" } }),
      rec(6, { type: "assistant", requestId: "r4", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git commit -m x" } }] } }),
    ].join("\n") + "\n",
  );

  it("counts the four traces", () => {
    const [session] = parseTranscript(file);
    expect(session, "input: the planted transcript parses").toBeTruthy();
    expect(session!.humanPrompts).toBe(3);
    expect(session!.habits).toMatchObject({
      rules_version: "hb-2.3",
      names_files: { opportunities: 1, hits: 1 }, // hb-2.3: the task's first work prompt only
      plan_before_edit: { opportunities: 1, hits: 1 },
      diff_before_commit: { opportunities: 1, hits: 1 },
      located_corrections: { opportunities: 1, hits: 1 },
    });
  });

  it("keeps no prompt word and no file name in what it emits", () => {
    const [session] = parseTranscript(file);
    const wire = JSON.stringify(session!.habits);
    for (const word of [...SECRET_WORDS.split(" "), "billing", "line 12"]) expect(wire).not.toContain(word);
  });
});
