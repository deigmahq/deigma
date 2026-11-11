// What `npx deigma init` and `deigma history` print, as pure functions (copy v4, the CLI table).
//
// They live apart from main.ts so the words are tested: main.ts is the process, and a sentence
// that only exists inside a top-level `await` is a sentence nobody checks. The vocabulary is the
// one every surface shares — "your Deigma", "pieces of work", "a confirmed result" — and none of
// the inside of the program ("passport", "wedge", "carrier", "landing") reaches a person here.

import { AGENT_NAMES, agentsPhrase, type Agent } from "@mentat/schemas";

/** Where a person sees what was read. The API's address is not it: deigma.net is the site and
 *  api.deigma.net the service, and the stand overrides both. */
export function webBaseUrlFor(apiBaseUrl: string, override?: string): string {
  if (override) return override.replace(/\/$/, "");
  try {
    const url = new URL(apiBaseUrl);
    if (url.hostname.startsWith("api.")) {
      url.hostname = url.hostname.slice(4);
      return url.origin;
    }
    return url.origin;
  } catch {
    return "https://deigma.net";
  }
}

/** Said BEFORE the history is read: what will be read and what never leaves. Consent is the act
 *  of running `init`, so the sentence comes first and `--no-history` skips the pass. Schema 2.10:
 *  it names the agents whose journals are on this machine — no "Codex" for somebody who never
 *  used it, and no agent at all on a machine with neither. */
export function historyConsentLine(agents: readonly Agent[]): string {
  const who = agentsPhrase(agents);
  const what = who ? `your ${who} sessions` : "your agent sessions";
  const history = agents.length === 0 || agents.includes("claude_code") ? " and prompt history" : "";
  return `Reading ${what}${history} on this machine: counts, timings and tool names only — no prompts, no code, no file paths.`;
}
export const HISTORY_CONSENT_LINE = historyConsentLine(["claude_code"]);

export const HISTORY_SKIPPED_LINE = "Skipping your agent history on this machine (--no-history).";

export const SERVICE_UNREACHABLE_LINE =
  "Could not reach Deigma; your history will be read next time you run `npx deigma history`.";

export type HistoryOutcome =
  | { kind: "skipped" }
  | { kind: "unreachable" }
  | { kind: "nothing"; reason: "no_consent" | "nothing_found" | undefined }
  | {
      kind: "read";
      sessions: number;
      outside: number;
      sent: boolean;
      older?: number;
      olderSent?: number;
      /** Schema 2.10: of `sessions`, how many each agent's journal gave. Absent: all Claude Code. */
      byAgent?: Partial<Record<Agent, number>>;
      /** Codex journal files this machine could not read (a compressed file with no decoder). */
      unreadable?: number;
    };

/** "Read 42 Claude Code sessions.", "Read 3 Codex sessions.", "Read 45 sessions: 42 in Claude Code,
 *  3 in Codex." — the agents a person has, with counts, and nothing about one they do not. */
export function sessionsReadText(sessions: number, byAgent?: Partial<Record<Agent, number>>): string {
  const plural = (n: number) => (n === 1 ? "session" : "sessions");
  const present = (Object.keys(AGENT_NAMES) as Agent[]).filter((a) => (byAgent?.[a] ?? 0) > 0);
  if (present.length <= 1) {
    const only = present[0] ?? "claude_code";
    return `Read ${sessions} ${AGENT_NAMES[only]} ${plural(sessions)}.`;
  }
  return `Read ${sessions} ${plural(sessions)}: ${present.map((a) => `${byAgent![a]} in ${AGENT_NAMES[a]}`).join(", ")}.`;
}

/**
 * The lines after a connection (copy v4):
 *
 *   Connected as @{h}. Read {n} Claude Code sessions. New sessions count when run through
 *   `deigma proxy -- <your MCP server>`.
 *   {k} were in repositories Deigma doesn't read.
 *   See it: https://deigma.net/dashboard · Your week: npx deigma pulse
 *
 * The count is of what was READ, said only once it was; a pass that was skipped or found nothing
 * says that instead of "Read 0", which would be a zero standing in for "did not look".
 */
/** What `init` says about the hook (./claude-hook), one line, or nothing when it was declined. */
export const HOOK_ADDED_LINE =
  "New Claude Code sessions are read when they end, and twice a day while one stays open: added a SessionEnd and a Stop hook to ~/.claude/settings.json (`npx deigma init --no-hook` skips them, `npx deigma logout` removes them).";
export const HOOK_PRESENT_LINE =
  "New Claude Code sessions are read when they end, and twice a day while one stays open (the hooks are in place).";
/** What `status` says when it adds the Stop entry to a machine set up before it existed (0.4.1). */
export const STOP_HOOK_ADDED_LINE =
  "Added: an open Claude Code session is now read twice a day — one Stop hook in ~/.claude/settings.json (`npx deigma logout` removes it).";
/** What `status` says when it rewrites entries of ours that an older version wrote, or wrote for
 *  another shell (a Windows machine set up by 0.5, whose lines needed `sh`). */
