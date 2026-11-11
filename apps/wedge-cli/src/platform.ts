/**
 * What differs on Windows, in one place (2026-11-11: the first person on Windows).
 *
 * Three things the rest of the CLI used to assume:
 *   * that `spawn("npx", …)` starts npx. On Windows the runnable is `npx.cmd`, a batch file: Node
 *     finds no `npx` (ENOENT), and since 18.20.2 / 20.12.2 it refuses to start a .cmd without a
 *     shell (EINVAL). `deigma proxy -- npx -y <server>` left the MCP client waiting on a server
 *     that never started, and said nothing;
 *   * that a program another tool runs for us (a Claude Code hook, the Codex `notify` entry) has
 *     `sh`. Claude Code runs a hook's text in Git Bash, or in PowerShell when Git is not installed;
 *     Codex starts `notify` as a program with no shell at all. So on Windows ours is `node` with
 *     the launcher below as its arguments: no shell reads it, in any of them;
 *   * that replacing a file by rename always works. On Windows a rename over a file another
 *     process holds open (an indexer, an antivirus scan, Claude Code reading its settings) fails
 *     with EPERM or EBUSY for a moment.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";

export const isWindows = (platform: NodeJS.Platform = process.platform): boolean => platform === "win32";

/**
 * The JavaScript `node -e` runs as our background trigger on Windows, where `sh` is not there to
 * run the POSIX line. The same promises as that line: nothing happens on a machine that is not
 * signed in (no ~/.config/deigma), a stamp older than `everyMinutes` (when there is one) is
 * touched before anything starts, `npx --yes deigma sync` starts detached with no window, and no
 * failure ever reaches the tool that ran us — everything is inside one try. Arguments after the
 * script (Codex appends the turn's JSON) are never read.
 */
export function syncLauncherScript(opts: { stamp?: string; everyMinutes?: number } = {}): string {
  const stamp = opts.stamp ? JSON.stringify(opts.stamp) : "null";
  const every = Math.max(0, Math.round(opts.everyMinutes ?? 0));
  return [
    'try{const fs=require("fs"),p=require("path"),os=require("os"),cp=require("child_process");',
    'const d=p.join(os.homedir(),".config","deigma");',
    "if(fs.existsSync(d)){",
    `const s=${stamp};let due=true;`,
    `if(s){const f=p.join(d,s);try{due=Date.now()-fs.statSync(f).mtimeMs>=${every}*60000}catch(e){due=true}`,
    'if(due)fs.writeFileSync(f,"")}',
    'if(due)cp.spawn("npx",["--yes","deigma","sync"],{shell:true,detached:true,stdio:"ignore",windowsHide:true}).unref()',
    "}}catch(e){}",
  ].join("");
}

/** Replaces `path` with `text` without a reader ever seeing half a file: a temporary file next to
 *  it, then a rename. On Windows the rename is tried again for a moment when another process holds
 *  the target (EPERM, EBUSY, EACCES); the temporary file never outlives a failure. */
export function writeFileAtomic(path: string, text: string, mode?: number): void {
  const tmp = `${path}.deigma-${process.pid}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

export function renameWithRetry(from: string, to: string, attempts = 6, waitMs = 50): void {
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i >= attempts || !BUSY.has(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs * i);
    }
  }
}

/** UTF-8 text without the byte-order mark Notepad and some editors put first. JSON.parse refuses
 *  it, and a TOML lexer accepts it only at the very start of the file. */
export const BOM = "﻿";
export function stripBom(text: string): { text: string; bom: boolean } {
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

// --- Starting a program by name, the way a terminal would --------------------------------------

export type Resolved = { command: string; args: string[]; options: SpawnOptions };

// cross-spawn's escaping for cmd.exe (MIT, github.com/moxystudio/node-cross-spawn, lib/util/escape.js).
const META = /([()\][%!^"`<>&|;, *?])/g;
function escapeCommand(arg: string): string {
  return arg.replace(META, "^$1");
}
function escapeArgument(arg: string, doubleEscape: boolean): string {
  let a = `${arg}`.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  a = `"${a}"`.replace(META, "^$1");
  return doubleEscape ? a.replace(META, "^$1") : a;
}

/**
 * How to start `command args` on this platform. Off Windows it is exactly what was asked. On
 * Windows the name is looked up on PATH with each PATHEXT extension, as cmd.exe would: a real
 * program (.exe, .com) starts directly; a batch file (.cmd, .bat — npx, npm and every npm-installed
 * server) starts through cmd.exe with its arguments escaped so cmd reads them as text, never as
 * operators. A name that resolves to nothing is passed on as given, so the error stays Node's own.
 * The current directory is not searched: a program dropped into a project folder is not ours to run.
 */
export function resolveCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isFile,
): Resolved {
  if (!isWindows(platform)) return { command, args, options: {} };
  const file = findOnPath(command, env, exists);
  if (!file || !/\.(cmd|bat)$/i.test(file)) return { command: file ?? command, args, options: {} };
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [escapeCommand(file), ...args.map((a) => escapeArgument(a, doubleEscape))].join(" ");
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function findOnPath(command: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | null {
  const exts = (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = (base: string): string[] => (win32.extname(base) ? [base] : exts.map((e) => base + e.toLowerCase()));
  if (win32.isAbsolute(command) || /[\\/]/.test(command)) return candidates(command).find(exists) ?? null;
  const dirs = (env.PATH ?? env.Path ?? "").split(win32.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const hit = candidates(win32.join(dir, command)).find(exists);
    if (hit) return hit;
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `spawn`, with the program found the way `resolveCommand` finds it. */
export function spawnResolved(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const r = resolveCommand(command, args);
  return spawn(r.command, r.args, { ...options, ...r.options });
}
