/**
 * Codex's local session journals, read as sessions (schema 2.10).
 *
 * The shape was read off real rollout files on two machines (2026-10-20, field names and counts
 * only — nobody's text was looked at): `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, or
 * `.jsonl.zst` (zstd-compressed) on the other machine, one thread per file. Every line is
 * `{timestamp, ordinal, type, payload}`. What this reader uses, and nothing else:
 *
 *   session_meta              payload.id (the thread's uuid), payload.cwd
 *   turn_context              payload.cwd, payload.model, payload.approval_policy (a string, or an
 *                             object `{granular: {...}}`), payload.sandbox_policy.type,
 *                             payload.collaboration_mode.mode
 *   world_state               payload.state.agents_md — non-empty when the project's AGENTS.md
 *                             was loaded into the thread
 *   token_usage_record        payload.response_id, payload.usage.{input,cached_input,output}_tokens
 *   response_item             payload.type custom_tool_call / function_call: payload.name, for
 *                             the count per tool (the input is not read)
 *   event_msg/turn_aborted    the person stopped the agent mid-turn (counted once per turn)
 *   event_msg/item_completed  payload.item, by its type:
 *     UserMessage             content[].text — a turn the person typed; read by the habit rules in
 *                             memory and dropped (./habits.ts), like Claude Code's prompts
 *     CommandExecution        command (argv), parsed_cmd[].{type,path}, exit_code (an integer),
 *                             status, aggregated_output (its tail, for a runner's failure summary
 *                             and a commit's sha — read and dropped)
 *     FileChange              changes: a map from a file path to {type: add|delete|update,
 *                             content | unified_diff} — the path's kind and the lines changed
 *
 * A file is a thread, and a thread is not a session: the same idle gap as Claude Code splits it
 * (`SESSION_IDLE_GAP_HOURS`, the product's ONE definition of a session). Codex has no hook "the
 * session ended"; a stretch is read once it has been idle for the gap, like everywhere else.
 *
 * What leaves the device is the same `session.summary` the Claude Code reader produces — counts,
 * durations, tool names from a closed vocabulary, the model, habit counts — with `agent: codex`.
 * A practice Codex cannot express (`NOT_EXPRESSIBLE`, @mentat/schemas) is no occasion here: its
 * count is null, never a miss.
 *
 * Not read, on purpose: Codex cloud tasks (they are not on this machine), `~/.codex/history.jsonl`
 * (the prompt-history features are not sent for any agent while `DESCRIPTIVE_ON_WIRE` is off), and
 * `session_meta.git` / review-mode events — shapes not observed on a real file are not implemented.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as zlib from "node:zlib";

import { DEVICE_PRACTICES, expressible } from "@mentat/schemas";

import { SESSION_IDLE_GAP_HOURS } from "../measurement";
import { classifyVerification, TRANSCRIPT_ID, type ClaudeCodeSession, type VerificationCategory } from "./claude-code";
import { commitClean, memoryAlive } from "./device-git";
import {
  HB2_RULES,
  type CommandFacts,
  type HabitMoment,
  type Habits,
  type PathKind,
  commandDir,
  commandFacts,
  commitShaOf,
  habitsOf,
  isManifest,
  pathKind,
  promptFacts,
  stripProse,
} from "./habits";
import { forEachLine } from "./lines";

/** Which reader produced a Codex session (schema 2.10). Moves when what a field MEANS moves. */
export const CODEX_READER_VERSION = "codex-reader-1" as const;

/** The prefix of every Codex session's id on the wire and in the sync's ledger: a Codex thread id
 *  and a Claude Code transcript id are both uuids, and the namespace keeps them apart. */
export const CODEX_ID_PREFIX = "codex-";

/** A rollout file: `.jsonl`, or `.jsonl.zst` compressed. */
const ROLLOUT = /\.jsonl(?:\.zst)?$/i;

