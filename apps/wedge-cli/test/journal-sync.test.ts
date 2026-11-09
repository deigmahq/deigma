/**
 * The incremental journal read (audit 2026-10-09 #5): sessions are read as they FINISH, from the
 * moment the device went live, with origin and ids that survive every way a session can be read
 * twice; the proxy starts it beside the tool and never waits for it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event, SessionSummaryEvent } from "@mentat/schemas";
import { MAX_OFFLINE_AGE_MS } from "@mentat/wedge-core";
import { beforeEach, describe, expect, it } from "vitest";

import { FILES, run, type CliDeps } from "../src/cli";
import { ledgerKey, loadSyncState, markSent, planSync, settleSync, startLiveIfNew, SYNC_FILES, SYNC_INTERVAL_MS, takeSyncLock, type SyncState } from "../src/journal-sync";
import { localBackfill } from "../src/local-backfill";

const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";
const SALT = "c3luYy10ZXN0LXNhbHQtMzItYnl0ZXMtbG9uZy0tLS0tLQ==";
const API = "http://api.test";
const HOUR = 3600_000;
const T0 = Date.UTC(2026, 9, 5, 12, 0); // the device went live
const NOW = T0 + 30 * HOUR;

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "deigma-sync-"));
  project = join(home, ".claude", "projects", "-w-repo");
  mkdirSync(project, { recursive: true });
});

const iso = (ms: number) => new Date(ms).toISOString();

/** A transcript in the shape Claude Code writes (see claude-code-journal.test.ts), one assistant
 *  record per turn. Its mtime is set to its last record, as a journal's would be. */
function transcript(id: string, turnsAt: number[]): string {
  const file = join(project, `${id}.jsonl`);
  writeFileSync(file, turnsAt.map((at, i) => record(id, at, i)).join("\n"));
  utimesSync(file, new Date(turnsAt.at(-1)!), new Date(turnsAt.at(-1)!));
  return file;
}
function record(id: string, at: number, i: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(at),
    sessionId: id,
    requestId: `req-${id}-${i}-${at}`,
    cwd: "/w/repo",
    gitBranch: "main",
    message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
  });
}

const ID = {
  history: "aaaaaaaa-0000-4000-8000-000000000001",
  ended: "bbbbbbbb-0000-4000-8000-000000000002",
  open: "cccccccc-0000-4000-8000-000000000003",
  late: "dddddddd-0000-4000-8000-000000000004",
  across: "eeeeeeee-0000-4000-8000-000000000005",
};

/** The state the sign-in of THIS CLI leaves (`startLiveIfNew`): its own reader on it. */
function fresh(): SyncState {
  return { version: 1, user_id: USER, live_since: iso(T0), last_run_at: null, files: {}, sent: {}, reader_version: "cc-reader-4" };
}
/** The state an older sync-era CLI leaves: no reader on it, so everything it marked was read by
 *  cc-reader-1. (A device with NO state is not this: see "a device with no record of consent".) */
function legacy(): SyncState {
  const { reader_version: _, ...rest } = fresh();
  return rest;
}

const plan = (state: SyncState, now = NOW) =>
  planSync({ state, userId: USER, salt: SALT, home, connectedRepos: [], now });

const sessionsOf = (p: ReturnType<typeof plan>) =>
  p.ready.map((r) => r.event as SessionSummaryEvent).map((e) => ({ id: e.payload.session_id, origin: e.origin }));

