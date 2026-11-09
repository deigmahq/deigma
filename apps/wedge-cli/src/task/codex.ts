/**
 * The Codex sessions of the task folder, read as events that carry text. The counterpart of
 * ./claude.ts, and held to the same rules:
 * this is the reader for a task the person took and attached after a yes, not the personal card's
 * (../journals/codex.ts), and it opens a rollout only far enough to see the working directory it
 * was started in before it drops it if that is not the task folder.
 *
 * The shape was read off real rollout files (2026-11-08, field names and counts only):
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (or `.jsonl.zst`), one thread per file, each
 * line `{timestamp, ordinal, type, payload}`. What this reader uses, and nothing else:
 *
 *   session_meta                       payload.cwd — where the thread was started
 *   event_msg / item_completed         payload.item, by its type:
 *     UserMessage                      content[].text — what the person typed
 *     AgentMessage                     content[].text — what the agent said (commentary and the final answer)
 *     CommandExecution                 command (argv), aggregated_output, exit_code, status — a shell call and its result
 *     FileChange                       changes: {path: {type, content | unified_diff}}, status, stdout, stderr
 *
 * The model's own tool calls (`response_item`, the `exec` of Codex's code mode) are not read: the
 * commands they run arrive as `CommandExecution` items, which carry the command line and what it
 * printed, and a file change arrives as `FileChange`. Reasoning is not read. A Codex tool whose
 * item has not been seen on a real file (a plan update, an MCP call, a search) is not read either:
 * its session still has the person's prompts, the agent's replies and every command and change.
 */
import type { TaskEventKind } from "@mentat/schemas";

import { codexSessionFiles, decompressZstd } from "../journals/codex";
import { forEachLine } from "../journals/lines";
import { isInFolder } from "./folder";
import type { Budget } from "./prepare";
import { codexChangeText, codexCommandText, codexResultText } from "./render";
import type { Normalizer } from "./text";
import type { FolderEvent, FolderRead } from "./types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Every line of a rollout, with the means to stop early. False when the file could not be read. */
function eachLine(file: string, onLine: (line: string) => boolean | void): boolean {
  if (/\.zst$/i.test(file)) {
    const text = decompressZstd(file);
    if (text === null) return false;
    let start = 0;
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
      if (onLine(text.slice(start, nl)) === false) return true;
      start = nl + 1;
    }
    if (start < text.length) onLine(text.slice(start));
    return true;
  }
  return forEachLine(file, onLine);
}

/** The text of an item's `content`: its blocks' `text`, joined. */
function contentText(item: Obj): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => str(obj(block)?.text) ?? "")
    .filter((part) => part !== "")
    .join("\n");
}

/** Every Codex session of the task folder, oldest first, with how many files could not be read. */
export function readCodexFolderSessions(input: {
  codexDir: string;
  folders: readonly string[];
  normalize: Normalizer;
  budget: Budget;
}): FolderRead {
  const sessions: FolderRead["sessions"] = [];
  let unreadable = 0;
  let stopped = false;

  for (const file of codexSessionFiles(input.codexDir)) {
    if (stopped) break;
    const events: FolderEvent[] = [];
    let member: boolean | null = null; // null until the thread says where it was started

    const push = (at: string, kind: TaskEventKind, text: string, tool?: string) => {
      if ((kind === "prompt" || kind === "reply") && text.trim() === "") return;
      const event: FolderEvent = { at, kind, ...(tool ? { tool } : {}), text: input.normalize(text, kind) };
      events.push(event);
      if (!input.budget.add(event)) stopped = true;
    };

    const opened = eachLine(file, (line) => {
      if (stopped) return false;
      if (!line.trim()) return;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        return; // a partial last line is normal in a journal still being written
      }
      const r = obj(rec);
      if (!r) return;
      const payload = obj(r.payload) ?? {};

      if (member === null && (r.type === "session_meta" || r.type === "turn_context")) {
        const cwd = str(payload.cwd);
        if (cwd) member = isInFolder(cwd, input.folders);
        if (member === false) return false; // another folder's thread: nothing more of it is read
        return;
      }
      if (member !== true || r.type !== "event_msg" || payload.type !== "item_completed") return;

      const ms = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      if (!Number.isFinite(ms)) return; // a record with no time cannot be placed in the order
      const at = new Date(ms).toISOString();
      const item = obj(payload.item) ?? {};

      switch (item.type) {
        case "UserMessage":
          push(at, "prompt", contentText(item));
          break;
        case "AgentMessage":
          push(at, "reply", contentText(item));
          break;
        case "CommandExecution": {
          const exit = typeof item.exit_code === "number" ? item.exit_code : null;
          const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
          push(at, "tool_call", codexCommandText(item.command), "shell");
          push(at, "tool_result", item.status === "declined" && output === "" ? "declined" : codexResultText(output, exit), "shell");
          break;
        }
        case "FileChange": {
          const changes = obj(item.changes) ?? {};
          for (const [path, change] of Object.entries(changes)) {
            push(at, "tool_call", codexChangeText(path, change), "apply_patch");
          }
          const printed = [str(item.stdout), str(item.stderr)].filter((s): s is string => s !== null).join("\n");
          push(at, "tool_result", printed || (str(item.status) ?? "completed"), "apply_patch");
          break;
        }
        default:
          break; // Reasoning and every item not seen on a real file
      }
    });

    if (!opened) {
      unreadable += 1;
      continue;
    }
    if (member !== true || events.length === 0) continue;
    sessions.push({ agent: "codex", startedAt: events[0]!.at, events });
  }
  return { sessions: sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt)), unreadable, overBudget: stopped };
}