/** Where Codex keeps its journals: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const own = env.CODEX_HOME;
  return own && own.trim() ? own : join(home, ".codex");
}

/** Every rollout file under `<codexHome>/sessions`, sorted. None when Codex is not on this machine. */
export function codexSessionFiles(codexDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // no Codex here, or a directory we cannot read: the wedge is a guest
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
      } else if (ROLLOUT.test(name)) {
        out.push(full);
      }
    }
  };
  walk(join(codexDir, "sessions"), 4);
  return out.sort();
}

/**
 * The text of a `.jsonl.zst` file, or null when it cannot be decompressed here. Node's own zstd
 * (22.15 and later) first; else the `zstd` binary, without a shell. A machine with neither has a
 * file we could not read — counted by the caller, never a crash and never "no sessions".
 */
export function decompressZstd(file: string): string | null {
  const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
  try {
    const raw = readFileSync(file);
    if (typeof z.zstdDecompressSync === "function") return z.zstdDecompressSync(raw).toString("utf8");
  } catch {
    // fall through to the binary: a decoder that refuses the file is not the last word
  }
  try {
    const r = spawnSync("zstd", ["-dc", file], { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    if (r.status === 0 && r.stdout) return r.stdout.toString("utf8");
  } catch {
    // no binary
  }
  return null;
}

/** Calls `onLine` with every line of a rollout file. False when the file could not be read. */
export function forEachRolloutLine(file: string, onLine: (line: string) => void): boolean {
  if (/\.zst$/i.test(file)) {
    const text = decompressZstd(file);
    if (text === null) return false;
    let start = 0;
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
      onLine(text.slice(start, nl));
      start = nl + 1;
    }
    if (start < text.length) onLine(text.slice(start));
    return true;
  }
  return forEachLine(file, (line) => {
    onLine(line);
  });
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The permission mode of a turn, in the words the habit rules read (`bypassPermissions` or not).
 * Codex runs with no approval AND no sandbox only when asked to (`approval_policy: "never"` with
 * `sandbox_policy.type: "danger-full-access"` — the `--dangerously-bypass-approvals-and-sandbox`
 * mode): that is Claude Code's bypass. Any approval policy that can ask (a string other than
 * `never`, or a granular object), or any sandbox, keeps permissions on. Null when the turn states
 * neither — then a risky command in it is no occasion, as in Claude Code.
 */
export function codexMode(turn: Obj): string | null {
  const approval = turn.approval_policy;
  const sandbox = str(obj(turn.sandbox_policy)?.type);
  if (approval === undefined && sandbox === null) return null;
  const noApproval = approval === "never";
  return noApproval && sandbox === "danger-full-access" ? "bypassPermissions" : "default";
}

/** The shell text of a command item: `[shell, -lc, script]` is the script; anything else is its
 *  arguments joined. Classified on the device and dropped. */
export function commandText(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const argv = command.filter((x): x is string => typeof x === "string");
  if (argv.length >= 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv.slice(2).join(" ");
  return argv.join(" ");
}

const countLines = (s: unknown): number => (typeof s === "string" && s.length > 0 ? s.split("\n").length : 0);

/** The lines a change to one file changed: a whole new or deleted file is its length; an update is,
 *  hunk by hunk, the larger of the lines it removed and the lines it added. */
export function changedLines(change: Obj): number {
  const type = str(change.type);
  if (type === "add" || type === "delete") return countLines(change.content);
  const diff = typeof change.unified_diff === "string" ? change.unified_diff : typeof change.diff === "string" ? change.diff : "";
  let total = 0;
  let minus = 0;
  let plus = 0;
  const flush = () => {
    total += Math.max(minus, plus);
    minus = plus = 0;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) flush();
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) plus += 1;
    else if (line.startsWith("-")) minus += 1;
  }
  flush();
  return total;
}

const lower = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const base = (p: string) => {
  const parts = p.replace(/\\/g, "/").split("/");
  return (parts[parts.length - 1] ?? p).toLowerCase();
};

/** One record reduced to what a session is made of. */
type Moment = HabitMoment & {
  iso: string;
  tool: string | null;
  responseId: string | null;
  tokensIn: number;
  tokensOut: number;
  humanPrompt: boolean;
  instructions: boolean;
  interrupt: string | null;
  verification: VerificationCategory | null;
  model: string | null;
  cwd: string | null;
};

