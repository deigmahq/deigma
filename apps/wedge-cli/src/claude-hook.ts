/**
 * The Claude Code hook that keeps the index moving (solo review B2, 2026-10-18).
 *
 * Sessions were read as they finish only while `deigma proxy` ran — and a person who connected
 * the terminal and wraps no MCP server had one batch of history at `init` and then silence: the
 * number promised to move with the work and did not. `init` therefore adds ONE entry to Claude
 * Code's user settings: when a Claude Code session ends, start `deigma sync` in the background.
 * The sync reads only sessions that already ended (journal-sync), so this hook is a trigger and
 * nothing else; it never runs in front of the person's tool, and its output goes nowhere.
 *
 * A session that never ends was never read: a person who keeps one Claude
 * Code session open for weeks had nothing read for 12 days, because SessionEnd never fired. So a
 * second entry rides on Stop, which fires after every turn: one `find` on a stamp, and when the
 * last attempt is more than STOP_READ_EVERY_MINUTES old, the same background sync — about twice a
 * day while somebody works. The sync still reads only stretches that ended (4 h idle), so an open
 * session is read day by day, never half-measured.
 *
 * Three promises, each held by a test:
 *   * it is said, in a line, when it is added, and `init --no-hook` does not add it;
 *   * it is ours and nothing else is touched: the entries are recognised by `HOOK_MARK`, every
 *     other setting and hook is kept byte for byte in meaning, and a settings file that does not
 *     parse is never rewritten — then nothing is added, and the proxy path still works;
 *   * `deigma logout` removes them.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isWindows, stripBom, syncLauncherScript, writeFileAtomic } from "./platform";

/** Recognises our entries; nothing a person writes by hand would contain it. */
export const HOOK_MARK = "deigma-sync-hook";
/** Background, silent, and never failing the session end: the sync is telemetry. */
export const HOOK_COMMAND = `(npx --yes deigma sync >/dev/null 2>&1 &) # ${HOOK_MARK}`;
export const HOOK_EVENT = "SessionEnd";

/** How long an open session waits for its next read: about twice a day ("1-2 times a day"). */
export const STOP_READ_EVERY_MINUTES = 720;
/** The Stop entry's own stamp, beside the CLI's files (~/.config/deigma, main.ts). It marks the
 *  ATTEMPT, not a finished sync, so a machine that is offline does not retry on every turn. */
export const STOP_STAMP = "stop-read.stamp";
/** One `find` per turn; past the interval, stamp and start the sync in the background. Ends in
 *  `true`, so a turn never sees the hook fail, whatever the shell could not do. */
export const STOP_HOOK_COMMAND = `f="$HOME/.config/deigma/${STOP_STAMP}"; [ -n "$(find "$f" -mmin -${STOP_READ_EVERY_MINUTES} 2>/dev/null)" ] || { touch "$f" 2>/dev/null && (npx --yes deigma sync >/dev/null 2>&1 &); }; true # ${HOOK_MARK}`;
export const STOP_HOOK_EVENT = "Stop";

type HookEntry = { type?: string; command?: string; args?: unknown; [k: string]: unknown };

/**
 * On Windows the entries are Claude Code's exec form: `node` with the launcher as its arguments
 * (./platform). Claude Code runs a hook's text in Git Bash, or in PowerShell when Git is not
 * installed, and the POSIX lines above are an error line after every turn in PowerShell; with
 * `args` set no shell reads the entry at all (Claude Code 2.1.139+). `node` is a real program, the
 * one npx itself needs, so it is on PATH wherever `npx deigma init` ran.
 */
export function hookEntry(event: string, platform: NodeJS.Platform = process.platform): HookEntry {
  if (!isWindows(platform)) {
    return { type: "command", command: event === STOP_HOOK_EVENT ? STOP_HOOK_COMMAND : HOOK_COMMAND };
  }
  const script =
    event === STOP_HOOK_EVENT
      ? syncLauncherScript({ stamp: STOP_STAMP, everyMinutes: STOP_READ_EVERY_MINUTES })
      : syncLauncherScript();
  return { type: "command", command: "node", args: ["-e", script, HOOK_MARK] };
}

/** Every event this module owns an entry on. */
const OUR_EVENTS: readonly string[] = [HOOK_EVENT, STOP_HOOK_EVENT];
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[] | unknown>; [k: string]: unknown };

export function claudeSettingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

function oursEntry(h: HookEntry | undefined): boolean {
  if (!h) return false;
  const args = Array.isArray(h.args) ? h.args.map(String).join(" ") : "";
  return `${String(h.command ?? "")} ${args}`.includes(HOOK_MARK);
}

function ours(group: HookGroup): boolean {
  return Array.isArray(group.hooks) && group.hooks.some(oursEntry);
}

