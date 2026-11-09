/**
 * The process that actually runs the MCP proxy (B4.3).
 *
 * `newSession`, `observe` and `closeSession` existed for a block with no production caller: the
 * pieces of a session lifecycle and nothing to drive them, so no live session was ever emitted and
 * the two process claims had no source at all. This is the driver.
 *
 * It sits between an MCP client and an MCP server on stdio: frames in, frames out, byte for byte.
 * The telemetry runs beside that stream and can only lose itself — the wedge fails open, because a
 * proxy that breaks somebody's tool is uninstalled the same day. Every failure below therefore
 * ends in "pass the bytes through anyway".
 *
 * The session boundary is the one definition, `SESSION_IDLE_GAP_HOURS`, shared with the local-log
 * backfill: two emitters with two rules would make a claim measured in sessions mix two units.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";

import type { Event } from "@mentat/schemas";

import { SESSION_IDLE_GAP_HOURS } from "./measurement";
import { closeSession, newSession, observe, type RpcFrame, type SessionState } from "./mcp-proxy";

export type ProxyIdentity = Parameters<typeof closeSession>[1];

export type ProxyRunDeps = {
  /** The upstream server, as a command line. Its stdio is what we sit in front of. */
  command: string;
  args: string[];
  identity: ProxyIdentity;
  /** Ships a finished session. Its failures are ours to swallow, never the user's to see. */
  send: (event: Event) => Promise<unknown>;
  /** Wired in tests; defaults to the real streams. */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  now?: () => number;
  gapHours?: number;
  onError?: (err: Error) => void;
};

/** Splits a byte stream into whole JSON-RPC lines, keeping a partial tail for the next chunk. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onLine(line);
      nl = buffer.indexOf("\n");
    }
  };
}

/**
 * Runs the proxy until the upstream exits.
 *
 * Returns the sessions it closed, which is what the tests assert on: a driver whose only evidence
 * is a side effect on a network is a driver nobody can check.
 */
export async function runProxy(deps: ProxyRunDeps): Promise<{ sessions: number }> {
  const now = deps.now ?? (() => Date.now());
  const gapMs = (deps.gapHours ?? SESSION_IDLE_GAP_HOURS) * 3600_000;
  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;

  let child: ChildProcessByStdio<Writable, Readable, null>;
  try {
    child = spawn(deps.command, deps.args, { stdio: ["pipe", "pipe", "inherit"] });
  } catch (err) {
    // We could not even start the tool. There is nothing to pass through, so this one is fatal —
    // but it is the tool's failure to report, not a telemetry failure to hide.
    throw err instanceof Error ? err : new Error(String(err));
  }

  let state: SessionState | null = null;
  let closed = 0;

  const flush = async (at: number): Promise<void> => {
    if (!state) return;
    const finished = state;
    state = null;
    try {
      await deps.send(closeSession(finished, deps.identity, at));
      closed += 1;
    } catch (err) {
      // A session that could not be shipped is a session nobody hears about. That is a loss of
      // telemetry, which is the only thing this file is ever allowed to lose.
      deps.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const toUpstream = lineReader((line) => {
    // The bytes go first, always. Observation happens after the tool has what it needs.
    child.stdin.write(`${line}\n`);
    let frame: RpcFrame;
    try {
      frame = JSON.parse(line) as RpcFrame;
    } catch {
      return; // not JSON-RPC, or a partial write from a client that framed it oddly: pass it on
    }
    const at = now();
    // The boundary, checked on the frame that would otherwise extend the session: a session idle
    // longer than the gap ENDED at its last frame, and this one begins the next.
    if (state && at - state.lastActivityAt > gapMs) void flush(state.lastActivityAt);
    if (!state) state = newSession(randomUUID(), at);
    try {
      observe(state, frame, at);
    } catch (err) {
      // Our own bug is still our bug, and it is not the user's call to lose.
      deps.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const fromUpstream = lineReader((line) => {
    stdout.write(`${line}\n`);
  });

  stdin.on("data", toUpstream);
  // When the client goes away, the tool must be told — otherwise it sits waiting on a pipe nobody
  // will write to again and the proxy outlives the thing it was measuring.
  stdin.on("end", () => child.stdin.end());
  child.stdout.on("data", fromUpstream);

  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    child.on("exit", done);
    child.on("error", (err) => {
      deps.onError?.(err instanceof Error ? err : new Error(String(err)));
      done();
    });
  });

  // The tool exited, so the session ended with it — this is the close that actually happens in
  // practice, the idle gap being for a long-lived client that goes quiet.
  await flush(now());
  return { sessions: closed };
}
