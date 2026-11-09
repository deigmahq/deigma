// From the sessions found to the body of the upload (src/task/prepare.ts): a real secret stops the
// whole attachment and is never named, the sessions are fitted to what the schema allows without
// leaving anything out, and the body passes the schema the server checks it with.
import { TASK_LIMITS, TaskSessionUpload } from "@mentat/schemas";
import { describe, expect, it } from "vitest";

import { Budget, fitSessionCount, prepareUpload, type Prepared } from "../src/task/prepare";
import { CUT_TIERS, cutText, recut, renderCut } from "../src/task/text";
import type { FolderEvent, FolderSession } from "../src/task/types";

const T = Date.parse("2026-11-05T13:00:00Z");
const at = (i: number) => new Date(T + i * 1000).toISOString();
const first = CUT_TIERS[0]!;

const event = (i: number, kind: FolderEvent["kind"], text: string, tool?: string): FolderEvent => ({
  at: at(i),
  kind,
  ...(tool ? { tool } : {}),
  text: cutText(text, kind, first),
});

const session = (agent: FolderSession["agent"], events: FolderEvent[], startedAt = events[0]?.at ?? at(0)): FolderSession => ({ agent, startedAt, events });

/** A key shaped like the secrets the scanner knows, assembled so this file holds no real-looking one. */
const GITHUB_TOKEN = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

function ready(p: Prepared) {
  if (p.kind !== "ready") throw new Error(`expected a body, got ${p.kind}`);
  return p;
}

describe("a body that is ready", () => {
  const found = [
    session("claude_code", [event(0, "prompt", "rename the helper"), event(1, "tool_call", "python -m pytest", "Bash"), event(2, "tool_result", "10 passed", "Bash")]),
    session("codex", [event(100, "prompt", "and the changelog?"), event(101, "reply", "the changelog needs one line")]),
  ];

  it("says how many sessions and events, and carries the consent the route asks for", () => {
    const p = ready(prepareUpload(found));
    expect(p.sessions).toEqual([
      { agent: "claude_code", startedAt: at(0), events: 3 },
      { agent: "codex", startedAt: at(100), events: 2 },
    ]);
    expect(p.events).toBe(5);
    expect(p.body.state).toBe("attached");
    if (p.body.state !== "attached") throw new Error("unreachable");
    expect(p.body.consent).toBe(true);
    expect(p.body.sessions.map((s) => s.events.length)).toEqual([3, 2]);
    expect(p.body.sessions.map((s) => s.agent)).toEqual(["claude_code", "codex"]);
  });

  it("is the shape the schema takes and no other: a session is an agent and events, an event is at, kind, tool?, text", () => {
    const p = ready(prepareUpload(found));
    expect(TaskSessionUpload.safeParse(p.body).success).toBe(true);
    if (p.body.state !== "attached") throw new Error("unreachable");
    const sent = JSON.parse(JSON.stringify(p.body)) as { sessions: Array<Record<string, unknown> & { events: Array<Record<string, unknown>> }> };
    for (const s of sent.sessions) {
      expect(Object.keys(s).sort()).toEqual(["agent", "events"]);
      for (const e of s.events) expect(Object.keys(e).every((k) => ["at", "kind", "tool", "text"].includes(k))).toBe(true);
    }
    // a prompt has no tool; a call and a result do
    expect(sent.sessions[0]!.events[0]).not.toHaveProperty("tool");
    expect(sent.sessions[0]!.events[1]).toMatchObject({ kind: "tool_call", tool: "Bash", text: "python -m pytest" });
  });

  it("measures the size the way the server does: the JSON text of the sessions", () => {
    const p = ready(prepareUpload(found));
    if (p.body.state !== "attached") throw new Error("unreachable");
    expect(p.bytes).toBe(Buffer.byteLength(JSON.stringify(p.body.sessions), "utf8"));
  });
});

