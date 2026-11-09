/**
 * `deigma task submit`: from the folder of the candidate's copy
 * of the task repository to a submitted pull request, with the session of the folder attached if
 * the person says yes.
 *
 *   1. the folder → its Git checkout, the GitHub repository of its remote, the branch checked out;
 *   2. the task → the person's open attempt for that repository (`GET /v1/me/tasks?repo=`), with
 *      its redact list and the company's name;
 *   3. the pull request → `--pr`, or the one from this branch (GitHub's public API);
 *   4. the sessions → the Claude Code and Codex journals of THIS folder, normalized, the strings the
 *      server lists replaced by its placeholder, every text scanned for secrets;
 *   5. the question → "N sessions · M events · K MB will be shared with <Company>: your prompts, the
 *      agent's replies and tool calls in this folder", and y/N. Nothing has left the machine yet;
 *   6. the sending → the session, then the pull request. If the first fails the second is not made;
 *      if the second fails the first is sent again, in its place, on the next run.
 *
 * What makes this command different from every other in the terminal: it is a person's act, and
 * it asks. It refuses to run where there is nobody to ask (no terminal), so a program driving the
 * shell cannot say yes for the person; it has no `--yes`; and it is not the proxy: where the
 * proxy fails open, this fails closed — any call that cannot be made stops it before anything is
 * submitted, and nothing is ever sent in part.
 */
import { join } from "node:path";

import { branchAt, repoAt } from "@mentat/wedge-core";

import {
  getTask,
  listTasks,
  setRepo,
  submitPull,
  uploadSession,
  type ApiAccess,
  type Call,
} from "./api";
import { checkoutRoot, folderIdentity } from "./folder";
import { readClaudeFolderSessions } from "./claude";
import { readCodexFolderSessions } from "./codex";
import { findPullRequest } from "./github";
import {
  alreadySubmittedLine,
  askWithSession,
  askWithoutSession,
  badPullArgumentLine,
  finalLine,
  invalidUploadLine,
  NO_BRANCH_LINE,
  NO_GITHUB_REMOTE_LINE,
  NO_TTY_LINE,
  noSessionLines,
  noTaskLine,
  NOT_A_CHECKOUT_LINE,
  NOTHING_SENT_LINE,
  pullLookupFailedLine,
  pullNoneLine,
  pullSeveralLine,
  refusedLines,
  repoMismatchLine,
  secretBlockedLines,
  sessionLine,
  sessionMismatchLine,
  sessionNotSentLine,
  severalTasksLine,
  shareLine,
  submitFailedAfterSessionLine,
  submitFailedLine,
  submittedLines,
  TASK_USAGE_LINES,
  tooLargeLines,
  tooManyLines,
  UNKNOWN_ANSWER_LINE,
  unreadableLine,
  UNREACHABLE_LINE,
  withoutSessionLines,
} from "./messages";
import { Budget, prepareUpload, type Prepared } from "./prepare";
import { makeNormalizer } from "./text";
import type { FolderSession } from "./types";

/** Asks a yes/no question of the person at the terminal; false is "no", and so is silence. */
export type AskYesNo = (question: string) => Promise<boolean>;

export type SubmitEnv = {
  api: ApiAccess;
  /** The network for public GitHub addresses; absent where there is none, and the pull request must then be named. */
  publicFetch: typeof globalThis.fetch | undefined;
  out: (line: string) => void;
  err: (line: string) => void;
  /** False where nobody can be asked (no terminal): the command then stops before it reads anything. */
  canAsk: boolean;
  ask: AskYesNo;
  cwd: string;
  home: string;
  /** The Codex home (`$CODEX_HOME`, else ~/.codex). */
  codexDir: string;
  webBaseUrl: string;
  /** Remembers the folder as a task's, so its sessions are never read into the card (./card-exclusion). */
  remember?: (root: string) => void;
};

/** The command's result: an exit code, or `ended` when the server no longer knows this sign-in. */
export type SubmitResult = number | "ended";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_SECRET = 3;

type Args = { pr: number | null; withoutSession: boolean };

function parseArgs(argv: readonly string[]): Args | "help" | "bad_pr" | "usage" {
  let pr: number | null = null;
  let withoutSession = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--without-session") {
      withoutSession = true;
    } else if (arg === "--pr" || arg.startsWith("--pr=")) {
      const value = arg === "--pr" ? argv[(i += 1)] : arg.slice("--pr=".length);
      if (value === undefined || !/^[1-9][0-9]{0,7}$/.test(value)) return "bad_pr";
      pr = Number(value);
    } else {
      return "usage";
    }
  }
  return { pr, withoutSession };
}

