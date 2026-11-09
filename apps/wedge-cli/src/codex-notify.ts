/**
 * The Codex `notify` entry that keeps the index moving for Codex sessions (schema 2.10).
 *
 * Codex has no "session ended" hook. What it has is ONE `notify` program in
 * `$CODEX_HOME/config.toml` (default ~/.codex), run at the end of every turn. So:
 *
 *   * `init` adds ours ONLY when `notify` is absent. A person who already runs a notify program
 *     keeps it untouched — there is room for one — and is told in one line that Codex sessions are
 *     then read on `deigma sync`, `status` and `pulse`, and by the Claude Code hook if it is there;
 *   * the entry is a quiet background `deigma sync`, throttled to at most once an hour by a stamp
 *     file, because it fires on every turn and the sync reads only sessions that already ended;
 *   * the file is edited minimally: two lines (a marker comment and the key) go at the top, where a
 *     top-level TOML key must be, and nothing else in the file is rewritten; ours is recognised by
 *     `NOTIFY_MARK` and `logout` removes exactly those two lines;
 *   * nothing is created where Codex is not installed (no $CODEX_HOME directory), `--no-hook` skips
 *     it, and a file we cannot read is never written.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Recognises our entry; nothing a person writes by hand would contain it. */
export const NOTIFY_MARK = "deigma-sync-notify";
/** The stamp the throttle reads, in the CLI's own config directory. */
export const NOTIFY_STAMP = "codex-notify.stamp";
/** At most one sync per this many minutes from Codex turns. */
export const NOTIFY_THROTTLE_MINUTES = 60;

export function codexConfigPath(codexDir: string): string {
  return join(codexDir, "config.toml");
}

/** The shell script `notify` runs. Codex appends one JSON argument (the turn's notification); it
 *  is never read. `find -newermt` is not portable, `find -mmin` is (macOS and Linux): an empty
 *  answer means the stamp is missing or older than the throttle. */
export function notifyScript(configDir: string): string {
  const stamp = shellQuote(join(configDir, NOTIFY_STAMP));
  return (
    `s=${stamp}; ` +
    `if [ -z "$(find "$s" -mmin -${NOTIFY_THROTTLE_MINUTES} 2>/dev/null)" ]; then ` +
    `mkdir -p "$(dirname "$s")" && touch "$s" && (npx --yes deigma sync >/dev/null 2>&1 &); fi`
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A TOML basic string. JSON's escapes are a subset of TOML's for every character we emit. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

/** The two lines `init` adds: the marker comment and the key. */
export function notifyLines(configDir: string): string[] {
  return [
    `# ${NOTIFY_MARK}: added by \`npx deigma init\` — reads ended Codex sessions; \`deigma logout\` removes it`,
    `notify = [${["sh", "-c", notifyScript(configDir), NOTIFY_MARK].map(tomlString).join(", ")}]`,
  ];
}

/** The top-level `notify` key, if any: a `notify =` line before the first table header. */
function topLevelNotify(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*\[/.test(l)) return -1;
    if (/^\s*notify\s*=/.test(l)) return i;
  }
  return -1;
}

function readConfig(path: string): string | null | "missing" {
  if (!existsSync(path)) return "missing";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.deigma-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export type NotifyOutcome = "added" | "present" | "taken" | "no_codex" | "unreadable_config" | "failed";

/** Whether our entry is in place (true), another program holds `notify` ("taken"), it is free
 *  (false), or the file cannot be read / Codex is not here (null). */
export function codexNotifyState(codexDir: string): true | false | "taken" | null {
  if (!isDir(codexDir)) return null;
  const text = readConfig(codexConfigPath(codexDir));
  if (text === null) return null;
  if (text === "missing") return false;
  const lines = text.split("\n");
  const at = topLevelNotify(lines);
  if (at < 0) return false;
  return lines[at]!.includes(NOTIFY_MARK) ? true : "taken";
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Adds the entry once, only where `notify` is free. Idempotent. */
export function installCodexNotify(codexDir: string, configDir: string): NotifyOutcome {
  try {
    if (!isDir(codexDir)) return "no_codex";
    const path = codexConfigPath(codexDir);
    const text = readConfig(path);
    if (text === null) return "unreadable_config";
    const body = text === "missing" ? "" : text;
    const lines = body.split("\n");
    const at = topLevelNotify(lines);
    if (at >= 0) return lines[at]!.includes(NOTIFY_MARK) ? "present" : "taken";
    // Top-level keys go before the first table: at the very top, the rest of the file untouched.
    const head = notifyLines(configDir).join("\n");
    write(path, body.length ? `${head}\n${body}` : `${head}\n`);
    return "added";
  } catch {
    return "failed";
  }
}

/** Removes our two lines and only those; leaves the file untouched when they are not there. */
export function removeCodexNotify(codexDir: string): boolean {
  try {
    const path = codexConfigPath(codexDir);
    const text = readConfig(path);
    if (text === null || text === "missing") return false;
    const lines = text.split("\n");
    const at = topLevelNotify(lines);
    if (at < 0 || !lines[at]!.includes(NOTIFY_MARK)) return false;
    const drop = new Set([at]);
    if (at > 0 && lines[at - 1]!.startsWith(`# ${NOTIFY_MARK}`)) drop.add(at - 1);
    write(path, lines.filter((_, i) => !drop.has(i)).join("\n"));
    return true;
  } catch {
    return false;
  }
}
