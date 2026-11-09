/**
 * The driver that finally calls newSession/closeSession (B4.3).
 *
 * They existed for a block with nothing invoking them — the pieces of a session lifecycle and no
 * lifecycle — so no live session was ever emitted and the two process claims had no source at all.
 * A function with tests and no caller is a defect, and this is what closes it.
 *
 * The tests use `cat` as the upstream: a real child process, real pipes, real exit.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { newDeviceSalt } from "@mentat/wedge-core";

import { lineReader, runProxy } from "../src/proxy-run";
import { wireToolName } from "../src/vocabulary";

const SALT = newDeviceSalt();

const IDENTITY = {
  userId: "11111111-1111-4111-8111-111111111111",
  salt: SALT,
} as unknown as Parameters<typeof runProxy>[0]["identity"];

function call(name: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
}

describe("framing", () => {
  it("keeps a partial line for the next chunk", () => {
    /** A tool that writes half a frame and then the rest must not have its call dropped, and must
     *  certainly not have half of it forwarded. */
    const seen: string[] = [];
    const feed = lineReader((l) => seen.push(l));
    feed('{"a":1}\n{"b":');
    feed('2}\n');
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("running the proxy", () => {
  it("passes every byte through and closes one session when the tool exits", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    const sent: unknown[] = [];

    const run = runProxy({
      command: "cat",
      args: [],
      identity: IDENTITY,
      send: async (e) => void sent.push(e),
      stdin,
      stdout,
      now: () => Date.UTC(2026, 8, 1, 9, 0),
    });
    stdin.write(`${call("Read")}\n`);
    stdin.write(`${call("mcp__acme__query")}\n`);
    await new Promise((r) => setTimeout(r, 150));
    stdin.end();
    const result = await run;

    // The bytes are the tool's, verbatim: the proxy is in the critical path of somebody's work.
    expect(out.join("")).toContain('"tools/call"');
    expect(result.sessions).toBe(1);
    expect(sent).toHaveLength(1);
    const payload = (sent[0] as { payload: { tool_calls: Record<string, number> } }).payload;
    // A built-in name travels as itself; a name the user configured only as a salted hash.
    expect(payload.tool_calls).toEqual({ Read: 1, [wireToolName("mcp__acme__query", SALT)]: 1 });
    expect(JSON.stringify(sent)).not.toContain("acme");
  });

  it("ends a session at its last frame when the gap is exceeded", async () => {
    /** The boundary is the shared constant, and the session that went quiet ended WHEN it went
     *  quiet — not when somebody came back, which would put four idle hours inside its duration. */
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const sent: { payload: { duration_ms: number } }[] = [];
    let clock = Date.UTC(2026, 8, 1, 9, 0);

    const run = runProxy({
      command: "cat",
      args: [],
      identity: IDENTITY,
      send: async (e) => void sent.push(e as never),
      stdin,
      stdout,
      now: () => clock,
      gapHours: 1,
    });
    stdin.write(`${call("Read")}\n`);
    await new Promise((r) => setTimeout(r, 60));
    clock += 30 * 60_000; // half an hour: same session
    stdin.write(`${call("Edit")}\n`);
    await new Promise((r) => setTimeout(r, 60));
    clock += 3 * 3600_000; // three hours later: a new one
    stdin.write(`${call("Bash")}\n`);
    await new Promise((r) => setTimeout(r, 60));
    stdin.end();
    const result = await run;

    expect(result.sessions).toBe(2);
    // The first session is half an hour long, not three and a half.
    expect(sent[0]!.payload.duration_ms).toBe(30 * 60_000);
  });

  it("fails open: a send that throws loses the telemetry and nothing else", async () => {
    /** The wedge sits in the critical path of somebody's daily work. A proxy that breaks a session
     *  is uninstalled the same day, so every failure here ends in "pass the bytes through". */
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    const errors: Error[] = [];

    const run = runProxy({
      command: "cat",
      args: [],
      identity: IDENTITY,
      send: async () => {
        throw new Error("ingestion is down");
      },
      stdin,
      stdout,
      onError: (e) => errors.push(e),
    });
    stdin.write(`${call("Read")}\n`);
    await new Promise((r) => setTimeout(r, 120));
    stdin.end();
    const result = await run;

    expect(out.join("")).toContain('"tools/call"'); // the call still went through
    expect(result.sessions).toBe(0); // and the session was lost, which is the only allowed loss
    expect(errors.map((e) => e.message)).toContain("ingestion is down");
  });

  it("forwards what is not JSON rather than swallowing it", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    const run = runProxy({ command: "cat", args: [], identity: IDENTITY, send: async () => {}, stdin, stdout });
    stdin.write("not json at all\n");
    await new Promise((r) => setTimeout(r, 120));
    stdin.end();
    await run;
    expect(out.join("")).toContain("not json at all");
  });
});
