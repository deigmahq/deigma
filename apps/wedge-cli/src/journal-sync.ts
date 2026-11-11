/**
 * The incremental journal read (audit 2026-10-09 #5).
 *
 * Journals were read only by `deigma init` and `deigma history`, by hand, so after install the
 * live path was nearly empty: the MCP proxy sees MCP frames, which name no prompt and no model,
 * and the sessions themselves sat in ~/.claude/projects until somebody typed a command. This reads
 * them as they FINISH, with nothing asked of the person:
 *
 *   * WHEN. `deigma proxy` (already in the person's MCP config — the product asks for nothing new)
 *     starts it beside the tool when it is due, and again every `SYNC_INTERVAL_MS` while it runs.
 *     It runs as a separate, detached, low-priority process (`deigma sync`): parsing a journal is
 *     synchronous CPU work, and on the proxy's own event loop it would sit between the client and
 *     its tool. The proxy only checks a timestamp and spawns; it never waits for the result and
 *     its exit does not wait for it either. Every failure is swallowed (fail open).
 *     `deigma sync` can also be run by hand or from a hook a person already has.
 *   * WHAT. Only sessions that ENDED — idle longer than `SESSION_IDLE_GAP_HOURS`, the one
 *     definition of a session — because the id below is derived from the session and the server
 *     keeps the first copy: a session sent half-way would stay half-measured forever.
 *     Only sessions that ENDED after `live_since` minus one idle gap — `live_since` is the sign-in
 *     (or the first sync on a device with no state, which is read as history declined: no
 *     look-back at all): whatever ended earlier is history, read with the consent line of
 *     `init` / `history`, never silently here. A session that ended within a gap
 *     of the sign-in, or that the sign-in cut through, is one `history` skipped as possibly still
 *     open; it is read here, labelled as history because it began before the wedge was there.
 *     Only transcripts whose file changed since the last run, or that still had an open session.
 *   * ORIGIN. Always `backfill`. Everything read from a journal FILE
 *     — by this sync or by `deigma history` — carries the flag, however fresh: a file is the
 *     easiest evidence there is to forge, and "the wedge was installed when it happened"
 *     does not change what it was read from. Only what the proxy observed itself is `live`.
 *   * IDS. Derived from (user, source, session id) — wedge-core `envelope` — so a re-read, a crash
 *     between send and bookkeeping, two proxies syncing at once, or a later `deigma history` all
 *     produce the same id, and ingestion drops the duplicate. The session id itself is pinned in
 *     the ledger below by the transcript and the stretch's start: the parser names a transcript's
 *     only stretch `<id>` and, once a second stretch appears, `<id>-1`, `<id>-2` — without the
 *     ledger, a session sent alone would come back under a new name when the person resumed it.
 *
 * State lives in ~/.config/deigma/sync.json (0600) beside the queue and the device salt: when the
 * device went live, when it last ran, which transcripts were read at which size, and the ledger.
 * Written only while signed in; the lock file keeps two runs from interleaving their writes.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { Event } from "@mentat/schemas";
import { MAX_BATCH, type ConnectedRepo } from "@mentat/wedge-core";

import type { Agent } from "@mentat/schemas";

import { parseTranscript, READER_VERSION, sessionFiles, type ClaudeCodeSession } from "./journals/claude-code";
import { CODEX_READER_VERSION, codexHome, codexSessionFiles, parseRollout } from "./journals/codex";
import { DESCRIPTIVE_ON_WIRE, journalSessionEvent, readHistoryGroups, readerVersionOf } from "./local-backfill";
import { writeFileAtomic } from "./platform";
import { SESSION_IDLE_GAP_HOURS } from "./measurement";

/** How often a running proxy starts another read. A session closes after a four-hour idle gap,
 *  so a quarter of an hour is far inside the delay the definition already has. */
export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** A lock older than this is a crashed run, not a running one. */
export const SYNC_LOCK_STALE_MS = 10 * 60 * 1000;
/** Ledger entries older than this are dropped; a transcript that old is not re-read unless it
 *  changes, and if it does the derived ids still make a resend a duplicate. */
export const LEDGER_HORIZON_MS = 120 * 24 * 3600 * 1000;

export const SYNC_FILES = { state: "sync.json", lock: "sync.lock" } as const;

