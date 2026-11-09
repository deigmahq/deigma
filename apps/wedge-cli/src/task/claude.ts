/**
 * The Claude Code sessions of the task folder, read as events that carry text.
 *
 * This is NOT the reader behind the personal card (../journals/claude-code.ts): that one reads a
 * prompt, a command or a result in memory and keeps a count; it must never hand text to anyone.
 * This one exists for the one case where text may leave the device — a task the person took for
 * one company, attached by them after a yes — and so it is held to the folder: it opens
 * the project folders Claude Code keeps for THIS working directory and for the ones below it, never
 * another project's, and it decides on the journal's own `cwd` (the folder name Claude Code gives a
 * project is lossy: `/a/b-c` and `/a/b/c` are the same name).
 *
 * The shape was read off real journals (2026-11-08, field names and counts only): one transcript
 * file per session, `<uuid>.jsonl` under `~/.claude/projects/<working directory, every character
 * that is not a letter or a digit written as "-">/`; subagent transcripts under
 * `<uuid>/subagents/`; records `{type, uuid, timestamp, cwd, message}` where `user` records hold
 * the person's prompt (a string, or text blocks) or the results of tool calls, and `assistant`
 * records hold `text`, `thinking` and `tool_use` blocks. Everything else in the file — attachments,
 * `api-request-blob` copies of the requests, titles, links, snapshots — is not read, and neither
 * is `thinking`.
 *
 * What is a prompt is the personal reader's own rule (`userTurnKind`): a turn the person typed, or
 * accepted from the tool's suggestion; a background task's notification, a hook's note and the
 * tool's frames are not. A slash command the person ran is a prompt too (`/plan rename the loader`).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { TaskEventKind } from "@mentat/schemas";

import { carriesPromptSource, subagentFiles, userTurnKind, type Rec } from "../journals/claude-code";
import { forEachLine } from "../journals/lines";
import { claudeProjectName, isInFolder } from "./folder";
import type { Budget } from "./prepare";
import { claudeResultText, claudeToolCallText } from "./render";
import type { Normalizer } from "./text";
import type { FolderEvent, FolderRead, FolderSession } from "./types";

const TRANSCRIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
/** The longest tool name the schema accepts (`TASK_LIMITS.toolName`). */
const TOOL_NAME_MAX = 64;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

/** A record that a prompt may be withdrawn from, once the transcript turns out to be tagged. */
type Pending = { ms: number; seq: number; byFrame: boolean; event: FolderEvent };

type Context = {
  folders: readonly string[];
  normalize: Normalizer;
  /** Record ids already seen in any transcript of this run: a resumed session that copied its
   *  history into a new file does not say it twice. */
  seen: Set<string>;
  seq: number;
  /** Counts what is read against what an upload may hold; the read stops when that is spent. */
  budget: Budget;
  stopped: boolean;
};

/** The project folders Claude Code keeps for the task folder and for the folders below it. */
export function claudeProjectDirs(root: string, folders: readonly string[]): string[] {
  const wanted = folders.map(claudeProjectName);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return []; // no Claude Code on this machine: not an error, just nothing to read
  }
  return names
    .filter((name) => wanted.some((w) => name === w || name.startsWith(`${w}-`)))
    .sort()
    .map((name) => join(root, name));
}

function transcriptsIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => TRANSCRIPT.test(name))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** The text blocks of a message, joined; a plain string is itself. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = obj(block);
      return b && b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

