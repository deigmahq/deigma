import { describe, expect, it } from "vitest";

import { decisionsLine, practiceLines } from "../src/words";

const base = {
  rules_version: "pi-1.4",
  ci90: null,
  value: null,
  level: null,
  n_sessions: 40,
  min_sessions: 20,
  n_landings: 0,
  min_landings: 20,
  n_days: 3,
  min_days: 7,
  groups: {},
  items: {},
  strengths: [],
  next_step: null,
  delta_7d: null,
  delta_reason: null,
} as const;

describe("the practice index in the terminal (solo review 2026-10-18)", () => {
  it("collecting names only the floor still short — never '40 of 20 sessions'", () => {
    const [line] = practiceLines({ ...base, state: "collecting" } as never);
    expect(line).toBe("Practice index: collecting — 3 of 7 days");
    const [few] = practiceLines({ ...base, state: "collecting", n_sessions: 4, n_days: 9 } as never);
    expect(few).toBe("Practice index: collecting — 4 of 20 sessions");
  });

  it("a preliminary reading is stamped, carries its interval, and says what it rests on", () => {
    const lines = practiceLines({
      ...base,
      state: "preliminary",
      value: 54,
      level: "Solid",
      ci90: { lo: 45, hi: 63 },
      n_landings: 12,
      strengths: ["tests_after_edit"],
      next_step: "security_review",
      delta_7d: 3,
      delta_reason: "tests_after_edit",
    } as never);
    expect(lines[0]).toBe(
      "Practice index (preliminary, only you see it): 54 · Solid, between 45 and 63 · 40 sessions · 12 shipped pieces of work · narrows as more work is read",
    );
    expect(lines).toContain("+3 this week · tests after edits");
    expect(lines).toContain("Strong at: tests after edits");
    expect(lines).toContain("Next step: security review");
    expect(lines.join(" ")).not.toMatch(/landing/i);
  });

  it("nothing on record prints nothing", () => {
    expect(practiceLines(null)).toEqual([]);
  });

  it("a person whose work nobody else decided gets a fact, not a countdown", () => {
    const claim = { key: "decisions_by_others", proven: false, value: null, ci90: null, progress: { have: 0, need: 45, unit: "pull requests decided by other people", approximate: true } };
    expect(decisionsLine(claim as never)).toEqual(["Accepted by other people: none decided yet"]);
    const some = { ...claim, progress: { ...claim.progress, have: 5 } };
    expect(decisionsLine(some as never)[0]).toContain("more pull requests decided by other people to go");
  });
});

describe("the agents the number was read from (schema 2.10)", () => {
  const published = { ...base, state: "published", value: 61, level: "Strong", ci90: { lo: 55, hi: 66 } } as const;
  it("names the agents a person has, with counts — and none they do not", () => {
    expect(practiceLines({ ...published, agents: { claude_code: 40, codex: 6 } } as never)).toContain(
      "Read: 40 sessions from Claude Code and 6 from Codex",
    );
    expect(practiceLines({ ...published, agents: { codex: 6 } } as never)).toContain("Read: 6 sessions from Codex");
    expect(practiceLines({ ...published, agents: { claude_code: 40 } } as never).join("\n")).not.toMatch(/Codex/);
    expect(practiceLines({ ...base, state: "collecting", agents: { codex: 2 } } as never)).toContain("Read: 2 sessions from Codex");
  });
  it("says when Codex sessions recomputed the number (decision 3)", () => {
    expect(practiceLines({ ...published, recomputed_with: "codex" } as never)).toContain("Recomputed with Codex sessions.");
    expect(practiceLines({ ...published, recomputed_with: null } as never).join("\n")).not.toMatch(/Recomputed/);
  });
});