export type SyncState = {
  version: 1;
  user_id: string;
  /** When this device started reading journals as they finish. Sessions before it are history. */
  live_since: string;
  last_run_at: string | null;
  /** Transcripts by path: their size and mtime when last read, and whether a session was open. */
  files: Record<string, { size: number; mtime_ms: number; open: boolean }>;
  /** `<transcript>@<stretch start>` -> the session id it was sent under, when it started, and by
   *  which reader (absent: `cc-reader-1`, everything sent before schema 2.5). */
  sent: Record<string, { session_id: string; started_at: string; reader?: string }>;
  /** The reader that made the file marks in `files` (absent: `cc-reader-1`). When it is not the
   *  current one, the marks say nothing about what THIS reader has read, and every transcript on
   *  disk is read again, whole — unless history was declined — see `planSync`. */
  reader_version?: string;
  /** Schema 2.10: the reader that made the marks of each OTHER agent's journal files, by agent
   *  (`reader_version` stays Claude Code's, so a state written before 2.10 keeps its meaning).
   *  Absent for an agent: none of its files was ever read by this device — a CLI updated to the
   *  Codex reader reads the Codex history once, whole, unless history was declined. */
  reader_versions?: Partial<Record<Exclude<Agent, "claude_code">, string>>;
  /** Set when the sign-in declined history (`init --no-history`), and on a device with no record of
   *  consent at all (`loadSyncState`): the sync then reads nothing that ended before `live_since` —
   *  no one-gap look-back, no upgrade re-read; the refusal is the promise. Lifted only by a pass
   *  the person runs (`deigma history`, `init` without the flag). */
  history_declined?: boolean;
};

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The state for this account. When there is none — or it was another account's — the device
 *  holds NO record of what the person agreed to: every 0.1.2 install is in that shape, including
 *  those that ran `init --no-history` (0.1.2 never wrote the refusal down). Absence of a record is
 *  not consent (review 2026-10-10, consent): such a device is read as if history was declined —
 *  live from now, no look-back, on the current reader so no "upgrade" re-reads what is on disk.
 *  Readings an older reader already sent are replaced only by a pass the person runs themselves
 *  (`deigma history`, or `init`), each of which says what it reads before it reads it. */
export function loadSyncState(configDir: string, userId: string, now: number): SyncState {
  const s = readJson<SyncState>(join(configDir, SYNC_FILES.state));
  if (s && s.version === 1 && s.user_id === userId && typeof s.live_since === "string") {
    return { ...s, files: s.files ?? {}, sent: s.sent ?? {} };
  }
  return {
    version: 1,
    user_id: userId,
    live_since: new Date(now).toISOString(),
    last_run_at: null,
    files: {},
    sent: {},
    reader_version: READER_VERSION,
    reader_versions: { codex: CODEX_READER_VERSION },
    history_declined: true,
  };
}

/** Marks the moment this device goes live for this account, if it has not already, and records
 *  what the sign-in's history pass did. Called at the sign-in, right after that pass reads
 *  everything up to now: what began after it is the sync's to read, as it finishes.
 *  `history`: "declined" (`--no-history`) — the sync never looks back; "read" — the person agreed
 *  and the pass ran; anything else (unreachable) records nothing new. On a device that already
 *  has a state, an explicit choice at this sign-in replaces the one on record. */
export function startLiveIfNew(
  configDir: string,
  userId: string,
  now: number,
  opts: { history?: "declined" | "read" } = {},
): void {
  const s = readJson<SyncState>(join(configDir, SYNC_FILES.state));
  if (s && s.version === 1 && s.user_id === userId) {
    if (opts.history === "declined" && !s.history_declined) saveSyncState(configDir, { ...s, history_declined: true });
    if (opts.history === "read" && s.history_declined) recordHistoryRead(configDir, userId, now);
    return;
  }
  // The history pass that just ran (or was declined) is THIS reader's: the marks start as its own.
  const fresh: SyncState = {
    version: 1,
    user_id: userId,
    live_since: new Date(now).toISOString(),
    last_run_at: null,
    files: {},
    sent: {},
    reader_version: READER_VERSION,
    reader_versions: { codex: CODEX_READER_VERSION },
  };
  saveSyncState(configDir, opts.history === "declined" ? { ...fresh, history_declined: true } : fresh);
}

