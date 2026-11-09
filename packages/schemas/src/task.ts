// The agent task — the shapes between the terminal and the API: what `npx deigma task submit` reads
// from the server and what it sends.
//
// A company gives a role one task. The candidate makes their own PUBLIC copy of the task's template
// repository on GitHub, works in it with any agent, opens a pull request there and submits with
// `npx deigma task submit`. The server reads the pull request through GitHub's public API at the
// commit that was submitted (no code is run). A session, if the candidate attached one, is sealed
// under their own key and read only by that company. The candidate sees the outcome after the
// company releases it, or 14 days after submitting.
//
// Declarative on purpose: strict objects, limits as exported constants the terminal reads, no
// `.transform()`. These are answers between our own terminal and our own API; none of it is part of
// the JSON Schema export. A field that does not appear here is not on the wire.
//
// WHAT IS NOT HERE: the outcome of an attempt. The terminal never reads it: on `CandidateTask` it is
// `results`, a value this package leaves untyped; the service pins its shape on its own side, and
// pins the closed lists of tasks and languages there too (the terminal reads a task's key and
// language as names).
//
// THE NORMALIZED SESSION. The terminal reads the Claude Code and Codex journals of the task folder
// on the candidate's machine and sends events in the order they happened:
//
//   prompt       what the person typed.
//   reply        what the agent said, as text.
//   tool_call    `tool` is the tool's own name (Claude Code: Bash, Edit, Write, MultiEdit,
//                NotebookEdit, Read, Grep, Glob, ExitPlanMode, …; Codex: exec, shell, apply_patch,
//                update_plan, …). `text` is, for a shell tool, the command line as it was run; for a
//                tool that writes a file, the path on the FIRST line and then what the call wrote
//                (the new text, or the patch); for any other tool, its arguments, briefly.
//   tool_result  `tool` is the name of the tool it answers; `text` is what the tool printed — the
//                tail of it when it is long. A command that did not exit 0 starts its text with
//                `exit code <n>`.
//
// A session in another shape is stored and shown as it is. Text is capped per event
// (`TASK_LIMITS.eventText`) and a session upload as a whole (`TASK_LIMITS.sessionBytes`); before
// anything leaves, the terminal replaces every string the server lists in `CandidateTask.redact`
// with the placeholder the server gives, and runs the secret scanner on every text.

import { z } from "zod";

import { nonNegativeInt, rfc3339, uuid } from "./common";
import { CompanyName, RoleTitle } from "./vocabulary";

// --- limits -----------------------------------------------------------------------------------------

/** What the task promises and the server enforces; the page and the terminal read them from here. */
export const TASK_LIMITS = {
  /** A session upload, as the JSON text of its `sessions`, in bytes, before it is sealed. */
  sessionBytes: 10 * 1024 * 1024,
  /** The request body that route accepts: the session plus the few bytes around it. */
  sessionBodyBytes: 10 * 1024 * 1024 + 64 * 1024,
  /** The longest text of one event, in characters; the terminal cuts, the server refuses a longer one. */
  eventText: 8_000,
  /** The most events one session may hold, and the most sessions one upload may hold. */
  eventsPerSession: 50_000,
  sessions: 20,
  /** The longest tool name. */
  toolName: 64,
  /** After submitting, a session may still be attached for this many minutes. */
  lateSessionMinutes: 10,
  /** The candidate sees the results at the latest this many days after submitting. */
  releaseDays: 14,
  /** A company can open a submitted task's results and session for this many days after the candidate
   *  submitted it, or for as long as the grant itself lives, whichever is longer. */
  companyAccessDays: 30,
  /** A task taken without sharing the card is open to the company for this many days. */
  grantDays: 30,
  /** A pull request number is a whole number from 1 to this. */
  pullNumberMax: 10_000_000,
  /** The longest a sentence printed on a screen is: the product's copy bound for a line. */
  line: 140,
} as const;

// --- vocabulary -------------------------------------------------------------------------------------

/** Where an attempt is: taken, submitted (the check is queued or running), checked. */
export const TASK_STATES = ["started", "submitted", "checked"] as const;
export const TaskState = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskState>;

/** Whether a session was attached. "Not available" is a stored state, never an absence and never a zero. */
export const TASK_SESSION_STATES = ["attached", "not_available"] as const;
export const TaskSessionState = z.enum(TASK_SESSION_STATES);
export type TaskSessionState = z.infer<typeof TaskSessionState>;

// --- names ------------------------------------------------------------------------------------------

