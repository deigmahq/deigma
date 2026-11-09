// What the REAL `activate()` puts on the wire for one accepted suggestion (fake vscode, real
// collector, real sender, real builders). The collector's own tests drive it with options a test
// chose; these hold what extension.ts actually passes it — which is where the constant salt hid
// (audit 2026-10-09 #1): the collector took a salt, and the extension never gave it one.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DraftCurationEvent } from "@mentat/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_KEY, USER_KEY } from "../src/connection";
import { DEVICE_SALT_KEY } from "../src/device-salt";
import type { QueueState } from "@mentat/wedge-core";

import { activate, queueStateKey, restoredQueue } from "../src/extension";
import * as fakeVscode from "./helpers/fake-vscode";
import { FakeDocument } from "./helpers/fake-host";

const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";
const SUGGESTION = [
  "export function totalPrice(items: Item[]): number {",
  "  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
  "}",
].join("\n");

type Api = { posted: DraftCurationEvent[]; fetch: typeof globalThis.fetch };

function fakeApi(repositories: { repo_id: number; full_name: string }[] = []): Api {
  const posted: DraftCurationEvent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/events" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { events: DraftCurationEvent[] };
      posted.push(...body.events.filter((e) => e.type === "draft.curation"));
      return json({ accepted: body.events.length });
    }
    if (url.pathname === "/v1/me/repositories") return json({ repositories });
    return json({ error: "not_found" }, 404);
  }) as typeof globalThis.fetch;
  return { posted, fetch };
}

const secretStorage = () => ({
  get: async (k: string) => fakeVscode.state.secrets.get(k),
  store: async (k: string, v: string) => void fakeVscode.state.secrets.set(k, v),
  delete: async (k: string) => void fakeVscode.state.secrets.delete(k),
});

/** One device: a signed-in editor that accepts SUGGESTION once. Returns what reached the API. */
async function oneDevice(api: Api, docPath = "/repo/src/app.ts"): Promise<{ event: DraftCurationEvent; salt: string }> {
  fakeVscode.reset();
  fakeVscode.state.secrets.set(SESSION_KEY, "sess-ide");
  fakeVscode.state.secrets.set(USER_KEY, USER);
  const context = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
  await activate(context as never);
  await vi.advanceTimersByTimeAsync(0); // the connected list arrives beside the editor, not before it
  const doc = new FakeDocument("// file\n", docPath);
  const change = doc.applyEdit(1, 1, SUGGESTION);
  for (const l of fakeVscode.state.onChange) l({ document: doc, contentChanges: [change] });
  for (const l of fakeVscode.state.onSave) l(doc);
  const before = api.posted.length;
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  for (const d of context.subscriptions) d.dispose();
  const event = api.posted[before];
  expect(event, "input: the accepted suggestion reached the API").toBeDefined();
  return { event: event!, salt: fakeVscode.state.secrets.get(DEVICE_SALT_KEY)! };
}

