// Signed in or not: nothing is read, kept or sent before the person signs in, the proxy
// still fails OPEN while signed out, and after sign-in everything is tied to the account.
//
// Every command runs through `run` with a temporary config directory, a recording fetch and fake
// streams, and each test first asserts the precondition it depends on (the directory is empty, the
// fetch was or was not called) — a test of "nothing is written" over a directory nobody looked at
// would pass against anything.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event } from "@mentat/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FILES, run, spawnPassThrough, type CliDeps } from "../src/cli";
import {
  PROXY_SESSION_ENDED_LINE,
  PROXY_SIGNED_OUT_LINE,
  SESSION_ENDED_LINE,
  SIGNED_OUT_DONE_LINE,
  SIGNED_OUT_LINE,
} from "../src/messages";

const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";
const API = "http://api.test";
// Salts as long as a real one (32 random bytes, base64): the builders refuse anything shorter.
const DEVICE_SALT = "dGhpcy1pcy1hLWRldmljZS1zYWx0LWZvci10ZXN0cy0x";
const LEGACY_SALT = "bGVnYWN5LXNhbHQtZnJvbS1iZWZvcmUtZml4MDUtLS0x";
const LEGACY_SALT_2 = "bGVnYWN5LXNhbHQtZnJvbS1iZWZvcmUtZml4MDUtLS0y";

type Call = { url: string; method: string; auth: string | undefined; body: unknown };
type Route = (call: Call) => Response | "throw";

let dir: string;
let calls: Call[];
let out: string[];
let err: string[];
let passed: Array<{ command: string; args: string[] }>;
let proxied: Array<Parameters<CliDeps["runProxy"]>[0]>;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "deigma-cli-")), "deigma");
  calls = [];
  out = [];
  err = [];
  passed = [];
  proxied = [];
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function event(id: string, occurredAt = new Date(1_000_000).toISOString()): Event {
  return { event_id: id, occurred_at: occurredAt, kind: "session.summary" } as unknown as Event;
}

function deps(route: Route, extra: Partial<CliDeps> = {}): CliDeps {
  return {
    configDir: dir,
    apiBaseUrl: API,
    fetch: (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url: String(url),
        method: init?.method ?? "GET",
        auth: headers.authorization,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const res = route(call);
      if (res === "throw") throw new TypeError("fetch failed");
      return res;
    }) as typeof globalThis.fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    sleep: async () => undefined,
    now: () => 1_000_000,
    passThrough: async (command, args) => {
      passed.push({ command, args });
      return 7;
    },
    runProxy: async (d) => {
      proxied.push(d);
      return { sessions: 0 };
    },
    localBackfill: async () => ({
      events: [event("hist-1")],
      sessions: 1,
      unresolved: 0,
      historyOnly: 0,
      attention_backfilled: false,
      note: "",
    }),
    ...extra,
  };
}

const files = () => (existsSync(dir) ? readdirSync(dir).sort() : []);

function signIn(session: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, FILES.session),
    JSON.stringify({ session: "sess-1", handle: "octocat", apiBaseUrl: API, user_id: USER, ...session }),
  );
  writeFileSync(join(dir, FILES.device), JSON.stringify({ salt: DEVICE_SALT }));
}

const nothingAnswers: Route = () => new Response("unexpected", { status: 500 });

