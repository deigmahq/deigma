// What the habit rules ask of git on THIS machine (Core 7 §4, rules hb-2.0). Everything here runs
// `git` as a child process without a shell, reads its output in memory and returns a yes/no; no
// path, message, diff or file name leaves it. Anything git cannot answer — not a repository, git
// missing, a timeout — is null: "not observed", which the rules turn into no occasion, never a miss.

import { execFileSync } from "node:child_process";

import { scanForSecrets } from "@mentat/wedge-core";

const DAY_MS = 86_400_000;
export const MEMORY_WINDOW_DAYS = 90;
export const MEMORY_MIN_CHARS = 20;

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Lines the diff added or removed, as a character count, per commit that touched the memory files:
 *  `[unix seconds, characters]`. Computed once per project directory and cached. */
const memoryHistory = new Map<string, [number, number][] | null>();

function historyOf(dir: string): [number, number][] | null {
  if (memoryHistory.has(dir)) return memoryHistory.get(dir)!;
  const out = git(dir, [
    "log", "-n", "400", "--no-color", "--no-ext-diff", "--unified=0", "--format=@%ct", "-p", "--",
    ":(top)CLAUDE.md", ":(top)AGENTS.md",
  ]);
  let result: [number, number][] | null = null;
  if (out !== null) {
    result = [];
    for (const line of out.split("\n")) {
      if (line.startsWith("@") && /^@\d+$/.test(line)) result.push([Number(line.slice(1)), 0]);
      else if (result.length > 0 && /^[+-](?![+-]{2} )/.test(line)) result[result.length - 1]![1] += line.length - 1;
    }
  }
  memoryHistory.set(dir, result);
  return result;
}

/** hb-2.2: whether the project keeps a memory file the agent reads — CLAUDE.md or AGENTS.md exists
 *  in the repository AND it was changed by more than 20 characters in the 90 days to `atMs`, or the
 *  session loaded it as instructions (`loaded`). A file nobody touched in a quarter and that the
 *  agent did not read is not kept. Null when `dir` is not a repository git can read. (hb-2.0 asked
 *  for a change in 30 days, so a stable, read file read as a miss every month.) */
export function memoryAlive(dir: string | null, atMs: number, loaded = false): boolean | null {
  if (!dir) return null;
  const history = historyOf(dir);
  if (history === null) return null;
  const exists = git(dir, ["ls-files", "--", ":(top)CLAUDE.md", ":(top)AGENTS.md"]);
  if (exists === null) return null;
  if (!exists.trim()) return false;
  if (loaded) return true;
  const from = atMs - MEMORY_WINDOW_DAYS * DAY_MS;
  const chars = history.reduce((n, [ts, c]) => (ts * 1000 > from && ts * 1000 <= atMs ? n + c : n), 0);
  return chars > MEMORY_MIN_CHARS;
}

/** hb-2.2: the kinds of secret the practice counts — the precise ones. The event guard blocks on
 *  everything the scanner knows (a false positive there costs one event); a practice score built on
 *  "a long literal assigned to a name with `token` in it" read test fixtures as leaks. */
export const PRACTICE_SECRET_KINDS = new Set([
  "github_token", "aws_access_key", "slack_token", "openai_key", "google_api_key", "jwt", "private_key_block",
]);
/** hb-2.2: files whose added lines are not where a leak is counted: documentation, tests, fixtures,
 *  examples, lock files and minified output. */
const NOT_A_LEAK_PATH = /(?:^|\/)(?:docs?|tests?|__tests__|spec|fixtures?|testdata|examples?|__mocks__)\/|\.(?:md|mdx|rst|txt|lock|min\.js|map|snap)$|(?:\.example|\.sample|\.template)(?:\.|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|[._-](?:test|spec)\.[a-z]+$/i;

/** Whether the lines a commit added carry no secret by the device's own precise patterns, outside
 *  docs, tests and fixtures. Null when the commit cannot be read (unknown sha, not a repository). */
export function commitClean(sha: string, dir: string | null): boolean | null {
  if (!dir || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const out = git(dir, ["show", "--no-color", "--no-ext-diff", "--unified=0", "--format=", sha, "--"]);
  if (out === null) return null;
  const added: string[] = [];
  let skip = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      skip = NOT_A_LEAK_PATH.test(path);
      continue;
    }
    if (!skip && line.startsWith("+")) added.push(line);
  }
  return !scanForSecrets(added.join("\n")).some((k) => PRACTICE_SECRET_KINDS.has(k));
}

/** Forgets the cached histories (tests). */
export function resetDeviceGit(): void {
  memoryHistory.clear();
}