function blank(at: number, iso: string): Moment {
  return {
    at,
    iso,
    prompt: null,
    touched: null,
    agentEdit: false,
    commit: false,
    planMode: false,
    tool: null,
    responseId: null,
    tokensIn: 0,
    tokensOut: 0,
    humanPrompt: false,
    instructions: false,
    interrupt: null,
    verification: null,
    model: null,
    cwd: null,
  };
}

/** A commit the agent made by running git. */
const GIT_COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
/** The person, by the item's own type: a user message typed into the thread. */
function userText(item: Obj): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (obj(b) && typeof (b as Obj).text === "string" ? ((b as Obj).text as string) : ""))
    .filter(Boolean)
    .join("\n");
}

/** One rollout record, reduced to its moments. `state` carries the turn's cwd and mode onto the
 *  items that follow it. Exported for the test that watches which keys are read. */
export function codexRecordMoments(rec: unknown, state: { cwd: string | null; mode: string | null; plan: boolean }): Moment[] {
  const r = obj(rec);
  if (!r) return [];
  const iso = str(r.timestamp) ?? "";
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return [];
  const payload = obj(r.payload) ?? {};
  const m = blank(at, iso);
  m.cwd = state.cwd;
  switch (r.type) {
    case "session_meta": {
      const cwd = str(payload.cwd);
      if (cwd) state.cwd = m.cwd = cwd;
      return [m];
    }
    case "turn_context": {
      const cwd = str(payload.cwd);
      if (cwd) state.cwd = m.cwd = cwd;
      m.model = str(payload.model);
      state.mode = codexMode(payload);
      m.mode = state.mode;
      // A plan mode, when Codex's collaboration mode names one. Only `default` was observed on a
      // real journal; the typed request for a plan (`asksPlan`) counts either way.
      state.plan = str(obj(payload.collaboration_mode)?.mode) === "plan";
      m.planMode = state.plan;
      return [m];
    }
    case "world_state": {
      const agents = obj(obj(payload.state)?.agents_md);
      m.instructions = !!agents && Object.keys(agents).length > 0;
      return [m];
    }
    case "token_usage_record": {
      const usage = obj(payload.usage) ?? {};
      m.responseId = str(payload.response_id);
      // OpenAI's input count includes the cached part; what was newly paid for is the rest — the
      // same rule as Claude Code's (cache reads are re-reading the same context).
      m.tokensIn = Math.max(0, num(usage.input_tokens) - num(usage.cached_input_tokens));
      m.tokensOut = num(usage.output_tokens);
      return [m];
    }
    case "response_item": {
      const t = str(payload.type);
      if (t === "custom_tool_call" || t === "function_call") m.tool = str(payload.name);
      return [m];
    }
    case "event_msg":
      break;
    default:
      return [m];
  }
  const kind = str(payload.type);
  if (kind === "turn_aborted") {
    m.interrupt = str(payload.turn_id) ?? `at:${iso}`;
    return [m];
  }
  if (kind !== "item_completed") return [m];
  const item = obj(payload.item) ?? {};
  const itemType = str(item.type);
  if (itemType === "UserMessage") {
    const text = userText(item);
    if (text.trim()) {
      m.humanPrompt = true;
      // Read here, on the device, and kept only as what the rules say about it.
      m.prompt = promptFacts(text);
    }
    return [m];
  }
  if (itemType === "CommandExecution") {
    const command = commandText(item.command);
    const exit = typeof item.exit_code === "number" ? item.exit_code : null;
    const status = str(item.status);
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
    const facts: CommandFacts = commandFacts(command);
    const bare = classifyVerification(stripProse(command));
    const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map(obj).filter((p): p is Obj => !!p) : [];
    const lookup = parsed.length > 0 && parsed.every((p) => ["read", "list_files", "search"].includes(str(p.type) ?? ""));
    const read = parsed.find((p) => str(p.type) === "read" && str(p.path));
    m.isTool = true;
    m.cmd = facts;
    m.verification = classifyVerification(command);
    m.testOrBuild = bare === "test" || bare === "build";
    m.check = bare === "test" || bare === "lint" || /\b(?:tsc\b[^\n;&|]*--noEmit|pyright|mypy)\b/.test(stripProse(command));
    m.explore = lookup || facts.lookup;
    m.commit = GIT_COMMIT.test(command);
    m.refused = status === "declined";
    m.failed = exit !== null ? exit !== 0 : status === "failed";
    m.reportsFailure = !!m.check && HB2_RULES.failureReport.test(output.slice(-4000));
    m.sha = m.commit && !m.failed ? commitShaOf(output) : null;
    m.dir = commandDir(command) ?? state.cwd;
    m.mode = state.mode;
    m.planMode = state.plan;
    m.touched = read ? base(str(read.path)!) : null;
    return [m];
  }
  if (itemType === "FileChange") {
    const changes = obj(item.changes) ?? {};
    const status = str(item.status);
    const out: Moment[] = [];
    for (const [path, raw] of Object.entries(changes)) {
      const change = obj(raw) ?? {};
      const edit: { file: string; kind: PathKind; manifest: boolean; lines: number } = {
        file: lower(path),
        kind: pathKind(path),
        manifest: isManifest(path),
        lines: changedLines(change),
      };
      out.push({
        ...m,
        isTool: true,
        edit,
        agentEdit: true,
        touched: base(path),
        refused: status === "declined",
        failed: status === "failed",
        mode: state.mode,
        planMode: state.plan,
      });
    }
    return out.length ? out : [m];
  }
  return [m];
}

