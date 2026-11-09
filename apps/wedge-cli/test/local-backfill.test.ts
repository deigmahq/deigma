// Acceptance (written before the implementation): the wedge has history on the device too
// (collector §2.1).
//
//   * the ENVIRONMENT is a property of the setup, not of behaviour: connected MCP servers, the
//     presence of project instructions and reusable skills can be read the moment the wedge is
//     installed;
//   * SESSIONS and iterations sit in the local journals of the AI tools, so the path-to-result
//     claim has a past as well;
//   * ATTENTION TELEMETRY is not backfilled and cannot be: t_validation_ms, scrolls and edits were
//     never recorded. Verification discipline is the one claim that honestly costs time forward.
//     This test states that explicitly instead of letting it be discovered later.
//
// Everything here obeys §2: only metadata leaves the device, and the local backfill runs on
// explicit consent at install.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isBuiltInTool } from "../src/vocabulary";
import { localBackfill, readEnvironment } from "../src/local-backfill";

const SALT = "ZGV2aWNlLXNhbHQtZm9yLXRlc3RzLTMyLWJ5dGVzLWxvbmc=";
const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "deigma-home-"));
  // an MCP client configuration, as Claude Code / Cursor keep it
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      mcpServers: {
        filesystem: { command: "npx", args: ["@modelcontextprotocol/server-filesystem"] },
        github: { command: "npx", args: ["@modelcontextprotocol/server-github"] },
        postgres: { command: "npx", args: ["@modelcontextprotocol/server-postgres"] },
      },
    }),
  );
  // reusable skills / commands
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
  writeFileSync(join(home, ".claude", "commands", "review.md"), "# review\nrun the checklist\n");
  writeFileSync(join(home, ".claude", "commands", "ship.md"), "# ship\n");
  // Three sessions in the shape Claude Code actually writes: one `<uuid>.jsonl` per session under
  // a per-project directory, assistant records carrying `requestId`, `gitBranch` and a `usage`
  // whose `iterations` is a LIST. The previous fixture invented a `type: "session"` row format
  // that exists nowhere, which is precisely why the reader it tested found nothing on a real
  // machine while every assertion here passed.
  const day = 24 * 60 * 60 * 1000;
  const at = (offsetDays: number, hour: number) =>
    new Date(Date.now() - offsetDays * day + hour * 3600_000).toISOString();
  const project = join(home, ".claude", "projects", "-w-repo");
  mkdirSync(project, { recursive: true });
  const turn = (id: string, ts: string, tools: string[], iterations: number): string =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      sessionId: id,
      requestId: `req-${id}-${ts}`,
      cwd: "/w/repo",
      gitBranch: "main",
      message: {
        model: "claude-opus-5",
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          cache_creation_input_tokens: 80,
          cache_read_input_tokens: 40_000,
          iterations: Array.from({ length: iterations }, () => ({ output_tokens: 1 })),
        },
        content: tools.map((name) => ({ type: "tool_use", name, input: {} })),
      },
    });
  const sessions: Array<[string, number, string[][]]> = [
    ["11111111-1111-4111-8111-111111111111", 9, [["Read", "Edit"], ["Read"]]],
    ["22222222-2222-4222-8222-222222222222", 8, [["Read"]]],
    // An MCP tool named the way a user names one — an employer and an internal system. It is here
    // so the vocabulary assertion below has something to catch; without it the test passes on a
    // fixture that could never fail.
    ["33333333-3333-4333-8333-333333333333", 2, [["Bash"], ["Edit", "mcp__acme-billing__query"]]],
  ];
  for (const [id, offset, turns] of sessions) {
    writeFileSync(
      join(project, `${id}.jsonl`),
      turns.map((tools, i) => turn(id, at(offset, 1 + i), tools, 2)).join("\n"),
    );
  }
  return home;
}

