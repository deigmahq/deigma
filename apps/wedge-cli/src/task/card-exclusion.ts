/**
 * A hiring task's folder is never read into the person's card (deigma.net/privacy: "a task session
 * never counts toward your card").
 *
 * The card's readers — the incremental sync, the history pass and the live proxy — read every
 * session on the machine as counts, and the server cannot tell a task's session from any other: a
 * session outside a connected repository travels without its repository, on purpose. So the
 * exclusion is made here, on the device, before anything is built from a session:
 *
 *   * a folder is a task folder when its checkout's GitHub remote is a copy the person gave a task
 *     page (`GET /v1/me/tasks` — the page asks for the address before the work starts), or when it
 *     was remembered as one;
 *   * a folder once known — by that match, or by `deigma task submit` run in it — is remembered in
 *     ~/.config/deigma/task-folders.json (0600), so its sessions stay out after the copy is deleted
 *     or its remote is changed: a new reader re-reads every transcript on disk;
 *   * the same file keeps the copies' addresses from the last read that asked the server, so the
 *     proxy — which never waits on the network in front of a tool — decides from this file alone.
 *
 * There is no marker file to look for: nothing in a task template may name Deigma, so the copy is
 * known by its address.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repoAt } from "@mentat/wedge-core";

import { checkoutRoot, isInFolder } from "./folder";
import { writeFileAtomic } from "../platform";

export const TASK_FOLDERS_FILE = "task-folders.json";

/** What the device knows of the person's task folders. */
export type KnownTaskFolders = {
  /** Folders known to be task folders. Only ever added to. */
  folders: string[];
  /** The person's task copies (`owner/name`) as the server last listed them. */
  repos: string[];
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

/** What this device knows; nothing when the file is absent or unreadable. */
export function knownTaskFolders(configDir: string): KnownTaskFolders {
  try {
    const s = JSON.parse(readFileSync(join(configDir, TASK_FOLDERS_FILE), "utf8")) as Record<string, unknown> | null;
    return { folders: strings(s?.folders), repos: strings(s?.repos) };
  } catch {
    return { folders: [], repos: [] };
  }
}

/**
 * Adds folders to the known ones and, when given, replaces the copies' addresses with the server's
 * latest list. A folder already known is not added twice; when nothing changes nothing is written.
 */
export function rememberTaskFolders(configDir: string, folders: readonly string[], repos?: readonly string[]): void {
  const known = knownTaskFolders(configDir);
  const next: KnownTaskFolders = {
    folders: [...new Set([...known.folders, ...folders.filter((f) => f !== "")])],
    repos: repos ? [...new Set(repos)] : known.repos,
  };
  if (next.folders.length === known.folders.length && next.repos.join("\n") === known.repos.join("\n")) return;
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, TASK_FOLDERS_FILE);
  writeFileAtomic(path, `${JSON.stringify({ version: 1, ...next })}\n`, 0o600); // a reader never sees half a file
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The person's task copies (`owner/name`); `ended` when the server no longer knows the sign-in, null
 * when it could not be asked. A server that has no tasks answers 404: no tasks, which is an
 * answer, not a failure. Only the addresses are read from the list, so a list that grows fields
 * stays readable by this version.
 */
export async function taskRepositories(
  fetch: typeof globalThis.fetch,
  apiBaseUrl: string,
  headers: Record<string, string>,
): Promise<string[] | "ended" | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/v1/me/tasks`, { headers });
    if (res.status === 401) return "ended";
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown } | null;
    const items = body && Array.isArray(body.items) ? body.items : [];
    return items.flatMap((item) => {
      const repo = item && typeof item === "object" ? (item as { repo?: unknown }).repo : undefined;
      return typeof repo === "string" && REPO.test(repo) ? [repo] : [];
    });
  } catch {
    return null;
  }
}

export type TaskFolderCheck = {
  /** Whether a session whose journal records `cwd` as its folder is in a task folder. */
  has: (cwd: string | null) => boolean;
  /** The task folders this check recognised that were not known before it. */
  found: () => string[];
};

export function taskFolderCheck(input: {
  known: KnownTaskFolders;
  /** Wired in tests; the checkout's own files by default. */
  rootOf?: (cwd: string) => string | null;
  repoOf?: (root: string) => string | null;
}): TaskFolderCheck {
  const repos = new Set(input.known.repos.map((r) => r.toLowerCase()));
  const rootOf = input.rootOf ?? checkoutRoot;
  const repoOf = input.repoOf ?? ((root: string) => repoAt(root));
  const folders = [...input.known.folders];
  const fresh: string[] = [];
  const answers = new Map<string, boolean>();
  return {
    has(cwd) {
      if (!cwd) return false;
      const memo = answers.get(cwd);
      if (memo !== undefined) return memo;
      let answer = isInFolder(cwd, folders);
      if (!answer && repos.size > 0) {
        const root = rootOf(cwd);
        const repo = root ? repoOf(root) : null;
        if (root && repo && repos.has(repo.toLowerCase())) {
          folders.push(root);
          fresh.push(root);
          answer = true;
        }
      }
      answers.set(cwd, answer);
      return answer;
    },
    found: () => [...fresh],
  };
}
