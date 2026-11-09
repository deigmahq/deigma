// Local backfill at install (collector §2.1).
//
// Two of the four claims have a past on the device: the ENVIRONMENT is a property of the setup
// (which MCP servers are connected, whether project instructions exist, which reusable skills are
// defined), and SESSIONS sit in the local journals of the AI tools. Reading them at install means
// the owner's habits and agent facts do not start from zero (Core 7 §4).
//
// The third one cannot be backfilled: attention telemetry (t_validation_ms, scrolls, edits) was
// never recorded by anything, so the editor habits (ed-1.0) honestly start from the next accepted
// suggestion. This module says so out loud rather than quietly emitting nothing.
//
// Everything obeys §2: only metadata leaves the device, the pass runs on explicit consent, and
// the events go through the same builders (and the same secret scanner) as live telemetry.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { Agent, Event } from "@mentat/schemas";
import {
  buildPromptHistory,
  buildSessionSummary,
  connectedRepoIdAt,
  modelFromId,
  requireDeviceSalt,
  type EnvInputs,
} from "@mentat/wedge-core";

import { projectHash } from "./environment/names";
import { READER_VERSION, readClaudeCodeSessions, sessionFiles, type ClaudeCodeSession } from "./journals/claude-code";
import { CODEX_READER_VERSION, codexHome, codexSessionFiles, readCodexSessions } from "./journals/codex";
import {
  historyFeatures,
  promptsWithin,
  readPromptHistory,
  splitByIdleGap,
  type HistoryGroup,
} from "./journals/prompt-history";
import { SESSION_IDLE_GAP_HOURS } from "./measurement";
import type { ConnectedRepo } from "@mentat/wedge-core";
import { sessionCarrierHint } from "./session-hint";
import { wireToolCalls } from "./vocabulary";

/** Where the supported tools keep their configuration and journals, relative to $HOME. */
const CONFIG_FILES = [
  [".claude", "settings.json"],
  [".claude", "settings.local.json"],
  [".cursor", "mcp.json"],
  [".codex", "config.json"],
] as const;
const SKILL_DIRS = [
  [".claude", "commands"],
  [".claude", "skills"],
  [".cursor", "commands"],
] as const;
// Only formats CONFIRMED on real files ship (B4.1). `.claude/projects` was read off 291
// transcripts on 2026-09-07; `.codex/sessions` was in this list on the strength of a guess and is
// gone until somebody points a parser at real Codex logs. A reader for a format nobody has seen
// does not find nothing — it finds nothing WHILE LOOKING CORRECT, which is worse.
const CLAUDE_CODE_PROJECTS = [".claude", "projects"] as const;
/** Claude Code's prompt history: confirmed on a real file 2026-10-09 (schema 2.5). */
export const CLAUDE_CODE_HISTORY = [".claude", "history.jsonl"] as const;

/**
 * Whether the descriptive fields of schema 2.5 leave the device: the `prompt.history` events and,
 * on `session.summary`, `prompt_history`, `steering`, `commit_checks` and `suggestions_accepted`.
 *
 * OFF, and it stays off until a server consumer reads them (review of the wedge-reader sprint,
 * 2026-10-10). Nothing on the server renders, scores or aggregates any of them — the platform only
 * drops `prompt.history` once a transcript reading exists — and the project's rules are that data
 * of no use to the server does not travel ("что не привязывается к носителю, не отправляется") and
 * that code nobody calls is a defect. A nine-month calendar of sessions across every project on
 * the machine is also the kind of record that must not exist on our side without a reason a person
 * can see. So the reader computes them on the device (the CLI states what the history alone
 * knows; the SWE-chat study runs the same reader offline) and sends null — "not sent", the same
 * value an older producer sends. TODO(wire-2.5): turn on together with the consumer (a descriptive
 * Logbook panel with a route-level test), and then also from the sync, once per rules version.
 *
 * `reader_version` and `transcript_id` are not behind it: the server reads them (a re-read
 * supersedes the old reader's reading).
 */