describe("local backfill at install", () => {
  it("reads the environment without touching a single line of content", () => {
    const env = readEnvironment(fakeHome());
    expect(env.mcpTools.sort()).toEqual(["filesystem", "github", "postgres"]);
    expect(env.reusableSkillCalls).toBe(2); // two commands defined, counted as available skills
    expect(env.projectInstructionsLoaded).toBe(false); // none in this fixture
    expect(JSON.stringify(env)).not.toContain("npx"); // no command lines, no arguments
  });

  it("turns local session journals into session.summary events with their original timestamps", async () => {
    const home = fakeHome();
    const result = await localBackfill({ userId: USER, home, consent: true, salt: SALT });
    expect(result.sessions).toBe(3);
    const types = new Set(result.events.map((e) => e.type));
    expect(types).toEqual(new Set(["session.summary"]));

    const first = result.events[0]!;
    expect(first.type).toBe("session.summary");
    if (first.type !== "session.summary") throw new Error("unreachable");
    expect(first.payload.iterations).toBe(4);
    // E comes from THIS SESSION, not from what the machine looks like today. This session called
    // no MCP tool, so its diversity is zero — which is what its transcript says. The old fallback
    // to `readEnvironment` reported the machine's three configured servers here, and that is
    // precisely the "statement about today wearing an old date" that kept backfilled sessions out
    // of the environment claim until R5 was wired.
    expect(first.payload.env_features.mcp_tool_diversity).toBe(0);
    expect(first.payload.env_features.mcp_tool_count).toBe(0);
    // The session that DID call one reports it.
    const withMcp = result.events.find(
      (e) => e.type === "session.summary" && e.payload.env_features.mcp_tool_count > 0,
    );
    expect(withMcp, "the fixture's third session calls an MCP tool").toBeDefined();
    // the event is dated when the work happened, not when the wedge was installed
    expect(Date.parse(first.occurred_at)).toBeLessThan(Date.now() - 24 * 3600_000);
    expect(Date.parse(first.sent_at)).toBeGreaterThan(Date.parse(first.occurred_at));
  });

  it("carries the model the journal names, with its generation derived from the name (audit 2026-10-09 #2)", async () => {
    const result = await localBackfill({ userId: USER, home: fakeHome(), consent: true, salt: SALT });
    expect(result.events.length, "input: sessions were read").toBe(3);
    for (const e of result.events) {
      expect(e.type === "session.summary" && e.model).toEqual({
        family: "claude",
        name: "claude-opus-5",
        generation_tag: "claude-5",
      });
    }
    // the placeholder every event carried until 2.4 is gone
    expect(JSON.stringify(result.events)).not.toContain("2026H2");
  });

  it("a session whose journal names no model says so — never a placeholder", async () => {
    const home = mkdtempSync(join(tmpdir(), "deigma-home-"));
    const project = join(home, ".claude", "projects", "-w-repo");
    mkdirSync(project, { recursive: true });
    const ts = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    writeFileSync(
      join(project, "44444444-4444-4444-8444-444444444444.jsonl"),
      // `<synthetic>` is the journal's marker for a record no model produced
      JSON.stringify({ type: "assistant", timestamp: ts, sessionId: "s", requestId: "r", message: { model: "<synthetic>", usage: {} } }),
    );
    const result = await localBackfill({ userId: USER, home, consent: true, salt: SALT });
    expect(result.events, "input: the session was read").toHaveLength(1);
    expect(result.events[0]!.type === "session.summary" && result.events[0]!.model).toEqual({
      known: false,
      family: "unknown",
      name: "unknown",
      generation_tag: "unknown",
    });
  });

  it("never backfills attention telemetry — the one claim that costs time forward", async () => {
    const result = await localBackfill({ userId: USER, home: fakeHome(), consent: true, salt: SALT });
    expect(result.events.some((e) => e.type === "draft.curation")).toBe(false);
    expect(result.attention_backfilled).toBe(false);
    expect(result.note).toMatch(/attention/i);
    // and nothing in the payloads can stand in for it
    expect(JSON.stringify(result.events)).not.toMatch(/t_validation_ms|n_scroll|n_edits/);
  });

  it("does nothing at all without consent", async () => {
    const result = await localBackfill({ userId: USER, home: fakeHome(), consent: false, salt: SALT });
    expect(result.events).toHaveLength(0);
    expect(result.sessions).toBe(0);
    expect(result.skipped_reason).toBe("no_consent");
  });

  it("survives a machine with no AI tooling installed", async () => {
    const empty = mkdtempSync(join(tmpdir(), "deigma-empty-"));
    const result = await localBackfill({ userId: USER, home: empty, consent: true, salt: SALT });
    expect(result.events).toHaveLength(0);
    expect(result.sessions).toBe(0);
    expect(result.skipped_reason).toBe("nothing_found");
  });
});

