/**
 * The exact session -> pull request link (audit 2026-10-09 #4).
 *
 * The fixture is built from the REAL record shape — keys and value types read off this machine's
 * ~/.claude/projects on 2026-10-09 (641 `pr-link` records, every one
 * `{type, sessionId, timestamp, prNumber:int, prRepository:"owner/name", prUrl}`) — with synthetic
 * values. The neighbouring records are the content-bearing kinds the same journals hold
 * (`ai-title`, `last-prompt`, `file-history-snapshot`, a tool result with `originalFile` /
 * `oldString` / `newString`), each carrying a sentinel, so "the parser never reads them" is
 * checked two ways: no sentinel reaches any output, and a recording proxy shows the keys were
 * never even touched.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseTranscript, prLinkOf, recordMoments, type Rec } from "../src/journals/claude-code";
import { localBackfill } from "../src/local-backfill";
import { sessionCarrierHint } from "../src/session-hint";

const SALT = "cHItbGluay10ZXN0LXNhbHQtMzItYnl0ZXMtbG9uZy0tLQ==";
const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";
const SESSION = "5e55a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRET = "SENTINEL-DO-NOT-READ";
const REMOTE_URL = ["git", "@github.com:acme/shop.git"].join("");

/** Keys that hold the person's words or code. None may ever be read. (`old_string` / `new_string` of an
 *  edit call are read by the habit rules hb-2.0 to count the LINES an edit changed, in memory, and
 *  dropped: see test/habits2.test.ts for what then reaches the wire.) */
const FORBIDDEN = ["aiTitle", "lastPrompt", "prUrl", "prompt_snapshot", "originalFile", "oldString", "newString", "snapshot", "backup", "toolUseResult"];

const ts = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString();

function prLink(minute: number, number: number, repository = "acme/shop"): Record<string, unknown> {
  return {
    type: "pr-link",
    sessionId: SESSION,
    timestamp: ts(minute),
    prNumber: number,
    prRepository: repository,
    prUrl: `https://github.com/${repository}/pull/${number}`,
  };
}

function transcript(links: Record<string, unknown>[]): Record<string, unknown>[] {
  return [
    { type: "user", timestamp: ts(0), sessionId: SESSION, cwd: "/w/shop", gitBranch: "feat/cart", message: { role: "user", content: "fix the cart" } },
    {
      type: "assistant",
      timestamp: ts(1),
      sessionId: SESSION,
      requestId: "req-1",
      cwd: "/w/shop",
      gitBranch: "feat/cart",
      message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "Edit", input: { file_path: "/w/shop/cart.ts", old_string: SECRET, new_string: SECRET } }] },
    },
    { type: "user", timestamp: ts(2), sessionId: SESSION, toolUseResult: { originalFile: SECRET, oldString: SECRET, newString: SECRET }, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    { type: "ai-title", sessionId: SESSION, aiTitle: SECRET },
    { type: "last-prompt", sessionId: SESSION, leafUuid: "u", lastPrompt: SECRET },
    { type: "file-history-snapshot", messageId: "m", isSnapshotUpdate: false, snapshot: { prompt_snapshot: SECRET } },
    ...links,
  ];
}