/** Ours, and exactly what this version writes for this platform. */
function current(group: HookGroup, event: string, platform: NodeJS.Platform): boolean {
  const want = JSON.stringify(hookEntry(event, platform));
  return Array.isArray(group.hooks) && group.hooks.length === 1 && JSON.stringify(group.hooks[0]) === want;
}

/** The settings, or null when the file exists and is not a JSON object (then it is not ours to
 *  rewrite). A missing file is an empty object. */
function readSettings(path: string): Settings | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // Only a file that is not there is an empty one. A file we could not read (locked, no access)
    // is somebody's settings all the same, and writing `{}` plus our hooks over it would lose them.
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
  try {
    const parsed: unknown = JSON.parse(stripBom(text).text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Settings) : null;
  } catch {
    return null;
  }
}

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export type HookOutcome = "added" | "present" | "unreadable_settings" | "failed";

function ourEntryOn(settings: Settings, event: string): boolean {
  const groups = settings.hooks && typeof settings.hooks === "object" ? (settings.hooks as Record<string, unknown>)[event] : undefined;
  return Array.isArray(groups) && (groups as HookGroup[]).some(ours);
}

/** Whether the SessionEnd entry is in place (true / false), or null when the settings cannot be
 *  read. It is the one `init` asked about; the Stop entry rides with it (`stopHookInstalled`). */
export function syncHookInstalled(home: string): boolean | null {
  const settings = readSettings(claudeSettingsPath(home));
  return settings === null ? null : ourEntryOn(settings, HOOK_EVENT);
}

/** Whether the Stop entry that reads an open session twice a day is in place, or null. */
export function stopHookInstalled(home: string): boolean | null {
  const settings = readSettings(claudeSettingsPath(home));
  return settings === null ? null : ourEntryOn(settings, STOP_HOOK_EVENT);
}

/** Whether every entry of ours that is there is the one this version writes for this platform:
 *  false when one was written by an older version or for another shell (a Windows machine set up
 *  by 0.5, whose lines need `sh`), null when the settings cannot be read. No entry is not stale. */
export function syncHookStale(home: string, platform: NodeJS.Platform = process.platform): boolean | null {
  const settings = readSettings(claudeSettingsPath(home));
  if (settings === null) return null;
  const hooks = settings.hooks && typeof settings.hooks === "object" ? (settings.hooks as Record<string, unknown>) : {};
  return OUR_EVENTS.some((event) => {
    const groups = hooks[event];
    return Array.isArray(groups) && (groups as HookGroup[]).some((g) => ours(g) && !current(g, event, platform));
  });
}

/** Adds whichever of our entries is missing and rewrites ours where it is not what this version
 *  writes for this platform. Idempotent: a second `init` finds them and changes nothing; a machine
 *  set up before the Stop entry existed gets that one, and says "added". */
export function installSyncHook(home: string, platform: NodeJS.Platform = process.platform): HookOutcome {
  try {
    const path = claudeSettingsPath(home);
    const settings = readSettings(path);
    if (settings === null) return "unreadable_settings";
    const hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};
    const next: Record<string, unknown> = { ...hooks };
    let changed = false;
    for (const event of OUR_EVENTS) {
      const existing = hooks[event];
      if (existing !== undefined && !Array.isArray(existing)) return "unreadable_settings";
      const groups = (existing ?? []) as HookGroup[];
      if (groups.some((g) => current(g, event, platform))) continue;
      // Ours but stale: replaced in place, every other group on the event kept as it was.
      next[event] = [...groups.filter((g) => !ours(g)), { hooks: [hookEntry(event, platform)] }];
      changed = true;
    }
    if (!changed) return "present";
    writeSettings(path, { ...settings, hooks: next });
    return "added";
  } catch {
    return "failed";
  }
}

/** Removes our entries and only ours; leaves the file untouched when none is there. */
export function removeSyncHook(home: string): boolean {
  try {
    const path = claudeSettingsPath(home);
    const settings = readSettings(path);
    const hooks = settings?.hooks;
    if (!settings || !hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
    const nextHooks: Record<string, unknown> = { ...hooks };
    let removed = false;
    for (const event of OUR_EVENTS) {
      const groups = hooks[event];
      if (!Array.isArray(groups) || !(groups as HookGroup[]).some(ours)) continue;
      const kept = (groups as HookGroup[]).filter((g) => !ours(g));
      if (kept.length) nextHooks[event] = kept;
      else delete nextHooks[event];
      removed = true;
    }
    if (!removed) return false;
    const next: Settings = { ...settings, hooks: nextHooks };
    if (Object.keys(nextHooks).length === 0) delete next.hooks;
    writeSettings(path, next);
    return true;
  } catch {
    return false;
  }
}
