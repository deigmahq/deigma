// The commands of `deigma`, as a function a test can call.
//
// main.ts used to dispatch at the top level of the module, so nothing about signing in, signing
// out or failing open could be checked without running a real process against a real account.
// Everything the process touches — the config directory, the network, the child process, the
// two output streams — arrives here as a dependency; main.ts only wires the real ones.
//
// The rule this file holds: a person can install it, but there is no point if it stores something
// without signing in, so NOTHING is read, kept or sent before the person signs in.
//
//   * Signed out, `status`, `pulse` and `history` print how to sign in and exit 2 — no request,
//     no file. A bare `deigma` says whether this machine is signed in.
//   * Signed out, `proxy` runs the MCP server exactly as if Deigma were not there (the wedge
//     fails OPEN: a tool that stops working because of us is uninstalled the same day) and says
//     on stderr — never stdout, which is the JSON-RPC channel — that the session is not recorded.
//   * A session the server no longer knows (401) is a sign-in that ended: the local copy and the
//     unsent sessions that belonged to it are removed, and the person is told how to sign in again.
//   * Signed in, everything is tied to the account: a session that could not be sent when it
//     ended waits in an on-disk queue (≤ 72 h, the server's own horizon for late events) and goes
//     with the next command that talks to Deigma. The queue exists only while signed in.
//
// Three files under ~/.config/deigma, all 0600:
//   session.json  the sign-in: session, handle, user id, which API. Written only after approval.
//   device.json   the device's salt (see ./vocabulary). Apart from the sign-in on purpose: signing
//                 out and in again must not change every project hash and tool hash this machine
//                 ever sent. Written at the first sign-in, never before.
//   queue.json    sessions not sent yet, with the user id they belong to.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  awaitApproval,
  dropExpired,
  MAX_BATCH,
  MIN_DEVICE_SALT_LENGTH,
  newDeviceSalt,
  startDeviceFlow,
} from "@mentat/wedge-core";
import { renderPulse, weeklyPulse } from "@mentat/coach";
import type { Event } from "@mentat/schemas";

import {
  batches,
  ledgerKey,
  loadSyncState,
  settleSync,
  planSync,
  recordHistoryRead,
  saveSyncState,
  startLiveIfNew,
  SYNC_FETCH_TIMEOUT_MS,
  SYNC_INTERVAL_MS,
  syncDue,
  takeSyncLock,
} from "./journal-sync";
import { agentsOnThisMachine, type localBackfill as LocalBackfill } from "./local-backfill";
import {
  ALREADY_SIGNED_OUT_LINE,
  connectedLines,
  HELP_LINES,
  deviceReadLine,
  historyConsentLine,
  historyLines,
  PROXY_SESSION_ENDED_LINE,
  PROXY_SIGNED_OUT_LINE,
  queuedSentLine,
  SESSION_ENDED_LINE,
  SIGNED_OUT_DONE_LINE,
  SIGNED_OUT_LINE,
  signedInLine,
  STOP_HOOK_ADDED_LINE,
  USAGE_LINE,
  webBaseUrlFor,
  type HistoryOutcome,
} from "./messages";
import type { runProxy as RunProxy } from "./proxy-run";
import type { ConnectedRepo } from "@mentat/wedge-core";
import { renderStatus } from "./status";
import { installSyncHook, removeSyncHook, stopHookInstalled, syncHookInstalled } from "./claude-hook";
import { codexNotifyState, installCodexNotify, removeCodexNotify } from "./codex-notify";
import { codexHome } from "./journals/codex";
import { knownTaskFolders, rememberTaskFolders, taskFolderCheck, taskRepositories } from "./task/card-exclusion";
import { TASK_USAGE_LINES } from "./task/messages";
import { taskSubmit } from "./task/submit";