describe("a secret", () => {
  it("stops the whole attachment, names the session and the kind, and never the secret", () => {
    const clean = session("claude_code", [event(0, "prompt", "rename the helper")]);
    const dirty = session("codex", [
      event(100, "prompt", "why does the deploy fail?"),
      event(101, "tool_result", `GITHUB_TOKEN=${GITHUB_TOKEN}`, "shell"),
    ]);
    const p = prepareUpload([clean, dirty]);
    expect(p.kind).toBe("secret");
    if (p.kind !== "secret") throw new Error("unreachable");
    expect(p.hits).toEqual([{ agent: "codex", startedAt: at(100), kinds: ["github_token"] }]);
    expect(JSON.stringify(p)).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(p)).not.toContain("ghp_");
  });

  it("is found in a prompt, a reply, a call and a result alike", () => {
    for (const kind of ["prompt", "reply", "tool_call", "tool_result"] as const) {
      const p = prepareUpload([session("claude_code", [event(0, kind, `see ${GITHUB_TOKEN} there`, kind.startsWith("tool") ? "Bash" : undefined)])]);
      expect(p.kind, kind).toBe("secret");
    }
  });

  it("is found at the end of a long result, which the cut keeps", () => {
    const text = `${"output line\n".repeat(2_000)}token = '${"x".repeat(24)}'`;
    expect(prepareUpload([session("claude_code", [event(0, "tool_result", text, "Bash")])]).kind).toBe("secret");
  });

  it("is not looked for in what is cut away, which does not leave", () => {
    const text = `${"a".repeat(first.resultHead)}${"output line\n".repeat(2_000)} ${GITHUB_TOKEN} ${"b".repeat(first.resultTail)}`;
    const p = prepareUpload([session("claude_code", [event(0, "tool_result", text, "Bash")])]);
    expect(p.kind).toBe("ready");
    expect(JSON.stringify(ready(p).body)).not.toContain(GITHUB_TOKEN);
  });

  it("is checked in the text as it was said, not as JSON would write it", () => {
    // `password = "…"` with its quotes: JSON-escaped, the quotes would hide it from the pattern.
    const p = prepareUpload([session("claude_code", [event(0, "tool_call", 'config.py\npassword = "correct-horse-battery-staple"', "Write")])]);
    expect(p.kind).toBe("secret");
  });
});

describe("fitting what the schema allows", () => {
  const sessions = (counts: number[], agents: FolderSession["agent"][] = []) =>
    counts.map((n, i) =>
      session(
        agents[i] ?? "claude_code",
        Array.from({ length: n }, (_, k) => event(i * 1000 + k, "prompt", `p${i}-${k}`)),
      ),
    );

  it("leaves alone what is within the limit", () => {
    const given = sessions([3, 2, 1]);
    expect(fitSessionCount(given, 20)).toEqual(given);
  });

  it("joins the neighbours with the fewest events first, keeping every event in order, until it fits", () => {
    const fitted = fitSessionCount(sessions([5, 1, 1, 6]), 3)!;
    expect(fitted.map((s) => s.events.length)).toEqual([5, 2, 6]);
    expect(fitted[1]!.events.map((e) => renderCut(e.text))).toEqual(["p1-0", "p2-0"]);
    expect(fitted.reduce((n, s) => n + s.events.length, 0)).toBe(13);
  });

  it("joins only sessions of one agent: it says it cannot rather than leave one out", () => {
    expect(fitSessionCount(sessions([1, 1, 1], ["claude_code", "codex", "claude_code"]), 2)).toBeNull();
    const mixed = fitSessionCount(sessions([1, 1, 2, 2], ["claude_code", "claude_code", "codex", "codex"]), 2)!;
    expect(mixed.map((s) => [s.agent, s.events.length])).toEqual([["claude_code", 2], ["codex", 4]]);
  });

  it("sends at most the sessions an upload may hold, and all their events", () => {
    const many = sessions(Array.from({ length: TASK_LIMITS.sessions + 5 }, () => 2));
    const p = ready(prepareUpload(many));
    expect(p.sessions).toHaveLength(TASK_LIMITS.sessions);
    expect(p.events).toBe((TASK_LIMITS.sessions + 5) * 2);
    if (p.body.state !== "attached") throw new Error("unreachable");
    expect(p.body.sessions.reduce((n, s) => n + s.events.length, 0)).toBe(p.events);
  });

  it("refuses, saying so, what cannot be fitted", () => {
    const alternating = sessions(Array.from({ length: TASK_LIMITS.sessions + 1 }, () => 1), Array.from({ length: TASK_LIMITS.sessions + 1 }, (_, i) => (i % 2 ? "codex" : "claude_code")));
    expect(prepareUpload(alternating)).toEqual({ kind: "too_many", what: "sessions", count: TASK_LIMITS.sessions + 1 });
    const long = [session("claude_code", Array.from({ length: TASK_LIMITS.eventsPerSession + 1 }, (_, i) => event(i, "prompt", "x")))];
    expect(prepareUpload(long)).toEqual({ kind: "too_many", what: "events", count: TASK_LIMITS.eventsPerSession + 1 });
  });
});

