/**
 * Claude Code's local transcripts, read as sessions (B4.1, R5).
 *
 * The shape here was read off 291 real files on a real machine (2026-09-07, 37 206 records), not
 * remembered, because the previous reader was written from an imagined format — records with
 * `session_id` and `type: "session"` — and found **zero** sessions on a machine that had seven.
 * Every field below was confirmed to exist in those files.
 *
 * A transcript file is not a session. The same measurement found one file spanning fifteen days:
 * taking the file at face value gives 7 sessions where the idle gap gives 27, and the process
 * claims (floor: 10 sessions) would wait months instead of four weeks. The boundary is
 * `SESSION_IDLE_GAP_HOURS`, shared with the live proxy so the product has ONE definition of a
 * session: two emitters with two rules make a claim measured in sessions mix two units.
 *
 * The same directory holds `agent-<id>.jsonl` — transcripts of SUBAGENTS — and 273 of the 291
 * files were those. They are folded into the session whose work they are, in both layouts they
 * occur in: directly under `subagents/`, and under `subagents/workflows/<wf_id>/`.
 *
 * What leaves the device. Counts and durations only. No prompt text: `SessionSummaryInput` says a
 * backfill "holds no prompt text", and this honours it — the transcripts are full of the person's
 * own words and their code. The habit rules (./habits.ts) read a typed prompt in memory, keep only
 * what the rules say about it (a few booleans and file basenames, used and dropped inside one
 * session's fold) and emit counts. Tool
 * NAMES are handled a layer up (`../vocabulary`): built-in names are a closed vocabulary, and
 * anything a user named is hashed on the device before it can travel.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { Agent } from "@mentat/schemas";

import { REVIEWER_WORDS } from "../environment/names";
import { SESSION_IDLE_GAP_HOURS } from "../measurement";
import { commitClean, memoryAlive } from "./device-git";
import {
  HB2_RULES,
  type CommandFacts,
  type Habits,
  type PromptFacts,
  type PathKind,
  commandDir,
  commandFacts,
  commandIsReview,
  commandIsSecurity,
  commitShaOf,
  editOf,
  habitsOf,
  promptFacts,
  slashCommandOf,
  stripProse,
  touchedFile,
} from "./habits";
import { forEachLine } from "./lines";

/**
 * Which reader produced a session (schema 2.5). Travels on the wire so the server can let a
 * re-read of the same transcript REPLACE the earlier reading instead of adding to it — the max
 * version per transcript wins.
 *
 * `cc-reader-1` is everything before 2026-10-10: it counted background-task notifications and
 * local commands as turns the person typed (SR2 D1 — measured 1.9x on a real machine), missed
 * the real shape of a hook firing (D2), found loaded instructions by a text marker only (D3) and
 * read whole files into memory (D4). `cc-reader-2` fixed those. `cc-reader-3` is this file: the
 * reading that carries the habit traces (hb-2.1), so a transcript `cc-reader-2` sent without them is
 * read once more and replaced (solo review M14). `cc-reader-4` carries hb-2.3 (reviews through
 * agents and workflows, files named without the extension). A change to what any field of a
 * reading MEANS moves this constant; a change that does not (a refactor) does not.
 */
export const READER_VERSION = "cc-reader-4" as const;

/** A session as this journal states it, before it becomes a `session.summary`. */
export type ClaudeCodeSession = {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Distinct API requests, from `requestId` on assistant records. */
  requests: number;
  /** The sampler's own count: `message.usage.iterations` is a LIST, and its length is the count. */
  iterations: number;
  toolCalls: Record<string, number>;
  /** Distinct `mcp__server__tool` names used — E-1.0's tool diversity, as USED not as configured. */
  mcpTools: string[];
  mcpToolCalls: number;
  /** `Skill` invocations: E-1.0's reusable-skill component. */
  reusableSkillCalls: number;
  /** Whether the project's own instructions were IN CONTEXT — loaded, not merely read. */
  projectInstructionsLoaded: boolean;
  /** Turns the person typed. The unit of PtR-1.1; `requests` counts API calls and cannot serve.
   *  See `userTurnKind`: a background task's notification and a local command are not typed. */
  humanPrompts: number;
  /** Prompts the person accepted from the tool's own suggestion (`promptSource:
   *  "suggestion_accepted"`). An act of the person, but not a turn they typed — counted apart so
   *  neither definition borrows from the other. */
  suggestionsAccepted: number;
  /** Times the person stopped the agent mid-answer: a user record with `interruptedMessageId`,
   *  or the tool's own `[Request interrupted by user` frame. Distinct by the record interrupted. */
  interrupts: number;
  /** Typed turns that came right after an interruption — the person redirecting the work. */
  followupsAfterInterrupt: number;
  /** Commits the agent made (a `git commit` it ran), and of those, how many came after a
   *  verification run (PtL-1.0's categories, classified on the device) that followed the last
   *  edit the agent made before it. A commit with no check since the last edit is unverified. */
  commits: number;
  commitsVerified: number;
  /** The transcript's own id (Claude Code's random `sessionId`), when it has the uuid shape. The
   *  key under which a re-read replaces an earlier reading (schema 2.5). */
  transcriptId: string | null;
  /** Verification runs by category (PtL-1.0). Counts only; commands stay on the device. */
  verificationRuns: Record<VerificationCategory, number>;
  tokensIn: number;
  tokensOut: number;
  /** Subagent transcripts the session produced — its own agents plus any a workflow spawned. */
  subagents: number;
  /** Workflows the session ran. The one local signal that separates orchestrating from
   *  delegating (6.1 §2.1), where κ is uncalibrated and the two are one category. */
  workflows: number;
  /** From `gitBranch`. The repository is resolved later (B4.3); a branch alone cannot bind. */
  branch: string | null;
  /** From `cwd`, kept ONLY to group sessions by project locally. Never emitted. */
  cwd: string | null;
  model: string | null;
  /** The distinct pull requests this stretch's `pr-link` records name, in order of first
   *  appearance. Measured 2026-10-09 with this parser: of 52 sessions on this machine, 22 named
   *  any — 13 exactly one, 9 two to five — so a long session opens several pull requests,
   *  which is why ONE is a binding and several are not (see ../session-hint.ts). */
  pullRequests: { repository: string; number: number }[];
  /** The transcript file's name, kept ONLY as the incremental sync's ledger key. Never emitted. */
  transcript: string;
  /** Habit traces (Core 7 §4) by the public rules hb-1.0 — counts only (./habits.ts). */
  habits: Habits;
  /** Schema 2.10: the agent whose journal this is (./codex.ts reads Codex's into the same shape). */
  agent: Agent;
};

