/**
 * Which repository a session or an editor workspace is in, and whether it is one the server can
 * bind (B4.3). ONE implementation for both wedges (audit 2026-10-09 #3): the editor used to send a
 * branch with no `repo_id`, and the server's `carrier_key_from_hint` returns None for a hint
 * without a repository — so not one IDE draft ever bound to a
 * carrier. The CLI already did this right; the extension now calls the same functions.
 *
 * This exists to decide what NOT to send. A branch is worth putting on the wire only for a
 * repository the server already reads: there it resolves to a carrier, and the branch names are
 * ones the server sees in the carrier events anyway. Anywhere else the branch is just a name —
 * `feature/acme-billing-migration` is an employer and a project — travelling with nothing to
 * resolve against. The answer is not to hash it (a hash cannot bind either); the answer is not to
 * send it, and to let the event arrive unresolved, which is a state the History panel names as
 * "sessions outside tracked repositories".
 *
 * The mapping is done entirely on the device: directory -> the repository's git remote ->
 * `owner/name` -> the connected list the server handed over (`GET /v1/me/repositories`) -> the
 * numeric GitHub repository id, which is what the server joins on. The directory, the remote URL
 * and `owner/name` never leave; only the numeric id of a repository the person connected does.
 *
 * Git is read from its files, never by running git: the wedge is a guest on this machine and must
 * not run somebody else's binaries. Two layouts, both confirmed on real checkouts (2026-10-09):
 *   * a plain checkout — `.git/` is the git directory (`HEAD`, `config`);
 *   * a linked worktree — `.git` is a FILE `gitdir: <path>`; `HEAD` is in that directory and the
 *     shared `config` is in its `commondir` (`../..`). Before this the editor read `.git/HEAD`
 *     only, and found no branch at all in a worktree.
 */

import { readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export type ConnectedRepo = { repo_id: number; full_name: string };

type ReadFile = (p: string) => string;
const defaultRead: ReadFile = (p) => readFileSync(p, "utf8");

/** `owner/name` from a git remote URL, in the forms git writes. */
export function repoFromRemote(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  // git@github.com:owner/name  |  https://github.com/owner/name  |  ssh://git@github.com/owner/name
  const match = /(?:github\.com[:/])([^/\s]+)\/([^/\s]+)$/.exec(cleaned);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The git directories of a checkout rooted exactly at `dir`, or null when `dir` is not one. */
function gitDirsAt(dir: string, read: ReadFile): { gitDir: string; commonDir: string } | null {
  const plain = join(dir, ".git");
  try {
    read(join(plain, "config"));
    return { gitDir: plain, commonDir: plain };
  } catch {
    // not a plain checkout; maybe a worktree
  }
  let pointer: string;
  try {
    pointer = read(plain);
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match?.[1]) return null;
  const gitDir = resolve(dir, match[1]);
  let commonDir = gitDir;
  try {
    commonDir = resolve(gitDir, read(join(gitDir, "commondir")).trim());
  } catch {
    // a submodule's gitdir holds its own config
  }
  return { gitDir, commonDir };
}

/** The nearest checkout at or above `cwd` (a session's cwd is often a subdirectory). */
function findCheckout(cwd: string, read: ReadFile): { gitDir: string; commonDir: string } | null {
  let dir = cwd;
  for (let depth = 0; depth < 12; depth += 1) {
    const found = gitDirsAt(dir, read);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir || parse(dir).root === dir) return null;
    dir = parent;
  }
  return null;
}

/** `owner/name` of the repository a directory belongs to, or null. The first remote wins;
 *  `origin` if it is there, since that is what people push to. */
export function repoAt(cwd: string, readFile: ReadFile = defaultRead): string | null {
  const checkout = findCheckout(cwd, readFile);
  if (!checkout) return null;
  let text: string;
  try {
    text = readFile(join(checkout.commonDir, "config"));
  } catch {
    return null;
  }
  const remotes: Record<string, string> = {};
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const section = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
    if (section) {
      current = section[1] ?? null;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url && current && url[1]) remotes[current] = url[1];
  }
  const chosen = remotes.origin ?? Object.values(remotes)[0];
  return chosen ? repoFromRemote(chosen) : null;
}

/** The checked-out branch NAME (a one-line ref in HEAD), or null — detached HEAD included. */
export function branchAt(cwd: string, readFile: ReadFile = defaultRead): string | null {
  const checkout = findCheckout(cwd, readFile);
  if (!checkout) return null;
  try {
    const head = readFile(join(checkout.gitDir, "HEAD")).trim();
    return /^ref:\s+refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The numeric id of the connected repository a directory belongs to, or null. */
export function connectedRepoIdAt(
  cwd: string | null,
  connected: ReadonlyArray<ConnectedRepo>,
  readFile?: ReadFile,
): number | null {
  if (!cwd || connected.length === 0) return null;
  const fullName = repoAt(cwd, readFile);
  if (!fullName) return null;
  return connected.find((r) => r.full_name.toLowerCase() === fullName.toLowerCase())?.repo_id ?? null;
}

/** The id of a repository named `owner/name`, when the person connected it. */
export function connectedRepoId(fullName: string, connected: ReadonlyArray<ConnectedRepo>): number | null {
  return connected.find((r) => r.full_name.toLowerCase() === fullName.toLowerCase())?.repo_id ?? null;
}

/**
 * The carrier hint an event may carry.
 *
 * Both fields or neither: a `repo_id` without a branch cannot bind, and a branch without a
 * `repo_id` is the name we decided not to send. An unresolved event is a fact the History panel
 * states, not an accident.
 */
export function carrierHintFor(
  cwd: string | null,
  branch: string | null,
  connected: ReadonlyArray<ConnectedRepo>,
  readFile?: ReadFile,
): { repoId: number; branch: string } | null {
  if (!cwd || !branch) return null;
  const repoId = connectedRepoIdAt(cwd, connected, readFile);
  return repoId ? { repoId, branch } : null;
}