/** `owner/name` of a repository on GitHub: a login (1-39 letters, digits and single hyphens, not
 *  starting or ending with one), a slash, and a repository name (1-100 of letters, digits, dots,
 *  hyphens and underscores; never `.` or `..`) — the same two patterns the page reads an address
 *  with. One regular expression, so the shape stays declarative. */
export const TASK_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
export const TaskRepoName = z.string().regex(TASK_REPO_PATTERN);
export type TaskRepoName = z.infer<typeof TaskRepoName>;

/** The address of a repository on GitHub. */
export const taskRepoUrl = (repo: string): string => `https://github.com/${repo}`;
/** The address of a pull request on GitHub. */
export const taskPullUrl = (repo: string, number: number): string => `https://github.com/${repo}/pull/${number}`;

/** A pull request's number. */
export const TaskPullNumber = z.number().int().min(1).max(TASK_LIMITS.pullNumberMax);
export type TaskPullNumber = z.infer<typeof TaskPullNumber>;

const Line = z.string().min(1).max(TASK_LIMITS.line);

/** A task's key and the language of its template, as names: the terminal reads whichever task the
 *  server names, and does not know the list of them. */
export const TASK_NAME_PATTERN = /^[a-z][a-z0-9]*$/;
export const TaskKeyName = z.string().max(40).regex(TASK_NAME_PATTERN);
export type TaskKeyName = z.infer<typeof TaskKeyName>;
export const TaskLanguageName = z.string().max(40).regex(TASK_NAME_PATTERN);
export type TaskLanguageName = z.infer<typeof TaskLanguageName>;

// --- the normalized session --------------------------------------------------------------------

export const TASK_EVENT_KINDS = ["prompt", "reply", "tool_call", "tool_result"] as const;
export const TaskEventKind = z.enum(TASK_EVENT_KINDS);
export type TaskEventKind = z.infer<typeof TaskEventKind>;

/** One thing that happened in the session, in the order it happened. The page prints no clock time. */
export const TaskSessionEvent = z.strictObject({
  at: rfc3339,
  kind: TaskEventKind,
  tool: z.string().min(1).max(TASK_LIMITS.toolName).optional(),
  text: z.string().max(TASK_LIMITS.eventText),
});
export type TaskSessionEvent = z.infer<typeof TaskSessionEvent>;

export const TASK_AGENTS = ["claude_code", "codex"] as const;
export const TaskAgent = z.enum(TASK_AGENTS);
export type TaskAgent = z.infer<typeof TaskAgent>;

/** One session of one agent whose working directory is the task folder. */
export const TaskSession = z.strictObject({
  agent: TaskAgent.optional(),
  events: z.array(TaskSessionEvent).min(1).max(TASK_LIMITS.eventsPerSession),
});
export type TaskSession = z.infer<typeof TaskSession>;

/**
 * `POST /v1/me/tasks/:grant_id/session` — the terminal (or the page) says what it attaches.
 *
 *   * `attached` — the sessions of the task folder, normalized. `consent: true` is the person's
 *     answer to the terminal's "N sessions · M events · K MB will be shared with <company>: your
 *     prompts, the agent's replies and tool calls in this folder. Share? y/N": it is sent only after
 *     a yes, and the route refuses a body without it.
 *   * `not_available` — there is no session to attach (another agent, no journal in the folder).
 *
 * Only before the task is submitted, or within `TASK_LIMITS.lateSessionMinutes` after.
 */
export const TaskSessionUpload = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("attached"),
    consent: z.literal(true),
    sessions: z.array(TaskSession).min(1).max(TASK_LIMITS.sessions),
  }),
  z.strictObject({ state: z.literal("not_available") }),
]);
export type TaskSessionUpload = z.infer<typeof TaskSessionUpload>;

/** The answer: what the server holds now. For `not_available` the three counts are 0. */
export const TaskSessionReceipt = z.strictObject({
  state: TaskSessionState,
  sessions: nonNegativeInt,
  events: nonNegativeInt,
  /** The size of the stored session, in bytes, before it was sealed. */
  bytes: nonNegativeInt,
});
export type TaskSessionReceipt = z.infer<typeof TaskSessionReceipt>;

// --- the candidate's side ----------------------------------------------------------------------

/**
 * A string the terminal replaces, and what it puts in its place. The server lists them for the
 * attempt; the terminal replaces each in every text before the session is scanned and cut, and never
 * reads what the replacement says.
 */
export const TaskRedaction = z.strictObject({
  text: z.string().min(8).max(200),
  replace_with: z.string().min(1).max(32),
});
export type TaskRedaction = z.infer<typeof TaskRedaction>;