/** A history pass the person ran (`deigma history`, with its consent line) read the journals with
 *  this reader: the refusal on record — written by `--no-history` or assumed for a device with no
 *  record at all — is lifted, so the sync looks one idle gap back from going live, as after a
 *  consented sign-in. A device with no state goes live now. */
export function recordHistoryRead(configDir: string, userId: string, now: number): void {
  const s = loadSyncState(configDir, userId, now);
  const { history_declined: _, ...rest } = s;
  saveSyncState(configDir, rest);
}

export function saveSyncState(configDir: string, state: SyncState): void {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, SYNC_FILES.state);
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, 0o600); // a reader never sees half a file
}

/** Whether a run is due: never ran, or the last one is older than the interval. A cheap read —
 *  the proxy calls it before spawning anything. */
export function syncDue(configDir: string, now: number, intervalMs = SYNC_INTERVAL_MS): boolean {
  const s = readJson<{ last_run_at?: string | null }>(join(configDir, SYNC_FILES.state));
  const last = s?.last_run_at ? Date.parse(s.last_run_at) : NaN;
  return !Number.isFinite(last) || now - last >= intervalMs;
}

/** Takes the lock, or returns null when another run holds a fresh one. */
export function takeSyncLock(configDir: string, now: number): (() => void) | null {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, SYNC_FILES.lock);
  // The lock names its holder, so a run releases only its OWN lock (review of PR #29): a run that
  // outlived the stale limit and finished after another took over must not delete the new lock.
  const token = `${process.pid}:${randomUUID()}`;
  const take = (): boolean => {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
  if (!take()) {
    let stale = false;
    try {
      stale = now - statSync(path).mtimeMs > SYNC_LOCK_STALE_MS;
    } catch {
      stale = true;
    }
    if (!stale) return null;
    rmSync(path, { force: true });
    if (!take()) return null;
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === token) rmSync(path, { force: true });
    } catch {
      // already gone
    }
  };
}

/** How long one request of the detached sync may take before it is abandoned: a hung request
 *  must not keep the process — and its lock — alive. */
export const SYNC_FETCH_TIMEOUT_MS = 30_000;

/** The ledger key of a session: its transcript and its stretch's start, neither of which changes
 *  when the transcript grows. */
export const ledgerKey = (s: Pick<ClaudeCodeSession, "transcript" | "startedAt">): string => `${s.transcript}@${s.startedAt}`;

/** The ledger's reader of an entry written before 2.10 (no `reader`): Claude Code's first. */
const ledgerReader = (key: string, reader: string | undefined): string =>
  reader ?? (key.startsWith("codex/") ? CODEX_READER_VERSION : "cc-reader-1");

export type SyncPlan = {
  /** Events to send, each with the ledger entry that records it once it went. */
  ready: { event: Event; key: string; sessionId: string; startedAt: string; file: string; reader: string; agent: Agent }[];
  /** The state with file bookkeeping updated — the ledger is updated by `markSent`. */
  state: SyncState;
  /** Counts for the caller (and the tests): finished, still open, history left alone. */
  counts: { ended: number; open: number; history: number; alreadySent: number };
  /** Schema 2.10: the sessions read this run by agent (ended and sent), and Codex files that could
   *  not be read here (a compressed file with no decoder) — a count, never a crash. */
  byAgent: Partial<Record<Agent, number>>;
  unreadable: number;
};

/**
 * What one run would send. Pure apart from reading the journals: nothing is written and nothing
 * is sent here, so the decision is testable on its own.
 */