/** `/plan rename the loader` out of the frame Claude Code writes for a slash command the person ran. */
function slashCommand(text: string): string | null {
  const lead = text.trimStart();
  if (!lead.startsWith("<command-name>") && !lead.startsWith("<command-message>")) return null;
  const name = /<command-name>\s*(\/?[\w:.-]+)\s*<\/command-name>/.exec(lead)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(lead)?.[1]?.trim();
  const command = name.startsWith("/") ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

type Read = { events: Pending[]; tagged: boolean; member: boolean; opened: boolean };

function readFile(file: string, ctx: Context, own: boolean): Read {
  const events: Pending[] = [];
  const toolNames = new Map<string, string>();
  let tagged = false;
  // A subagent's transcript belongs to the session it sits under; a session's own is judged by the
  // working directory its first record names.
  let decided = !own;
  let member = !own;

  const push = (ms: number, kind: TaskEventKind, text: string, tool?: string, byFrame = false) => {
    // A prompt or a reply with nothing in it is not an event; a result with nothing in it still is
    // (the command ran and printed nothing).
    if (kind !== "tool_result" && kind !== "tool_call" && text.trim() === "") return;
    const cut = ctx.normalize(text, kind);
    ctx.seq += 1;
    const event: FolderEvent = {
      at: new Date(ms).toISOString(),
      kind,
      ...(tool ? { tool: tool.slice(0, TOOL_NAME_MAX) } : {}),
      text: cut,
    };
    events.push({ ms, seq: ctx.seq, byFrame, event });
    if (!ctx.budget.add(event)) ctx.stopped = true;
  };

  const opened = forEachLine(file, (line) => {
    if (ctx.stopped) return false;
    if (!line.trim()) return;
    let rec: Rec & Obj;
    try {
      rec = JSON.parse(line) as Rec & Obj;
    } catch {
      return; // a partial last line is normal in a journal still being written
    }
    if (!obj(rec)) return;
    if (!decided && typeof rec.cwd === "string" && rec.cwd) {
      decided = true;
      member = isInFolder(rec.cwd, ctx.folders);
      if (!member) return false; // another folder's session: nothing more of it is read
    }
    if (carriesPromptSource(rec)) tagged = true;
    if (rec.type !== "user" && rec.type !== "assistant") return;
    if (!decided) return; // a record before the file says where it is: not placed
    const uuid = typeof rec.uuid === "string" ? rec.uuid : null;
    if (uuid) {
      if (ctx.seen.has(uuid)) return;
      ctx.seen.add(uuid);
    }
    const ms = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isFinite(ms)) return; // a record with no time cannot be placed in the order

    const message = obj(rec.message);
    const content = message?.content;

    if (rec.type === "assistant") {
      // The harness's own notes ("[Request interrupted…]", API errors) are written as the agent's.
      if (message?.model === "<synthetic>" || !Array.isArray(content)) return;
      for (const block of content) {
        const b = obj(block);
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string") push(ms, "reply", b.text);
        else if (b.type === "tool_use" && typeof b.name === "string") {
          if (typeof b.id === "string") toolNames.set(b.id, b.name);
          push(ms, "tool_call", claudeToolCallText(b.name, b.input), b.name);
        }
      }
      return;
    }

    // user: what the tools answered, then what the person said.
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = obj(block);
        if (!b || b.type !== "tool_result") continue;
        const tool = typeof b.tool_use_id === "string" ? toolNames.get(b.tool_use_id) : undefined;
        push(ms, "tool_result", claudeResultText(tool, b.content, b.is_error === true), tool);
      }
    }
    const typed = userTurnKind(rec, false);
    if (typed !== null) {
      // `typed` here means "typed unless the transcript turns out to be tagged": a record that
      // carries neither field is the person's only by the frame of its text (userTurnKind).
      const certain = userTurnKind(rec, true) !== null;
      push(ms, "prompt", textOf(content), undefined, !certain);
      return;
    }
    if (rec.isMeta !== true && rec.isSidechain !== true) {
      const command = slashCommand(textOf(content));
      if (command) push(ms, "prompt", command);
    }
  });
  return { events, tagged, member, opened };
}

/** Every Claude Code session of the task folder, oldest first, with what could not be read. */
export function readClaudeFolderSessions(input: {
  projectsRoot: string;
  folders: readonly string[];
  normalize: Normalizer;
  budget: Budget;
}): FolderRead {
  const ctx: Context = {
    folders: input.folders,
    normalize: input.normalize,
    seen: new Set(),
    seq: 0,
    budget: input.budget,
    stopped: false,
  };
  const sessions: FolderSession[] = [];
  let unreadable = 0;
  for (const dir of claudeProjectDirs(input.projectsRoot, input.folders)) {
    for (const file of transcriptsIn(dir)) {
      if (ctx.stopped) break;
      const main = readFile(file, ctx, true);
      if (!main.opened) {
        unreadable += 1;
        continue;
      }
      if (!main.member) continue;
      const parts = [main, ...subagentFiles(file).files.map((f) => readFile(f, ctx, false))];
      const events = parts
        .flatMap((p) => (p.tagged ? p.events.filter((e) => !e.byFrame) : p.events))
        .sort((a, b) => a.ms - b.ms || a.seq - b.seq)
        .map((e) => e.event);
      if (events.length === 0) continue;
      sessions.push({ agent: "claude_code", startedAt: events[0]!.at, events });
    }
  }
  return {
    sessions: sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    unreadable,
    overBudget: ctx.stopped,
  };
}