describe("signed out: nothing is read, kept or sent", () => {
  it.each(["status", "pulse", "history", "whoami"])("`deigma %s` says how to sign in, exits 2, touches nothing", async (cmd) => {
    expect(files()).toEqual([]);
    const code = await run([cmd], deps(nothingAnswers));
    expect(code).toBe(2);
    expect(err).toEqual([SIGNED_OUT_LINE]);
    expect(out).toEqual([]);
    expect(calls, "a signed-out command made a request").toEqual([]);
    expect(files(), "a signed-out command wrote a file").toEqual([]);
  });

  it("a bare `deigma` shows every command and that this machine is not signed in", async () => {
    expect(await run([], deps(nothingAnswers))).toBe(0);
    for (const c of ["init", "--no-hook", "status", "pulse", "sync", "history", "proxy", "whoami", "logout"]) {
      expect(out.join("\n"), c).toContain(c);
    }
    expect(out[out.length - 1]).toBe(SIGNED_OUT_LINE);
    // An unknown command still answers with the usage line and points at the full list.
    out.length = 0;
    expect(await run(["frobnicate"], deps(nothingAnswers))).toBe(2);
    expect(out.join("\n")).toContain("npx deigma help");
    expect(calls).toEqual([]);
    expect(files()).toEqual([]);
  });

  it("the history pass never runs before a sign-in", async () => {
    let read = 0;
    await run(["history"], deps(nothingAnswers, { localBackfill: async () => ((read += 1), { events: [], sessions: 0, unresolved: 0, historyOnly: 0, attention_backfilled: false, note: "" }) }));
    expect(read).toBe(0);
  });

  it("a denied code leaves the machine signed out, with no file written", async () => {
    const route: Route = (c) =>
      c.url.endsWith("/auth/device/token")
        ? json({ status: "denied", error: "access_denied" })
        : json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "http://web.test/device", expires_in: 900, interval: 1 });
    await expect(run(["init"], deps(route))).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(0);
    expect(files()).toEqual([]);
  });
});

describe("signed out, the proxy fails open", () => {
  it("runs the MCP server unchanged, says so on stderr only, records nothing", async () => {
    const code = await run(["proxy", "--", "mcp-server", "--port", "0"], deps(nothingAnswers));
    expect(passed).toEqual([{ command: "mcp-server", args: ["--port", "0"] }]);
    expect(code, "the tool's own exit code is the proxy's").toBe(7);
    expect(err).toEqual([PROXY_SIGNED_OUT_LINE]);
    expect(out, "stdout is the JSON-RPC channel; nothing of ours goes there").toEqual([]);
    expect(proxied).toEqual([]);
    expect(calls).toEqual([]);
    expect(files()).toEqual([]);
  });

  it("the real pass-through is the child's own stdio and exit code", async () => {
    const code = await spawnPassThrough(process.execPath, ["-e", "process.exit(5)"], (l) => err.push(l));
    expect(code).toBe(5);
    const missing = await spawnPassThrough("/nonexistent/deigma-test-binary", [], (l) => err.push(l));
    expect(missing).toBe(127);
    expect(err.join("\n")).toContain("/nonexistent/deigma-test-binary");
  });
});

describe("a sign-in the server no longer knows", () => {
  it.each(["status", "pulse", "history", "whoami"])("`deigma %s` on a 401 removes the local sign-in and says so", async (cmd) => {
    signIn();
    writeFileSync(join(dir, FILES.queue), JSON.stringify({ user_id: USER, pending: [event("q-1")] }));
    const code = await run([cmd], deps((c) => (c.url.endsWith("/repositories") ? json({ repositories: [] }) : json({}, 401))));
    expect(code).toBe(2);
    expect(err).toEqual([SESSION_ENDED_LINE]);
    expect(files(), "the device salt stays; the sign-in and its unsent sessions go").toEqual([FILES.device]);
  });

  it("the proxy on a 401 at its first send stops recording and the tool keeps running", async () => {
    signIn();
    const d = deps(() => json({}, 401), {
      runProxy: async (p) => {
        await p.send(event("live-1"));
        await p.send(event("live-2"));
        return { sessions: 0 };
      },
    });
    expect(await run(["proxy", "--", "mcp-server"], d)).toBe(0);
    expect(err).toEqual([PROXY_SESSION_ENDED_LINE]);
    expect(calls.filter((c) => c.url.endsWith("/v1/events"))).toHaveLength(1);
    expect(files()).toEqual([FILES.device]);
  });

  it("a sign-in without its user id that has ended passes the tool through", async () => {
    signIn({ user_id: undefined });
    expect(await run(["proxy", "--", "mcp-server"], deps(() => json({}, 401)))).toBe(7);
    expect(passed).toHaveLength(1);
    expect(err).toEqual([PROXY_SESSION_ENDED_LINE]);
  });
});