/** A session read from any agent's journal: one shape, so one builder makes its event. */
export type JournalSession = ClaudeCodeSession;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** Transcript files that are SESSIONS. `agent-*.jsonl` are subagents of one and are not sessions. */
export function sessionFiles(root: string): string[] {
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return []; // no Claude Code on this machine: not an error, just nothing to read
  }
  const out: string[] = [];
  for (const project of projects) {
    const dir = join(root, project);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (UUID.test(name)) out.push(join(dir, name));
      }
    } catch {
      continue; // unreadable directory: the wedge is a guest on this machine
    }
  }
  return out.sort();
}

export type Rec = {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  requestId?: string;
  cwd?: string;
  gitBranch?: string;
  attachment?: unknown;
  message?: { model?: string; usage?: Record<string, unknown>; content?: unknown };
};

/** The first text of a record's message, trimmed at the start — read ONLY to recognise the frame
 *  the tool itself wraps around what it injects (`<task-notification>`, `<command-name>`, …).
 *  Nothing of it is kept: callers test a prefix and drop the string. */
/** Every text block of a record's message, joined — read ONLY by the habit rules (./habits.ts),
 *  which keep what the rules say about it and drop the string. */
function promptText(rec: Rec): string {
  const content = rec.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function leadingText(rec: Rec): string | null {
  const content = rec.message?.content;
  if (typeof content === "string") return content.trimStart();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text.trimStart();
    }
  }
  return null;
}

/** Frames Claude Code puts around text it injects in the user role. None of them is a turn the
 *  person typed: a background task finishing, a slash command's expansion and output, a `!`
 *  shell command and its output, the tool's own note that the person interrupted it, and a
 *  message from another agent of an agent team (`<teammate-message …>`, CLI 2.1.39 on, in
 *  transcripts that carry no `promptSource` — review 2026-10-10). */
export const MACHINE_FRAMES = [
  "<task-notification",
  "<command-",
  "<local-command",
  "<bash-",
  "<teammate-message",
  "[Request interrupted by user",
] as const;

/** Whether a record's content carries a tool result. The user role carries the result of every
 *  tool call the agent made, and a record that does is the tool answering the agent, never a turn
 *  the person typed — also when a text block rides beside the result (`[tool_result, "Tool
 *  loaded."]` in untagged transcripts, review 2026-10-10), which `leadingText` would otherwise
 *  read as prose. */