function write(records: Record<string, unknown>[]): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "deigma-prlink-"));
  const project = join(home, ".claude", "projects", "-w-shop");
  mkdirSync(project, { recursive: true });
  const file = join(project, `${SESSION}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  return { home, file };
}

/** A deep proxy that records every key read at any depth. */
function watched<T extends object>(value: T, seen: Set<string>): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === "string") seen.add(key);
      const v = Reflect.get(target, key, receiver) as unknown;
      return v && typeof v === "object" ? watched(v as object, seen) : v;
    },
  });
}

describe("reading pr-link", () => {
  it("reads the number and the repository, and nothing else of the record", () => {
    const seen = new Set<string>();
    expect(prLinkOf(watched(prLink(5, 31) as Rec, seen))).toEqual({ repository: "acme/shop", number: 31 });
    expect([...seen].sort()).toEqual(["prNumber", "prRepository", "type"]);
  });

  it("refuses a record that does not have the confirmed shape", () => {
    expect(prLinkOf({ ...prLink(5, 31), prNumber: "31" } as Rec)).toBeNull();
    expect(prLinkOf({ ...prLink(5, 0) } as Rec)).toBeNull();
    expect(prLinkOf({ ...prLink(5, 31), prRepository: "https://github.com/acme/shop" } as Rec)).toBeNull();
    expect(prLinkOf({ ...prLink(5, 31), type: "frame-link" } as Rec)).toBeNull();
  });

  it("never touches a content field of any record in the journal", () => {
    const seen = new Set<string>();
    for (const rec of transcript([prLink(5, 31)])) recordMoments(watched(rec as Rec, seen));
    expect(seen.size, "input: the records were read").toBeGreaterThan(5);
    for (const key of FORBIDDEN) expect(seen.has(key), `read ${key}`).toBe(false);
  });

  it("a session names the pull requests of its own stretch", () => {
    const { file } = write(transcript([prLink(5, 31), prLink(6, 31)]));
    const [s] = parseTranscript(file);
    expect(s, "input: one session").toBeDefined();
    expect(s!.pullRequests).toEqual([{ repository: "acme/shop", number: 31 }]);
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });
});

describe("binding a session by its pull request", () => {
  const CONNECTED = [{ repo_id: 7, full_name: "acme/shop" }];
  const read = (files: Record<string, string>) => (p: string) => {
    const f = files[p];
    if (f === undefined) throw new Error(`ENOENT ${p}`);
    return f;
  };
  const shopCheckout = read({ "/w/shop/.git/config": `[remote "origin"]\n\turl = ${REMOTE_URL}\n` });
  const session = (pullRequests: { repository: string; number: number }[]) => ({ cwd: "/w/shop", branch: "feat/cart", pullRequests });

  it("one pull request in a connected repository: the exact binding, preferred over the branch", () => {
    expect(sessionCarrierHint(session([{ repository: "acme/shop", number: 31 }]), CONNECTED, shopCheckout)).toEqual({
      repoId: 7,
      prNumber: 31,
      branch: "feat/cart",
    });
  });

  it("the branch rides along only when the checkout is that same repository", () => {
    const connected = [...CONNECTED, { repo_id: 8, full_name: "acme/api" }];
    expect(sessionCarrierHint(session([{ repository: "acme/api", number: 4 }]), connected, shopCheckout)).toEqual({ repoId: 8, prNumber: 4 });
  });

  it("several pull requests in one stretch are not a binding: the branch rule stands", () => {
    const many = session([
      { repository: "acme/shop", number: 31 },
      { repository: "acme/shop", number: 33 },
    ]);
    expect(sessionCarrierHint(many, CONNECTED, shopCheckout)).toEqual({ repoId: 7, branch: "feat/cart" });
  });

  it("one pull request somewhere nobody connected falls back to the checkout's branch rule (review of PR #29)", () => {
    expect(sessionCarrierHint(session([{ repository: "other/thing", number: 2 }]), CONNECTED, shopCheckout)).toEqual({ repoId: 7, branch: "feat/cart" });
  });

  it("end to end: the backfill puts the pull request on the wire and nothing of the journal's words", async () => {
    const { home } = write(transcript([prLink(5, 31)]));
    // the checkout the session ran in, on the real filesystem
    mkdirSync(join(home, "w", "shop", ".git"), { recursive: true });
    writeFileSync(join(home, "w", "shop", ".git", "config"), `[remote "origin"]\n\turl = ${REMOTE_URL}\n`);
    const records = transcript([prLink(5, 31)]).map((r) => ("cwd" in r ? { ...r, cwd: join(home, "w", "shop") } : r));
    writeFileSync(join(home, ".claude", "projects", "-w-shop", `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));

    const result = await localBackfill({ userId: USER, home, consent: true, salt: SALT, connectedRepos: CONNECTED, now: () => new Date(Date.UTC(2026, 8, 21)) });
    expect(result.events, "input: the session was read").toHaveLength(1);
    const event = result.events[0]!;
    expect(event.type === "session.summary" && event.payload.carrier_hint).toEqual({
      provider: "github",
      repo_id: 7,
      branch: "feat/cart",
      pr_number: 31,
    });
    const wire = JSON.stringify(result.events);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain("acme/shop");
    expect(wire).not.toContain("github.com");
  });
});