describe("the size of the upload", () => {
  /** Enough long results that the first size is over the limit and a smaller one fits. */
  const heavy = (events: number) =>
    session(
      "claude_code",
      Array.from({ length: events }, (_, i) => event(i, "tool_result", `${"line of output\n".repeat(900)}`, "Bash")),
    );

  it("cuts every event the same, harder, until the upload fits", () => {
    const full = ready(prepareUpload([heavy(600)])); // ~600 * 8 KB would be 4.8 MB: fits at the first size
    expect(full.bytes).toBeLessThan(TASK_LIMITS.sessionBytes);

    const p = ready(prepareUpload([heavy(2_400)])); // ~19 MB at the first size
    expect(p.bytes).toBeLessThanOrEqual(TASK_LIMITS.sessionBytes);
    if (p.body.state !== "attached") throw new Error("unreachable");
    const texts = p.body.sessions[0]!.events.map((e) => e.text);
    expect(texts).toHaveLength(2_400);
    // every event was cut by the same rule: the same length, and one marker
    expect(new Set(texts.map((t) => t.length)).size).toBe(1);
    expect(texts[0]!.length).toBeLessThan(first.resultHead + first.resultTail);
    expect(texts[0]!.match(/characters cut/g)).toHaveLength(1);
  });

  it("says when even the smallest size is too much, and sends nothing", () => {
    const tiny = CUT_TIERS[CUT_TIERS.length - 1]!;
    const eventsNeeded = Math.ceil(TASK_LIMITS.sessionBytes / (tiny.resultHead + tiny.resultTail)) + 10;
    const sessions = Array.from({ length: TASK_LIMITS.sessions }, (_, s) =>
      session(
        "claude_code",
        Array.from({ length: Math.ceil(eventsNeeded / TASK_LIMITS.sessions) + 1 }, (_, i) => event(s * 10_000 + i, "tool_result", "z".repeat(5_000), "Bash")),
      ),
    );
    const p = prepareUpload(sessions);
    expect(p.kind).toBe("too_large");
    if (p.kind !== "too_large") throw new Error("unreachable");
    expect(p.bytes).toBeGreaterThan(TASK_LIMITS.sessionBytes);
    // More than ten megabytes are built and cut three times: about 3 s alone, past the default 5 s
    // when the whole suite runs beside it.
  }, 30_000);

  it("keeps every text inside what one event may hold", () => {
    const p = ready(prepareUpload([heavy(50)]));
    if (p.body.state !== "attached") throw new Error("unreachable");
    for (const e of p.body.sessions[0]!.events) expect(e.text.length).toBeLessThanOrEqual(TASK_LIMITS.eventText);
  });
});

describe("the budget a read spends", () => {
  it("is a floor: what it has counted is never more than the smallest the upload can be", () => {
    const smallest = CUT_TIERS[CUT_TIERS.length - 1]!;
    const kinds = ["prompt", "reply", "tool_call", "tool_result"] as const;
    const events: FolderEvent[] = [];
    for (let i = 0; i < 400; i += 1) {
      const kind = kinds[i % 4]!;
      const length = [0, 1, 40, 700, 1_500, 9_000, 30_000][i % 7]!;
      events.push(event(i, kind, "q".repeat(length), kind.startsWith("tool") ? (i % 3 ? "Bash" : "mcp__plugin_design_linear__save_issue") : undefined));
    }
    const budget = new Budget(Infinity);
    for (const e of events) budget.add(e);
    const smallestSize = Buffer.byteLength(
      JSON.stringify(
        events.map((e) => ({ at: e.at, kind: e.kind, ...(e.tool ? { tool: e.tool } : {}), text: renderCut(recut(e.text, e.kind, smallest)) })),
      ),
      "utf8",
    );
    expect(budget.bytes).toBeGreaterThan(0);
    expect(budget.bytes).toBeLessThanOrEqual(smallestSize);
    // ... and not far below it, or it would stop nothing
    expect(budget.bytes).toBeGreaterThan(smallestSize * 0.8);
  });

  it("says it is spent once even the floor is over the limit, and not before", () => {
    const budget = new Budget(1_000);
    let added = 0;
    while (budget.add(event(added, "tool_result", "z".repeat(300), "Bash"))) added += 1;
    expect(budget.exceeded).toBe(true);
    expect(added).toBeGreaterThan(1);
    expect(added).toBeLessThan(5);
  });

  it("starts at the limit an upload may be", () => {
    expect(new Budget().limit).toBeLessThan(TASK_LIMITS.sessionBytes);
    expect(new Budget().limit).toBeGreaterThan(TASK_LIMITS.sessionBytes - 4_096);
  });
});
