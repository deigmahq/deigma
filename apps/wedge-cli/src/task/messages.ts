/**
 * What `deigma task submit` prints, as pure functions and constants (the same reason as
 * ../messages.ts: a sentence that only exists inside a command is a sentence nobody checks). The
 * word rule of the terminal holds here — none of the inside of the program reaches a person — and
 * `test/task-copy.test.ts` runs it over every sentence in this file.
 *
 * The hard-edged ones are fixed: the line that says what will be shared and with whom, "Session
 * not available", and that submitting is final.
 */
import { AGENT_NAMES, TASK_LIMITS, type Agent } from "@mentat/schemas";

import type { SecretHit, SessionLine } from "./prepare";

export const TASK_USAGE_LINES: readonly string[] = [
  "usage: deigma task submit [--pr <number>] [--without-session]",
  "",
  "  Run it in your copy of the task repository, after you opened the pull request there.",
  "  It finds your task by this folder's GitHub remote and the pull request by its branch,",
  "  shows what will be shared, asks, and only then sends.",
  "    --pr <number>        the pull request to submit, when its branch cannot say",
  "    --without-session    submit the pull request alone; reads nothing from your agents",
];

export const NOT_A_CHECKOUT_LINE =
  "This folder is not a Git checkout. Run `npx deigma task submit` inside your copy of the task repository.";

export const NO_GITHUB_REMOTE_LINE =
  "This folder has no GitHub remote. Run `npx deigma task submit` inside your copy of the task repository, the one you cloned from GitHub.";

export const NO_BRANCH_LINE =
  "No branch is checked out here. Check out the branch of your pull request, or name it: `npx deigma task submit --pr <number>`.";

export const NO_TTY_LINE =
  "Deigma asks before anything is sent, and there is nobody to ask here. Run `npx deigma task submit` yourself in a terminal.";

export const UNREACHABLE_LINE = "Could not reach Deigma. Nothing was sent and nothing was submitted. Try again in a moment.";

export const NOTHING_SENT_LINE = "Nothing was sent.";

export const UNKNOWN_ANSWER_LINE =
  "Deigma answered in a form this version of the terminal does not know. Nothing was sent. Run `npx deigma@latest task submit`.";

export const noTaskLine = (repo: string) =>
  `No task of yours is open for ${repo}. Take the task from the page of your invitation, make your copy from its template, and run this again in that copy.`;

export const severalTasksLine = (repo: string) =>
  `More than one task of yours has no repository yet, so ${repo} cannot be matched to one. Add it on the task page, then run this again.`;

export const alreadySubmittedLine = (day: string) =>
  `This task was submitted on ${day}. Submitting is final, so there is nothing more to send from here.`;

export const repoMismatchLine = (task: string, folder: string) =>
  `Your task is registered for ${task}, but this folder is a clone of ${folder}. Run it in the folder of ${task}.`;

export const pullNoneLine = (repo: string, branch: string) =>
  `No pull request from branch ${branch} was found in ${repo}. Open one on GitHub and run this again, or name it: \`npx deigma task submit --pr <number>\`.`;

export const pullSeveralLine = (numbers: readonly number[]) =>
  `Several pull requests come from this branch (${numbers.map((n) => `#${n}`).join(", ")}). Name the one to submit: \`npx deigma task submit --pr <number>\`.`;

export const pullLookupFailedLine =
  "Could not look up your pull request on GitHub. Name it yourself: `npx deigma task submit --pr <number>`.";

export const badPullArgumentLine = "--pr takes a pull request number, such as `--pr 3`.";

const AGENT_FALLBACK = "agent";
export const agentName = (agent: Agent) => AGENT_NAMES[agent] ?? AGENT_FALLBACK;