/** What is shared, said once, before the person takes the task. */
export const TASK_SHARED_KEYS = ["pull_request", "checks", "session", "card"] as const;
export const TaskSharedItem = z.strictObject({
  key: z.enum(TASK_SHARED_KEYS),
  line: Line,
});
export type TaskSharedItem = z.infer<typeof TaskSharedItem>;

/**
 * `GET /v1/me/tasks/:grant_id` — the person's own attempt, as the terminal reads it: the task, the
 * template, the copy they named, the pull request, whether a session was attached, and — once
 * released — the outcome.
 *
 *   * `session_open_until` is when a session can no longer be attached (`lateSessionMinutes` after
 *     submitting); null before the task is submitted.
 *   * `release_at` is the latest moment the outcome is shown to the person (14 days after
 *     submitting); the company can release it sooner. `results` is null until the moment has passed
 *     and the check has finished. The terminal does not read it: it is `unknown` here.
 *   * `redact` is for the terminal: every string in it is replaced by its `replace_with` in every
 *     text before the session is scanned and sent.
 */
export const CandidateTask = z.strictObject({
  grant_id: uuid,
  company: CompanyName,
  role_title: RoleTitle,
  task: z.strictObject({
    key: TaskKeyName,
    title: z.string().min(1),
    summary: z.string().min(1),
    bug_report: z.string().min(1),
    language: TaskLanguageName,
  }),
  template: z.strictObject({ repository: TaskRepoName, url: z.url() }),
  shared: z.array(TaskSharedItem),
  state: TaskState,
  repo: TaskRepoName.nullable(),
  pull: z.strictObject({ number: TaskPullNumber, url: z.url() }).nullable(),
  started_at: rfc3339,
  submitted_at: rfc3339.nullable(),
  session_state: TaskSessionState.nullable(),
  session_open_until: rfc3339.nullable(),
  release_at: rfc3339.nullable(),
  results: z.unknown(),
  redact: z.array(TaskRedaction),
});
export type CandidateTask = z.infer<typeof CandidateTask>;

/** One row of `GET /v1/me/tasks`: enough for the terminal to find the attempt by the folder's remote. */
export const CandidateTaskItem = z.strictObject({
  grant_id: uuid,
  company: CompanyName,
  role_title: RoleTitle,
  task: z.strictObject({ key: TaskKeyName, title: z.string().min(1), language: TaskLanguageName }),
  state: TaskState,
  repo: TaskRepoName.nullable(),
  pr_number: TaskPullNumber.nullable(),
  submitted_at: rfc3339.nullable(),
});
export type CandidateTaskItem = z.infer<typeof CandidateTaskItem>;

export const CandidateTaskList = z.strictObject({ items: z.array(CandidateTaskItem) });
export type CandidateTaskList = z.infer<typeof CandidateTaskList>;

// --- refusals ---------------------------------------------------------------------------------------

/**
 * Every refusal the candidate's task routes give, by code. A refusal says what was refused and never
 * quotes what was sent; `message` is the plain-words sentence a page can print as it is.
 *
 *   invalid_request        400 — the body is not the shape the route takes
 *   not_found              404 — a link, an attempt or a pull request that is nobody's: one answer
 *   no_task                409 — the role has no task that is ready
 *   already_started        409 — this person already took this role's task
 *   repo_not_found         400 — no public repository by that name
 *   repo_not_from_template 400 — the repository was not made from the task's template
 *   no_repo                409 — submit before a copy was named
 *   pull_not_found         400 — no such pull request in the named copy
 *   already_submitted      409 — submitting is final
 *   session_window_closed  409 — a session can no longer be attached
 *   session_too_large      413 — over `TASK_LIMITS.sessionBytes`
 *   secret_found           400 — the session carries something the secret scanner blocks (never what)
 *   github_unavailable     503 — GitHub could not be asked just now; nothing was changed
 *   rate_limited           429 — with `retry_after_s` and the `Retry-After` header
 */
export const TASK_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "no_task",
  "already_started",
  "repo_not_found",
  "repo_not_from_template",
  "no_repo",
  "pull_not_found",
  "already_submitted",
  "session_window_closed",
  "session_too_large",
  "secret_found",
  "github_unavailable",
  "rate_limited",
] as const;
export const TaskErrorCode = z.enum(TASK_ERROR_CODES);
export type TaskErrorCode = z.infer<typeof TaskErrorCode>;

export const TaskError = z.strictObject({
  error: TaskErrorCode,
  message: z.string().min(1).max(300).optional(),
  retry_after_s: z.number().int().positive().optional(),
});
export type TaskError = z.infer<typeof TaskError>;