describe("the editor's device salt, through activate()", () => {
  let api: Api;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    api = fakeApi();
    globalThis.fetch = api.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("hashes with this device's own stored salt — not with any constant", async () => {
    const { event, salt } = await oneDevice(api);
    expect(salt.length).toBeGreaterThanOrEqual(32);
    const expected = createHash("sha256").update(salt).update(SUGGESTION, "utf8").digest("hex");
    expect(event.payload.draft_hash).toBe(expected);
    const constant = createHash("sha256").update("device-salt").update(SUGGESTION, "utf8").digest("hex");
    expect(event.payload.draft_hash).not.toBe(constant);
    // the editor cannot know the model behind a suggestion, and says so instead of a placeholder
    expect(event.model).toEqual({ known: false, family: "unknown", name: "unknown", generation_tag: "unknown" });
    // the salt is kept, never sent
    expect(JSON.stringify(api.posted)).not.toContain(salt);
  });

  it("two devices hash the same suggestion differently", async () => {
    const a = await oneDevice(api);
    const b = await oneDevice(api);
    expect(a.salt).not.toBe(b.salt);
    expect(a.event.payload.draft_hash).not.toBe(b.event.payload.draft_hash);
  });

  it("the same device keeps its salt across a restart", async () => {
    fakeVscode.reset();
    fakeVscode.state.secrets.set(SESSION_KEY, "sess-ide");
    fakeVscode.state.secrets.set(USER_KEY, USER);
    const first = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
    await activate(first as never);
    const salt = fakeVscode.state.secrets.get(DEVICE_SALT_KEY);
    for (const d of first.subscriptions) d.dispose();
    fakeVscode.state.commands.clear();
    const second = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
    await activate(second as never);
    expect(salt).toBeTruthy();
    expect(fakeVscode.state.secrets.get(DEVICE_SALT_KEY)).toBe(salt);
    for (const d of second.subscriptions) d.dispose();
  });

  it("nothing is kept before a sign-in: no salt on a machine that never connected", async () => {
    fakeVscode.reset();
    const context = { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
    await activate(context as never);
    expect(fakeVscode.state.secrets.has(DEVICE_SALT_KEY)).toBe(false);
  });
});

describe("the editor's carrier hint, through activate() (audit 2026-10-09 #3)", () => {
  // A real checkout on disk, in the layout git writes: the extension reads files, never runs git.
  const REMOTE_URL = ["git", "@github.com:acme/shop.git"].join("");
  const checkout = (): string => {
    const root = mkdtempSync(join(tmpdir(), "deigma-shop-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "config"), `[remote "origin"]\n\turl = ${REMOTE_URL}\n`);
    return root;
  };
  /** The golden fixture the Python side binds. */
  const golden = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../packages/schemas/fixtures/valid/event/draft.curation.editor-bound.json"),
      "utf8",
    ),
  ) as DraftCurationEvent;

  const realFetch = globalThis.fetch;
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("a draft in a connected repository carries its id and branch — exactly the hint the server binds", async () => {
    const api = fakeApi([{ repo_id: 7, full_name: "acme/shop" }]);
    globalThis.fetch = api.fetch;
    const { event } = await oneDevice(api, join(checkout(), "src", "cart.ts"));
    expect(golden.payload.carrier_hint, "input: the golden fixture carries a hint").toBeDefined();
    expect(event.payload.carrier_hint).toEqual(golden.payload.carrier_hint);
    // the remote and the path stay on the machine; only the numeric id travels
    const wire = JSON.stringify(api.posted);
    expect(wire).not.toContain("acme/shop");
    expect(wire).not.toContain("cart.ts");
  });

  it("a draft in a repository nobody connected carries no hint at all — not even the branch", async () => {
    const api = fakeApi([{ repo_id: 9, full_name: "someone/else" }]);
    globalThis.fetch = api.fetch;
    const { event } = await oneDevice(api, join(checkout(), "src", "cart.ts"));
    expect(event.payload.carrier_hint).toBeUndefined();
  });

  it("an unreachable API leaves the draft unattached and the editor untouched", async () => {
    const api = fakeApi();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/me/repositories")) throw new TypeError("fetch failed");
      return api.fetch(input, init);
    }) as typeof globalThis.fetch;
    const { event } = await oneDevice(api, join(checkout(), "src", "cart.ts"));
    expect(event.payload.carrier_hint).toBeUndefined();
  });
});

