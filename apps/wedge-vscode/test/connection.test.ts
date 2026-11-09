// RD-16b: the editor signs itself in. Until this, `activate()` collected only when SecretStorage
// held a session and nothing in the product wrote one, so the published extension could never
// connect. Two layers are held here: the Connection against a fake API (what goes on the wire,
// what is stored, what the person is told), and `activate()` itself against a fake `vscode`, so
// the commands are proven wired and not merely written.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  Connection,
  type ConnectionHost,
  type ConnectionState,
  OPEN_PAGE,
  SESSION_KEY,
  statusText,
  USER_KEY,
} from "../src/connection";
import { DEVICE_SALT_KEY } from "../src/device-salt";
import { activate } from "../src/extension";
import * as fakeVscode from "./helpers/fake-vscode";

const API = "http://api.test";
const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";
const DEVICE = {
  device_code: "dc_ide",
  user_code: "WXYZ-2345",
  verification_uri: "http://web.test/device",
  verification_uri_complete: "http://web.test/device?user_code=WXYZ-2345",
  expires_in: 900,
  interval: 2,
};

type Call = { method: string; path: string; body: string | null; auth: string | null };

/** The API as the device flow sees it. Every route answers what the real one answers. */
function fakeApi(opts: {
  token?: unknown[];
  me?: { status: number; body?: unknown };
  endSession?: "ok" | "unreachable" | 401 | undefined;
  /** What ingestion answers; 401 once the session has been ended on the server. */
  events?: 200 | 401;
  start?: "ok" | "unreachable";
}) {
  const calls: Call[] = [];
  const token = [...(opts.token ?? [{ status: "pending" }, { status: "ok", session: "sess-ide", handle: "octocat" }])];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      body: typeof init?.body === "string" ? init.body : null,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (call.path === "/auth/device/start") {
      if (opts.start === "unreachable") throw new TypeError("fetch failed");
      return json(DEVICE);
    }
    if (call.path === "/auth/device/token") return json(token.shift() ?? { status: "pending" });
    if (call.path === "/v1/me") return json(opts.me?.body ?? { user_id: USER }, opts.me?.status ?? 200);
    if (call.path === "/v1/me/session" && call.method === "DELETE") {
      if (opts.endSession === "unreachable") throw new TypeError("fetch failed");
      if (opts.endSession === 401) return json({ error: "unauthenticated" }, 401);
      return json({ revoked: true });
    }
    if (call.path === "/v1/me/sources/wedge_ide" && call.method === "DELETE") {
      return json({ disconnected: "wedge_ide" });
    }
    if (call.path === "/v1/events" && call.method === "POST") {
      if (opts.events === 401) return json({ error: "unauthenticated" }, 401);
      return json({ accepted: 1 });
    }
    return json({ error: "not_found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function fakeHost(api: ReturnType<typeof fakeApi>, pick?: string) {
  const secrets = new Map<string, string>();
  const states: ConnectionState[] = [];
  const messages: string[] = [];
  const opened: string[] = [];
  let clock = 1_000_000;
  const host: ConnectionHost = {
    secrets: {
      get: async (k) => secrets.get(k),
      store: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    fetch: api.fetch,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    openExternal: async (url) => {
      opened.push(url);
      return true;
    },
    notify: async (text) => {
      messages.push(text);
      return pick;
    },
    setState: (s) => void states.push(s),
  };
  return { host, secrets, states, messages, opened };
}

/** Lets the notification's `.then` (the button) run before the assertions read `opened`. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Deigma: Connect (the device flow from the editor)", () => {
  it("asks for an editor code, shows it, opens the page on request, and stores the session with its account", async () => {
    const api = fakeApi({});
    const h = fakeHost(api, OPEN_PAGE);
    const outcome = await new Connection(h.host, API).connect();
    await settle();

    expect(outcome).toEqual({
      status: "connected",
      handle: "octocat",
      credentials: { session: "sess-ide", userId: USER },
    });
    const start = api.calls.find((c) => c.path === "/auth/device/start");
    expect(start, "the flow never asked for a code").toBeDefined();
    // The kind decides which sessions a disconnect revokes (RD-14): an editor that asked as the
    // CLI would be signed out by "disconnect the CLI" and survive "disconnect the editor".
    expect(JSON.parse(start!.body ?? "{}")).toEqual({ client: "ide" });
    // The person compares the code on the page with the one the editor shows; the link prefills.
    expect(h.messages[0]).toContain(DEVICE.user_code);
    expect(h.opened).toEqual([DEVICE.verification_uri_complete]);
    expect(h.states[0]).toEqual({ kind: "waiting", userCode: DEVICE.user_code });
    expect(h.states.at(-1)).toEqual({ kind: "connected" });
    // The account id comes from /v1/me asked WITH the new session, not from anywhere else.
    expect(api.calls.find((c) => c.path === "/v1/me")?.auth).toBe("Bearer sess-ide");
    expect(h.secrets.get(SESSION_KEY)).toBe("sess-ide");
    expect(h.secrets.get(USER_KEY)).toBe(USER);
  });

  it("opens nothing unless the person asks for the page", async () => {
    const h = fakeHost(fakeApi({}));
    await new Connection(h.host, API).connect();
    await settle();
    expect(h.opened).toEqual([]);
  });

  it("stores nothing when the account cannot be named — half a connection is none", async () => {
    const api = fakeApi({ me: { status: 500, body: { error: "internal_error" } } });
    const h = fakeHost(api);
    const outcome = await new Connection(h.host, API).connect();
    expect(outcome.status).toBe("failed");
    expect([...h.secrets.keys()]).toEqual([]);
    expect(h.states.at(-1)).toEqual({ kind: "not_connected" });
    // …and the approved session does not stay behind on the server, where Settings would show
    // the editor connected: that one session is ended, and never the editor kind as a whole.
    const ended = api.calls.filter((c) => c.method === "DELETE");
    expect(ended).toEqual([{ method: "DELETE", path: "/v1/me/session", body: null, auth: "Bearer sess-ide" }]);
    expect(h.messages.at(-1)).toMatch(/the sign-in was ended there/);
  });

  it("says the approved sign-in still stands when it cannot be ended either", async () => {
    const h = fakeHost(fakeApi({ me: { status: 500, body: { error: "internal_error" } }, endSession: "unreachable" }));
    const outcome = await new Connection(h.host, API).connect();
    expect(outcome.status).toBe("failed");
    expect([...h.secrets.keys()]).toEqual([]);
    expect(h.messages.at(-1)).toMatch(/still stands on deigma\.net until you disconnect the editor under Settings, Sources/);
  });

  it.each([
    ["refused", { status: "denied", error: "access_denied" }, /was refused/],
    ["ran out", { status: "denied", error: "expired_token" }, /ran out/],
  ])("says the code was %s and stores nothing", async (_label, answer, words) => {
    const h = fakeHost(fakeApi({ token: [answer] }));
    const outcome = await new Connection(h.host, API).connect();
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.reason).toMatch(words);
    expect(h.messages.at(-1)).toMatch(words);
    expect([...h.secrets.keys()]).toEqual([]);
    expect(h.states.at(-1)).toEqual({ kind: "not_connected" });
  });

  it("never throws out of the command when the API is unreachable (the wedge fails open)", async () => {
    const h = fakeHost(fakeApi({ start: "unreachable" }));
    const outcome = await new Connection(h.host, API).connect();
    expect(outcome.status).toBe("failed");
    expect(h.messages.at(-1)).toMatch(/could not be reached/);
    expect([...h.secrets.keys()]).toEqual([]);
  });

  it("does not start a second flow while one is waiting, nor any flow when already connected", async () => {
    const api = fakeApi({});
    const h = fakeHost(api);
    const connection = new Connection(h.host, API);
    const [first, second] = await Promise.all([connection.connect(), connection.connect()]);
    expect(first.status).toBe("connected");
    expect(second).toEqual({ status: "in_progress" });
    const asked = api.calls.length;
    expect(await connection.connect()).toEqual({
      status: "already_connected",
      credentials: { session: "sess-ide", userId: USER },
    });
    expect(api.calls.length).toBe(asked);
  });
});

describe("Deigma: Disconnect", () => {
  async function connected(endSession?: "ok" | "unreachable" | 401) {
    const api = fakeApi({ endSession });
    const h = fakeHost(api);
    const connection = new Connection(h.host, API);
    await connection.connect();
    expect(h.secrets.get(SESSION_KEY), "precondition: the editor is connected").toBe("sess-ide");
    return { api, h, connection };
  }

  it("ends this editor's own session on deigma.net and forgets it here", async () => {
    const { api, h, connection } = await connected("ok");
    expect(await connection.disconnect()).toEqual({ status: "disconnected", revoked: true });
    const deletes = api.calls.filter((c) => c.method === "DELETE");
    // The one session this editor holds. The Settings row's revocation (sources/wedge_ide) would
    // also sign out an editor on another machine, which would then keep saying it collects.
    expect(deletes.map((c) => c.path)).toEqual(["/v1/me/session"]);
    expect(deletes[0]?.auth).toBe("Bearer sess-ide");
    expect([...h.secrets.keys()]).toEqual([]);
    expect(h.states.at(-1)).toEqual({ kind: "not_connected" });
    expect(h.messages.at(-1)).toMatch(/ended on deigma\.net; the CLI and editors on other machines are untouched/);
  });

  it("reads a session that already ended there as revoked", async () => {
    const { connection } = await connected(401);
    expect(await connection.disconnect()).toEqual({ status: "disconnected", revoked: true });
  });

  it("forgets the session here when deigma.net is unreachable, and does not claim it was revoked there", async () => {
    const { h, connection } = await connected("unreachable");
    expect(await connection.disconnect()).toEqual({ status: "disconnected", revoked: false });
    expect([...h.secrets.keys()]).toEqual([]);
    expect(h.messages.at(-1)).toMatch(/still stands there/);
    expect(h.messages.at(-1)).not.toMatch(/ended on deigma\.net/);
  });
});

describe("a session ended elsewhere", () => {
  it("is forgotten here, and the editor says it is not connected", async () => {
    const api = fakeApi({});
    const h = fakeHost(api);
    const connection = new Connection(h.host, API);
    await connection.connect();
    await connection.endedElsewhere();
    expect([...h.secrets.keys()]).toEqual([]);
    expect(h.states.at(-1)).toEqual({ kind: "not_connected" });
    expect(h.messages.at(-1)).toMatch(/ended on deigma\.net, so it stopped collecting/);
  });
});

describe("the status bar", () => {
  it("says the editor is not connected, in a fact and no instruction", () => {
    expect(statusText({ kind: "not_connected" })).toBe("Deigma: not connected");
    expect(statusText({ kind: "waiting", userCode: "WXYZ-2345" })).toBe("Deigma: waiting for WXYZ-2345");
  });

  it("while a code waits, a click on the bar runs no command that does not exist yet", async () => {
    fakeVscode.reset();
    const api = fakeApi({ token: [] }); // the code stays pending
    const realFetch = globalThis.fetch;
    globalThis.fetch = api.fetch;
    let release: () => void = () => undefined;
    const realTimeout = globalThis.setTimeout;
    // Hold the poll at its first sleep so the waiting state can be read.
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      ms && ms < 30_000 ? void (release = fn) : realTimeout(fn, ms)) as typeof globalThis.setTimeout;
    try {
      const context = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
      await activate(context as never);
      void fakeVscode.state.commands.get("deigma.connect")!();
      for (let i = 0; i < 20 && !fakeVscode.state.status.text.startsWith("Deigma: waiting"); i++) await settle();
      expect(fakeVscode.state.status.text).toBe("Deigma: waiting for WXYZ-2345");
      const command = fakeVscode.state.status.command;
      expect(command === undefined || fakeVscode.state.commands.has(command), `bar bound to unregistered ${command}`).toBe(true);
      void release;
      for (const d of context.subscriptions) d.dispose();
    } finally {
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realTimeout;
    }
  });
});

describe("activate() wires the sign-in (fake vscode)", () => {
  beforeEach(() => fakeVscode.reset());

  it("a fresh install shows 'not connected', offers Connect, and collects nothing", async () => {
    const context = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
    await activate(context as never);
    expect(fakeVscode.state.status).toMatchObject({ text: "Deigma: not connected", command: "deigma.connect", visible: true });
    expect(fakeVscode.state.context.get("deigma.connected")).toBe(false);
    expect([...fakeVscode.state.commands.keys()].sort()).toEqual(["deigma.connect", "deigma.disconnect"]);
  });

  it("Connect stores the session and starts collecting without a reload; Disconnect stops it", async () => {
    const api = fakeApi({ endSession: "ok" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = api.fetch;
    const realTimeout = globalThis.setTimeout;
    // The device flow sleeps the server's interval between polls; the test does not wait for it.
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      realTimeout(fn, ms && ms >= 30_000 ? ms : 0)) as typeof globalThis.setTimeout;
    try {
      const context = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
      await activate(context as never);
      await fakeVscode.state.commands.get("deigma.connect")!();

      expect(fakeVscode.state.secrets.get(SESSION_KEY)).toBe("sess-ide");
      expect(fakeVscode.state.secrets.get(USER_KEY)).toBe(USER);
      expect(fakeVscode.state.context.get("deigma.connected")).toBe(true);
      // The collector registered its commands: it is running, not waiting for a window reload.
      expect(fakeVscode.state.commands.has("deigma.pause")).toBe(true);
      expect(fakeVscode.state.status.text).toMatch(/AI suggestions/);
      // copy v4: the secret scanner's count reaches the real item's tooltip, not the bar
      expect(fakeVscode.state.status.tooltip).toMatch(/blocked by the secret scanner/);
      expect(fakeVscode.state.status.command).toBe("deigma.status");

      await fakeVscode.state.commands.get("deigma.disconnect")!();
      // The session and the account go; the device salt stays, as the CLI keeps device.json.
      expect([...fakeVscode.state.secrets.keys()]).toEqual([DEVICE_SALT_KEY]);
      expect(fakeVscode.state.commands.has("deigma.pause")).toBe(false);
      expect(fakeVscode.state.status).toMatchObject({ text: "Deigma: not connected", command: "deigma.connect" });
      expect(api.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/me/session"]);
      for (const d of context.subscriptions) d.dispose();
    } finally {
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realTimeout;
    }
  });

  it("a session ended on deigma.net stops collecting and the bar stops saying it collects", async () => {
    // Settings revoked the editor (or another machine signed out): ingestion answers 401. Before
    // this the sender retried forever and the bar kept saying `collecting`.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const api = fakeApi({ events: 401 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = api.fetch;
    try {
      fakeVscode.state.secrets.set(SESSION_KEY, "sess-ide");
      fakeVscode.state.secrets.set(USER_KEY, USER);
      const context = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
      await activate(context as never);
      expect(fakeVscode.state.status.text, "precondition: collecting").toMatch(/AI suggestions/);
      await fakeVscode.state.commands.get("deigma.pause")!(); // one event in the queue
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(api.calls.some((c) => c.path === "/v1/events"), "precondition: a batch was sent").toBe(true);
      // The session and the account go; the device salt stays, as the CLI keeps device.json.
      expect([...fakeVscode.state.secrets.keys()]).toEqual([DEVICE_SALT_KEY]);
      expect(fakeVscode.state.commands.has("deigma.pause")).toBe(false);
      expect(fakeVscode.state.status).toMatchObject({ text: "Deigma: not connected", command: "deigma.connect" });
      expect(fakeVscode.state.context.get("deigma.connected")).toBe(false);
      const sent = api.calls.filter((c) => c.path === "/v1/events").length;
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(api.calls.filter((c) => c.path === "/v1/events").length, "kept retrying a session that is gone").toBe(sent);
      for (const d of context.subscriptions) d.dispose();
    } finally {
      globalThis.fetch = realFetch;
      vi.useRealTimers();
    }
  });

  it("a window opened before another window connected: its Connect starts collecting here", async () => {
    // SecretStorage is shared between the editor's windows. This window activated with nothing
    // stored; another window then signed in. A click on this window's "not connected" bar must
    // not be a dead click.
    const api = fakeApi({});
    const realFetch = globalThis.fetch;
    globalThis.fetch = api.fetch;
    try {
      const context = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
      await activate(context as never);
      expect(fakeVscode.state.status.text, "precondition: not connected").toBe("Deigma: not connected");
      fakeVscode.state.secrets.set(SESSION_KEY, "sess-ide"); // stored by the other window
      fakeVscode.state.secrets.set(USER_KEY, USER);
      await fakeVscode.state.commands.get("deigma.connect")!();
      expect(fakeVscode.state.commands.has("deigma.pause")).toBe(true);
      expect(fakeVscode.state.context.get("deigma.connected")).toBe(true);
      expect(fakeVscode.state.status.text).toMatch(/AI suggestions/);
      expect(fakeVscode.state.messages.at(-1)).toMatch(/already connected from another window/);
      expect(api.calls.filter((c) => c.path.startsWith("/auth/device")), "no second code was asked for").toEqual([]);
      for (const d of context.subscriptions) d.dispose();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an editor already signed in starts collecting at once", async () => {
    fakeVscode.state.secrets.set(SESSION_KEY, "sess-ide");
    fakeVscode.state.secrets.set(USER_KEY, USER);
    const context = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
    await activate(context as never);
    expect(fakeVscode.state.commands.has("deigma.pause")).toBe(true);
    expect(fakeVscode.state.context.get("deigma.connected")).toBe(true);
    for (const d of context.subscriptions) d.dispose();
  });
});

describe("the manifest", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
  const contributed: string[] = manifest.contributes.commands.map((c: { command: string }) => c.command);
  const palette: { command: string; when: string }[] = manifest.contributes.menus.commandPalette;

  it("contributes Connect and Disconnect, and the palette offers each only in the state it changes", () => {
    expect(contributed.length, "precondition: the manifest lists commands").toBeGreaterThan(0);
    expect(contributed).toEqual(expect.arrayContaining(["deigma.connect", "deigma.disconnect"]));
    const when = Object.fromEntries(palette.map((p) => [p.command, p.when]));
    expect(when["deigma.connect"]).toBe("!deigma.connected");
    for (const id of ["deigma.disconnect", "deigma.pause", "deigma.resume", "deigma.status"]) {
      expect(when[id], id).toBe("deigma.connected");
    }
  });

  it("names a version above the published 0.1.0, which cannot connect", () => {
    const [major = 0, minor = 0] = String(manifest.version).split(".").map(Number);
    expect(major * 100 + minor).toBeGreaterThan(1);
  });
});

function secretStorage() {
  return {
    get: async (k: string) => fakeVscode.state.secrets.get(k),
    store: async (k: string, v: string) => void fakeVscode.state.secrets.set(k, v),
    delete: async (k: string) => void fakeVscode.state.secrets.delete(k),
  };
}