export function planSync(input: {
  state: SyncState;
  userId: string;
  salt: string;
  home: string;
  connectedRepos: ReadonlyArray<ConnectedRepo>;
  now: number;
  gapHours?: number;
  descriptiveOnWire?: boolean;
  /** The environment `$CODEX_HOME` is read from; the process's own by default. */
  env?: NodeJS.ProcessEnv;
  /** Whether a session's folder is a hiring task's (./task/card-exclusion): never read into the card. */
  isTaskFolder?: (cwd: string | null) => boolean;
}): SyncPlan {
  const gapMs = (input.gapHours ?? SESSION_IDLE_GAP_HOURS) * 3600_000;
  const liveSince = Date.parse(input.state.live_since);
  // One idle gap BEFORE going live (review of PR #29, B2): the history pass at sign-in skips a
  // session that ended less than a gap ago (it might still be going), so the sync has to be the
  // one that reads it. Such a session began before the wedge was there and travels as backfill;
  // the thin overlap with the history pass is harmless — the same session has the same event id.
  // Unless the sign-in declined history (`init --no-history`): then nothing that ended before it
  // is read, not even within that gap (re-review of PR #29).
  const readFrom = input.state.history_declined ? liveSince : liveSince - gapMs;
  // A new reader (schema 2.5): the file marks were made by the old one, so none of them says this
  // transcript has been read — every transcript on disk is read again (not only those in the
  // window: see `touched` below), and its stretches go out under the new reader's ids. The server keeps, per transcript, only the highest reader's
  // events, so the re-read REPLACES the old
  // reading; for that to lose nothing, a transcript is re-sent WHOLE — every ended stretch,
  // including those before the window, which the sign-in's history pass sent with the person's
  // consent. Unless they declined history: then nothing before the window was ever sent, and
  // nothing before it is read now either.
  const upgrading = (input.state.reader_version ?? "cc-reader-1") !== READER_VERSION;
  // Schema 2.10: Codex's journal has its own reader and its own marks. A device whose state names
  // no Codex reader never read a Codex file: the history there is read once, whole — unless the
  // person declined history, which covers every agent.
  const codexUpgrading = input.state.reader_versions?.codex !== CODEX_READER_VERSION;
  const codexFiles = codexSessionFiles(codexHome(input.home, input.env));
  const codexSet = new Set(codexFiles);
  const keptMarks: SyncState["files"] = {};
  for (const [path, mark] of Object.entries(input.state.files)) {
    // A mark of a Codex rollout no longer on disk is still Codex's (it keeps its reader's meaning).
    const isCodex = codexSet.has(path) || /[\\/]sessions[\\/].*rollout-[^\\/]*\.jsonl(?:\.zst)?$/.test(path);
    if (isCodex ? !codexUpgrading : !upgrading) keptMarks[path] = mark;
  }
  const state: SyncState = {
    ...input.state,
    files: keptMarks,
    sent: { ...input.state.sent },
    reader_version: READER_VERSION,
    reader_versions: { ...input.state.reader_versions, codex: CODEX_READER_VERSION },
  };
  const counts = { ended: 0, open: 0, history: 0, alreadySent: 0 };
  const byAgent: SyncPlan["byAgent"] = {};
  let unreadable = 0;
  const ready: SyncPlan["ready"] = [];
  // The prompt history gives each session its `prompt_history` features — read once per run, and
  // only while those features travel at all (local-backfill `DESCRIPTIVE_ON_WIRE`).
  const descriptiveOnWire = input.descriptiveOnWire ?? DESCRIPTIVE_ON_WIRE;
  const history = descriptiveOnWire ? readHistoryGroups(input.home) : undefined;
  const ctx = {
    userId: input.userId,
    salt: input.salt,
    connectedRepos: input.connectedRepos,
    descriptiveOnWire,
    ...(history ? { history } : {}),
  };

  const gapHours = input.gapHours ?? SESSION_IDLE_GAP_HOURS;
  const journals: { file: string; agentUpgrading: boolean; parse: () => ClaudeCodeSession[] | null }[] = [
    ...sessionFiles(join(input.home, ".claude", "projects")).map((file) => ({
      file,
      agentUpgrading: upgrading,
      parse: () => parseTranscript(file, gapHours),
    })),
    ...codexFiles.map((file) => ({ file, agentUpgrading: codexUpgrading, parse: () => parseRollout(file, gapHours) })),
  ];
  for (const { file, agentUpgrading, parse } of journals) {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(file);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    const known = state.files[file];
    // Untouched since the last read and nothing was open in it: nothing new can be there.
    if (known && known.size === size && known.mtime_ms === mtimeMs && !known.open) continue;
    // A transcript last written before the read-from moment holds history only — which this
    // reader has already read at the sign-in, unless it is an upgrade (see `touched` below).
    if (mtimeMs < readFrom && !(agentUpgrading && !input.state.history_declined)) {
      state.files[file] = { size, mtime_ms: mtimeMs, open: false };
      continue;
    }
    let open = false;
    const stretches = parse();
    if (stretches === null) {
      // Could not be read here (a compressed file with no decoder): left unmarked, so a later run
      // on a machine that can read it does.
      unreadable += 1;
      continue;
    }
    // A transcript this run sends anything of is sent whole (see `upgrading` above): its stretches
    // from before the window too, unless history was declined. Their ids are derived from the
    // transcript and the stretch's start, so one the history pass already sent is a duplicate.
    // On a reader upgrade EVERY transcript on disk is sent whole, not only those with a stretch in
    // the window (review 2026-10-10): what ended before it was sent by the sign-in's history pass
    // under the old reader, nothing re-runs that pass by itself, and the old reading — with its
    // inflated count of typed turns — would otherwise stay in force for as long as the transcript
    // exists. A device with NO sync state is not an upgrade (`loadSyncState`): nothing on it says
    // the person agreed to history, so its old readings wait for a `deigma history` they run.
    const touched = agentUpgrading || stretches.some((s) => Date.parse(s.endedAt) >= readFrom);
    for (const s of stretches) {
      // A hiring task's session never counts toward the card.
      if (input.isTaskFolder?.(s.cwd)) continue;
      const started = Date.parse(s.startedAt);
      const ended = Date.parse(s.endedAt);
      if (!Number.isFinite(started) || !Number.isFinite(ended)) continue;
      if (ended < readFrom && (input.state.history_declined || !touched)) {
        counts.history += 1;
        continue;
      }
      if (input.now - ended <= gapMs) {
        open = true; // still going: it will be read whole, once it ends
        counts.open += 1;
        continue;
      }
      const key = ledgerKey(s);
      const reader = readerVersionOf(s);
      const before = state.sent[key];
      if (before && ledgerReader(key, before.reader) === reader) {
        counts.alreadySent += 1;
        continue;
      }
      // Sent before by an older reader: read again, under the name it went out with.
      const sessionId = before?.session_id ?? s.sessionId;
      // A journal is a file: what is read from it is backfill, always (see the header).
      const origin = "backfill" as const;
      const built = journalSessionEvent(s, { ...ctx, origin, sessionId });
      if (!built) continue;
      counts.ended += 1;
      byAgent[s.agent] = (byAgent[s.agent] ?? 0) + 1;
      ready.push({ event: built.event, key, sessionId, startedAt: s.startedAt, file, reader, agent: s.agent });
    }
    state.files[file] = { size, mtime_ms: mtimeMs, open };
  }
  return { ready, state, counts, byAgent, unreadable };
}