describe("what one run reads", () => {
  it("nothing read from a journal file is ever live, however fresh (founder decision 2026-10-09)", async () => {
    // The freshest session the sync can read: began after going live, ended just past the gap.
    transcript(ID.ended, [NOW - 6 * HOUR, NOW - 4 * HOUR - 60_000]);
    const synced = plan(fresh()).ready.map((r) => r.event);
    const history = (await localBackfill({ userId: USER, home, consent: true, salt: SALT, now: () => new Date(NOW) })).events;
    expect(synced.length, "input: the sync read it").toBe(1);
    expect(history.length, "input: history read it").toBe(1);
    for (const e of [...synced, ...history]) expect(e.origin).toBe("backfill");
  });

  it("only sessions that ended, from the moment the device went live", () => {
    transcript(ID.history, [T0 - 50 * HOUR, T0 - 49 * HOUR]); // before going live: history
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]); // ended 27 h ago
    transcript(ID.open, [NOW - 2 * HOUR, NOW - HOUR]); // still going: not yet
    const p = plan(fresh());
    expect(sessionsOf(p)).toEqual([{ id: ID.ended, origin: "backfill" }]);
    expect(p.counts).toMatchObject({ ended: 1, open: 1 });
  });

  it("a session that began before the device went live and ended after it is read — as history", () => {
    transcript(ID.across, [T0 - HOUR, T0 + HOUR]);
    expect(sessionsOf(plan(fresh()))).toEqual([{ id: ID.across, origin: "backfill" }]);
  });

  it("a session that ended just before the sign-in — which history skipped as maybe open — is read; one a gap older is not (B2)", async () => {
    const GAP = 4 * HOUR; // SESSION_IDLE_GAP_HOURS
    transcript(ID.across, [T0 - 3 * HOUR, T0 - HOUR]); // finished an hour before `init`
    transcript(ID.history, [T0 - GAP - 3 * HOUR, T0 - GAP - HOUR]); // older than a gap: history's
    // history at sign-in does skip the first one (still within a gap of "now")
    const atInit = await localBackfill({ userId: USER, home, consent: true, salt: SALT, now: () => new Date(T0) });
    expect(atInit.events.map((e) => e.type === "session.summary" && e.payload.session_id)).toEqual([ID.history]);
    // and the sync reads exactly that one, as history
    expect(sessionsOf(plan(fresh()))).toEqual([{ id: ID.across, origin: "backfill" }]);
  });

  it("a live-era session found after the 72 h window travels as backfill, as the server would derive", () => {
    const later = T0 + 100 * HOUR;
    transcript(ID.late, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    expect(later - (T0 + 2 * HOUR)).toBeGreaterThan(MAX_OFFLINE_AGE_MS);
    expect(sessionsOf(plan(fresh(), later))).toEqual([{ id: ID.late, origin: "backfill" }]);
  });

  it("puts no prompt, path or branch name on the wire, and the model the journal names", () => {
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const [r] = plan(fresh()).ready;
    const e = r!.event as SessionSummaryEvent;
    expect(e.model).toEqual({ family: "claude", name: "claude-opus-5", generation_tag: "claude-5" });
    expect(JSON.stringify(e)).not.toContain("/w/repo");
    expect(e.payload.carrier_hint).toBeUndefined(); // nothing connected: nothing named
  });
});