export type CliDeps = {
  /** ~/.config/deigma in the real process; a temporary directory in tests. */
  configDir: string;
  /** Where a NEW sign-in talks to. A stored sign-in keeps the API it was made against. */
  apiBaseUrl: string;
  webUrlOverride?: string | undefined;
  fetch: typeof globalThis.fetch;
  /** stdout. Never used by `proxy`: there stdout belongs to the MCP client. */
  out: (line: string) => void;
  /** stderr. */
  err: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Runs the MCP server with the terminal's own stdio and resolves to its exit code: the proxy
   *  when there is nobody to attribute a session to. */
  passThrough: (command: string, args: string[]) => Promise<number>;
  runProxy: typeof RunProxy;
  localBackfill: typeof LocalBackfill;
  /** Starts `deigma sync` as a detached, low-priority process and returns at once (./journal-sync).
   *  Never awaited, never in front of the tool; a failure to start is swallowed. */
  startSync?: (() => void) | undefined;
  /** $HOME in the real process; a temporary directory in tests. */
  home?: string | undefined;
  /** Offers to open the sign-in page on Enter, the way `npm login` does, and returns a function
   *  that stops listening. Only the real process sets it, and only on a terminal: a test or a pipe
   *  never waits on a key. The link is still printed, so nothing depends on it. */
  offerOpen?: ((url: string) => () => void) | undefined;
  /** Whose `~/.claude/settings.json` `init` may add the SessionEnd hook to (./claude-hook). Only
   *  the real process sets it — a test that does not name a directory can never touch a real
   *  person's Claude Code settings — and without it no hook is added or removed. */
  claudeSettingsHome?: string | undefined;
  /** The Codex home (`$CODEX_HOME`, else ~/.codex) whose config.toml `init` may add the notify
   *  entry to (./codex-notify, decision 4). Only the real process sets it, for the same reason as
   *  `claudeSettingsHome`; without it nothing is added or removed. */
  codexConfigHome?: string | undefined;
  /** Per-request limit of `deigma sync`; SYNC_FETCH_TIMEOUT_MS unless a test shortens it. */
  syncFetchTimeoutMs?: number | undefined;
  /** The folder the command runs in (`deigma task submit`, the proxy): process.cwd() in the real process. */
  cwd?: string | undefined;
  /** The network for public GitHub addresses, which does not add Deigma's client header (./task/github).
   *  Without it the pull request of a branch cannot be looked up and `--pr` names it. */
  publicFetch?: typeof globalThis.fetch | undefined;
  /** Whether there is a person at a terminal who can be asked (stdin and stdout are both a TTY).
   *  Only the real process sets it: `deigma task submit` sends nothing without a yes, and a pipe
   *  or a program driving the shell is not a person. */
  canAsk?: boolean | undefined;
  /** Asks a yes/no question at the terminal; false is no, and so is Ctrl-C or a closed input. */
  ask?: ((question: string) => Promise<boolean>) | undefined;
};

type Session = { session: string; handle: string | null; apiBaseUrl: string; user_id?: string };
type Queue = { user_id: string; pending: Event[] };

/** The sign-in a test or a person can see on disk, and nothing else. */
export const FILES = { session: "session.json", device: "device.json", queue: "queue.json" } as const;

class Store {
  constructor(private readonly dir: string) {}

  private path(name: string): string {
    return join(this.dir, name);
  }

  private read<T>(name: string): T | null {
    try {
      return JSON.parse(readFileSync(this.path(name), "utf8")) as T;
    } catch {
      return null;
    }
  }

  private write(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  private remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }

  session(): Session | null {
    const s = this.read<Session>(FILES.session);
    return s && typeof s.session === "string" && s.session.length > 0 ? s : null;
  }

  saveSession(s: Session): void {
    // The salt used to live in session.json: move it out BEFORE the file is rewritten without it,
    // or an older sign-in would lose the salt every hash it sent was made with.
    this.salt();
    this.write(FILES.session, { session: s.session, handle: s.handle, apiBaseUrl: s.apiBaseUrl, user_id: s.user_id });
  }

  /**
   * The device salt, made at the first sign-in. An older session.json carried it; it is moved,
   * not regenerated, so the hashes this machine already sent keep meaning the same project.
   * Called only while signed in: nothing is written before a sign-in.
   */
  salt(): string {
    // Anything shorter than a device salt is not one (the builders refuse to hash with it), and a
    // salt the builders refuse would silently drop every session this machine closes.
    const usable = (s: string | undefined): s is string => typeof s === "string" && s.length >= MIN_DEVICE_SALT_LENGTH;
    const device = this.read<{ salt?: string }>(FILES.device);
    if (usable(device?.salt)) return device.salt;
    const legacy = this.read<{ salt?: string }>(FILES.session)?.salt;
    const salt = usable(legacy) ? legacy : newDeviceSalt();
    this.write(FILES.device, { salt });
    return salt;
  }