/** Records what went, and forgets ledger entries past the horizon. */
export function markSent(state: SyncState, sent: SyncPlan["ready"], now: number): SyncState {
  const next = { ...state, sent: { ...state.sent } };
  for (const r of sent) next.sent[r.key] = { session_id: r.sessionId, started_at: r.startedAt, reader: r.reader };
  for (const [k, v] of Object.entries(next.sent)) {
    if (now - Date.parse(v.started_at) > LEDGER_HORIZON_MS) delete next.sent[k];
  }
  return next;
}

/**
 * The state to write after a run: the ledger records what went, and a transcript whose sessions
 * did NOT all go keeps the mark it had before this run (review of PR #29, B1). Without that, an
 * unreachable API on the run that first read a transcript marked it as read at its current size —
 * and an unchanged file is skipped, so the session waited for a send that never came again.
 */
export function settleSync(previous: SyncState, plan: SyncPlan, went: SyncPlan["ready"], now: number): SyncState {
  const next = markSent(plan.state, went, now);
  const gone = new Set(went.map((r) => r.key));
  let incomplete = false;
  for (const r of plan.ready) {
    if (gone.has(r.key)) continue;
    incomplete = true;
    const before = previous.files[r.file];
    if (before) next.files[r.file] = before;
    else delete next.files[r.file];
  }
  // A re-read that did not all go keeps the old reader's mark, so the next run re-reads again
  // rather than trusting file marks this reader never finished.
  if (incomplete) {
    if (previous.reader_version === undefined) delete next.reader_version;
    else next.reader_version = previous.reader_version;
    if (previous.reader_versions === undefined) delete next.reader_versions;
    else next.reader_versions = previous.reader_versions;
  }
  return next;
}

/** Splits into batches the ingestion accepts. */
export function batches<T>(items: T[], size = MAX_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