describe("what a backfilled packet is allowed to contain", () => {
  it("carries no long strings, so no prompt or path can hide in one", async () => {
    /**
     * The DoD of B4.1, as a shape rather than a promise (Zero Content Leakage).
     *
     * A backfill reads transcripts full of somebody's own words and their code. The guarantee that
     * none of it leaves is worth what its mechanism is worth, and this is that mechanism: every
     * string in the outgoing event is either a known short token — an id, an enum, a tool name, a
     * hash, a timestamp — or it does not belong there. Sixty-four characters is comfortably above
     * every legitimate value and far below anything worth exfiltrating.
     *
     * `cwd` is the case this was written for: the parser reads it to group sessions locally, and
     * a filesystem path carries the person's name, their employer's project names and more. It is
     * never emitted, and this is what says so.
     */
    const result = await localBackfill({ userId: USER, home: fakeHome(), consent: true, salt: SALT });
    expect(result.events.length).toBeGreaterThan(0);

    const LIMIT = 64;
    const offenders: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        if (value.length > LIMIT) offenders.push(`${path} (${value.length} chars)`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          // Keys travel too: `tool_calls` is keyed by tool name, and an MCP tool name is a string
          // somebody else chose.
          if (k.length > LIMIT) offenders.push(`key ${path}.${k} (${k.length} chars)`);
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(result.events, "events");
    expect(offenders).toEqual([]);

    // Length is a floor, not the rule. The rule is a CLOSED VOCABULARY: every tool name on the
    // wire is either a built-in — a name that says nothing about anybody — or a salted hash. An
    // MCP name is neither, and `mcp__acme-billing__query` is an employer and an internal system.
    for (const event of result.events) {
      const payload = (event as { payload: { tool_calls: Record<string, number> } }).payload;
      for (const name of Object.keys(payload.tool_calls)) {
        const known = isBuiltInTool(name) || /^tool:[0-9a-f]{12}$/.test(name);
        expect(known, `tool name outside the vocabulary: ${name}`).toBe(true);
      }
    }
    expect(JSON.stringify(result.events)).not.toContain("mcp__");
    expect(JSON.stringify(result.events)).not.toContain("acme");
    // ...and the fixture really did use one, so the two assertions above are not vacuous.
    const hashed = result.events.flatMap((e) =>
      Object.keys((e as { payload: { tool_calls: Record<string, number> } }).payload.tool_calls),
    ).filter((n) => n.startsWith("tool:"));
    expect(hashed.length, "the fixture used no MCP tool, so nothing was hashed").toBeGreaterThan(0);

    // And no branch travels for a repository nobody connected. The fixture's sessions sit in a
    // directory that is not a checkout of anything on the list, so every one of them is
    // unresolved — which is the state, not a failure.
    for (const event of result.events) {
      expect((event as { payload: { carrier_hint?: unknown } }).payload.carrier_hint).toBeUndefined();
    }
    expect(result.unresolved).toBe(result.sessions);
    expect(JSON.stringify(result.events)).not.toContain("main");

    // And the two fields that would be the leak if anything were: no absolute path, no home dir.
    const serialised = JSON.stringify(result.events);
    expect(serialised).not.toContain("/w/repo");
    expect(serialised).not.toMatch(/\/(Users|home)\//);
  });
});

describe("running the history pass twice", () => {
  it("is a no-op, not a second copy of everything", async () => {
    /**
     * A live event happens once and its id lives in the wedge's on-disk queue, so a retry cannot
     * duplicate it. A backfill has no queue — it re-reads the same journals every run — and with a
     * random id per run each run added another copy of every past session.
     *
     * Measured on a real machine: three runs of `deigma history` produced 96 events for 33
     * sessions, and every claim counted in sessions counted the copies. That is wrong, and it is
     * also a way to inflate a passport by typing one command twice.
     */
    const home = fakeHome();
    const first = await localBackfill({ userId: USER, home, consent: true, salt: SALT });
    const second = await localBackfill({ userId: USER, home, consent: true, salt: SALT });

    const ids = (r: typeof first): string[] => r.events.map((e) => (e as { event_id: string }).event_id);
    expect(ids(first)).toEqual(ids(second));
    expect(new Set(ids(first)).size, "one id per session, not one per reading").toBe(first.events.length);

    // A different person reading the same machine does not collide with the first.
    const other = await localBackfill({
      userId: "22222222-2222-4222-8222-222222222222",
      home,
      consent: true,
      salt: SALT,
    });
    expect(ids(other).some((id) => ids(first).includes(id))).toBe(false);
  });
});