describe("signed in: tied to the account", () => {
  it("the proxy attributes sessions to the account with the device salt, and starts without a request in front of the tool", async () => {
    signIn();
    let callsBeforeTool = -1;
    const d = deps(() => json({ accepted: 1 }), {
      runProxy: async (p) => {
        callsBeforeTool = calls.length;
        proxied.push(p);
        await p.send(event("live-1"));
        return { sessions: 1 };
      },
    });
    expect(await run(["proxy", "--", "mcp-server", "-v"], d)).toBe(0);
    expect(callsBeforeTool).toBe(0);
    expect(proxied[0]!.identity).toEqual({ userId: USER, salt: DEVICE_SALT });
    expect(proxied[0]!.command).toBe("mcp-server");
    const sent = calls.filter((c) => c.url === `${API}/v1/events`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.auth).toBe("Bearer sess-1");
    expect(err).toEqual([]);
  });

  it("a session that could not be sent waits on disk, for this account only, and goes with the next command", async () => {
    signIn();
    const offline = deps(() => "throw", {
      runProxy: async (p) => {
        await p.send(event("live-1"));
        await p.send(event("live-2"));
        return { sessions: 2 };
      },
    });
    expect(await run(["proxy", "--", "mcp-server"], offline)).toBe(0);
    const queued = JSON.parse(readFileSync(join(dir, FILES.queue), "utf8")) as { user_id: string; pending: Event[] };
    expect(queued.user_id).toBe(USER);
    expect(queued.pending.map((e) => e.event_id)).toEqual(["live-1", "live-2"]);
    expect(statSync(join(dir, FILES.queue)).mode & 0o777).toBe(0o600);

    calls = [];
    out = [];
    const online = deps((c) =>
      c.url.endsWith("/repositories") ? json({ repositories: [] }) : c.url.endsWith("/pulse") ? json({ view: { status: "init", backfill: "running", backfill_progress: null, metadata_collected: [] }, telemetryDays: 0 }) : json({ accepted: 2 }),
    );
    expect(await run(["status"], online)).toBe(0);
    const flushed = calls.find((c) => c.url === `${API}/v1/events`);
    expect((flushed!.body as { events: Event[] }).events.map((e) => e.event_id)).toEqual(["live-1", "live-2"]);
    expect(out.join("\n")).toContain("Sent 2 earlier sessions");
    expect(files()).not.toContain(FILES.queue);
  });

  it("another account's unsent sessions are never sent as this one's", async () => {
    signIn();
    writeFileSync(join(dir, FILES.queue), JSON.stringify({ user_id: "someone-else", pending: [event("theirs")] }));
    await run(["history"], deps((c) => (c.url.endsWith("/v1/me") ? json({ user_id: USER, handle: "octocat" }) : json({ repositories: [] }))));
    const sentIds = calls
      .filter((c) => c.url.endsWith("/v1/events"))
      .flatMap((c) => (c.body as { events: Event[] }).events.map((e) => e.event_id));
    expect(sentIds).toEqual(["hist-1"]);
  });

  it("logout ends the session on the server, removes it here, and keeps the device salt", async () => {
    signIn();
    expect(await run(["logout"], deps(() => json({ revoked: true })))).toBe(0);
    expect(calls).toEqual([{ url: `${API}/v1/me/session`, method: "DELETE", auth: "Bearer sess-1", body: undefined }]);
    expect(out).toEqual([SIGNED_OUT_DONE_LINE]);
    expect(files()).toEqual([FILES.device]);
    // ...and afterwards it is signed out like a machine that never was.
    calls = [];
    err = [];
    expect(await run(["status"], deps(nothingAnswers))).toBe(2);
    expect(err).toEqual([SIGNED_OUT_LINE]);
    expect(calls).toEqual([]);
  });

  it("logout while Deigma is unreachable still signs this machine out", async () => {
    signIn();
    expect(await run(["logout"], deps(() => "throw"))).toBe(0);
    expect(files()).toEqual([FILES.device]);
  });

  it("whoami names the account", async () => {
    signIn();
    expect(await run(["whoami"], deps(() => json({ user_id: USER, handle: "octocat" })))).toBe(0);
    expect(out[0]).toContain("Signed in as @octocat");
  });
});