/** What a call that did not succeed means for the command, said once. */
function stopOn(env: SubmitEnv, done: Exclude<Call<unknown>, { kind: "ok" }>): SubmitResult {
  switch (done.kind) {
    case "ended":
      return "ended";
    case "unreachable":
      env.err(UNREACHABLE_LINE);
      return EXIT_FAILED;
    case "unknown":
      env.err(UNKNOWN_ANSWER_LINE);
      return EXIT_FAILED;
    case "refused":
      for (const line of refusedLines(done.refusal.code, done.refusal.message, done.refusal.retryAfterSeconds)) env.err(line);
      return EXIT_FAILED;
  }
}

const sameRepo = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

const dayOf = (iso: string) => iso.slice(0, 10);

export async function taskSubmit(env: SubmitEnv, rest: readonly string[]): Promise<SubmitResult> {
  const args = parseArgs(rest);
  if (args === "help") {
    for (const line of TASK_USAGE_LINES) env.out(line);
    return 0;
  }
  if (args === "bad_pr") {
    env.err(badPullArgumentLine);
    return EXIT_USAGE;
  }
  if (args === "usage") {
    for (const line of TASK_USAGE_LINES) env.err(line);
    return EXIT_USAGE;
  }
  // Nobody to ask: stop before anything is read or sent.
  if (!env.canAsk) {
    env.err(NO_TTY_LINE);
    return EXIT_USAGE;
  }

  // 1. the folder
  const root = checkoutRoot(env.cwd);
  if (!root) {
    env.err(NOT_A_CHECKOUT_LINE);
    return EXIT_USAGE;
  }
  const repo = repoAt(root);
  if (!repo) {
    env.err(NO_GITHUB_REMOTE_LINE);
    return EXIT_USAGE;
  }
  const branch = branchAt(root);
  if (args.pr === null && !branch) {
    env.err(NO_BRANCH_LINE);
    return EXIT_USAGE;
  }

  // 2. the task
  const listed = await listTasks(env.api, repo);
  if (listed.kind !== "ok") return stopOn(env, listed);
  const mine = listed.value.filter((t) => sameRepo(t.repo, repo));
  let item = mine.find((t) => t.state === "started") ?? mine[0];
  if (!item) {
    // The page may not have been told about this copy yet: one open attempt with no copy is it.
    const all = await listTasks(env.api);
    if (all.kind !== "ok") return stopOn(env, all);
    const unplaced = all.value.filter((t) => t.repo === null && t.state === "started");
    if (unplaced.length === 0) {
      env.err(noTaskLine(repo));
      return EXIT_FAILED;
    }
    if (unplaced.length > 1) {
      env.err(severalTasksLine(repo));
      return EXIT_FAILED;
    }
    const registered = await setRepo(env.api, unplaced[0]!.grant_id, repo);
    if (registered.kind !== "ok") return stopOn(env, registered);
    item = unplaced[0]!;
  }
  if (item.state !== "started" || item.submitted_at !== null) {
    env.err(alreadySubmittedLine(item.submitted_at ? dayOf(item.submitted_at) : "an earlier day"));
    return EXIT_FAILED;
  }
  const loaded = await getTask(env.api, item.grant_id);
  if (loaded.kind !== "ok") return stopOn(env, loaded);
  const task = loaded.value;
  if (task.repo !== null && !sameRepo(task.repo, repo)) {
    env.err(repoMismatchLine(task.repo, repo));
    return EXIT_FAILED;
  }
  // From here the folder is this task's, whatever the answer below: its sessions stay out of the card.
  try {
    env.remember?.(root);
  } catch {
    // a folder that could not be remembered is still matched by its address on the next read
  }

  // 3. the pull request
  let pr = args.pr;
  if (pr === null) {
    const found = env.publicFetch ? await findPullRequest(env.publicFetch, repo, branch!) : ({ kind: "unreachable" } as const);
    if (found.kind === "unreachable") {
      env.err(pullLookupFailedLine);
      return EXIT_FAILED;
    }
    if (found.kind === "none") {
      env.err(pullNoneLine(repo, branch!));
      return EXIT_FAILED;
    }
    if (found.kind === "several") {
      env.err(pullSeveralLine(found.numbers));
      return EXIT_FAILED;
    }
    pr = found.number;
  }

  // 4. the sessions of this folder, only if the person has not said they want none
  let found: FolderSession[] = [];
  let unreadable = 0;
  if (!args.withoutSession) {
    const identity = folderIdentity(root, env.home);
    const normalize = makeNormalizer({
      redact: task.redact.map((r) => ({ text: r.text, replaceWith: r.replace_with })),
      folders: identity.folders,
      homes: identity.homes,
    });
    const budget = new Budget();
    const claude = readClaudeFolderSessions({ projectsRoot: join(env.home, ".claude", "projects"), folders: identity.folders, normalize, budget });
    // A read that has spent the budget stops: what is left is too long to send at any size, and the
    // other agent's journal is not opened for nothing.
    const codex = budget.exceeded
      ? { sessions: [], unreadable: 0, overBudget: true }
      : readCodexFolderSessions({ codexDir: env.codexDir, folders: identity.folders, normalize, budget });
    found = [...claude.sessions, ...codex.sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    unreadable = claude.unreadable + codex.unreadable;
    if (claude.overBudget || codex.overBudget) {
      for (const line of tooLargeLines(null)) env.err(line);
      return EXIT_FAILED;
    }
  }
  const prepared: Prepared | null = found.length > 0 ? prepareUpload(found) : null;
  if (prepared?.kind === "secret") {
    for (const line of secretBlockedLines(prepared.hits)) env.err(line);
    return EXIT_SECRET;
  }
  if (prepared?.kind === "too_large") {
    for (const line of tooLargeLines(prepared.bytes)) env.err(line);
    return EXIT_FAILED;
  }
  if (prepared?.kind === "too_many") {
    for (const line of tooManyLines(prepared.what, prepared.count)) env.err(line);
    return EXIT_FAILED;
  }
  if (prepared?.kind === "invalid") {
    env.err(invalidUploadLine);
    return EXIT_FAILED;
  }

  // 5. the question
  const attach = prepared?.kind === "ready" ? prepared : null;
  if (attach) {
    for (const s of attach.sessions) env.out(sessionLine(s));
    if (unreadable > 0) env.out(unreadableLine(unreadable));
    env.out(shareLine({ sessions: attach.sessions.length, events: attach.events, bytes: attach.bytes, company: task.company }));
    env.out(finalLine(pr));
  } else {
    for (const line of args.withoutSession ? withoutSessionLines(task.company) : noSessionLines(task.company)) env.out(line);
    if (unreadable > 0) env.out(unreadableLine(unreadable));
    env.out(finalLine(pr));
  }
  const yes = await env.ask(attach ? askWithSession(task.company, pr) : askWithoutSession(pr));
  if (!yes) {
    env.out(NOTHING_SENT_LINE);
    return EXIT_FAILED;
  }

  // 6. the sending: the session first, and the pull request only if it arrived whole
  const body = attach ? attach.body : ({ state: "not_available" } as const);
  const stored = await uploadSession(env.api, task.grant_id, body);
  if (stored.kind !== "ok") {
    const code = stopOn(env, stored);
    if (code !== "ended") env.err(sessionNotSentLine);
    return code;
  }
  const expected = attach ? { state: "attached", sessions: attach.sessions.length, events: attach.events } : { state: "not_available", sessions: 0, events: 0 };
  if (
    stored.value.state !== expected.state ||
    stored.value.sessions !== expected.sessions ||
    stored.value.events !== expected.events
  ) {
    env.err(sessionMismatchLine);
    return EXIT_FAILED;
  }
  const submitted = await submitPull(env.api, task.grant_id, pr);
  if (submitted.kind !== "ok") {
    const code = stopOn(env, submitted);
    if (code !== "ended") env.err(attach ? submitFailedAfterSessionLine : submitFailedLine);
    return code;
  }

  // 7. what happens next
  const releaseAt = submitted.value?.release_at ?? null;
  for (const line of submittedLines({
    company: task.company,
    pr,
    sessionAttached: attach !== null,
    releaseDay: releaseAt ? dayOf(releaseAt) : null,
    taskUrl: `${env.webBaseUrl}/tasks/${task.grant_id}`,
  })) {
    env.out(line);
  }
  return 0;
}