  /** Signing out, or a sign-in that ended: the session and the sessions it had not sent. */
  forget(): void {
    // An older session.json still holds the device salt: move it out before the file goes,
    // or signing out (or a 401) would change every hash this machine sends after the next sign-in.
    if (this.read<{ salt?: string }>(FILES.session)?.salt) this.salt();
    this.remove(FILES.session);
    this.remove(FILES.queue);
  }

  queue(userId: string, now: number): Event[] {
    const q = this.read<Queue>(FILES.queue);
    // Sessions of another account are not this one's to send.
    if (!q || q.user_id !== userId || !Array.isArray(q.pending)) return [];
    return dropExpired({ pending: q.pending, firstQueuedAt: null }, now).state.pending;
  }

  setQueue(userId: string, pending: Event[]): void {
    if (pending.length === 0) this.remove(FILES.queue);
    // Bounded: a machine offline for a long time keeps the newest batch, not an ever-growing file.
    else this.write(FILES.queue, { user_id: userId, pending: pending.slice(-MAX_BATCH) });
  }
}

/**
 * The MCP server as if Deigma were not there: its own stdio (so the client talks to it directly,
 * byte for byte, with nothing of ours in the path), its own exit code. The proxy when there is
 * nobody to attribute a session to.
 */
export function spawnPassThrough(command: string, args: string[], err: (line: string) => void): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", (e) => {
      err(`${command}: ${e.message}`);
      resolve(127);
    });
  });
}

const auth = (s: Session) => ({ authorization: `Bearer ${s.session}` });

/** GET /v1/me: the account, `ended` on a 401, null when Deigma cannot be reached. */
async function whoIs(deps: CliDeps, s: Session): Promise<{ user_id: string; handle: string | null } | "ended" | null> {
  try {
    const res = await deps.fetch(`${s.apiBaseUrl}/v1/me`, { headers: auth(s) });
    if (res.status === 401) return "ended";
    if (!res.ok) return null;
    return (await res.json()) as { user_id: string; handle: string | null };
  } catch {
    return null;
  }
}

/** POST /v1/events. `ended` on a 401; `retry` for what a later pass can still deliver. */
/** Whether a 400 is the server not knowing this wedge's schema version yet. */
export async function refusedForVersion(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { error?: unknown; issues?: unknown };
    if (body.error === "unsupported_schema_version") return true;
    return (
      Array.isArray(body.issues) &&
      body.issues.some(
        (i) => !!i && Array.isArray((i as { path?: unknown }).path) && (i as { path: unknown[] }).path.at(-1) === "schema_version",
      )
    );
  } catch {
    return false;
  }
}