describe("the device salt", () => {
  it("an older sign-in keeps its salt: it moves to device.json and out of session.json", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FILES.session), JSON.stringify({ session: "old", handle: "octocat", apiBaseUrl: API, salt: LEGACY_SALT }));
    const d = deps((c) => (c.url.endsWith("/v1/me") ? json({ user_id: USER, handle: "octocat" }) : json({})));
    expect(await run(["proxy", "--", "mcp-server"], d)).toBe(0);
    expect(proxied[0]!.identity.salt).toBe(LEGACY_SALT);
    expect(JSON.parse(readFileSync(join(dir, FILES.device), "utf8"))).toEqual({ salt: LEGACY_SALT });
    expect(JSON.parse(readFileSync(join(dir, FILES.session), "utf8"))).not.toHaveProperty("salt");
  });

  it("an older sign-in that has ended keeps its salt when the sign-in is removed", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FILES.session), JSON.stringify({ session: "old", handle: "octocat", apiBaseUrl: API, salt: LEGACY_SALT }));
    expect(await run(["status"], deps((c) => (c.url.endsWith("/repositories") ? json({ repositories: [] }) : json({}, 401))))).toBe(2);
    expect(files()).toEqual([FILES.device]);
    expect(JSON.parse(readFileSync(join(dir, FILES.device), "utf8"))).toEqual({ salt: LEGACY_SALT });
    rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FILES.session), JSON.stringify({ session: "old", handle: "octocat", apiBaseUrl: API, salt: LEGACY_SALT_2 }));
    expect(await run(["logout"], deps(() => json({ revoked: true })))).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, FILES.device), "utf8"))).toEqual({ salt: LEGACY_SALT_2 });
  });

  it("signing out and in again keeps the same salt, so project hashes keep meaning the same project", async () => {
    signIn();
    await run(["logout"], deps(() => json({ revoked: true })));
    const route: Route = (c) => {
      if (c.url.endsWith("/auth/device/token")) return json({ status: "ok", session: "sess-2", handle: "octocat" });
      if (c.url.includes("/auth/device")) {
        return json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "http://web.test/device", expires_in: 900, interval: 1 });
      }
      if (c.url.endsWith("/v1/me")) return json({ user_id: USER, handle: "octocat" });
      return json({ repositories: [] });
    };
    expect(await run(["init", "--no-history"], deps(route))).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, FILES.device), "utf8"))).toEqual({ salt: DEVICE_SALT });
    expect(JSON.parse(readFileSync(join(dir, FILES.session), "utf8"))).toMatchObject({ session: "sess-2", user_id: USER });
  });

  it("init adds the SessionEnd and Stop hooks and says so; --no-hook does not; logout removes them (review B2)", async () => {
    const route: Route = (c) => {
      if (c.url.endsWith("/auth/device/token")) return json({ status: "ok", session: "sess-2", handle: "octocat" });
      if (c.url.includes("/auth/device")) {
        return json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "http://web.test/device", expires_in: 900, interval: 1 });
      }
      if (c.url.endsWith("/v1/me")) return json({ user_id: USER, handle: "octocat" });
      if (c.url.endsWith("/v1/me/session")) return json({ revoked: true });
      return json({ repositories: [] });
    };
    const claude = mkdtempSync(join(tmpdir(), "deigma-claude-"));
    const settings = join(claude, ".claude", "settings.json");
    expect(await run(["init", "--no-history", "--no-hook"], deps(route, { claudeSettingsHome: claude }))).toBe(0);
    expect(existsSync(settings)).toBe(false);
    expect(out.join("\n")).toContain("deigma proxy");
    out.length = 0;
    expect(await run(["init", "--no-history"], deps(route, { claudeSettingsHome: claude }))).toBe(0);
    expect(readFileSync(settings, "utf8")).toContain("deigma sync");
    // Both entries (founder, 2026-10-31): the session end, and twice a day while one stays open.
    expect(Object.keys(JSON.parse(readFileSync(settings, "utf8")).hooks).sort()).toEqual(["SessionEnd", "Stop"]);
    expect(out.join("\n")).toContain("a SessionEnd and a Stop hook");
    expect(await run(["logout"], deps(route, { claudeSettingsHome: claude }))).toBe(0);
    expect(readFileSync(settings, "utf8")).not.toContain("deigma sync");
  });

  it("history goes in batches; a batch that cannot go is not reported as read (review M15)", async () => {
    signIn();
    const events = Array.from({ length: 1200 }, (_, i) => ({ event_id: `e${i}` }));
    let posts = 0;
    const route: Route = (c) => {
      if (c.url.endsWith("/v1/me")) return json({ user_id: USER, handle: "octocat" });
      if (c.url.endsWith("/v1/events")) {
        posts += 1;
        return posts === 2 ? json({}, 503) : json({ accepted: 1 });
      }
      return json({ repositories: [] });
    };
    const backfill = async () => ({ events, sessions: 40, unresolved: 0, historyOnly: 0, attention_backfilled: false, note: "" });
    expect(await run(["history"], deps(route, { localBackfill: backfill as never }))).toBe(0);
    const sizes = calls.filter((c) => c.url.endsWith("/v1/events")).map((c) => (c.body as { events: unknown[] }).events.length);
    expect(sizes).toEqual([500, 500]); // the second failed, the third was never tried
    expect(out.join("\n")).toContain("npx deigma history");
    expect(out.join("\n")).not.toContain("Read 40");
  });

  it("init offers to open the sign-in page and stops listening once approved; status says what this machine read", async () => {
    const route: Route = (c) => {
      if (c.url.endsWith("/auth/device/token")) return json({ status: "ok", session: "sess-2", handle: "octocat" });
      if (c.url.includes("/auth/device")) {
        return json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "http://web.test/device", verification_uri_complete: "http://web.test/device?code=ABCD-1234", expires_in: 900, interval: 1 });
      }
      if (c.url.endsWith("/v1/me")) return json({ user_id: USER, handle: "octocat" });
      return json({ repositories: [] });
    };
    const offered: string[] = [];
    let stopped = 0;
    const offerOpen = (url: string) => {
      offered.push(url);
      return () => {
        stopped += 1;
      };
    };
    expect(await run(["init", "--no-history", "--no-hook"], deps(route, { offerOpen }))).toBe(0);
    expect(offered).toEqual(["http://web.test/device?code=ABCD-1234"]);
    expect(stopped).toBe(1);
  });

  it("a stored salt too short to be a device salt is replaced, not used (audit 2026-10-09 #1)", async () => {
    signIn();
    writeFileSync(join(dir, FILES.device), JSON.stringify({ salt: "device-salt" }));
    const d = deps(() => json({ accepted: 1 }), {
      runProxy: async (p) => {
        proxied.push(p);
        return { sessions: 0 };
      },
    });
    expect(await run(["proxy", "--", "mcp-server"], d)).toBe(0);
    const salt = (proxied[0]!.identity as { salt: string }).salt;
    expect(salt).not.toBe("device-salt");
    expect(Buffer.from(salt, "base64")).toHaveLength(32);
    expect(JSON.parse(readFileSync(join(dir, FILES.device), "utf8"))).toEqual({ salt });
  });
});