function carriesToolResult(rec: Rec): boolean {
  const content = rec.message?.content;
  return (
    Array.isArray(content) &&
    content.some((b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result")
  );
}

function isMachineFrame(text: string): boolean {
  return MACHINE_FRAMES.some((f) => text.startsWith(f));
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Whether this record shows the project's instructions were IN CONTEXT.
 *
 * The first version of this asked whether an attachment mentioned CLAUDE.md anywhere, and that is
 * a different question: it caught the file being READ or EDITED, which is what happens when
 * somebody works on their instructions rather than works under them. Measured on this machine it
 * answered 6 of 33 for a person whose main project has had a CLAUDE.md the whole time — a number
 * that was neither the count of sessions in that project (17) nor the count of anything else.
 *
 * What actually happens is that the file is injected into the session as instructions, and the
 * injection names itself: `CLAUDE.md (project instructions, checked into the codebase)`. A memory
 * file below the project root arrives separately, as an attachment of type `nested_memory`. Both
 * are load events; a read of the file is not. Verified on the real transcripts: the marker
 * appears in exactly the one project that has such a file, and in none of the others.
 *
 * The match is on the injection's own frame, not on anybody's text, and it runs on the device.
 */
const PROJECT_INSTRUCTIONS_MARKER = /(CLAUDE|AGENTS)\.md \(project instructions/;

function mentionsProjectInstructions(rec: Rec): boolean {
  const a = rec.attachment as Record<string, unknown> | undefined;
  if (rec.type === "attachment" && a && a.type === "nested_memory") return true;
  // SR2 D3: the structural form, read off 507 real records on 2026-10-09 — an attachment of type
  // `instructions` whose `files[].type` says which kind of file was loaded. `Project` is the
  // project's own instruction file; `AutoMem` is the tool's automatic memory and is not one.
  // Only the TYPE of each file is read, never its path or its text.
  if (rec.type === "attachment" && a && a.type === "instructions") {
    const files = a.files;
    return (
      Array.isArray(files) &&
      files.some((f) => !!f && typeof f === "object" && (f as { type?: unknown }).type === "Project")
    );
  }
  // The text marker stays as the fallback, for versions that wrote no such attachment.
  const content = rec.message?.content;
  if (typeof content === "string") return PROJECT_INSTRUCTIONS_MARKER.test(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as { type?: string; text?: unknown }).text;
      if (typeof text === "string" && PROJECT_INSTRUCTIONS_MARKER.test(text)) return true;
    }
  }
  return false;
}

/**
 * What a user-role record is, as a turn (SR2 D1): typed by the person, accepted from the tool's
 * suggestion, or not a turn of the person's at all.
 *
 * The unit of path-to-result from PtR-1.1. `requests` cannot serve: it counts API calls, so it
 * counts the tool's own retries and continuations — 8163 of them against 6 typed turns in the
 * median session on a real machine. A claim built on that would rise with how chatty the tool is.
 *
 * The first rule counted every user record with text, and the user role is worn by much that the
 * person never typed: of 649 records it counted on a real machine (2026-10-09), 279 were
 * notifications that a background task finished and 14 were local commands; 313 were typed. The
 * count reached PtR-1.1 inflated about 1.9x — and inflated MORE for whoever ran more background
 * work, which is a volume rising into a claim. The structured fields decide now:
 *   * `promptSource: "suggestion_accepted"` is the person accepting the tool's own suggestion —
 *     counted apart; `promptSource: "system"` is not the person, whatever else the record says;
 *   * else `origin.kind` decides: `human` is the person, whatever `promptSource` says — the VS Code
 *     extension writes `promptSource: "sdk"` on the person's own prompts, and a prompt typed while
 *     the agent was busy is `promptSource: "queued"`; `task-notification`, `peer`, `coordinator`
 *     are not the person;
 *   * else `promptSource`: `typed` and `queued` are the person, any other value is not;
 *   * else — a record carrying neither field — the transcript decides. In a TAGGED transcript
 *     (one whose CLI writes `promptSource` on its user records) an untagged prose record was
 *     injected by the machine, not typed; only a transcript written before either field existed
 *     falls back to the frame of the text. (SWE-chat canary on real record shapes, 2026-10-10:
 *     the previous rule dropped every VS Code prompt and every queued prompt without an origin
 *     check, and counted the machine's untagged prose.)
 * A record carrying a tool result is never a typed turn, whatever rides beside it, and a machine
 * frame never is either, whatever the fields say: a slash command the person
 * typed is recorded as its `<command-name>` expansion, and the prompt history counts slash
 * commands apart as well (./prompt-history.ts) — the two readers keep one definition.
 */
export type UserTurnKind = "typed" | "suggestion" | null;

/** Whether a user record carries `promptSource` — what makes its transcript TAGGED. */
export function carriesPromptSource(rec: Rec): boolean {
  return rec?.type === "user" && typeof (rec as Record<string, unknown>).promptSource === "string";
}

/** Whether a user record carries neither `promptSource` nor `origin.kind`: its kind is then a
 *  property of its transcript (`userTurnKind`'s last rule), not of the record. */
function untaggedRecord(rec: Rec): boolean {
  const r = rec as Record<string, unknown>;
  const origin = r.origin;
  const hasOrigin =
    !!origin && typeof origin === "object" && typeof (origin as { kind?: unknown }).kind === "string";
  return typeof r.promptSource !== "string" && !hasOrigin;
}

/** `tagged`: the transcript the record belongs to is tagged (`carriesPromptSource` holds for one
 *  of its user records). Defaults to an untagged transcript, the frame rule. */
export function userTurnKind(rec: Rec, tagged = false): UserTurnKind {
  const r = rec as Record<string, unknown>;
  if (rec.type !== "user" || r.isMeta === true || r.isSidechain === true || r.isCompactSummary === true) {
    return null;
  }
  if (carriesToolResult(rec)) return null;
  const text = leadingText(rec);
  if (text === null || text.length === 0 || isMachineFrame(text)) return null;
  const source = typeof r.promptSource === "string" ? r.promptSource : null;
  if (source === "suggestion_accepted") return "suggestion";
  if (source === "system") return null;
  const origin = r.origin;
  if (origin && typeof origin === "object" && typeof (origin as { kind?: unknown }).kind === "string") {
    return (origin as { kind: string }).kind === "human" ? "typed" : null;
  }
  if (source !== null) return source === "typed" || source === "queued" ? "typed" : null;
  return tagged ? null : "typed";
}

/** The record an interruption interrupted, as a key to count it once — or null when this record
 *  is not an interruption. Ids only; the text is tested for the tool's frame and dropped. */
function interruptionKey(rec: Rec): string | null {
  const r = rec as Record<string, unknown>;
  if (rec.type !== "user" || r.isSidechain === true) return null;
  const marked = typeof r.interruptedMessageId === "string" && r.interruptedMessageId.length > 0;
  const text = leadingText(rec);
  if (!marked && !(text !== null && text.startsWith("[Request interrupted by user"))) return null;
  for (const k of ["parentUuid", "uuid"] as const) {
    if (typeof r[k] === "string" && r[k]) return `${k}:${r[k] as string}`;
  }
  return `at:${rec.timestamp ?? ""}`;
}

/** The agent's own edit tools. Names only — the edit itself is never read. */
const AGENT_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** A commit the agent made by running git. The command is matched here and dropped. */
const GIT_COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;

/** Categories of a verification run (PtL-1.0), from a closed vocabulary.
 *
 * The command is classified HERE, on the device, and neither it nor its arguments ever travel:
 * what leaves is one of four names and a count. Nothing scores this yet — the claim it feeds is
 * behind DEIGMA_FEATURE_VERIFY_BEFORE_LANDING and that flag is off — but the counting has to
 * start before the claim can ever be computed from history. */
const VERIFICATION_PATTERNS: [VerificationCategory, RegExp][] = [
  ["test", /\b(pytest|vitest|jest|mocha|go test|cargo test|npm (run )?test|yarn test|pnpm test|rspec|phpunit)\b/],
  ["build", /\b(npm run build|yarn build|pnpm build|tsc|cargo build|go build|make|vite build|webpack|gradle)\b/],
  ["lint", /\b(eslint|ruff|flake8|pylint|mypy|prettier|clippy|typecheck|golangci-lint|black)\b/],
];

export type VerificationCategory = "test" | "build" | "lint" | "review";

export function classifyVerification(command: string): VerificationCategory | null {
  const low = command.toLowerCase();
  for (const [category, pattern] of VERIFICATION_PATTERNS) {
    if (pattern.test(low)) return category;
  }
  return null;
}

/**
 * Subagent transcripts of one session, in both layouts that occur: directly under `subagents/`,
 * and under `subagents/workflows/<wf_id>/`. Reading only the first found 3 on a machine that had
 * 273 — and missed the workflows entirely, which is the one signal here that distinguishes
 * orchestrating from delegating (6.1 §2.1).
 */
export function subagentFiles(sessionPath: string): { files: string[]; workflows: number } {
  const root = join(sessionPath.replace(/\.jsonl$/i, ""), "subagents");
  const files: string[] = [];
  const workflows = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (name.startsWith("wf_")) workflows.add(name);
        if (depth > 0) walk(full, depth - 1);
      } else if (name.startsWith("agent-") && name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  walk(root, 3);
  return { files: files.sort(), workflows: workflows.size };
}

/** One timestamped record, reduced to what a session is made of. */
type Moment = {
  at: number;
  iso: string;
  requestId: string | null;
  tool: string | null;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
  instructions: boolean;
  humanPrompt: boolean;
  /** The typed turn was decided by the frame rule alone (the record carries neither
   *  `promptSource` nor `origin.kind`); `momentsOf` withdraws it when the file is tagged. */
  typedByFrame: boolean;
  suggestionAccepted: boolean;
  /** Set on an interruption: the key it is counted once by (`interruptionKey`). */
  interrupt: string | null;
  /** The moment's tool call was one of the agent's edit tools. */
  agentEdit: boolean;
  /** The moment's tool call was a `git commit` the agent ran. */
  commit: boolean;
  /** Set when the moment's tool call was a subagent: its name, matched against the review vocabulary. */
  subagentType: string | null;
  /** Set when the moment's tool call was a verification run (PtL-1.0). */
  verification: VerificationCategory | null;
  branch: string | null;
  cwd: string | null;
  model: string | null;
  /** Set on a `pr-link` record: the pull request it names (`prLinkOf`). */
  prLink: { repository: string; number: number } | null;
  /** Habits (hb-1.0): what a typed prompt's text says, derived here and the text dropped; the
   *  basename of a file the agent opened; whether the session was in plan mode. */
  prompt: PromptFacts | null;
  touched: string | null;
  planMode: boolean;
  // --- hb-2.0 (./habits.ts). Derived from the tool call on the device; command text, paths and
  // subagent prompts are classified here and dropped.
  isTool: boolean;
  edit: { file: string; kind: PathKind; manifest: boolean; lines: number } | null;
  cmd: CommandFacts | null;
  testOrBuild: boolean;
  failed: boolean;
  refused: boolean;
  sha: string | null;
  explore: boolean;
  plans: boolean;
  security: boolean;
  review: boolean;
  mode: string | null;
  dir: string | null;
  /** The person ran /clear (hb-2.1: the next work prompt is a new task). */
  clear: boolean;
  /** The id of the tool call this moment is, and the results this record carries for other calls;
   *  joined in `momentsOf` and then of no further use. */
  useId: string | null;
  results: { id: string; isError: boolean; refused: boolean; sha: string | null; reportsFailure: boolean }[];
  /** hb-2.2: a test, lint or typecheck run, and whether its result reports a failure. */
  check: boolean;
  reportsFailure: boolean;
};

/** The file's records reduced to moments, read a line at a time (D4): what is held is the moments,
 *  never the file. An unreadable file has none — one unreadable subagent must not take the
 *  session with it. */
function momentsOf(file: string): Moment[] {
  const out: Moment[] = [];
  let tagged = false;
  let pendingMode: string | null = null;
  forEachLine(file, (line) => {
    if (!line.trim()) return;
    let rec: Rec;
    try {
      rec = JSON.parse(line) as Rec;
    } catch {
      return; // a partial last line is normal in a journal still being written
    }
    if (carriesPromptSource(rec)) tagged = true;
    // hb-2.2: a `permission-mode` record carries the mode and no time, so it makes no moment of its
    // own; its mode is carried onto the next moment that states none (it was dropped before, and
    // the mode was then known only where a user record happened to repeat it).
    const r = rec as Record<string, unknown>;
    if (r?.type === "permission-mode" && typeof r.permissionMode === "string") {
      pendingMode = r.permissionMode;
      return;
    }
    for (const m of recordMoments(rec)) {
      if (pendingMode !== null && m.mode === null) {
        m.mode = pendingMode;
        if (pendingMode === "plan") m.planMode = true;
        pendingMode = null;
      }
      out.push(m);
    }
  });
  // A tool's result arrives in a later record: join it to the call by id (hb-2.0 reads whether a
  // commit failed, whether the person refused a call, and the sha a commit reported).
  const results = new Map<string, Moment["results"][number]>();
  for (const m of out) for (const r of m.results) results.set(r.id, r);
  for (const m of out) {
    const r = m.useId ? results.get(m.useId) : undefined;
    if (!r) continue;
    m.failed = r.isError;
    m.refused = r.refused;
    m.sha = r.sha;
    m.reportsFailure = m.check && r.reportsFailure;
  }
  // Whether the file is tagged is known only once it is read; the moments are held anyway, so the
  // untagged prose of a tagged transcript is withdrawn here instead of reading the file twice.
  if (tagged) {
    for (const m of out) {
      if (m.typedByFrame) {
        m.humanPrompt = false;
        m.typedByFrame = false;
        m.prompt = null;
      }
    }
  }
  return out;
}

/** `owner/name` as Claude Code writes `prRepository`: GitHub's own character set, nothing else. */
const PR_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The pull request a `type: "pr-link"` record names, or null (audit 2026-10-09 #4).
 *
 * Claude Code writes one of these when a session opens or touches a pull request. The shape was
 * read off this machine's journals on 2026-10-09 — keys only, 641 records, every one of them
 * `{type, sessionId, timestamp, prNumber, prRepository, prUrl}`, `prNumber` an integer and
 * `prRepository` an `owner/name` — and it is the one EXACT link a journal holds between a session
 * and a piece of work: everything else is the branch-and-day guess.
 *
 * Allow-listed: exactly `prNumber` and `prRepository` are read (plus `type` and `timestamp`, which
 * every record gives). `prUrl` is not — it says the same thing with a host in it — and no other
 * key of the record is touched. `prRepository` is matched against the person's connected list on
 * the device and never travels; only the connected repository's numeric id and the number do.
 */
export function prLinkOf(rec: Rec): { repository: string; number: number } | null {
  if (rec.type !== "pr-link") return null;
  const r = rec as Record<string, unknown>;
  const number = r.prNumber;
  const repository = r.prRepository;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  if (typeof repository !== "string" || !PR_REPOSITORY.test(repository)) return null;
  return { repository, number };
}

/** The results a user-role record carries: whether each call errored, whether the person refused
 *  it, and the sha a commit reported. The result text is read here and dropped. */
function toolResultsOf(rec: Rec): Moment["results"] {
  const content = rec.message?.content;
  if (!Array.isArray(content)) return [];
  const out: Moment["results"] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; tool_use_id?: unknown; is_error?: unknown; content?: unknown };
    if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
    const text =
      typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n")
          : "";
    const isError = b.is_error === true;
    out.push({
      id: b.tool_use_id,
      isError,
      refused: isError && HB2_RULES.refusal.test(text),
      sha: isError ? null : commitShaOf(text),
      // hb-2.2: a runner's own summary of a failure, read from the tail of the result and
      // dropped. A test piped through `tail` exits 0 whatever it says.
      reportsFailure: HB2_RULES.failureReport.test(text.slice(-4000)),
    });
  }
  return out;
}

/** One journal record, reduced to the moments a session is made of. Exported for the test that
 *  watches which keys of a record are ever read. */
export function recordMoments(rec: Rec): Moment[] {
  const out: Moment[] = [];
  {
    if (typeof rec !== "object" || rec === null) return out;
    const iso = typeof rec.timestamp === "string" ? rec.timestamp : "";
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return out; // a record with no time cannot be placed in a session

    const msg = rec.message;
    const usage = msg && typeof msg === "object" ? msg.usage : undefined;
    const u = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
    const turn = userTurnKind(rec);
    const base: Omit<Moment, "tool"> = {
      at,
      iso,
      requestId: typeof rec.requestId === "string" ? rec.requestId : null,
      // `iterations` is an ARRAY of per-iteration usage records, not a count — read off the real
      // files after the first version summed it as a number and reported 0 for 7 588 of them.
      iterations: Array.isArray(u.iterations) ? u.iterations.length : 0,
      // Cache READS are excluded on purpose: every request re-reads the same context, so summing
      // them counts one conversation thousands of times. On this machine that produced 3.5
      // billion "input tokens" for seven sessions. What counts is what was newly paid for.
      tokensIn: num(u.input_tokens) + num(u.cache_creation_input_tokens),
      tokensOut: num(u.output_tokens),
      instructions: mentionsProjectInstructions(rec),
      humanPrompt: turn === "typed",
      typedByFrame: turn === "typed" && untaggedRecord(rec),
      suggestionAccepted: turn === "suggestion",
      interrupt: interruptionKey(rec),
      agentEdit: false,
      commit: false,
      subagentType: null,
      verification: null,
      // "HEAD" is what a detached checkout reports. It is not a branch, it cannot bind to a
      // carrier (B4.3), and emitting it as one would put a hint on the wire that can only ever
      // resolve to nothing.
      branch:
        typeof rec.gitBranch === "string" && rec.gitBranch && rec.gitBranch !== "HEAD"
          ? rec.gitBranch
          : null,
      cwd: typeof rec.cwd === "string" && rec.cwd ? rec.cwd : null,
      model:
        msg && typeof msg.model === "string" && msg.model !== "<synthetic>" ? msg.model : null,
      prLink: prLinkOf(rec),
      // hb-1.0 reads a typed prompt's text here, on the device, and keeps only what the rules say
      // about it (./habits.ts); the string itself goes no further than this line.
      prompt: turn === "typed" ? promptFacts(promptText(rec)) : null,
      touched: null,
      planMode: (rec as Record<string, unknown>).permissionMode === "plan",
      isTool: false,
      edit: null,
      cmd: null,
      testOrBuild: false,
      failed: false,
      refused: false,
      sha: null,
      explore: false,
      plans: false,
      security: false,
      review: false,
      mode:
        typeof (rec as Record<string, unknown>).permissionMode === "string"
          ? ((rec as Record<string, unknown>).permissionMode as string)
          : null,
      dir: null,
      clear: false,
      useId: null,
      results: [],
      check: false,
      reportsFailure: false,
    };
    if (rec.type === "user") {
      const text = leadingText(rec);
      // hb-2.2: newer Claude Code writes `<command-message>` before `<command-name>`; both
      // orders are a slash command, and the name is matched on its last `:` segment.
      if (text !== null && (text.startsWith("<command-name>") || text.startsWith("<command-message>"))) {
        const name = slashCommandOf(promptText(rec));
        if (name) {
          base.security = commandIsSecurity(name);
          base.review = commandIsReview(name) || base.security;
          base.clear = name === "clear";
        }
      }
      base.results = toolResultsOf(rec);
    }

    const content = msg && typeof msg === "object" ? msg.content : undefined;
    // A tool call and what it says about the environment. The INPUT is inspected here and only
    // here: a subagent type, a skill name and the category of a shell command are read on the
    // device, matched against closed vocabularies, and what travels is a name from those
    // vocabularies or a count. The command itself, its arguments and the subagent's prompt do
    // not leave — Zero Content Leakage is about what is emitted, not about what is looked at on
    // the machine that already holds the file.
    const tools: {
      name: string;
      subagentType: string | null;
          verification: VerificationCategory | null;
      agentEdit: boolean;
      commit: boolean;
      touched: string | null;
      hb: Pick<Moment, "isTool" | "edit" | "cmd" | "testOrBuild" | "check" | "explore" | "plans" | "security" | "review" | "dir" | "useId" | "sha">;
    }[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; name?: string; input?: unknown; id?: unknown };
        if (b.type !== "tool_use" || typeof b.name !== "string") continue;
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const str = (key: string): string | null =>
          typeof input[key] === "string" && input[key] ? (input[key] as string) : null;
        const isAgent = b.name === "Agent" || b.name === "Task";
        // hb-2.3: what an agent or a workflow was asked to do — its short description, a workflow's
        // name and the opening of its script (where its meta names it). Read here, matched against
        // the review words, dropped.
        const isWorkflow = b.name === "Workflow";
        const asked = isAgent || isWorkflow
          ? [str("description"), str("name"), isWorkflow ? (str("script") ?? "").slice(0, 600) : null].filter(Boolean).join(" ")
          : "";
        const askedReview = asked !== "" && HB2_RULES.reviewTask.test(asked);
        const askedSecurity = askedReview && HB2_RULES.securityTask.test(asked);
        const command = b.name === "Bash" ? str("command") : null;
        const kind = isAgent ? (str("subagent_type") ?? "") : "";
        const skill = b.name === "Skill" ? (str("skill") ?? str("name") ?? "").toLowerCase() : "";
        const facts = command ? commandFacts(command) : null;
        const bareVerification = command ? classifyVerification(stripProse(command)) : null;
        tools.push({
          name: b.name,
          subagentType: isAgent ? (str("subagent_type") ?? str("description")) : null,
          verification: command ? classifyVerification(command) : null,
          agentEdit: AGENT_EDIT_TOOLS.has(b.name),
          commit: command ? GIT_COMMIT.test(command) : false,
          touched: touchedFile(b.name, input),
          hb: {
            isTool: true,
            edit: editOf(b.name, input),
            cmd: facts,
            testOrBuild: bareVerification === "test" || bareVerification === "build",
            check:
              bareVerification === "test" ||
              bareVerification === "lint" ||
              (command !== null && /\b(?:tsc\b[^\n;&|]*--noEmit|pyright|mypy)\b/.test(stripProse(command))),
            explore:
              HB2_RULES.exploreTools.has(b.name) ||
              (facts?.lookup ?? false) ||
              (isAgent && HB2_RULES.exploreSubagent.test(kind)),
            plans: HB2_RULES.planTools.has(b.name),
            security: (isAgent && HB2_RULES.securitySubagent.test(kind)) || (!!skill && commandIsSecurity(skill)) || askedSecurity,
            review: (isAgent && HB2_RULES.reviewSubagent.test(kind)) || (!!skill && commandIsReview(skill)) || askedReview,
            dir: command ? (commandDir(command) ?? base.cwd) : null,
            useId: typeof (b as { id?: unknown }).id === "string" ? ((b as { id: string }).id) : null,
            sha: null,
          },
        });
      }
    }
    if (tools.length === 0) {
      out.push({ ...base, tool: null });
    } else {
      // The record's usage belongs to the record, not to each tool in it: a turn that called
      // three tools is one request, not three, and counting its tokens three times would inflate
      // exactly the way the cache-read sum did.
      tools.forEach((t, i) => {
        const withTool = {
          ...base,
          tool: t.name,
          subagentType: t.subagentType,
          verification: t.verification,
          agentEdit: t.agentEdit,
          commit: t.commit,
          touched: t.touched,
          ...t.hb,
          planMode: base.planMode || t.name === "ExitPlanMode" || t.name === "EnterPlanMode",
          // A record that carries a tool call is the agent's, not a typed prompt.
          prompt: null,
        };
        out.push(
          i === 0
            ? withTool
            : { ...withTool, iterations: 0, tokensIn: 0, tokensOut: 0, requestId: null },
        );
      });
    }
  }
  return out;
}