async function sendEvents(deps: CliDeps, s: Session, events: Event[]): Promise<"sent" | "ended" | "retry" | "refused"> {
  try {
    const res = await deps.fetch(`${s.apiBaseUrl}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(s) },
      body: JSON.stringify({ events }),
    });
    if (res.ok) return "sent";
    if (res.status === 401) return "ended";
    // A 4xx other than these is the server refusing the batch: sending it again changes nothing.
    if (res.status === 408 || res.status === 429 || res.status >= 500) return "retry";
    // A server older than this wedge refuses the batch for its schema version (review of PR #29,
    // S2). That batch is early, not wrong: kept and sent again after the upgrade, never recorded
    // as refused — otherwise a wedge released before the API would drop every session for good.
    // The current API says `unsupported_schema_version`; one deployed before it says
    // `invalid_batch` with an issue at `schema_version`, and both are read.
    if (res.status === 400 && (await refusedForVersion(res))) return "retry";
    return "refused";
  } catch {
    return "retry";
  }
}

/** Sends what waited in the queue. Quiet unless something went. */
async function flushQueue(deps: CliDeps, store: Store, s: Session, userId: string, say: (l: string) => void) {
  const pending = store.queue(userId, deps.now());
  if (pending.length === 0) return;
  const result = await sendEvents(deps, s, pending);
  if (result === "sent" || result === "refused") store.setQueue(userId, []);
  if (result === "sent") say(queuedSentLine(pending.length));
  if (result === "ended") store.forget();
}

/** The repositories the person connected, or null when the server could not be asked. Not asked
 *  is not "none connected": read as an empty list, every session went out with no hint, the
 *  ledger kept it, and the server keeps the first copy of an event — so a hint lost to one failed
 *  request was never repaired (binding review, 2026-10-31). The callers send nothing on null. */
async function connectedRepositories(deps: CliDeps, s: Session): Promise<ConnectedRepo[] | null> {
  try {
    const res = await deps.fetch(`${s.apiBaseUrl}/v1/me/repositories`, { headers: auth(s) });
    if (res.ok) return ((await res.json()) as { repositories: ConnectedRepo[] }).repositories;
  } catch {
    // fall through: not asked
  }
  return null;
}

/**
 * The local history pass (B4.1, B4.3), run at `init` and by `history` — only ever signed in.
 * Consent is the act of running it: the line says what will be read before it is read, and
 * `--no-history` skips it.
 */
async function readHistory(
  deps: CliDeps,
  store: Store,
  s: Session,
  argv: string[],
  onRead?: (userId: string) => void,
): Promise<HistoryOutcome | "ended"> {
  if (argv.includes("--no-history")) return { kind: "skipped" };
  deps.out(historyConsentLine(agentsOnThisMachine(deps.home ?? homedir())));
  const connected = await connectedRepositories(deps, s);
  if (connected === null) return { kind: "unreachable" };
  // A hiring task's folder is never read into the card (./task/card-exclusion); without the
  // person's task copies the pass cannot tell which folder is one, so it reads nothing.
  const taskRepos = await taskRepositories(deps.fetch, s.apiBaseUrl, auth(s));
  if (taskRepos === "ended") return "ended";
  if (taskRepos === null) return { kind: "unreachable" };
  const me = await whoIs(deps, s);
  if (me === "ended") return "ended";
  if (!me) return { kind: "unreachable" };
  // The sync's ledger: a session it already sent goes out under the same id, so the server keeps
  // one copy however many passes read it.
  const ledger = loadSyncState(deps.configDir, me.user_id, deps.now()).sent;
  const tasks = taskFolderCheck({ known: { folders: knownTaskFolders(deps.configDir).folders, repos: taskRepos } });
  const result = await deps.localBackfill({
    userId: me.user_id,
    consent: true,
    salt: store.salt(),
    connectedRepos: connected,
    sessionIdFor: (session) => ledger[ledgerKey(session)]?.session_id,
    isTaskFolder: tasks.has,
    ...(deps.home ? { home: deps.home } : {}),
  });
  rememberTaskFolders(deps.configDir, tasks.found(), taskRepos);
  if (result.events.length === 0) {
    onRead?.(me.user_id);
    return { kind: "nothing", reason: result.skipped_reason };
  }
  // Solo review M15: the history went in ONE request, and a failure lost it while the screen
  // promised "they go with the next pass" — nothing kept them. Now it goes in batches, and a batch
  // that cannot go stops the pass without recording it as read: the next `deigma history` (or the
  // sync, which reads the same transcripts) sends it again under the same ids, and the server
  // keeps one copy of what already arrived.
  for (const batch of batches(result.events)) {
    const sent = await sendEvents(deps, s, batch);
    if (sent === "ended") return "ended";
    if (sent === "retry") return { kind: "unreachable" };
  }
  onRead?.(me.user_id);
  return {
    kind: "read",
    sessions: result.sessions,
    outside: result.unresolved,
    sent: true,
    older: result.historyOnly,
    olderSent: result.historyOnlySent ?? 0,
    ...(result.byAgent ? { byAgent: result.byAgent } : {}),
    ...(result.unreadable ? { unreadable: result.unreadable } : {}),
  };
}

async function init(deps: CliDeps, store: Store, argv: string[]): Promise<number> {
  const flow = {
    apiBaseUrl: deps.apiBaseUrl,
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: deps.now,
    print: deps.out,
  };
  // A denied or expired code throws before anything is written: the machine stays signed out.
  const device = await startDeviceFlow(flow);
  let stopOffer: (() => void) | null = null;
  try {
    stopOffer = deps.offerOpen ? deps.offerOpen(device.verification_uri_complete ?? device.verification_uri) : null;
  } catch {
    stopOffer = null; // a terminal that cannot be read is not a reason to stop signing in
  }
  let approved: Awaited<ReturnType<typeof awaitApproval>>;
  try {
    approved = await awaitApproval(flow, device);
  } finally {
    stopOffer?.();
  }
  const s: Session = { session: approved.session, handle: approved.handle, apiBaseUrl: deps.apiBaseUrl };
  const me = await whoIs(deps, s);
  if (me && me !== "ended") s.user_id = me.user_id;
  store.saveSession(s);
  store.salt();
  if (s.user_id) await flushQueue(deps, store, s, s.user_id, deps.out);
  // Taken BEFORE the history pass, so the sync's window (from one idle gap before this moment)
  // overlaps what history reads rather than leaving a gap between the two.
  const liveAt = deps.now();
  const history = await readHistory(deps, store, s, argv);
  if (history === "ended") return ended(deps, store);
  // From here on, Claude Code sessions are read as they finish (./journal-sync); what came before
  // is the history this command just read — or chose not to, with --no-history.
  // A declined history stays declined: the sync then does not look one gap back either.
  if (s.user_id) {
    const choice = history.kind === "skipped" ? "declined" : history.kind === "unreachable" ? undefined : "read";
    startLiveIfNew(deps.configDir, s.user_id, liveAt, choice ? { history: choice } : {});
  }
  // Solo review B2: without this, nothing read a new session unless `deigma proxy` wrapped an MCP
  // server, and the number stood still while the person worked (./claude-hook).
  const hookOutcome =
    argv.includes("--no-hook") || !deps.claudeSettingsHome ? "declined" : installSyncHook(deps.claudeSettingsHome);
  const hook = hookOutcome === "added" ? "added" : hookOutcome === "present" ? "present" : "none";
  // Decision 4: Codex has no session-end hook, only ONE `notify` program — ours goes there only
  // when it is free, and only where Codex is installed (./codex-notify).
  const notifyOutcome =
    argv.includes("--no-hook") || !deps.codexConfigHome ? "none" : installCodexNotify(deps.codexConfigHome, deps.configDir);
  const notify =
    notifyOutcome === "added" || notifyOutcome === "present" || notifyOutcome === "taken" ? notifyOutcome : "none";
  for (const line of connectedLines({
    handle: approved.handle,
    history,
    webBaseUrl: webBaseUrlFor(deps.apiBaseUrl, deps.webUrlOverride),
    hook,
    notify,
  })) {
    deps.out(line);
  }
  return 0;
}

function signedOut(deps: CliDeps): number {
  deps.err(SIGNED_OUT_LINE);
  return 2;
}

function ended(deps: CliDeps, store: Store): number {
  store.forget();
  deps.err(SESSION_ENDED_LINE);
  return 2;
}

/** Both `pulse` and `status` read the same endpoint: the API reports facts, the CLI decides
 *  what may be said about them. */
async function fetchPulse(
  deps: CliDeps,
  store: Store,
  s: Session,
): Promise<Parameters<typeof weeklyPulse>[0] | "ended" | number> {
  let res: Response;
  try {
    res = await deps.fetch(`${s.apiBaseUrl}/v1/me/pulse`, { headers: auth(s) });
  } catch {
    deps.err("Could not reach Deigma. Try again in a moment.");
    return 1;
  }
  if (res.status === 401) return "ended";
  if (!res.ok) {
    deps.err(`Your Deigma could not be read (HTTP ${res.status}).`);
    return 1;
  }
  if (s.user_id) await flushQueue(deps, store, s, s.user_id, deps.out);
  return (await res.json()) as Parameters<typeof weeklyPulse>[0];
}

async function proxy(deps: CliDeps, store: Store, argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  const upstream = sep === -1 ? [] : argv.slice(sep + 1);
  if (upstream.length === 0) {
    deps.err("usage: deigma proxy -- <mcp-server> [args...]");
    return 2;
  }
  const [command, ...args] = upstream as [string, ...string[]];
  const s = store.session();
  if (!s) {
    deps.err(PROXY_SIGNED_OUT_LINE);
    return deps.passThrough(command, args);
  }
  let userId = s.user_id;
  if (!userId) {
    // An older sign-in did not keep its user id: ask once, and keep it.
    const me = await whoIs(deps, s);
    if (me === "ended") {
      store.forget();
      deps.err(PROXY_SESSION_ENDED_LINE);
      return deps.passThrough(command, args);
    }
    // Unreachable and nothing to attribute a session to: the tool runs, nothing is recorded.
    if (!me) return deps.passThrough(command, args);
    userId = me.user_id;
    store.saveSession({ ...s, user_id: userId });
  }
  const uid = userId;
  // What waited from an earlier run goes beside the tool, never in front of it.
  const flushed = flushQueue(deps, store, s, uid, () => {});
  // Claude Code sessions that finished are read from this machine's own log by a separate,
  // detached process (./journal-sync): due-check is one small file read, the spawn returns at
  // once, and nothing here waits for it. Again every SYNC_INTERVAL_MS while the tool runs.
  const kickSync = (): void => {
    try {
      if (deps.startSync && store.session() && syncDue(deps.configDir, deps.now())) deps.startSync();
    } catch {
      // fail open: a sync that cannot start is telemetry lost, never the tool
    }
  };
  kickSync();
  const syncTimer = setInterval(kickSync, SYNC_INTERVAL_MS);
  syncTimer.unref?.();
  let endedSaid = false;
  const inTaskFolder = taskFolderOfProxy(deps);
  await deps.runProxy({
    command,
    args,
    identity: { userId: uid, salt: store.salt() },
    send: async (event) => {
      // After a 401 the sign-in is gone: nothing more is kept or sent for this run.
      if (!store.session()) return;
      // A hiring task's session never counts toward the card: the tool runs, nothing is recorded.
      if (inTaskFolder()) return;
      const result = await sendEvents(deps, s, [event]);
      if (result === "retry") store.setQueue(uid, [...store.queue(uid, deps.now()), event]);
      if (result === "ended") {
        store.forget();
        if (!endedSaid) deps.err(PROXY_SESSION_ENDED_LINE);
        endedSaid = true;
      }
    },
    onError: () => {},
  });
  clearInterval(syncTimer);
  await flushed;
  return 0;
}

/**
 * Whether the proxy runs in a hiring task's folder (./task/card-exclusion). Asked when a session is
 * about to be sent — never in front of the tool — once per run, from the device's own file: the
 * known folders and the task copies the last read listed. The proxy never asks the network here; a
 * question that cannot be answered is a no, the same answer the reads gave before tasks existed.
 */
function taskFolderOfProxy(deps: CliDeps): () => boolean {
  let answer: boolean | null = null;
  return () => {
    if (answer !== null) return answer;
    try {
      const tasks = taskFolderCheck({ known: knownTaskFolders(deps.configDir) });
      answer = tasks.has(deps.cwd ?? process.cwd());
      rememberTaskFolders(deps.configDir, tasks.found());
    } catch {
      answer ??= false; // fail open: the tool is never what pays
    }
    return answer;
  };
}

/**
 * `deigma sync`: one incremental read of the journals (./journal-sync). Started by the proxy in
 * the background; also safe to run by hand or from a hook. Quiet by design — nobody is watching
 * its output — and exit 0 whatever happened, except that it does nothing at all signed out.
 */
async function sync(given: CliDeps, store: Store): Promise<number> {
  // Every request of this run is bounded: the process is detached and nobody waits for it, so a
  // request that hangs would otherwise keep it — and its lock — alive indefinitely.
  const limit = given.syncFetchTimeoutMs ?? SYNC_FETCH_TIMEOUT_MS;
  const deps: CliDeps = {
    ...given,
    fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      given.fetch(input, { ...init, signal: AbortSignal.timeout(limit) })) as typeof globalThis.fetch,
  };
  const s = store.session();
  if (!s) return 0; // nothing is read or kept before a sign-in
  let userId = s.user_id;
  if (!userId) {
    const me = await whoIs(deps, s);
    if (!me || me === "ended") return 0;
    userId = me.user_id;
  }
  const now = deps.now();
  const unlock = takeSyncLock(deps.configDir, now);
  if (!unlock) return 0; // another run is reading; it will see the same files
  try {
    const connected = await connectedRepositories(deps, s);
    if (connected === null) return 0; // not asked: nothing is read, sent or recorded this run
    // A hiring task's folder is never read into the card (./task/card-exclusion): without the
    // person's task copies this run cannot tell which folder is one, so it reads nothing.
    const taskRepos = await taskRepositories(deps.fetch, s.apiBaseUrl, auth(s));
    if (taskRepos === null || taskRepos === "ended") return 0;
    const tasks = taskFolderCheck({ known: { folders: knownTaskFolders(deps.configDir).folders, repos: taskRepos } });
    const previous = loadSyncState(deps.configDir, userId, now);
    const plan = planSync({
      state: previous,
      userId,
      salt: store.salt(),
      home: deps.home ?? homedir(),
      connectedRepos: connected,
      now,
      isTaskFolder: tasks.has,
    });
    rememberTaskFolders(deps.configDir, tasks.found(), taskRepos);
    const went: typeof plan.ready = [];
    for (const batch of batches(plan.ready)) {
      const sentAt = new Date(deps.now()).toISOString();
      const result = await sendEvents(
        deps,
        s,
        batch.map((r) => ({ ...r.event, sent_at: sentAt }) as Event),
      );
      if (result === "ended") {
        store.forget();
        return 0; // the sign-in is gone: nothing more is kept for it
      }
      // "refused" is the server rejecting the batch's shape; sending it again changes nothing, so
      // it is recorded like a sent one rather than retried forever.
      if (result === "sent" || result === "refused") went.push(...batch);
      if (result === "retry") break; // unreachable: the rest waits for the next run, unrecorded
    }
    saveSyncState(deps.configDir, { ...settleSync(previous, plan, went, now), last_run_at: new Date(now).toISOString() });
  } catch {
    // fail open: the next run starts from the last state that was written
  } finally {
    unlock();
  }
  return 0;
}

/**
 * `deigma task submit`: the agent task a company gave (./task/submit).
 * Not in `help`: the command is shown on the task page, after sign-in, and nowhere else. A person's
 * act that asks before it sends — so it needs a sign-in, a terminal to ask at, and a folder.
 */
async function task(deps: CliDeps, store: Store, argv: string[]): Promise<number> {
  const [, sub, ...rest] = argv;
  if (sub !== "submit") {
    for (const line of TASK_USAGE_LINES) deps.out(line);
    return sub === undefined || sub === "--help" || sub === "-h" ? 0 : 2;
  }
  // Asking for the usage reads nothing and needs no account.
  if (rest.includes("--help") || rest.includes("-h")) {
    for (const line of TASK_USAGE_LINES) deps.out(line);
    return 0;
  }
  const s = store.session();
  if (!s) return signedOut(deps);
  const home = deps.home ?? homedir();
  const result = await taskSubmit(
    {
      api: { base: s.apiBaseUrl, session: s.session, fetch: deps.fetch },
      publicFetch: deps.publicFetch,
      out: deps.out,
      err: deps.err,
      canAsk: deps.canAsk === true && deps.ask !== undefined,
      ask: deps.ask ?? (async () => false),
      cwd: deps.cwd ?? process.cwd(),
      home,
      codexDir: deps.codexConfigHome ?? codexHome(home, {}),
      webBaseUrl: webBaseUrlFor(s.apiBaseUrl, deps.webUrlOverride),
      remember: (root) => rememberTaskFolders(deps.configDir, [root]),
    },
    rest,
  );
  return result === "ended" ? ended(deps, store) : result;
}

async function logout(deps: CliDeps, store: Store): Promise<number> {
  const s = store.session();
  if (!s) {
    deps.out(ALREADY_SIGNED_OUT_LINE);
    return 0;
  }
  // Ends this one session on the server too, so Settings stops listing it. Unreachable is not a
  // reason to stay signed in here: the local copy goes either way.
  await deps
    .fetch(`${s.apiBaseUrl}/v1/me/session`, { method: "DELETE", headers: auth(s) })
    .catch(() => null);
  store.forget();
  // The hook `init` added has nothing to sync for once signed out; it goes with the sign-in.
  if (deps.claudeSettingsHome) removeSyncHook(deps.claudeSettingsHome);
  if (deps.codexConfigHome) removeCodexNotify(deps.codexConfigHome);
  deps.out(SIGNED_OUT_DONE_LINE);
  return 0;
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const store = new Store(deps.configDir);
  const [command = "help"] = argv;
  if (command === "init") return init(deps, store, argv);
  if (command === "proxy") return proxy(deps, store, argv);
  if (command === "logout") return logout(deps, store);
  if (command === "sync") return sync(deps, store);
  if (command === "task") return task(deps, store, argv);

  if (command === "help" || command === "--help" || command === "-h") {
    for (const line of HELP_LINES) deps.out(line);
    const s = store.session();
    deps.out("");
    deps.out(s ? signedInLine(s.handle, s.apiBaseUrl) : SIGNED_OUT_LINE);
    return 0;
  }
  if (!["status", "pulse", "history", "whoami"].includes(command)) {
    deps.out(USAGE_LINE);
    deps.out("Every command, in a line each: npx deigma help");
    const s = store.session();
    deps.out(s ? signedInLine(s.handle, s.apiBaseUrl) : SIGNED_OUT_LINE);
    return 2;
  }

  // Every command below needs an account, and asks for nothing before it has one.
  const s = store.session();
  if (!s) return signedOut(deps);

  if (command === "whoami") {
    const me = await whoIs(deps, s);
    if (me === "ended") return ended(deps, store);
    deps.out(signedInLine(me?.handle ?? s.handle, s.apiBaseUrl));
    return 0;
  }
  if (command === "history") {
    if (s.user_id) await flushQueue(deps, store, s, s.user_id, deps.out);
    // A pass the person ran with its consent line lifts a refusal on record (./journal-sync).
    const h = await readHistory(deps, store, s, argv, (uid) => recordHistoryRead(deps.configDir, uid, deps.now()));
    if (h === "ended") return ended(deps, store);
    for (const line of historyLines(h)) deps.out(line);
    return 0;
  }
  // Reading the number is also a moment to read what ended since the last pass, for anybody whose
  // Claude Code has no hook and no proxy (solo review B2). Detached; the answer below never waits.
  try {
    if (deps.startSync && syncDue(deps.configDir, deps.now())) deps.startSync();
  } catch {
    // fail open
  }
  const body = await fetchPulse(deps, store, s);
  if (body === "ended") return ended(deps, store);
  if (typeof body === "number") return body;
  if (command === "status") {
    deps.out(renderStatus({ view: body.view, telemetryDays: body.telemetryDays }));
    if (s.user_id) {
      const state = loadSyncState(deps.configDir, s.user_id, deps.now());
      // A machine set up before the Stop entry existed (0.4.1) gets it here, said in a line: its
      // person accepted the hooks at `init`. One set up with --no-hook has no SessionEnd entry and
      // is left as it is.
      const home = deps.claudeSettingsHome;
      const upgraded =
        !!home && syncHookInstalled(home) === true && stopHookInstalled(home) === false && installSyncHook(home) === "added";
      deps.out(
        deviceReadLine({
          lastRunAt: state.last_run_at,
          now: deps.now(),
          hook: home ? syncHookInstalled(home) : null,
          stopHook: home ? stopHookInstalled(home) : null,
          open: Object.values(state.files).filter((f) => f.open).length,
          codexNotify: deps.codexConfigHome ? codexNotifyState(deps.codexConfigHome) : null,
        }),
      );
      if (upgraded) deps.out(STOP_HOOK_ADDED_LINE);
    }
    return 0;
  }
  const text = renderPulse(weeklyPulse(body));
  // An empty week is skipped, not printed as a zero (Playbook §3.1c).
  if (text) deps.out(text);
  return 0;
}
