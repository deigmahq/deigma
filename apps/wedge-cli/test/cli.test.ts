// Acceptance tests for the CLI wedge: the device flow (Playbook §8), the MCP proxy's
// session.summary with E-1.0 features (collector §3.2, §4) and the Weekly Pulse speech rules
// (Playbook v1.4 §3.1).
import { SESSION_IDLE_GAP_HOURS } from "../src/measurement";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PassportView, Snapshot } from "@mentat/schemas";
import { PassportView as PassportViewSchema } from "@mentat/schemas";
import { describe, expect, it, vi } from "vitest";

import { awaitApproval, DeviceFlowError, newDeviceSalt, startDeviceFlow, type DeviceFlowDeps } from "@mentat/wedge-core";
import { wireToolName } from "../src/vocabulary";

const SALT = newDeviceSalt();
import { closeSession, newSession, observe, sessionEnded } from "../src/mcp-proxy";
import { renderPulse, weeklyPulse } from "@mentat/coach";
import { renderStatus } from "../src/status";

const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";

function deps(responses: unknown[], printed: string[] = []): DeviceFlowDeps {
  const queue = [...responses];
  return {
    apiBaseUrl: "http://api.test",
    fetch: vi.fn(async () => {
      const body = queue.shift();
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof globalThis.fetch,
    sleep: async () => undefined,
    now: () => 1_000_000,
    print: (line) => printed.push(line),
  };
}

describe("device flow (npx deigma init)", () => {
  it("prints a short code and exchanges it for a session without the user copying keys", async () => {
    const printed: string[] = [];
    const d = deps(
      [
        {
          device_code: "dc_1",
          user_code: "WXYZ-1234",
          verification_uri: "http://web.test/device",
          expires_in: 900,
          interval: 1,
        },
        { status: "pending" },
        { status: "slow_down", interval: 2 },
        { status: "ok", session: "sess-abc", handle: "octocat" },
      ],
      printed,
    );
    const device = await startDeviceFlow(d);
    expect(printed[0]).toContain("WXYZ-1234");
    expect(printed[0]).toContain("http://web.test/device");
    const approved = await awaitApproval(d, device);
    expect(approved).toEqual({ session: "sess-abc", handle: "octocat" });
  });

  it("prints the link with the code in it when the API sends one, and still prints the code", async () => {
    const printed: string[] = [];
    await startDeviceFlow(
      deps(
        [
          {
            device_code: "dc_2",
            user_code: "WXYZ-1234",
            verification_uri: "http://web.test/device",
            verification_uri_complete: "http://web.test/device?user_code=WXYZ-1234",
            expires_in: 900,
            interval: 1,
          },
        ],
        printed,
      ),
    );
    expect(printed).toHaveLength(1);
    expect(printed[0]).toBe(
      "Open http://web.test/device?user_code=WXYZ-1234 and check the code there reads WXYZ-1234",
    );
  });

  it("asks as the CLI by sending no body — the request the CLI in people's hands already makes", async () => {
    const d = deps([
      { device_code: "dc_3", user_code: "WXYZ-1234", verification_uri: "u", expires_in: 900, interval: 1 },
    ]);
    await startDeviceFlow(d);
    const calls = (d.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.length, "precondition: the flow asked for a code").toBe(1);
    expect(calls[0]![0]).toBe("http://api.test/auth/device/start");
    expect(calls[0]![1].body).toBeUndefined();
  });

  it("fails loudly when the user denies or the code expires", async () => {
    const denied = deps([{ status: "denied", error: "access_denied" }]);
    await expect(
      awaitApproval(denied, {
        device_code: "dc",
        user_code: "X",
        verification_uri: "u",
        expires_in: 900,
        interval: 1,
      }),
    ).rejects.toBeInstanceOf(DeviceFlowError);

    const expired = deps([]);
    await expect(
      awaitApproval(expired, {
        device_code: "dc",
        user_code: "X",
        verification_uri: "u",
        expires_in: 0,
        interval: 1,
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe("MCP proxy", () => {
  it("derives session.summary and E-1.0 features from JSON-RPC metadata only", () => {
    let s = newSession("s_1", 1_000);
    s = observe(s, { method: "resources/read", params: { name: "repo/CLAUDE.md" } });
    s = observe(s, { method: "tools/call", params: { name: "read_file", _meta: { tokensIn: 400 } } });
    s = observe(s, { method: "tools/call", params: { name: "read_file" } });
    s = observe(s, { method: "tools/call", params: { name: "edit_file", _meta: { tokensOut: 120 } } });
    s = observe(s, { method: "tools/call", params: { name: "skill/review" } });
    s = observe(s, {
      method: "sampling/createMessage",
      params: { _meta: { promptText: "add a regression test for the retry policy", tokensIn: 300 } },
    });

    const event = closeSession(s, { userId: USER, salt: SALT }, 91_000);
    expect(event.type).toBe("session.summary");
    // The upstream server names its tools: they travel hashed with the device salt (./vocabulary).
    expect(event.payload.tool_calls).toEqual({
      [wireToolName("read_file", SALT)]: 2,
      [wireToolName("edit_file", SALT)]: 1,
      [wireToolName("skill/review", SALT)]: 1,
    });
    expect(JSON.stringify(event.payload.tool_calls)).not.toContain("read_file");
    expect(event.payload.tokens_in).toBe(700);
    expect(event.payload.tokens_out).toBe(120);
    expect(event.payload.duration_ms).toBe(90_000);
    expect(event.payload.iterations).toBe(1);

    const env = event.payload.env_features;
    expect(env.e_definition_version).toBe("E-1.0");
    expect(env.project_instructions_loaded).toBe(true); // the fact, from resources/read
    expect(env.reusable_skill_calls).toBe(1);
    expect(env.mcp_tool_calls).toBe(4);
    expect(env.mcp_tool_diversity).toBeGreaterThan(0);
    expect(env.mcp_tool_diversity).toBeLessThanOrEqual(1);

    // the prompt itself never leaves: only its features
    const wire = JSON.stringify(event);
    expect(wire).not.toContain("regression test");
    expect(wire).not.toContain("CLAUDE.md");
    expect(event.payload.prompt_features).toHaveLength(1);
    expect(event.payload.prompt_features[0]!.categories).toContain("test");
  });
});

const draftView = PassportViewSchema.parse(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../packages/schemas/fixtures/valid/passport_view/draft.json"),
      "utf8",
    ),
  ),
) as PassportView;

function withStatus(status: "draft" | "calibrating" | "verified"): PassportView {
  const view = JSON.parse(JSON.stringify(draftView)) as PassportView;
  if (view.status === "init") throw new Error("fixture");
  view.status = status;
  view.snapshot.status = status;
  const claim = view.snapshot.claims.decisions_by_others;
  view.snapshot.claims.decisions_by_others =
    status === "verified"
      ? { ...claim, proven: true, value: 0.83, ci90: { lo: 0.74, hi: 0.9 }, n_observations: 48, blocked_by: null, progress: null, preliminary: null }
      : {
          ...claim,
          proven: false,
          value: null,
          ci90: null,
          n_observations: 12,
          blocked_by: "interval",
          progress: { have: 12, need: 30, unit: "pull requests decided by other people", approximate: true },
          preliminary: { value: 0.62, ci90: { lo: 0.49, hi: 0.76 } },
        };
  view.snapshot.claims_proven = status === "verified" ? 1 : 0;
  view.snapshot.headline_claim = status === "verified" ? "decisions_by_others" : null;
  return view;
}

describe("Weekly Pulse speech rules (Playbook §3.1)", () => {
  it("skips an empty week instead of reporting a zero", () => {
    const view = withStatus("calibrating");
    if (view.status !== "init") view.snapshot.practice_index = null; // nothing moved at all
    const pulse = weeklyPulse({
      view,
      week: { episodes: 0, finalised: 0, from: "2026-08-10", to: "2026-08-16" },
      telemetryDays: 3,
    });
    expect(pulse.skipped).toBe(true);
    expect(renderPulse(pulse)).toBe("");
  });

  it("before the claim is proven: counters and how far it is, no value — not even the preliminary one", () => {
    const text = renderPulse(
      weeklyPulse({
        view: withStatus("calibrating"),
        week: { episodes: 4, finalised: 3, from: "2026-08-10", to: "2026-08-16" },
        telemetryDays: 5,
      }),
    );
    expect(text).toContain("+4 pieces of work · 3 got a confirmed result");
    expect(text).toContain("Calibrating");
    expect(text).toContain("Accepted by other people: not proven yet: about 18 more pull requests decided by other people to go");
    expect(text).not.toMatch(/\d+%/);
    // The unproven claim has no value and no interval; the owner's preliminary practice reading is
    // the one line that may carry "between", and it is stamped as preliminary.
    const unstamped = text.split("\n").filter((l) => !l.includes("(preliminary, only you see it)"));
    expect(unstamped.join("\n")).not.toContain("between");
    expect(text.toLowerCase()).not.toContain("verified");
  });

  it("once proven: the value with its interval, the stamp that says who decided, the measured context", () => {
    const text = renderPulse(
      weeklyPulse({
        view: withStatus("verified"),
        week: { episodes: 2, finalised: 2, from: "2026-08-10", to: "2026-08-16" },
        telemetryDays: 30,
      }),
    );
    expect(text).toContain("Accepted by other people: 83%, between 74 and 90");
    expect(text).toContain("Verified · decided by other people");
    expect(text).toContain("measured across");
  });

  it("prints none of the old habit counters (2026-10-18): the index is what the week reports", () => {
    const view = withStatus("calibrating");
    if (view.status !== "init") expect(Object.keys(view.snapshot.habits.traces).length, "input: the snapshot carries traces").toBeGreaterThan(0);
    const text = renderPulse(weeklyPulse({ view, week: { episodes: 2, finalised: 1, from: "2026-08-10", to: "2026-08-16" }, telemetryDays: 9 }));
    expect(text).not.toMatch(/A plan before the agent's first edit|Changes looked at before the agent's commit|Suggestions read in the editor/);
    expect(renderStatus({ view, telemetryDays: 9 })).not.toMatch(/A plan before the agent's first edit|times, in \d+ sessions?/);
  });
});

describe("deigma status", () => {
  it("never prints a value of an unproven claim", () => {
    const text = renderStatus({ view: withStatus("calibrating"), telemetryDays: 4 });
    expect(text).toContain("Your Deigma: Calibrating");
    expect(text).toContain("Accepted by other people: not proven yet: about 18 more pull requests decided by other people to go");
    expect(text).not.toMatch(/\d+%/);
    const unstamped = text.split("\n").filter((l) => !l.includes("(preliminary, only you see it)"));
    expect(unstamped.join("\n")).not.toContain("between");
    expect(text).not.toContain("Verified");
  });

  it("prints the proven claim with its interval in words and never Verified bare", () => {
    const text = renderStatus({ view: withStatus("verified"), telemetryDays: 30 });
    expect(text).toContain("Your Deigma: Verified · decided by other people");
    expect(text).toContain("Accepted by other people: 83%, between 74 and 90");
    expect(text).toContain("measured across");
  });

  it("a proven claim without an interval prints no value", () => {
    const view = withStatus("verified");
    if (view.status === "init") throw new Error("fixture");
    view.snapshot.claims.decisions_by_others.ci90 = null;
    const text = renderStatus({ view, telemetryDays: 11 });
    expect(text).not.toMatch(/\d+%/);
  });

  it("an empty Deigma says so instead of inventing a status", () => {
    const text = renderStatus({
      view: { status: "init", backfill: "running", backfill_progress: null, metadata_collected: [] },
      telemetryDays: 0,
    });
    expect(text).toContain("Your Deigma: draft");
    expect(text).not.toContain("claims proven");
  });
});

describe("when a live session ends", () => {
  const frame = { method: "tools/call", params: { name: "Read" } } as Parameters<typeof observe>[1];

  it("uses the same gap as the backfill, from the same constant", () => {
    /**
     * The unit has one definition or a claim measured in sessions mixes two. Before this the live
     * side had no boundary at all — `closeSession` took whatever `endedAt` a caller passed, and
     * there was no caller — while the backfill took a whole transcript file, which on a real
     * machine meant a fifteen-day session.
     */
    const start = Date.UTC(2026, 8, 1, 9, 0);
    const state = newSession("s-1", start);
    observe(state, frame, start);
    const gapMs = SESSION_IDLE_GAP_HOURS * 3600_000;
    expect(sessionEnded(state, start + gapMs - 1)).toBe(false);
    expect(sessionEnded(state, start + gapMs + 1)).toBe(true);
  });

  it("measures idleness from the last frame, not from the start", () => {
    /** A session that has been busy for six hours has not ended; one idle for five has. */
    const start = Date.UTC(2026, 8, 1, 9, 0);
    const state = newSession("s-2", start);
    observe(state, frame, start + 6 * 3600_000);
    expect(sessionEnded(state, start + 6 * 3600_000 + 60_000)).toBe(false);
    expect(sessionEnded(state, start + 11 * 3600_000)).toBe(true);
  });
});
