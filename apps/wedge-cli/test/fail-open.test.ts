// Acceptance: the MCP proxy fails OPEN (Playbook v1.7 §2, CLAUDE.md).
//
// The proxy sits in the critical path of somebody's daily work. Any error inside it — ingestion
// unreachable, a hang, a bug of ours — must mean the traffic is passed through transparently and
// the telemetry for that session is dropped. A wedge that breaks a session is uninstalled the same
// day, and no amount of telemetry is worth that.
//
// Fail-open holds by construction in the driver that actually runs (src/proxy-run.ts): each line is
// written to the tool BEFORE it is parsed or observed, and the tool's answers are piped back without
// being read at all, so no telemetry path sits between a byte and its destination. These tests hold
// that against the real driver. (A per-call wrapper with a 250 ms budget, `proxyCall`, used to live
// in mcp-proxy.ts with its own tests and no caller — removed 2026-10-20: a fail-open guarantee
// tested on code nobody runs is not a guarantee.)
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { newDeviceSalt } from "@mentat/wedge-core";

import { runProxy } from "../src/proxy-run";

const IDENTITY = {
  userId: "11111111-1111-4111-8111-111111111111",
  salt: newDeviceSalt(),
} as unknown as Parameters<typeof runProxy>[0]["identity"];

const CALL = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_file" } });

function harness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: string[] = [];
  stdout.on("data", (c: Buffer) => out.push(c.toString("utf8")));
  return { stdin, stdout, out: () => out.join("") };
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe("the proxy fails open", () => {
  it("passes the round trip through while the telemetry sink hangs", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const run = runProxy({
      command: "cat",
      args: [],
      identity: IDENTITY,
      send: () => new Promise<void>((r) => (release = r)), // ingestion never answers
      stdin: h.stdin,
      stdout: h.stdout,
    });
    h.stdin.write(`${CALL}\n`);
    await settle();
    // `cat` echoed the call back: it reached the tool and the tool's answer reached the client,
    // with the telemetry not even attempted yet.
    expect(h.out()).toContain('"id":7');
    h.stdin.end();
    await settle();
    release();
    await run;
  });

  it("passes a frame through even when our own bookkeeping throws on it", async () => {
    const h = harness();
    const errors: Error[] = [];
    const run = runProxy({
      command: "cat",
      args: [],
      identity: IDENTITY,
      send: async () => undefined,
      stdin: h.stdin,
      stdout: h.stdout,
      onError: (e) => errors.push(e),
    });
    // Valid JSON that is not an object: observe() reads `.params` of null and throws.
    h.stdin.write("null\n");
    h.stdin.write(`${CALL}\n`);
    await settle();
    h.stdin.end();
    await run;
    expect(h.out()).toContain("null\n");
    expect(h.out()).toContain('"id":7');
    expect(errors.length, "input: the bookkeeping really failed").toBeGreaterThan(0);
  });

  it("an unreachable sink loses the session and nothing else", async () => {
    const h = harness();
    const run = runProxy({
      command: "cat",
      args: [],
      identity: IDENTITY,
      send: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
      },
      stdin: h.stdin,
      stdout: h.stdout,
    });
    h.stdin.write(`${CALL}\n`);
    await settle();
    h.stdin.end();
    const result = await run;
    expect(h.out()).toContain('"id":7');
    expect(result.sessions).toBe(0);
  });
});