/** The rollout's moments in file order, and its thread id. Null when the file could not be read. */
function momentsOf(file: string): { moments: Moment[]; threadId: string | null } | null {
  const moments: Moment[] = [];
  let threadId: string | null = null;
  const state = { cwd: null as string | null, mode: null as string | null, plan: false };
  const ok = forEachRolloutLine(file, (line) => {
    if (!line.trim()) return;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return; // a partial last line is normal in a journal still being written
    }
    const r = obj(rec);
    if (r?.type === "session_meta" && threadId === null) threadId = str(obj(r.payload)?.id);
    moments.push(...codexRecordMoments(rec, state));
  });
  return ok ? { moments, threadId } : null;
}

/** The predominant model: most turns, a tie to the later one. */
function predominant(models: Map<string, { n: number; last: number }>): string | null {
  let best: [string, { n: number; last: number }] | null = null;
  for (const e of models) if (!best || e[1].n > best[1].n || (e[1].n === best[1].n && e[1].last > best[1].last)) best = e;
  return best ? best[0] : null;
}

/** The practices Codex cannot express are no occasion (decision 2): null, whatever the rules saw. */
export function applyPracticeTable(habits: Habits): Habits {
  const out = { ...habits } as Record<string, unknown>;
  for (const key of DEVICE_PRACTICES) if (!expressible("codex", key)) out[key] = null;
  return out as Habits;
}