const pad = (n: number) => String(n).padStart(2, "0");
/** `2026-11-05 13:02 UTC`: the same in every time zone, so the line a person reads is the line a test reads. */
export function whenUtc(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Megabytes the way the line states them: one decimal, and never "0.0" for something that is there.
 *  The upload's limit is ten of them (10 MiB, `TASK_LIMITS.sessionBytes`), so they are mebibytes. */
export function megabytes(bytes: number): string {
  const mb = Math.ceil(bytes / 104_857.6) / 10;
  return `${Math.max(0.1, mb).toFixed(1)} MB`;
}

export const sessionLine = (s: SessionLine) =>
  `  ${agentName(s.agent)} · ${whenUtc(s.startedAt)} · ${plural(s.events, "event", "events")}`;

/** The line the contract fixes: how much, and with whom. */
export function shareLine(input: { sessions: number; events: number; bytes: number; company: string }): string {
  return (
    `${plural(input.sessions, "session", "sessions")} · ${plural(input.events, "event", "events")} · ${megabytes(input.bytes)} ` +
    `will be shared with ${input.company}: your prompts, the agent's replies and tool calls in this folder`
  );
}

export const finalLine = (pr: number) =>
  `Submitting pull request #${pr} is final: later pushes are not checked.`;

export const askWithSession = (company: string, pr: number) =>
  `Share with ${company} and submit pull request #${pr}?`;

export const noSessionLines = (company: string): string[] => [
  "No Claude Code or Codex session of this folder was found on this machine.",
  "Only sessions started in this folder, or in a folder below it, are looked for.",
  `Without one, ${company} sees your pull request and what the checks find, and "Session not available" where the session would be.`,
];

export const withoutSessionLines = (company: string): string[] => [
  `Submitting without a session: ${company} sees your pull request and what the checks find, and "Session not available" where the session would be.`,
];

export const askWithoutSession = (pr: number) => `Submit pull request #${pr} without a session?`;

export const unreadableLine = (n: number) =>
  `${plural(n, "compressed Codex file", "compressed Codex files")} in this machine's journal could not be read here, so ${n === 1 ? "it is" : "they are"} not in the list.`;

const KIND_WORDS: Record<string, string> = {
  github_token: "a GitHub token",
  aws_access_key: "an AWS access key",
  slack_token: "a Slack token",
  openai_key: "an API key",
  google_api_key: "a Google API key",
  jwt: "a signed token",
  private_key_block: "a private key",
  url_credentials: "a password inside a web address",
  assigned_secret: "a value assigned to a name like a password or a key",
};
const kindWords = (kind: string) => KIND_WORDS[kind] ?? "a secret";

/** A secret was found: which session, what kind of secret, and what was done. Never the secret. */
export function secretBlockedLines(hits: readonly SecretHit[]): string[] {
  return [
    "Nothing was sent. A session in this folder holds something that looks like a real secret:",
    ...hits.map((h) => `  ${agentName(h.agent)} · ${whenUtc(h.startedAt)} · ${[...new Set(h.kinds.map(kindWords))].join(", ")}`),
    "Deigma does not send it and does not print it. The text is in your agent's own log on this machine, which Deigma never changes.",
    "You can submit the pull request without a session: `npx deigma task submit --without-session`.",
  ];
}

/** The sessions cannot be sent at any size. `bytes` is what they come to when that is known; a read that
 *  stopped as soon as it was sure does not know, and says only that it is more than the limit. */
export function tooLargeLines(bytes: number | null): string[] {
  const limit = megabytes(TASK_LIMITS.sessionBytes);
  return [
    bytes === null
      ? `The sessions of this folder are too long to send even cut short: an upload may be ${limit}. Nothing was sent.`
      : `The sessions of this folder come to ${megabytes(bytes)} even cut short, over the ${limit} an upload may be. Nothing was sent.`,
    "You can submit the pull request without a session: `npx deigma task submit --without-session`.",
  ];
}

export function tooManyLines(what: "sessions" | "events", count: number): string[] {
  const limit = what === "sessions" ? TASK_LIMITS.sessions : TASK_LIMITS.eventsPerSession;
  return [
    `This folder has ${count.toLocaleString("en-US")} ${what} in a form that cannot be joined, over the ${limit.toLocaleString("en-US")} one upload may hold. Nothing was sent.`,
    "You can submit the pull request without a session: `npx deigma task submit --without-session`.",
  ];
}

export const invalidUploadLine =
  "The session could not be put into the form Deigma takes. Nothing was sent. You can submit the pull request without a session: `npx deigma task submit --without-session`.";

export const sessionNotSentLine = "The session could not be sent, so the pull request was not submitted.";

export const sessionMismatchLine =
  "Deigma stored something other than the session that was sent, so the pull request was not submitted. Run the command again.";

export const submitFailedAfterSessionLine =
  "Your session was sent, but the pull request was not submitted. Run the command again: it sends the session again in its place and submits.";

export const submitFailedLine = "The pull request was not submitted. Run the command again.";

/** A refusal in the API's own plain words, or ours when it gave none. */
export function refusedLines(code: string | null, message: string | null, retryAfterSeconds: number | null): string[] {
  if (code === "rate_limited") {
    return [`Too many tries just now.${retryAfterSeconds ? ` Try again in ${retryAfterSeconds} seconds.` : " Try again in a moment."}`];
  }
  if (code === "github_unavailable") return ["GitHub could not be asked just now. Nothing was changed. Try again in a moment."];
  const words: Record<string, string> = {
    already_submitted: "This task was already submitted. Submitting is final.",
    session_window_closed: "A session can no longer be attached: it can be added until ten minutes after submitting.",
    session_too_large: "The session is over the size an upload may be.",
    secret_found: "Deigma's own check found something that looks like a secret in the session, so it was not stored.",
    pull_not_found: "That pull request is not in your copy of the repository.",
    no_repo: "Your copy of the repository is not set on the task yet.",
    repo_not_found: "That repository is not public, or does not exist.",
    repo_not_from_template: "That repository was not made from the task's template.",
    not_found: "Deigma does not know that task.",
  };
  return [message ?? (code ? words[code] : undefined) ?? "Deigma refused it."];
}

export function submittedLines(input: {
  company: string;
  pr: number;
  sessionAttached: boolean;
  releaseDay: string | null;
  /** The task's own page on the site, where the results will be. */
  taskUrl: string;
}): string[] {
  return [
    `Submitted pull request #${input.pr}.`,
    input.sessionAttached
      ? `${input.company} sees what the checks find and your session first.`
      : `${input.company} sees what the checks find first; the session reads "Session not available".`,
    input.releaseDay
      ? `You see the same results after your interview, or on ${input.releaseDay} at the latest.`
      : `You see the same results after your interview, or ${TASK_LIMITS.releaseDays} days after you submitted.`,
    "Nothing here is added to your Deigma card, and no task session counts toward it.",
    `Your task: ${input.taskUrl}`,
  ];
}
