// What a tool call and a tool result say, as the text of an event.
import { describe, expect, it } from "vitest";

import {
  claudeResultText,
  claudeToolCallText,
  codexChangeText,
  codexCommandText,
  codexResultText,
  flatten,
  resultContentText,
} from "../src/task/render";

describe("a Claude Code tool call", () => {
  it("is, for the shell, the command line as it was run", () => {
    expect(claudeToolCallText("Bash", { command: "python -m pytest -q", description: "run the tests" })).toBe("python -m pytest -q");
  });

  it("is, for a tool that writes a file, the path on the first line and then what it wrote", () => {
    expect(claudeToolCallText("Edit", { file_path: "/w/src/report.py", old_string: "OLD", new_string: "NEW\nTEXT" })).toBe(
      "/w/src/report.py\nNEW\nTEXT",
    );
    expect(claudeToolCallText("Write", { file_path: "/w/tests/test_x.py", content: "def test_x():\n    pass\n" })).toBe(
      "/w/tests/test_x.py\ndef test_x():\n    pass\n",
    );
    expect(
      claudeToolCallText("MultiEdit", { file_path: "/w/a.py", edits: [{ old_string: "1", new_string: "ONE" }, { old_string: "2", new_string: "TWO" }] }),
    ).toBe("/w/a.py\nONE\n\nTWO");
    expect(claudeToolCallText("NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: "x = 1" })).toBe("/w/n.ipynb\nx = 1");
    // an edit that wrote nothing is still a path on the first line
    expect(claudeToolCallText("Edit", { file_path: "/w/a.py", old_string: "x", new_string: "" })).toBe("/w/a.py");
  });

  it("never carries what a write REPLACED: the text of a write is the new text alone", () => {
    const text = claudeToolCallText("Edit", { file_path: "/w/src/app.py", old_string: "OLD_VALUE", new_string: "NEW_VALUE" });
    expect(text).toBe("/w/src/app.py\nNEW_VALUE");
    expect(text).not.toContain("OLD_VALUE");
  });

  it("is the plan for ExitPlanMode, the path for Read, and the arguments, briefly, for the rest", () => {
    expect(claudeToolCallText("ExitPlanMode", { plan: "1. rename the helper\n2. run the tests" })).toBe("1. rename the helper\n2. run the tests");
    expect(claudeToolCallText("Read", { file_path: "/w/src/app.py", offset: 1 })).toBe("/w/src/app.py");
    expect(claudeToolCallText("Grep", { pattern: "needle", path: "/w/src", glob: "*.py" })).toBe("pattern: needle\npath: /w/src\nglob: *.py");
    expect(claudeToolCallText("TodoWrite", { todos: [{ content: "find the bug", status: "completed" }, { content: "fix it", status: "in_progress" }] })).toBe(
      "[completed] find the bug\n[in_progress] fix it",
    );
    expect(claudeToolCallText("Task", { subagent_type: "Explore", description: "look", prompt: "find the loader" })).toBe(
      "subagent_type: Explore\ndescription: look\nprompt: find the loader",
    );
  });

  it("writes a string as it is, never JSON-escaped, so the secret scanner sees what a person would see", () => {
    const text = claudeToolCallText("mcp__x__set", { note: 'password = "abcdefghijklmnopqrstuvwxyz"\nnext' });
    expect(text).toBe('note: password = "abcdefghijklmnopqrstuvwxyz"\nnext');
    expect(flatten({ a: { b: ["one", { c: 'two "quoted"' }] } })).toBe('a: b: one\nc: two "quoted"');
  });
});

describe("a Claude Code result", () => {
  it("is what the tool printed: a string, or the text blocks of a list", () => {
    expect(resultContentText("3 passed")).toBe("3 passed");
    expect(
      resultContentText([
        { type: "text", text: "line one" },
        { type: "image", source: {} },
        { type: "tool_reference", tool_name: "x" },
        { type: "text", text: "line two" },
      ]),
    ).toBe("line one\n[image]\nline two");
    expect(resultContentText(undefined)).toBe("");
  });

  it("starts, for a shell command that did not exit 0, with `exit code <n>` in lower case", () => {
    expect(claudeResultText("Bash", "Exit code 1\nFAILED tests/test_x.py", true)).toBe("exit code 1\nFAILED tests/test_x.py");
    expect(claudeResultText("Bash", "Exit code 127\n(eval):1: command not found", true)).toBe("exit code 127\n(eval):1: command not found");
  });

  it("leaves every other result as it was said", () => {
    expect(claudeResultText("Bash", "3 passed in 0.04s", false)).toBe("3 passed in 0.04s");
    // an error that is not a command's exit has no exit code to state
    expect(claudeResultText("Bash", "The user doesn't want to proceed with this tool use.", true)).toBe(
      "The user doesn't want to proceed with this tool use.",
    );
    expect(claudeResultText("Edit", "Exit code 1 is a thing the file says", true)).toBe("Exit code 1 is a thing the file says");
    expect(claudeResultText(undefined, "Exit code 2\nx", true)).toBe("Exit code 2\nx");
  });
});

describe("a Codex shell call, its result, and a file change", () => {
  it("takes the script out of `[shell, -lc, script]` and joins any other argv", () => {
    expect(codexCommandText(["/bin/zsh", "-lc", "python -m pytest"])).toBe("python -m pytest");
    expect(codexCommandText(["git", "status", "--short"])).toBe("git status --short");
    expect(codexCommandText("ls -la")).toBe("ls -la");
    expect(codexCommandText(null)).toBe("");
  });

  it("starts a result that did not exit 0 with `exit code <n>`", () => {
    expect(codexResultText("3 passed", 0)).toBe("3 passed");
    expect(codexResultText("FAILED", 1)).toBe("exit code 1\nFAILED");
    expect(codexResultText("", 2)).toBe("exit code 2");
    // no exit code known: nothing is invented
    expect(codexResultText("partial", null)).toBe("partial");
  });

  it("is a file change in the words of Codex's own patch envelope: the file named first, then what it wrote", () => {
    expect(codexChangeText("/w/src/loader.py", { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b" })).toBe(
      "*** Update File: /w/src/loader.py\n@@ -1 +1 @@\n-a\n+b",
    );
    expect(codexChangeText("/w/new.py", { type: "add", content: "x = 1\n" })).toBe("*** Add File: /w/new.py\nx = 1\n");
    expect(codexChangeText("/w/gone.py", { type: "delete" })).toBe("*** Delete File: /w/gone.py");
    // a change of a kind nobody has seen is an update, not a guess about its words
    expect(codexChangeText("/w/x.py", { type: "rename" })).toBe("*** Update File: /w/x.py");
  });
});
