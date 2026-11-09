/**
 * Which folder the task is in, and which sessions are in it.
 *
 * The task folder is the root of the Git checkout the command runs in (the person may stand in a
 * sub-folder of it). A session belongs to it when the working directory the agent's own journal
 * records is the folder or a folder below it — compared by real path as well as by the path as
 * written, because a symbolic link (`/tmp` is `/private/tmp` on a Mac) is the same folder to the
 * person and a different string to a journal.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import type { FolderIdentity } from "./types";

/** The nearest folder at or above `cwd` that holds a `.git` (a folder, or the file of a worktree). */
export function checkoutRoot(cwd: string): string | null {
  let dir = cwd;
  for (let depth = 0; depth < 24; depth += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir || parse(dir).root === dir) return null;
    dir = parent;
  }
  return null;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The folder as written and as it really is, and the home directory the same two ways. */
export function folderIdentity(root: string, home: string | null): FolderIdentity {
  return {
    folders: [...new Set([root, real(root)])],
    homes: home ? [...new Set([home, real(home)])] : [],
  };
}

const slashed = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Whether `cwd` — a path a journal wrote — is the task folder or inside it. */
export function isInFolder(cwd: string, folders: readonly string[]): boolean {
  const candidates = new Set([slashed(cwd), slashed(real(cwd))]);
  for (const folder of folders.map(slashed)) {
    if (folder === "") continue;
    for (const candidate of candidates) {
      if (candidate === folder || candidate.startsWith(`${folder}/`)) return true;
    }
  }
  return false;
}

/** The name a Claude Code project folder has for a working directory: every character that is not
 *  a letter or a digit becomes `-` (read off ~/.claude/projects on a real machine). */
export function claudeProjectName(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}