describe("the editor's offline queue survives a restart (handbook finding 2026-10-20)", () => {
  // The Sender took persist/restore and the extension never passed them: whatever had not been
  // sent when the window closed was gone. Mutation-checked: dropping `persist` or `restore` from
  // startCollecting turns the first test red.
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  const signedIn = () => {
    fakeVscode.state.secrets.set(SESSION_KEY, "sess-ide");
    fakeVscode.state.secrets.set(USER_KEY, USER);
    return { subscriptions: [] as { dispose(): void }[], secrets: secretStorage(), globalState: fakeVscode.globalStateMemento(), extension: fakeVscode.extensionManifest };
  };
  const offline = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/v1/events")) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ repositories: [] }), { status: 200 });
  }) as typeof globalThis.fetch;

  it("an event gathered offline is sent after the editor restarts, under its own event_id", async () => {
    fakeVscode.reset();
    globalThis.fetch = offline;
    const first = signedIn();
    await activate(first as never);
    await vi.advanceTimersByTimeAsync(0);
    const doc = new FakeDocument("// file\n", "/repo/src/app.ts");
    const change = doc.applyEdit(1, 1, SUGGESTION);
    for (const l of fakeVscode.state.onChange) l({ document: doc, contentChanges: [change] });
    for (const l of fakeVscode.state.onSave) l(doc);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    for (const d of first.subscriptions) d.dispose(); // the window closes with the event unsent
    await vi.advanceTimersByTimeAsync(0);

    const kept = fakeVscode.state.globalState.get(queueStateKey(USER)) as QueueState | undefined;
    expect(kept?.pending.length, "input: the unsent event is kept on this machine").toBe(1);
    const keptId = kept!.pending[0]!.event_id;
    // what is kept is metadata only — the suggestion's text is not in it
    expect(JSON.stringify(kept)).not.toContain("items.reduce");

    // Restart: a fresh activation, same machine, network back.
    fakeVscode.state.commands.clear();
    fakeVscode.state.onChange.length = 0;
    fakeVscode.state.onSave.length = 0;
    const api = fakeApi();
    globalThis.fetch = api.fetch;
    const second = signedIn();
    await activate(second as never);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    for (const d of second.subscriptions) d.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.posted.map((e) => e.event_id)).toContain(keptId);
    expect((fakeVscode.state.globalState.get(queueStateKey(USER)) as QueueState).pending).toHaveLength(0);
  });

  it("events past the 72 h offline window are dropped, not sent", async () => {
    fakeVscode.reset();
    const golden = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../packages/schemas/fixtures/valid/event/draft.curation.editor-bound.json"), "utf8"),
    ) as DraftCurationEvent;
    const stale = { ...golden, occurred_at: new Date(Date.now() - 73 * 3_600_000).toISOString() };
    fakeVscode.state.globalState.set(queueStateKey(USER), { pending: [stale], firstQueuedAt: Date.now() - 73 * 3_600_000 });
    const api = fakeApi();
    globalThis.fetch = api.fetch;
    const context = signedIn();
    await activate(context as never);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    for (const d of context.subscriptions) d.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.posted.map((e) => e.event_id)).not.toContain(stale.event_id);
    expect((fakeVscode.state.globalState.get(queueStateKey(USER)) as QueueState).pending).toHaveLength(0);
  });

  it("another account's queue is never sent under this session", async () => {
    fakeVscode.reset();
    const golden = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../packages/schemas/fixtures/valid/event/draft.curation.editor-bound.json"), "utf8"),
    ) as DraftCurationEvent;
    const other = { ...golden, occurred_at: new Date().toISOString() };
    fakeVscode.state.globalState.set(queueStateKey("someone-else"), { pending: [other], firstQueuedAt: Date.now() - 10 * 60_000 });
    const api = fakeApi();
    globalThis.fetch = api.fetch;
    const context = signedIn();
    await activate(context as never);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    for (const d of context.subscriptions) d.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.posted.map((e) => e.event_id)).not.toContain(other.event_id);
  });

  it("restoredQueue refuses what is not a queue", () => {
    expect(restoredQueue(undefined)).toBeNull();
    expect(restoredQueue("x")).toBeNull();
    expect(restoredQueue({ pending: "no" })).toBeNull();
    expect(restoredQueue({ pending: [], firstQueuedAt: null })).toEqual({ pending: [], firstQueuedAt: null });
  });
});