describe("read twice, sent once", () => {
  it("a second run with nothing new reads nothing, and a resumed transcript sends only its new stretch", () => {
    const file = transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const first = plan(fresh());
    expect(first.ready).toHaveLength(1);
    const after = markSent(first.state, first.ready, NOW);
    expect(plan(after).ready, "unchanged files: nothing to read").toEqual([]);

    // The person resumes the same transcript the next day: a second stretch after the idle gap.
    appendFileSync(file, `\n${record(ID.ended, T0 + 20 * HOUR, 9)}\n${record(ID.ended, T0 + 21 * HOUR, 10)}`);
    utimesSync(file, new Date(T0 + 21 * HOUR), new Date(T0 + 21 * HOUR));
    const second = plan(after);
    // The parser now names the stretches `<id>-1` and `<id>-2`; the first went as `<id>` and is in
    // the ledger, so only the new one travels, and the old one is not re-sent under a new name.
    expect(sessionsOf(second)).toEqual([{ id: `${ID.ended}-2`, origin: "backfill" }]);
    expect(second.counts.alreadySent).toBe(1);
  });

  it("the id is the session's, whichever pass reads it: a later `deigma history` duplicates nothing", async () => {
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const p = plan(fresh());
    const synced = p.ready[0]!.event;
    const ledger = markSent(p.state, p.ready, NOW).sent;
    const history = await localBackfill({
      userId: USER,
      home,
      consent: true,
      salt: SALT,
      now: () => new Date(NOW),
      sessionIdFor: (s) => ledger[ledgerKey(s)]?.session_id,
    });
    const same = history.events.find((e) => e.type === "session.summary" && e.payload.session_id === ID.ended);
    expect(same, "input: history read the same session").toBeDefined();
    expect(same!.event_id).toBe(synced.event_id);
    expect(same!.origin).toBe("backfill"); // the label differs; the id does not, so the server keeps one
  });

  it("history does not read a session that is still going (it would freeze it half-measured)", async () => {
    transcript(ID.open, [NOW - 2 * HOUR, NOW - HOUR]);
    const r = await localBackfill({ userId: USER, home, consent: true, salt: SALT, now: () => new Date(NOW) });
    expect(r.events).toEqual([]);
  });
});

// ------------------------------------------------------------------ through the CLI itself

type Call = { url: string; method: string; body: unknown };

function cliDeps(dir: string, calls: Call[], extra: Partial<CliDeps> = {}): CliDeps {
  return {
    configDir: dir,
    apiBaseUrl: API,
    home,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url).endsWith("/v1/me/repositories")) return j({ repositories: [] });
      if (String(url).endsWith("/v1/events")) return j({ accepted: 1 });
      return j({ user_id: USER });
    }) as typeof globalThis.fetch,
    out: () => {},
    err: () => {},
    sleep: async () => undefined,
    now: () => NOW,
    passThrough: async () => 0,
    runProxy: async () => ({ sessions: 0 }),
    localBackfill: async () => ({ events: [], sessions: 0, unresolved: 0, historyOnly: 0, attention_backfilled: false, note: "" }),
    ...extra,
  };
}

function signIn(dir: string, state?: SyncState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILES.session), JSON.stringify({ session: "sess-1", handle: "octocat", apiBaseUrl: API, user_id: USER }));
  writeFileSync(join(dir, FILES.device), JSON.stringify({ salt: SALT }));
  if (state) writeFileSync(join(dir, SYNC_FILES.state), JSON.stringify(state));
}