export const DESCRIPTIVE_ON_WIRE = false;

/** The prompt history of this machine, grouped; empty when there is none or it cannot be read —
 *  the wedge is a guest here, and a history it cannot read is a history it does not report. */
export function readHistoryGroups(home: string): Map<string, HistoryGroup> {
  try {
    return readPromptHistory(join(home, ...CLAUDE_CODE_HISTORY));
  } catch {
    return new Map();
  }
}
const INSTRUCTION_FILES = ["CLAUDE.md", ".cursorrules", "AGENTS.md"] as const;

export type LocalEnvironment = EnvInputs & { skillsDefined: number };

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // missing, unreadable or not ours: the wedge is a guest on this machine
  }
}

function listFiles(dir: string, depth = 2): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (depth > 0) out = out.concat(listFiles(full, depth - 1));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * The environment as the claims see it: the NAMES of the connected MCP servers, how many reusable
 * skills are defined, and whether project instructions exist. No command lines, no arguments, no
 * file contents — the names are what E-1.0 is defined on (collector §4).
 */
export function readEnvironment(home: string = homedir()): LocalEnvironment {
  const servers = new Set<string>();
  for (const parts of CONFIG_FILES) {
    const config = readJson(join(home, ...parts));
    const declared = (config?.mcpServers ?? config?.servers) as Record<string, unknown> | undefined;
    for (const name of Object.keys(declared ?? {})) servers.add(name);
  }
  let skills = 0;
  for (const parts of SKILL_DIRS) {
    skills += listFiles(join(home, ...parts), 1).filter((f) => f.endsWith(".md")).length;
  }
  const instructions = INSTRUCTION_FILES.some((name) => readJson(join(home, name)) !== null || fileExists(join(home, name)));
  return {
    mcpTools: [...servers],
    mcpToolCalls: 0,
    projectInstructionsLoaded: instructions,
    reusableSkillCalls: skills,
    skillsDefined: skills,
  };
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every session the local journals hold, oldest first.
 *
 * This used to look for rows carrying `session_id` and `type: "session"` — a format nobody had
 * checked. On a machine with seven real sessions, 37 206 records and 273 subagent transcripts it
 * returned ZERO, and every test of it passed. The parser it now delegates to was written against
 * those files.
 */
export function readSessions(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): ClaudeCodeSession[] {
  return readAgentSessions(home, env).sessions;
}

/** The agents whose journals are on this machine — said before they are read (the consent line),
 *  and only those: a person without Codex never reads the word. */
export function agentsOnThisMachine(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Agent[] {
  const out: Agent[] = [];
  if (sessionFiles(join(home, ...CLAUDE_CODE_PROJECTS)).length > 0) out.push("claude_code");
  if (codexSessionFiles(codexHome(home, env)).length > 0) out.push("codex");
  return out;
}

/**
 * Every session of every agent this machine has a journal for (schema 2.10): Claude Code's
 * transcripts and Codex's rollouts (`$CODEX_HOME`, else ~/.codex), oldest first — and how many
 * Codex files could not be read here (a compressed file with no decoder), as a count.
 */
export function readAgentSessions(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): { sessions: ClaudeCodeSession[]; unreadable: number } {
  const claude = readClaudeCodeSessions(join(home, ...CLAUDE_CODE_PROJECTS));
  const codex = readCodexSessions(codexHome(home, env));
  return {
    sessions: [...claude, ...codex.sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    unreadable: codex.unreadable,
  };
}

export type LocalBackfillResult = {
  events: Event[];
  sessions: number;
  /** Sessions whose repository the server cannot bind — shown as "sessions outside tracked
   *  repositories" rather than hidden (B4.3). */
  unresolved: number;
  /** Sessions known only from the prompt history (their transcripts are gone) — descriptive, and
   *  counted apart from `sessions`. Counted on the device; sent as `prompt.history` only behind
   *  `DESCRIPTIVE_ON_WIRE`, and then only for connected repositories. */
  historyOnly: number;
  /** Of those, how many went as `prompt.history` events (0 while the flag is off). */
  historyOnlySent?: number;
  /** Schema 2.10: of `sessions`, how many each agent's journal gave (agents with none left out). */
  byAgent?: Partial<Record<Agent, number>>;
  /** Codex journal files that could not be read on this machine (no zstd decoder). */
  unreadable?: number;
  /** Always false, and asserted by the tests: attention telemetry has no past to read. */
  attention_backfilled: false;
  note: string;
  skipped_reason?: "no_consent" | "nothing_found";
};

export type LocalBackfillInput = {
  userId: string;
  home?: string;
  consent: boolean;
  /**
   * The device's own salt. REQUIRED, not optional: tool names that are not on the built-in
   * vocabulary are hashed with it before they can travel, and hashing with a predictable salt
   * would make `mcp__acme-billing__query` recoverable by anyone who guessed the name. The salt
   * never leaves the device, which is what makes the hash un-reversible by us rather than merely
   * inconvenient.
   */
  salt: string;
  /**
   * The repositories the server can bind a session to, from `GET /v1/me/repositories`.
   *
   * A session's branch travels only for one of these. Everywhere else neither the branch nor the
   * repository is sent and the session arrives unresolved on purpose — a branch that cannot
   * resolve is a name on the wire with no use, and the fix for that is not to send it. Empty (the
   * default) therefore means every session is unresolved, which is the honest state before the
   * device has been told anything.
   */
  connectedRepos?: ReadonlyArray<ConnectedRepo>;
  /** The id a session was already sent under by the incremental sync (./journal-sync ledger), so a
   *  history pass re-reading it produces the same event id and the server keeps one copy. */
  sessionIdFor?: (session: ClaudeCodeSession) => string | undefined;
  now?: () => Date;
  /** Defaults to `DESCRIPTIVE_ON_WIRE`; the tests set it to hold the shape the wire will have. */
  descriptiveOnWire?: boolean;
  /** Where `$CODEX_HOME` is read from; the process's own environment by default. */
  env?: NodeJS.ProcessEnv;
  /** Whether a session's folder is a hiring task's (./task/card-exclusion): never read into the card. */
  isTaskFolder?: (cwd: string | null) => boolean;
};

export type JournalSessionContext = {
  userId: string;
  salt: string;
  connectedRepos: ReadonlyArray<ConnectedRepo>;
  /** Always `backfill`: whatever is read from a journal file carries the flag, whichever pass read
   *  it. The type leaves no other choice. */
  origin: "backfill";
  /** The id the session travels under, when the sync's ledger already gave it one. */
  sessionId?: string;
  /** The prompt history, grouped (schema 2.5): the session's own prompts in it give the
   *  `prompt_history` features. Absent or without the session: the features are null — not read,
   *  not zero. */
  history?: ReadonlyMap<string, HistoryGroup>;
  /** Defaults to `DESCRIPTIVE_ON_WIRE`: off, the descriptive 2.5 fields travel as null. */
  descriptiveOnWire?: boolean;
};

/**
 * One journal session as a `session.summary` — the ONE builder both the history pass and the
 * incremental sync use, so a session read either way is the same observation with the same id
 * (the id is derived from the session, ./journal-sync explains why that matters).
 * Null when the session has no usable start time.
 */
export function journalSessionEvent(
  session: ClaudeCodeSession,
  ctx: JournalSessionContext,
): { event: Event; resolved: boolean } | null {
  const started = Date.parse(session.startedAt);
  if (!Number.isFinite(started)) return null;
  // Built-in names travel as themselves; everything a user named — MCP servers above all — is
  // hashed here, before it reaches the event builder. See ./vocabulary.
  const toolCalls = wireToolCalls(session.toolCalls, ctx.salt);
  const hint = sessionCarrierHint(session, ctx.connectedRepos);
  // The history's prompts of THIS stretch: the transcript decides what the session is, the history
  // only describes what the person typed into it. No group, or no prompt in the stretch: null.
  const group = session.transcriptId ? ctx.history?.get(session.transcriptId) : undefined;
  const own = group ? promptsWithin(group.prompts, session.startedAt, session.endedAt) : [];
  const event = buildSessionSummary({
    userId: ctx.userId,
    source: "wedge_cli",
    origin: ctx.origin,
    tool: { name: "deigma-cli", version: "0.1.0" },
    salt: ctx.salt,
    // The model the journal itself names (`message.model`), allow-listed and with its generation
    // derived from the name (wedge-core/src/model.ts). Not known when the journal names none.
    model: modelFromId(session.model),
    // The event is dated when the work happened; `sent_at` says when we read it.
    now: () => new Date(started),
    sessionId: ctx.sessionId ?? session.sessionId,
    // No prompt text exists in a journal we are allowed to read, and we do not go looking:
    // the round count is what the path-to-result claim needs. The count of requests is known
    // even though their text is not, so it is reported rather than left to derive itself from
    // an empty list and come out as a zero that contradicts the rounds beside it.
    prompts: [],
    requests: session.requests,
    toolCalls,
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    durationMs: session.durationMs,
    iterations: session.iterations,
    // E comes from THIS SESSION and nothing else — no fallback to what the machine looks like
    // today, which is what made a backfilled E "a statement about today wearing the date of a
    // session months ago" (R5). Names, not the wire: `envFeatures` reduces this to a COUNT and
    // the array itself is never serialised (packages/wedge-core/src/features.ts).
    env: {
      mcpTools: session.mcpTools,
      mcpToolCalls: session.mcpToolCalls,
      projectInstructionsLoaded: session.projectInstructionsLoaded,
      reusableSkillCalls: session.reusableSkillCalls,
    },
    humanPrompts: session.humanPrompts,
    verificationRuns: session.verificationRuns,
    // Schema 2.5: which reader this is (a re-read by it replaces cc-reader-1's reading of the same
    // transcript on the server), and what the reader now sees beyond the counts it had.
    readerVersion: readerVersionOf(session),
    // The transcript and the stretch's start: the same reading whichever pass makes it, however
    // the stretch happens to be named at the time (`<id>` alone, or `<id>-1` once it has a sibling).
    // A Codex thread is namespaced (schema 2.10): its uuid and a Claude Code one never meet.
    subjectKey: `${session.agent === "codex" ? "codex:" : ""}${session.transcriptId ?? session.transcript}@${session.startedAt}`,
    transcriptId: session.transcriptId,
    agent: session.agent,
    // Habit counts. The scorer reads them, so they are not behind the descriptive flag.
    habits: session.habits,
    // Descriptive, and behind `DESCRIPTIVE_ON_WIRE`: no server consumer reads them yet.
    ...((ctx.descriptiveOnWire ?? DESCRIPTIVE_ON_WIRE)
      ? {
          suggestionsAccepted: session.suggestionsAccepted,
          steering: { interrupts: session.interrupts, followups_after_interrupt: session.followupsAfterInterrupt },
          commitChecks: { commits: session.commits, verified_after_last_edit: session.commitsVerified },
          promptHistory: own.length > 0 ? historyFeatures(own) : null,
        }
      : {}),
    // The exact pull request when the journal names one (pr-link), else branch and repository
    // together or neither (./session-hint): a repo id without either cannot bind, and a branch
    // without a repo id is the name we decided not to send.
    ...(hint
      ? {
          repoId: hint.repoId,
          ...(hint.branch ? { branch: hint.branch } : {}),
          ...(hint.prNumber ? { prNumber: hint.prNumber } : {}),
        }
      : {}),
  });
  return { event, resolved: hint !== null };
}

/** The reader of a session's agent (schema 2.10): each agent's journal has its own. */
export function readerVersionOf(session: Pick<ClaudeCodeSession, "agent">): typeof READER_VERSION | typeof CODEX_READER_VERSION {
  return session.agent === "codex" ? CODEX_READER_VERSION : READER_VERSION;
}

/** One session the prompt history alone still knows: a stretch of a group whose transcript is gone. */
export type HistoryOnlyStretch = {
  group: HistoryGroup;
  stretch: HistoryGroup["prompts"];
  /** The stretch's index within its group: part of what makes its id stable. */
  index: number;
  /** The connected repository the project directory is, or null. */
  repoId: number | null;
};

/**
 * Sessions known only from the prompt history (schema 2.5).
 *
 * A group whose transcript is still on disk is NOT one of them: the transcript wins, and that
 * session travels as a `session.summary` — counting it here too would be the same session twice.
 * What is left is what Claude Code has already deleted (it keeps transcripts about thirty days and
 * the history for months), plus old history records that name no session, grouped by project and
 * day. Each is split by the same idle gap as a transcript, and a stretch that ended within one gap
 * of now is left for later, like a session still going.
 */
export function historyOnlyStretches(input: {
  groups: ReadonlyMap<string, HistoryGroup>;
  /** Transcript ids that still have a transcript on this machine. */
  transcripts: ReadonlySet<string>;
  connectedRepos: ReadonlyArray<ConnectedRepo>;
  now: number;
  gapHours?: number;
  readRepo?: (p: string) => string;
}): HistoryOnlyStretch[] {
  const gapMs = (input.gapHours ?? SESSION_IDLE_GAP_HOURS) * 3600_000;
  const out: HistoryOnlyStretch[] = [];
  const repoIds = new Map<string, number | null>();
  for (const group of input.groups.values()) {
    if (group.transcriptId && input.transcripts.has(group.transcriptId)) continue;
    let repoId: number | null = null;
    if (group.project) {
      if (!repoIds.has(group.project)) {
        repoIds.set(group.project, connectedRepoIdAt(group.project, input.connectedRepos, input.readRepo));
      }
      repoId = repoIds.get(group.project) ?? null;
    }
    splitByIdleGap(group.prompts, gapMs).forEach((stretch, index) => {
      const last = stretch[stretch.length - 1]!;
      if (input.now - last.at <= gapMs) return; // may still be going
      out.push({ group, stretch, index, repoId });
    });
  }
  return out;
}

/**
 * The history-only sessions as `prompt.history` events — ONLY those whose project directory is a
 * connected repository (review 2026-10-10). Anywhere else the event would bind to nothing: a
 * session in a project the server cannot read is a date, a duration and a project hash with no
 * use on our side, and the fix for that is not to send it — the same rule as a branch that cannot
 * resolve (./session-hint). Only ever built when `DESCRIPTIVE_ON_WIRE` is on.
 *
 * Nothing here is a claim input: the repository id says where the work was, it binds no carrier.
 */
export function historyOnlyEvents(input: {
  stretches: ReadonlyArray<HistoryOnlyStretch>;
  userId: string;
  salt: string;
}): Event[] {
  const out: Event[] = [];
  for (const { group, stretch, index, repoId } of input.stretches) {
    if (repoId === null || !group.project) continue; // not a connected repository: not sent
    const first = stretch[0]!;
    const last = stretch[stretch.length - 1]!;
    const hash = projectHash(group.project, input.salt);
    // The id is derived from what the stretch IS — never from a path: the project enters only as
    // its salted hash, so the event id cannot be used to test a guess of a directory.
    const historyId = group.transcriptId
      ? `${group.transcriptId}:${index}`
      : `${hash}:${new Date(first.at).toISOString().slice(0, 10)}:${index}`;
    out.push(
      buildPromptHistory({
        userId: input.userId,
        source: "wedge_cli",
        // A file on the machine, always: it is the easiest evidence there is to forge.
        origin: "backfill",
        tool: { name: "deigma-cli", version: "0.1.0" },
        now: () => new Date(first.at),
        historyId,
        transcriptId: group.transcriptId,
        grouping: group.transcriptId ? "session" : "project_day",
        durationMs: last.at - first.at,
        projectHash: hash,
        repoId,
        features: historyFeatures(stretch),
      }),
    );
  }
  return out;
}

export async function localBackfill(input: LocalBackfillInput): Promise<LocalBackfillResult> {
  const note =
    "environment and session history are read from the device; attention telemetry " +
    "(validation time, scrolls, edits) is never backfilled — it was never recorded";
  if (!input.consent) {
    return { events: [], sessions: 0, unresolved: 0, historyOnly: 0, attention_backfilled: false, note, skipped_reason: "no_consent" };
  }
  // The same refusal as every content hash: tool names and project directories are hashed with it.
  requireDeviceSalt(input.salt);
  const home = input.home ?? homedir();
  const env = readEnvironment(home);
  const read = readAgentSessions(home, input.env ?? process.env);
  const sessions = read.sessions;
  const history = readHistoryGroups(home);
  if (sessions.length === 0 && env.mcpTools.length === 0 && history.size === 0) {
    return { events: [], sessions: 0, unresolved: 0, historyOnly: 0, attention_backfilled: false, note, skipped_reason: "nothing_found" };
  }
  const now = input.now ?? (() => new Date());
  const wire = input.descriptiveOnWire ?? DESCRIPTIVE_ON_WIRE;
  const events: Event[] = [];
  let unresolved = 0;
  const byAgent: Partial<Record<Agent, number>> = {};
  for (const session of sessions) {
    // A session still going is not read yet (2026-10-09). Its id is derived from the session, and
    // the server keeps the first copy of an id: sent now, it would stay half-measured forever.
    // The incremental sync (./journal-sync) reads it once it has ended.
    if (now().getTime() - Date.parse(session.endedAt) <= SESSION_IDLE_GAP_HOURS * 3600_000) continue;
    // A hiring task's session never counts toward the card.
    if (input.isTaskFolder?.(session.cwd)) continue;
    const built = journalSessionEvent(session, {
      userId: input.userId,
      salt: input.salt,
      connectedRepos: input.connectedRepos ?? [],
      // Read from a journal, not observed live: the flag travels with the observation forever
      // (6.1 §12). A local journal is the easiest evidence there is to forge.
      origin: "backfill",
      history,
      descriptiveOnWire: wire,
      ...(input.sessionIdFor?.(session) ? { sessionId: input.sessionIdFor(session)! } : {}),
    });
    if (!built) continue;
    if (!built.resolved) unresolved += 1;
    byAgent[session.agent] = (byAgent[session.agent] ?? 0) + 1;
    events.push(built.event);
  }
  const sessionEvents = events.length;
  // What the prompt history alone still knows: sessions whose transcripts are gone. A transcript
  // on disk — read above or not (a session still going) — keeps its session out of this list.
  const transcripts = new Set<string>();
  for (const file of sessionFiles(join(home, ...CLAUDE_CODE_PROJECTS))) {
    transcripts.add(basename(file).replace(/\.jsonl$/i, "").toLowerCase());
  }
  for (const s of sessions) if (s.agent === "claude_code" && s.transcriptId) transcripts.add(s.transcriptId);
  const older = historyOnlyStretches({
    groups: history,
    transcripts,
    connectedRepos: input.connectedRepos ?? [],
    now: now().getTime(),
  });
  // Counted on the device either way (the CLI says how many sessions the history alone knows);
  // sent only behind the flag, and then only for connected repositories.
  if (wire) events.push(...historyOnlyEvents({ stretches: older, userId: input.userId, salt: input.salt }));
  // `sent_at` is now, `occurred_at` is history: the ingestion tombstone and the offline window
  // both read `sent_at`, so a backfilled event is not mistaken for a late live one.
  const sentAt = now().toISOString();
  const stamped = events.map((e) => ({ ...e, sent_at: sentAt }) as Event);
  return {
    events: stamped,
    sessions: sessionEvents,
    unresolved,
    historyOnly: older.length,
    historyOnlySent: stamped.filter((e) => e.type === "prompt.history").length,
    byAgent,
    unreadable: read.unreadable,
    attention_backfilled: false,
    note,
  };
}