function fold(moments: Moment[], idBase: string, index: number, total: number, transcript: string): ClaudeCodeSession {
  const toolCalls: Record<string, number> = {};
  const mcp = new Set<string>();
  const responses = new Set<string>();
  const interrupts = new Set<string>();
  const models = new Map<string, { n: number; last: number }>();
  const verificationRuns: Record<VerificationCategory, number> = { test: 0, build: 0, lint: 0, review: 0 };
  let mcpToolCalls = 0;
  let humanPrompts = 0;
  let followups = 0;
  let afterInterrupt = false;
  let instructions = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let commits = 0;
  let commitsVerified = 0;
  let checkedSinceEdit = false;
  let cwd: string | null = null;
  let seen = 0;
  for (const m of moments) {
    if (m.responseId) responses.add(m.responseId);
    tokensIn += m.tokensIn;
    tokensOut += m.tokensOut;
    if (m.instructions) instructions = true;
    if (m.cwd) cwd = m.cwd;
    if (m.model) models.set(m.model, { n: (models.get(m.model)?.n ?? 0) + 1, last: (seen += 1) });
    if (m.interrupt && !interrupts.has(m.interrupt)) {
      interrupts.add(m.interrupt);
      afterInterrupt = true;
    }
    if (m.humanPrompt) {
      humanPrompts += 1;
      if (afterInterrupt) followups += 1;
      afterInterrupt = false;
    }
    if (m.tool) {
      toolCalls[m.tool] = (toolCalls[m.tool] ?? 0) + 1;
      if (m.tool.startsWith("mcp__")) {
        mcp.add(m.tool);
        mcpToolCalls += 1;
      }
    }
    if (m.agentEdit) checkedSinceEdit = false;
    if (m.verification) {
      verificationRuns[m.verification] += 1;
      checkedSinceEdit = true;
    }
    if (m.commit && !m.refused) {
      commits += 1;
      if (checkedSinceEdit) commitsVerified += 1;
    }
  }
  const first = moments[0]!;
  const last = moments[moments.length - 1]!;
  const habits = applyPracticeTable(
    habitsOf(moments, {
      container: cwd !== null && HB2_RULES.containerCwd.test(cwd),
      memoryAlive: memoryAlive(cwd, last.at, instructions),
      commitClean,
    }),
  );
  return {
    sessionId: total === 1 ? idBase : `${idBase}-${index + 1}`,
    startedAt: first.iso,
    endedAt: last.iso,
    durationMs: Math.max(0, last.at - first.at),
    requests: responses.size,
    // Codex writes no count of sampler iterations; 0 is "not observed", and nothing reads it.
    iterations: 0,
    toolCalls,
    mcpTools: [...mcp].sort(),
    mcpToolCalls,
    reusableSkillCalls: 0,
    projectInstructionsLoaded: instructions,
    humanPrompts,
    suggestionsAccepted: 0,
    interrupts: interrupts.size,
    followupsAfterInterrupt: followups,
    commits,
    commitsVerified,
    transcriptId: null,
    verificationRuns,
    tokensIn,
    tokensOut,
    subagents: 0,
    workflows: 0,
    branch: null,
    cwd,
    model: predominant(models),
    pullRequests: [],
    transcript,
    habits,
    agent: "codex",
  };
}

/** The ledger key of a rollout: namespaced, so it never meets a Claude Code transcript's name. */
export function codexTranscriptKey(file: string): string {
  return `codex/${basename(file)}`;
}

/** The sessions one rollout holds, split where the person stopped working. Null when the file
 *  could not be read (a `.zst` with no decoder on this machine). */
export function parseRollout(file: string, gapHours: number = SESSION_IDLE_GAP_HOURS): ClaudeCodeSession[] | null {
  const read = momentsOf(file);
  if (read === null) return null;
  const { moments, threadId } = read;
  if (moments.length === 0) return [];
  const uuid = threadId && TRANSCRIPT_ID.test(threadId) ? threadId.toLowerCase() : null;
  const idBase = `${CODEX_ID_PREFIX}${uuid ?? basename(file).replace(ROLLOUT, "")}`;
  const gapMs = gapHours * 3600_000;
  const segments: Moment[][] = [[]];
  for (const m of moments) {
    const current = segments[segments.length - 1]!;
    if (current.length > 0 && m.at - current[current.length - 1]!.at > gapMs) segments.push([m]);
    else current.push(m);
  }
  const kept = segments.filter((s) => s.length > 0);
  return kept.map((seg, i) => ({ ...fold(seg, idBase, i, kept.length, codexTranscriptKey(file)), transcriptId: uuid }));
}

export type CodexRead = {
  sessions: ClaudeCodeSession[];
  /** Rollout files found, and those that could not be read (a compressed file with no decoder). */
  files: number;
  unreadable: number;
};

/** Every Codex session on this machine, oldest first, with what could not be read. */
export function readCodexSessions(codexDir: string, gapHours: number = SESSION_IDLE_GAP_HOURS): CodexRead {
  const files = codexSessionFiles(codexDir);
  const sessions: ClaudeCodeSession[] = [];
  let unreadable = 0;
  for (const f of files) {
    const s = parseRollout(f, gapHours);
    if (s === null) unreadable += 1;
    else sessions.push(...s);
  }
  return { sessions: sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt)), files: files.length, unreadable };
}