export const HOOKS_UPDATED_LINE =
  "Updated: the Deigma entries in ~/.claude/settings.json and ~/.codex/config.toml now match this version (`npx deigma logout` removes them).";
/** The proxy could not start the MCP server it was given. Said on stderr: stdout is the client's. */
export function proxyStartFailedLine(command: string, message: string): string {
  return `deigma: could not start \`${command}\`: ${message}`;
}
/** Decision 4: what `init` says about Codex's `notify` (./codex-notify), one line. */
export const NOTIFY_ADDED_LINE =
  "New Codex sessions are read as you work: added one notify entry to ~/.codex/config.toml, at most one read an hour (`npx deigma init --no-hook` skips it, `npx deigma logout` removes it).";
export const NOTIFY_PRESENT_LINE = "New Codex sessions are read as you work (the notify entry is in place).";
export const NOTIFY_TAKEN_LINE =
  "Codex already runs its own notify program, so it was left as it is; new Codex sessions are read on `npx deigma sync`, `status` or `pulse`.";

export function connectedLines(input: {
  handle: string | null;
  history: HistoryOutcome;
  webBaseUrl: string;
  /** Whether the SessionEnd hook reads new sessions; without it, only the proxy does. */
  hook?: "added" | "present" | "none";
  /** Codex's notify entry (decision 4); absent or "none" where Codex is not on this machine. */
  notify?: "added" | "present" | "taken" | "none";
}): string[] {
  const who = input.handle ? ` as @${input.handle}` : "";
  const hook = input.hook ?? "none";
  const proxy =
    hook === "none" ? "New sessions count when run through `npx deigma proxy -- <your MCP server>`, or after `npx deigma sync`." : "";
  const lines: string[] = [];
  const h = input.history;
  if (h.kind === "read") {
    lines.push(`Connected${who}. ${sessionsReadText(h.sessions, h.byAgent)}${proxy ? ` ${proxy}` : ""}`);
    lines.push(...historyDetailLines(h));
  } else {
    lines.push(`Connected${who}.${proxy ? ` ${proxy}` : ""}`);
    if (h.kind === "skipped") lines.push(HISTORY_SKIPPED_LINE);
    if (h.kind === "nothing") lines.push(nothingReadLine(h.reason));
    if (h.kind === "unreachable") lines.push(SERVICE_UNREACHABLE_LINE);
  }
  if (hook === "added") lines.push(HOOK_ADDED_LINE);
  if (hook === "present") lines.push(HOOK_PRESENT_LINE);
  if (input.notify === "added") lines.push(NOTIFY_ADDED_LINE);
  if (input.notify === "present") lines.push(NOTIFY_PRESENT_LINE);
  if (input.notify === "taken") lines.push(NOTIFY_TAKEN_LINE);
  lines.push(`See it: ${input.webBaseUrl}/dashboard · Your week: npx deigma pulse`);
  return lines;
}

/** `deigma history` on its own: the same facts without the connection line. */
export function historyLines(h: HistoryOutcome): string[] {
  if (h.kind === "skipped") return [HISTORY_SKIPPED_LINE];
  if (h.kind === "unreachable") return [SERVICE_UNREACHABLE_LINE];
  if (h.kind === "nothing") return [nothingReadLine(h.reason)];
  return [sessionsReadText(h.sessions, h.byAgent), ...historyDetailLines(h)];
}

function historyDetailLines(h: Extract<HistoryOutcome, { kind: "read" }>): string[] {
  const lines: string[] = [];
  if (h.outside > 0) {
    lines.push(`${h.outside} ${h.outside === 1 ? "was" : "were"} in repositories Deigma doesn't read.`);
  }
  // Schema 2.5: sessions whose transcripts Claude Code already deleted, known from the prompt
  // history alone. Stated as a fact, apart from the sessions above — they count toward no claim,
  // and what of them stays on this machine is said, not implied (local-backfill
  // `DESCRIPTIVE_ON_WIRE`: none is sent until the server reads them).
  if (h.older && h.older > 0) {
    const kept = h.older - (h.olderSent ?? 0);
    lines.push(
      `${h.older} older session${h.older === 1 ? " is" : "s are"} known only from your prompt history` +
        (kept === h.older
          ? `; ${h.older === 1 ? "it stays" : "they stay"} on this machine.`
          : kept > 0
            ? `; ${kept} of them ${kept === 1 ? "stays" : "stay"} on this machine.`
            : "."),
    );
  }
  if (h.unreadable && h.unreadable > 0) {
    lines.push(
      `${h.unreadable} compressed Codex ${h.unreadable === 1 ? "file" : "files"} could not be read here: ` +
        "this Node.js has no zstd, and the zstd program was not found.",
    );
  }
  if (!h.sent) lines.push("They couldn't be sent yet; they go with the next pass.");
  return lines;
}

function nothingReadLine(reason: "no_consent" | "nothing_found" | undefined): string {
  return reason === "no_consent"
    ? "Your agent history on this machine was not read."
    : "No Claude Code or Codex history found on this machine yet.";
}