/** The model with the most records; a tie goes to the one seen last. Null when none was named. */
function predominant(models: Map<string, { n: number; last: number }>): string | null {
  let best: [string, { n: number; last: number }] | null = null;
  for (const entry of models) {
    if (!best || entry[1].n > best[1].n || (entry[1].n === best[1].n && entry[1].last > best[1].last)) best = entry;
  }
  return best ? best[0] : null;
}

/** Folds one stretch of moments into a session. */
function fold(
  moments: Moment[],
  idBase: string,
  index: number,
  total: number,
  sub: { files: string[]; workflows: number },
): Omit<ClaudeCodeSession, "transcript"> {
  const toolCalls: Record<string, number> = {};
  const mcp = new Set<string>();
  const requests = new Set<string>();
  let mcpToolCalls = 0;
  let skills = 0;
  let instructions = false;
  let humanPrompts = 0;
  let suggestionsAccepted = 0;
  const interrupts = new Set<string>();
  let followupsAfterInterrupt = 0;
  let afterInterrupt = false;
  let commits = 0;
  let commitsVerified = 0;
  // Whether a verification run has happened since the agent's last edit (or since the stretch
  // began, when it has made none). A commit reads it and leaves it as it is: a second commit with
  // no edit between is as verified as the first.
  let checkedSinceEdit = false;
  const verificationRuns: Record<VerificationCategory, number> = {
    test: 0,
    build: 0,
    lint: 0,
    review: 0,
  };
  let iterations = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let branch: string | null = null;
  let cwd: string | null = null;
  // The model that did most of the work: counted per record, the most frequent wins and a tie goes
  // to the later one. A session that switched models mid-way is still ONE session with one model
  // on the wire; the share it would take to describe the mix is not a field anybody reads.
  const models = new Map<string, { n: number; last: number }>();
  const pullRequests = new Map<string, { repository: string; number: number }>();
  let seen = 0;

  for (const m of moments) {
    if (m.requestId) requests.add(m.requestId);
    iterations += m.iterations;
    tokensIn += m.tokensIn;
    tokensOut += m.tokensOut;
    if (m.instructions) instructions = true;
    if (m.interrupt && !interrupts.has(m.interrupt)) {
      interrupts.add(m.interrupt);
      afterInterrupt = true;
    }
    if (m.humanPrompt) {
      humanPrompts += 1;
      if (afterInterrupt) followupsAfterInterrupt += 1;
      afterInterrupt = false;
    }
    if (m.suggestionAccepted) suggestionsAccepted += 1;
    // The order inside one record is the order the agent called its tools in, and the sort that
    // built `moments` is stable, so an edit, a test and a commit in one turn keep their order.
    if (m.agentEdit) checkedSinceEdit = false;
    const reviewer =
      m.tool !== null && m.subagentType !== null && REVIEWER_WORDS.some((w) => m.subagentType!.toLowerCase().includes(w));
    if (m.verification || reviewer) checkedSinceEdit = true;
    if (m.commit) {
      commits += 1;
      if (checkedSinceEdit) commitsVerified += 1;
    }
    if (m.verification) verificationRuns[m.verification] += 1;
    if (m.branch) branch = m.branch;
    if (m.cwd) cwd = m.cwd;
    if (m.model) models.set(m.model, { n: (models.get(m.model)?.n ?? 0) + 1, last: (seen += 1) });
    if (m.prLink) pullRequests.set(`${m.prLink.repository.toLowerCase()}#${m.prLink.number}`, m.prLink);
    if (m.tool) {
      toolCalls[m.tool] = (toolCalls[m.tool] ?? 0) + 1;
      if (m.tool.startsWith("mcp__")) {
        mcp.add(m.tool);
        mcpToolCalls += 1;
      }
      if (m.tool === "Skill") skills += 1;
      // A reviewing subagent IS a verification run before landing, and the only one that leaves
      // no shell command behind. PtL-1.0 counts it in its own category.
      if (m.subagentType && REVIEWER_WORDS.some((w) => m.subagentType!.toLowerCase().includes(w))) {
        verificationRuns.review += 1;
      }
    }
  }

  const first = moments[0]!;
  const last = moments[moments.length - 1]!;
  const lastAt = last.at;
  const habits = habitsOf(
    moments.map((m) => ({
      at: m.at,
      prompt: m.humanPrompt ? m.prompt : null,
      touched: m.touched,
      agentEdit: m.agentEdit,
      commit: m.commit,
      planMode: m.planMode,
      isTool: m.isTool,
      edit: m.edit,
      cmd: m.cmd,
      testOrBuild: m.testOrBuild,
      check: m.check,
      reportsFailure: m.reportsFailure,
      failed: m.failed,
      refused: m.refused,
      sha: m.sha,
      explore: m.explore,
      plans: m.plans,
      security: m.security,
      review: m.review,
      mode: m.mode,
      dir: m.dir,
      clear: m.clear,
    })),
    {
      container: cwd !== null && HB2_RULES.containerCwd.test(cwd),
      memoryAlive: memoryAlive(cwd, lastAt, instructions),
      commitClean,
    },
  );
  return {
    // Stable and unique: the transcript's id, plus which stretch of it this is. A transcript that
    // holds one session keeps its id unchanged, so nothing re-identifies when a person happens to
    // take a lunch break in the middle of one.
    sessionId: total === 1 ? idBase : `${idBase}-${index + 1}`,
    startedAt: first.iso,
    endedAt: last.iso,
    durationMs: Math.max(0, last.at - first.at),
    requests: requests.size,
    iterations,
    toolCalls,
    mcpTools: [...mcp].sort(),
    mcpToolCalls,
    reusableSkillCalls: skills,
    projectInstructionsLoaded: instructions,
    humanPrompts,
    suggestionsAccepted,
    interrupts: interrupts.size,
    followupsAfterInterrupt,
    commits,
    commitsVerified,
    transcriptId: TRANSCRIPT_ID.test(idBase) ? idBase.toLowerCase() : null,
    verificationRuns,
    tokensIn,
    tokensOut,
    // Subagents and workflows belong to the transcript, not to a stretch of it: which stretch an
    // agent ran in is not recoverable from the layout, and dividing the count between stretches
    // would invent a distribution.
    subagents: index === 0 ? sub.files.length : 0,
    workflows: index === 0 ? sub.workflows : 0,
    branch,
    cwd,
    model: predominant(models),
    pullRequests: [...pullRequests.values()],
    habits,
    agent: "claude_code",
  };
}