describe("a corrected reader re-reads what the old one sent (schema 2.5)", () => {
  /** The state a device was left in by a cc-reader-1 CLI: file marks that say "read", a ledger
   *  entry with no reader on it. */
  function oldState(file: string, key: string, sessionId: string): SyncState {
    const size = readFileSync(file).length;
    const mtime = T0 + 3 * HOUR;
    return {
      ...legacy(),
      files: { [file]: { size, mtime_ms: mtime, open: false } },
      sent: { [key]: { session_id: sessionId, started_at: iso(T0 + 2 * HOUR) } },
    };
  }

  it("an unchanged transcript the old reader sent is read again, under the name it went out with, and only once", () => {
    const file = transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const [s] = plan(fresh()).ready;
    expect(s, "input: the session is in the window").toBeDefined();
    const before = oldState(file, s!.key, "the-name-it-went-out-with");
    const p = plan(before);
    expect(p.ready).toHaveLength(1);
    const e = p.ready[0]!.event as SessionSummaryEvent;
    expect(e.payload.session_id).toBe("the-name-it-went-out-with");
    expect(e.payload.reader_version).toBe("cc-reader-4");
    expect(e.payload.transcript_id).toBe(ID.ended);
    const settled = settleSync(before, p, p.ready, NOW);
    expect(settled.reader_version).toBe("cc-reader-4");
    expect(plan(settled).ready, "re-read once, not every run").toEqual([]);
  });

  it("a re-read that did not all go keeps the old reader's mark, so the next run tries again", () => {
    const file = transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const [s] = plan(fresh()).ready;
    const before = oldState(file, s!.key, ID.ended);
    const p = plan(before);
    expect(p.ready, "input: something to send").toHaveLength(1);
    const settled = settleSync(before, p, [], NOW);
    expect(settled.reader_version).toBeUndefined();
    expect(plan(settled).ready).toHaveLength(1);
  });

  it("a transcript is sent whole — its stretch from before the window too — unless history was declined", () => {
    // Stretch 1 ended a day before the sign-in (the history pass sent it); stretch 2 is new. The
    // server keeps only the highest reader's events per transcript, so a re-read that sent stretch
    // 2 alone would make stretch 1 disappear from the passport.
    transcript(ID.across, [T0 - 26 * HOUR, T0 - 25 * HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
    expect(sessionsOf(plan(fresh())).map((x) => x.id)).toEqual([`${ID.across}-1`, `${ID.across}-2`]);
    // Declined: nothing from before the sign-in was ever sent, and nothing is now.
    expect(sessionsOf(plan({ ...fresh(), history_declined: true })).map((x) => x.id)).toEqual([`${ID.across}-2`]);
    // Under the current reader, a transcript entirely before the window is history, and stays the
    // history pass's to read — that pass already read it with this reader.
    transcript(ID.history, [T0 - 40 * HOUR, T0 - 39 * HOUR]);
    expect(sessionsOf(plan(fresh())).some((x) => x.id.startsWith(ID.history))).toBe(false);
  });

  it("an upgrade re-reads every transcript on disk — also one that ended before the window — unless history was declined (review 2026-10-10)", () => {
    // What a device that ran `init` under cc-reader-1 holds: a transcript that ended a day and a
    // half before `live_since` — the old history pass sent it — and nothing after. Without the
    // re-read, its cc-reader-1 reading (the inflated count of typed turns) stays in force.
    transcript(ID.history, [T0 - 40 * HOUR, T0 - 39 * HOUR]);
    const before = legacy();
    const p = plan(before);
    const reread = p.ready.map((r) => r.event as SessionSummaryEvent);
    expect(reread.map((e) => e.payload.session_id)).toEqual([ID.history]);
    expect(reread[0]!.payload.reader_version).toBe("cc-reader-4");
    expect(reread[0]!.payload.transcript_id).toBe(ID.history);
    expect(reread[0]!.origin).toBe("backfill");
    // Once it went, the device is on the new reader and the transcript is history again.
    expect(plan(settleSync(before, p, p.ready, NOW)).ready).toEqual([]);
    // A declined history is never read, upgrade or not.
    expect(plan({ ...legacy(), history_declined: true }).ready).toEqual([]);
  });

  it("the sign-in of this CLI starts on its own reader: its first sync does not re-read what its history pass just read", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    startLiveIfNew(dir, USER, T0);
    const state = loadSyncState(dir, USER, NOW);
    expect(state.reader_version).toBe("cc-reader-4");
    transcript(ID.history, [T0 - 40 * HOUR, T0 - 39 * HOUR]);
    expect(plan(state).ready).toEqual([]);
  });

  it("the id follows the stretch, not its name: read alone as `<id>`, read later as `<id>-1`, one event", async () => {
    const file = transcript(ID.across, [T0 - 26 * HOUR, T0 - 25 * HOUR]);
    const history = await localBackfill({ userId: USER, home, consent: true, salt: SALT, now: () => new Date(T0) });
    const alone = history.events.find((e) => e.type === "session.summary");
    expect(alone, "input: history read the first stretch").toBeDefined();
    expect((alone as SessionSummaryEvent).payload.session_id).toBe(ID.across);
    appendFileSync(file, `\n${record(ID.across, T0 + 2 * HOUR, 8)}\n${record(ID.across, T0 + 3 * HOUR, 9)}`);
    utimesSync(file, new Date(T0 + 3 * HOUR), new Date(T0 + 3 * HOUR));
    const later = plan(fresh()).ready.map((r) => r.event as SessionSummaryEvent);
    const first = later.find((e) => e.payload.session_id === `${ID.across}-1`);
    expect(first, "input: the sync named it -1").toBeDefined();
    expect(first!.event_id).toBe(alone!.event_id);
  });
});

describe("deigma sync", () => {
  it("sends finished sessions once, records them, and is quiet", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const calls: Call[] = [];
    expect(await run(["sync"], cliDeps(dir, calls))).toBe(0);
    const posted = calls.filter((c) => c.url.endsWith("/v1/events")).flatMap((c) => (c.body as { events: Event[] }).events);
    expect(posted.map((e) => e.type === "session.summary" && e.payload.session_id)).toEqual([ID.ended]);
    expect(posted[0]!.origin).toBe("backfill");
    expect(posted[0]!.sent_at).toBe(iso(NOW));
    const state = loadSyncState(dir, USER, NOW);
    expect(Object.values(state.sent).map((v) => v.session_id)).toEqual([ID.ended]);
    expect(state.last_run_at).toBe(iso(NOW));
    expect(existsSync(join(dir, SYNC_FILES.lock)), "the lock is released").toBe(false);

    const again: Call[] = [];
    await run(["sync"], cliDeps(dir, again));
    expect(again.filter((c) => c.url.endsWith("/v1/events"))).toEqual([]);
  });

  it("a repository list it could not get sends nothing and records nothing (binding review, 2026-10-31)", async () => {
    // Read as an empty list, a failed request sent every session with no hint, the ledger kept
    // it, and the server keeps the first copy of an event: the binding was lost for good.
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const api = (calls: Call[], repos: number) =>
      (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
        if (String(url).endsWith("/v1/me/repositories")) return repos === 200 ? j({ repositories: [] }) : j({ error: "down" }, repos);
        if (String(url).endsWith("/v1/events")) return j({ accepted: 1 });
        return j({ user_id: USER });
      }) as typeof globalThis.fetch;
    const failed: Call[] = [];
    expect(await run(["sync"], cliDeps(dir, failed, { fetch: api(failed, 503) }))).toBe(0);
    expect(failed.some((c) => c.url.endsWith("/v1/me/repositories")), "input: the list was asked for").toBe(true);
    expect(failed.filter((c) => c.url.endsWith("/v1/events")), "sent with no hint").toEqual([]);
    expect(Object.keys(loadSyncState(dir, USER, NOW).sent), "recorded as sent").toEqual([]);
    expect(existsSync(join(dir, SYNC_FILES.lock)), "the lock is released").toBe(false);
    // The next run that can ask sends it.
    const ok: Call[] = [];
    await run(["sync"], cliDeps(dir, ok, { fetch: api(ok, 200) }));
    const posted = ok.filter((c) => c.url.endsWith("/v1/events")).flatMap((c) => (c.body as { events: Event[] }).events);
    expect(posted.map((e) => e.type === "session.summary" && e.payload.session_id)).toEqual([ID.ended]);
  });

  it("signed out it reads nothing, asks nothing and writes nothing", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const calls: Call[] = [];
    expect(await run(["sync"], cliDeps(dir, calls))).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("an unreachable API sends nothing and records nothing: the next run tries again", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const calls: Call[] = [];
    await run(["sync"], cliDeps(dir, calls, {
      fetch: (async (url: string) => {
        calls.push({ url: String(url), method: "", body: undefined });
        if (String(url).endsWith("/v1/events")) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ repositories: [] }), { status: 200 });
      }) as typeof globalThis.fetch,
    }));
    expect(calls.some((c) => c.url.endsWith("/v1/events")), "input: a send was attempted").toBe(true);
    expect(loadSyncState(dir, USER, NOW).sent).toEqual({});

    // The next run, API back: the session it could not send goes now (review of PR #29, B1 — the
    // file had been marked read, and an unchanged file was never read again).
    const later: Call[] = [];
    await run(["sync"], cliDeps(dir, later, { now: () => NOW + SYNC_INTERVAL_MS }));
    const posted = later.filter((c) => c.url.endsWith("/v1/events")).flatMap((c) => (c.body as { events: Event[] }).events);
    expect(posted.map((e) => e.type === "session.summary" && e.payload.session_id)).toEqual([ID.ended]);
    expect(Object.values(loadSyncState(dir, USER, NOW).sent).map((v) => v.session_id)).toEqual([ID.ended]);
  });

  it.each([
    ["an API that predates the code", { error: "invalid_batch", issues: [{ code: "invalid_value", path: ["events", 0, "schema_version"] }] }],
    ["the current API", { error: "unsupported_schema_version", accepted: ["2.1", "2.2", "2.3"] }],
  ])("a batch refused for its schema version by %s is kept and goes after the upgrade (S2)", async (_who, refusal) => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const calls: Call[] = [];
    await run(["sync"], cliDeps(dir, calls, {
      fetch: (async (url: string) => {
        calls.push({ url: String(url), method: "", body: undefined });
        if (String(url).endsWith("/v1/events")) return new Response(JSON.stringify(refusal), { status: 400 });
        return new Response(JSON.stringify({ repositories: [] }), { status: 200 });
      }) as typeof globalThis.fetch,
    }));
    expect(calls.some((c) => c.url.endsWith("/v1/events")), "input: a send was refused").toBe(true);
    expect(loadSyncState(dir, USER, NOW).sent, "not recorded as sent").toEqual({});

    const later: Call[] = [];
    await run(["sync"], cliDeps(dir, later, { now: () => NOW + SYNC_INTERVAL_MS }));
    const posted = later.filter((c) => c.url.endsWith("/v1/events")).flatMap((c) => (c.body as { events: Event[] }).events);
    expect(posted.map((e) => e.type === "session.summary" && e.payload.session_id)).toEqual([ID.ended]);
  });

  it("a batch refused for any other reason is recorded, not retried forever", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    await run(["sync"], cliDeps(dir, [], {
      fetch: (async (url: string) => {
        if (String(url).endsWith("/v1/events")) {
          return new Response(JSON.stringify({ error: "invalid_batch", issues: [{ path: ["events", 0, "payload"] }] }), { status: 400 });
        }
        return new Response(JSON.stringify({ repositories: [] }), { status: 200 });
      }) as typeof globalThis.fetch,
    }));
    expect(Object.keys(loadSyncState(dir, USER, NOW).sent)).toHaveLength(1);
  });

  it("a request that hangs is abandoned: the run ends, releases its lock and records nothing", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    let hung = 0;
    const code = await run(["sync"], cliDeps(dir, [], {
      syncFetchTimeoutMs: 50,
      fetch: ((url: string, init?: RequestInit) => {
        if (!String(url).endsWith("/v1/events")) {
          return Promise.resolve(new Response(JSON.stringify({ repositories: [] }), { status: 200 }));
        }
        hung += 1;
        // never answers; only the run's own abort signal ends it
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      }) as typeof globalThis.fetch,
    }));
    expect(code).toBe(0);
    expect(hung, "input: the send hung").toBe(1);
    expect(existsSync(join(dir, SYNC_FILES.lock))).toBe(false);
    expect(loadSyncState(dir, USER, NOW).sent).toEqual({});
  });

  it("a run releases only its own lock", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    const unlock = takeSyncLock(dir, Date.now());
    expect(unlock, "input: the lock was taken").not.toBeNull();
    // the run outlived the stale limit; another took the lock over
    writeFileSync(join(dir, SYNC_FILES.lock), "someone-else");
    unlock!();
    expect(readFileSync(join(dir, SYNC_FILES.lock), "utf8")).toBe("someone-else");
  });

  it("another run holding the lock: this one does nothing", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    writeFileSync(join(dir, SYNC_FILES.lock), "");
    transcript(ID.ended, [T0 + 2 * HOUR, T0 + 3 * HOUR]);
    const calls: Call[] = [];
    await run(["sync"], cliDeps(dir, calls, { now: () => Date.now() }));
    expect(calls).toEqual([]);
  });

  it("a device with no record of consent (0.1.2, even after `init --no-history`) reads only what ends from now on (review 2026-10-10, consent)", async () => {
    // What every 0.1.2 install holds: a sign-in and a device salt, no sync.json. Its owner may
    // have declined history — 0.1.2 never wrote that down — so absence is read as a refusal.
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir);
    expect(existsSync(join(dir, SYNC_FILES.state)), "input: no sync state").toBe(false);
    transcript(ID.history, [NOW - 60 * HOUR, NOW - 59 * HOUR]); // long before: history
    transcript(ID.across, [NOW - 7 * HOUR, NOW - 5 * HOUR]); // ended within a gap of the first sync
    const api = (calls: Call[]) =>
      (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
        if (String(url).endsWith("/v1/me/repositories")) return j({ repositories: [] });
        if (String(url).endsWith("/v1/events")) return j({ accepted: 1 }, 202);
        return j({ user_id: USER, handle: "octocat" });
      }) as typeof globalThis.fetch;
    const posted = (calls: Call[]) =>
      calls.filter((c) => c.url.endsWith("/v1/events")).flatMap((c) => (c.body as { events: Event[] }).events)
        .map((e) => e.type === "session.summary" && e.payload.session_id);
    const first: Call[] = [];
    await run(["sync"], cliDeps(dir, first, { fetch: api(first) }));
    expect(posted(first), "nothing that ended before this device's first sync").toEqual([]);
    const state = loadSyncState(dir, USER, NOW);
    expect(state.history_declined).toBe(true);
    expect(state.reader_version, "not an upgrade: nothing on disk is re-read whole").toBe("cc-reader-4");
    // What ends after it is read as usual.
    transcript(ID.ended, [NOW + HOUR, NOW + 2 * HOUR]);
    const later: Call[] = [];
    await run(["sync"], cliDeps(dir, later, { fetch: api(later), now: () => NOW + 8 * HOUR }));
    expect(posted(later)).toEqual([ID.ended]);
    // `deigma history` — the person's own act, with its consent line — lifts the refusal.
    let historyRan = 0;
    await run(["history"], cliDeps(dir, [], {
      fetch: api([]),
      localBackfill: async () => {
        historyRan += 1;
        return { events: [], sessions: 0, unresolved: 0, historyOnly: 0, attention_backfilled: false, note: "" };
      },
    }));
    expect(historyRan, "input: the history pass ran").toBe(1);
    expect(loadSyncState(dir, USER, NOW).history_declined).toBeUndefined();
  });

  it("an explicit choice at a later sign-in replaces the one on record", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, { ...fresh(), history_declined: true });
    startLiveIfNew(dir, USER, NOW, { history: "read" });
    expect(loadSyncState(dir, USER, NOW).history_declined).toBeUndefined();
    expect(loadSyncState(dir, USER, NOW).live_since, "going live is not moved").toBe(iso(T0));
    startLiveIfNew(dir, USER, NOW, { history: "declined" });
    expect(loadSyncState(dir, USER, NOW).history_declined).toBe(true);
    startLiveIfNew(dir, USER, NOW, {}); // unreachable: nothing new is recorded
    expect(loadSyncState(dir, USER, NOW).history_declined).toBe(true);
  });

  it("`deigma history --no-history` lifts nothing", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, { ...fresh(), history_declined: true });
    await run(["history", "--no-history"], cliDeps(dir, []));
    expect(loadSyncState(dir, USER, NOW).history_declined).toBe(true);
  });

  it("init marks the moment the device goes live", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    const calls: Call[] = [];
    await run(["init", "--no-history"], cliDeps(dir, calls, {
      fetch: (async (url: string) => {
        const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (String(url).includes("/auth/device/token")) return j({ status: "ok", session: "sess-2", handle: "octocat" });
        if (String(url).includes("/auth/device")) return j({ device_code: "dc", user_code: "A-1", verification_uri: "http://w/d", expires_in: 900, interval: 1 });
        return j({ user_id: USER, handle: "octocat" });
      }) as typeof globalThis.fetch,
    }));
    const state = JSON.parse(readFileSync(join(dir, SYNC_FILES.state), "utf8")) as SyncState;
    expect(state.live_since).toBe(iso(NOW));
    expect(state.user_id).toBe(USER);
  });

  it.each([
    ["init --no-history", ["init", "--no-history"], []],
    ["init (history read)", ["init"], [ID.across]],
  ])("%s, then a session that ended an hour before sign-in is synced only if history was read", async (_name, argv, expected) => {
    // The B2 look-back exists for the session `history` skipped as maybe still open. When history
    // was DECLINED there is nothing to make up for, and reading it would break the refusal.
    transcript(ID.across, [NOW - 3 * HOUR, NOW - HOUR]);
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    const api = (calls: Call[]) =>
      (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
        if (String(url).includes("/auth/device/token")) return j({ status: "ok", session: "sess-2", handle: "octocat" });
        if (String(url).includes("/auth/device")) return j({ device_code: "dc", user_code: "A-1", verification_uri: "http://w/d", expires_in: 900, interval: 1 });
        if (String(url).endsWith("/v1/me/repositories")) return j({ repositories: [] });
        if (String(url).endsWith("/v1/events")) return j({ accepted: 1 }, 202);
        return j({ user_id: USER, handle: "octocat" });
      }) as typeof globalThis.fetch;
    await run(argv as string[], cliDeps(dir, [], { fetch: api([]) }));
    const later: Call[] = [];
    await run(["sync"], cliDeps(dir, later, { fetch: api(later), now: () => NOW + 5 * HOUR }));
    const posted = later.filter((c) => c.url.endsWith("/v1/events")).flatMap((c) => (c.body as { events: Event[] }).events);
    expect(posted.map((e) => e.type === "session.summary" && e.payload.session_id)).toEqual(expected);
  });
});