// ---- signed in or not -------------------------------------------------------------------------
//
// Nothing is read, kept or sent before the person signs in: the same rule as the editor. Every
// command that needs an account says how to get one and stops; the proxy says it on stderr (stdout
// is the MCP channel) and passes the tool's traffic through untouched.

/** Any command run while signed out. */
export const SIGNED_OUT_LINE =
  "Not signed in. Run `npx deigma init` to sign in from your terminal; your sessions go to your Deigma.";

/** The server no longer knows the session this machine kept (signed out elsewhere, or the
 *  account was deleted). The local copy is removed with it. */
export const SESSION_ENDED_LINE =
  "Your sign-in on this machine has ended. Run `npx deigma init` to sign in again.";

/** The proxy, signed out: one line on stderr, the tool runs as if Deigma were not there. */
export const PROXY_SIGNED_OUT_LINE =
  "Deigma: not signed in, so this session is not recorded. Run `npx deigma init` to sign in.";

/** The proxy, its sign-in ended mid-way or at start. */
export const PROXY_SESSION_ENDED_LINE =
  "Deigma: your sign-in on this machine has ended, so this session is not recorded. Run `npx deigma init` to sign in again.";

export const SIGNED_OUT_DONE_LINE =
  "Signed out. Nothing more is read or sent from this machine until you run `npx deigma init`.";

export const ALREADY_SIGNED_OUT_LINE = "Not signed in on this machine.";

export const USAGE_LINE = "usage: deigma <init|status|pulse|history|proxy|sync|whoami|logout> [--no-history] [--no-hook]";

/** The line `deigma status` adds about this machine (review of the CLI, 2026-10-18): when sessions
 *  were last read, whether the hook reads new ones, and how many are still open. Facts, no orders. */
export function deviceReadLine(input: {
  lastRunAt: string | null;
  now: number;
  hook: boolean | null;
  /** The Stop entry beside it (./claude-hook): an open session is read twice a day. */
  stopHook?: boolean | null;
  open: number;
  /** Codex's notify (decision 4): ours, another program's, free, or null — not on this machine. */
  codexNotify?: true | false | "taken" | null;
}): string {
  const parts: string[] = [];
  if (input.lastRunAt) {
    const hours = Math.max(0, Math.round((input.now - Date.parse(input.lastRunAt)) / 3_600_000));
    parts.push(`sessions last read ${hours === 0 ? "within the hour" : `${hours} h ago`}`);
  } else {
    parts.push("no session read from this machine yet");
  }
  if (input.hook === true && input.stopHook === true) {
    parts.push("new ones are read when a Claude Code session ends, and twice a day while one stays open");
  } else if (input.hook === true) parts.push("new ones are read when a Claude Code session ends");
  else if (input.hook === false) parts.push("new ones are read on `npx deigma sync`, `status` or `pulse`");
  if (input.codexNotify === true) parts.push("new Codex sessions are read as you work, at most hourly");
  else if (input.codexNotify === "taken" || input.codexNotify === false) {
    parts.push("new Codex sessions are read on `npx deigma sync`, `status` or `pulse`");
  }
  if (input.open > 0) parts.push(`${input.open} still open — a session counts after 4 h idle`);
  return `This machine: ${parts.join(" · ")}`;
}

/** `deigma help`: every command in one line each, and where the rest is written down. */
export const HELP_LINES: readonly string[] = [
  "deigma — your practice index from how you work with Claude Code and Codex, and your GitHub work.",
  "",
  "  init              sign in, read your Claude Code and Codex history once, and add a",
  "                    SessionEnd and a Stop hook (and a Codex notify entry where notify is free)",
  "                    so new sessions are read when they end, and twice a day while one is open",
  "    --no-history    sign in without reading anything already on this machine",
  "    --no-hook       sign in without adding the hooks or the Codex notify entry",
  "  status            your Deigma now: the practice index, what was read, when it was last read",
  "  pulse             this week: the index, how it moved, your next step",
  "  sync              read the sessions that ended since the last read (the hooks do this)",
  "  history           read your history again, after connecting more repositories",
  "  proxy -- <cmd>    run an MCP server through Deigma; your tool never waits on us",
  "  whoami            which account this machine is signed in as",
  "  logout            sign this machine out and remove the hooks and the notify entry; nothing",
  "                    more is read or sent",
  "",
  "What leaves this machine: counts, timings and tool names — never your prompts, code or file paths.",
  "A session counts once it has been idle for 4 hours; your number is recomputed within seconds.",
  "More: https://www.npmjs.com/package/deigma · https://deigma.net/guide",
];

/** `deigma whoami` and the line under the usage. */
export function signedInLine(handle: string | null, apiBaseUrl: string): string {
  const who = handle ? ` as @${handle}` : "";
  return `Signed in${who} (${apiBaseUrl}). Your sessions go to your Deigma.`;
}

/** Sessions that could not be sent when they ended and went with a later pass. */
export function queuedSentLine(n: number): string {
  return `Sent ${n} earlier session${n === 1 ? "" : "s"} that could not be sent when ${n === 1 ? "it" : "they"} ended.`;
}