/** A transcript id in Claude Code's own shape: a lower-case-able uuid, any version. */
export const TRANSCRIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The first `sessionId` the transcript names, read until it is found and no further. */
function firstSessionId(path: string): string | null {
  let found: string | null = null;
  forEachLine(path, (line) => {
    if (!line.trim()) return;
    try {
      const rec = JSON.parse(line) as Rec;
      if (typeof rec?.sessionId === "string" && rec.sessionId) {
        found = rec.sessionId;
        return false;
      }
    } catch {
      // a broken line is skipped, as everywhere in this reader
    }
  });
  return found;
}

/** The sessions one transcript contains, split where the person stopped working. */
export function parseTranscript(
  path: string,
  gapHours: number = SESSION_IDLE_GAP_HOURS,
): ClaudeCodeSession[] {
  const own = momentsOf(path);
  if (own.length === 0) return []; // the session's own transcript is not optional
  const sub = subagentFiles(path);
  const moments = [...own, ...sub.files.flatMap(momentsOf)].sort((a, b) => a.at - b.at);

  const idBase = firstSessionId(path) ?? basename(path).replace(/\.jsonl$/i, "");
  const gapMs = gapHours * 3600_000;
  const segments: Moment[][] = [[]];
  for (const m of moments) {
    const current = segments[segments.length - 1]!;
    if (current.length > 0 && m.at - current[current.length - 1]!.at > gapMs) {
      segments.push([m]);
    } else {
      current.push(m);
    }
  }
  const kept = segments.filter((seg) => seg.length > 0);
  // `transcript` is local bookkeeping (the sync's ledger key) and is never emitted.
  return kept.map((seg, i) => ({ ...fold(seg, idBase, i, kept.length, sub), transcript: basename(path) }));
}

/** Parses one transcript. Returns its first session, or null when it holds none. */
export function parseSession(path: string): ClaudeCodeSession | null {
  return parseTranscript(path)[0] ?? null;
}

/** Every Claude Code session on this machine, oldest first. */
export function readClaudeCodeSessions(
  root: string,
  gapHours: number = SESSION_IDLE_GAP_HOURS,
): ClaudeCodeSession[] {
  const out: ClaudeCodeSession[] = [];
  for (const file of sessionFiles(root)) out.push(...parseTranscript(file, gapHours));
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