describe("the proxy starts it beside the tool", () => {
  it("starts a sync when one is due, never when the last one was recent, and does not wait for it", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    let started = 0;
    let toolRan = false;
    await run(["proxy", "--", "mcp-server"], cliDeps(dir, [], {
      startSync: () => void (started += 1),
      runProxy: async () => {
        toolRan = true;
        return { sessions: 0 };
      },
    }));
    expect(started).toBe(1);
    expect(toolRan).toBe(true);

    signIn(dir, { ...fresh(), last_run_at: iso(NOW - SYNC_INTERVAL_MS / 2) });
    started = 0;
    await run(["proxy", "--", "mcp-server"], cliDeps(dir, [], { startSync: () => void (started += 1) }));
    expect(started).toBe(0);
  });

  it("fails open: a sync that cannot start leaves the tool running", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    signIn(dir, fresh());
    let toolRan = false;
    const code = await run(["proxy", "--", "mcp-server"], cliDeps(dir, [], {
      startSync: () => {
        throw new Error("spawn EAGAIN");
      },
      runProxy: async () => {
        toolRan = true;
        return { sessions: 0 };
      },
    }));
    expect(code).toBe(0);
    expect(toolRan).toBe(true);
  });

  it("signed out the proxy starts nothing", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "deigma-cfg-")), "deigma");
    let started = 0;
    await run(["proxy", "--", "mcp-server"], cliDeps(dir, [], { startSync: () => void (started += 1) }));
    expect(started).toBe(0);
  });
});
