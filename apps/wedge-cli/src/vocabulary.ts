/**
 * What a tool may be called on the wire.
 *
 * `tool_calls` is keyed by tool name, and the schema constrains those keys to nothing at all
 * (`z.record(z.string(), nonNegativeInt)`). For built-in tools that is harmless — the names are a
 * closed vocabulary that says nothing about anybody. MCP tools are different: the user names the
 * server, and `mcp__acme-billing__query` is an employer and an internal system travelling in a
 * 6.5 KB packet. Zero Content Leakage covers that as much as it covers a prompt.
 *
 * So the rule is an ALLOW-LIST, the same shape as the one the server keeps for its GitHub calls and for the
 * same reason: a deny-list protects against the names somebody thought of; an allow-list protects
 * against the ones nobody has thought of yet, which is the kind that arrives with the next
 * release. A name on the list travels as itself. Everything else — MCP tools, tools a future
 * version adds, tools another agent defines — is hashed on the device with the user's own salt.
 *
 * What survives hashing is what the measurement actually needs: the COUNT of distinct tools (the
 * `mcp_tool_diversity` component of E-1.0) and the counts per tool. What does not survive is the
 * dictionary, which was never an input to anything — the pipeline reads `sum(tool_calls.values())`
 * and nothing else.
 */

import { contentHash } from "@mentat/wedge-core";

/**
 * Built-in tool names, as observed on real transcripts (2026-09-07) plus the rest of the
 * documented set. Adding a name here is a decision that it says nothing about the person — which
 * is exactly the review a permission change gets.
 */
const BUILT_IN: ReadonlySet<string> = new Set([
  // file and shell
  "Bash",
  "BashOutput",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "KillShell",
  // web
  "WebFetch",
  "WebSearch",
  // agents, tasks and orchestration
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Workflow",
  "SendMessage",
  "ListAgents",
  "Skill",
  "ToolSearch",
  "StructuredOutput",
  // session and environment
  "TodoWrite",
  "ExitPlanMode",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "Monitor",
  "ScheduleWakeup",
  "SendUserFile",
  "Artifact",
  "AskUserQuestion",
  "ReportFindings",
  "PushNotification",
  "CronCreate",
  "CronList",
  "CronDelete",
  "RemoteTrigger",
  "EndConversation",
  "SlashCommand",
  // Codex (schema 2.10): `exec` was confirmed on a real Codex journal (2026-10-20); the rest are
  // Codex's documented built-in tools. None is named by a person.
  "exec",
  "apply_patch",
  "shell",
  "update_plan",
  "view_image",
  "web_search",
  "write_stdin",
]);

/** How much of the hash travels. Enough that two different tools do not collide in one person's
 *  history, short enough that it reads as an opaque token rather than as a key. */
const HASH_CHARS = 12;

export function isBuiltInTool(name: string): boolean {
  return BUILT_IN.has(name);
}

/**
 * The name a tool travels under.
 *
 * Built-in: itself. Anything else: `tool:<salted hash>` — stable for one person (so counting and
 * diversity work) and meaningless to anyone else (so the server never learns that somebody's
 * employer is called acme-billing). The salt stays on the device, which is what makes the hash
 * un-reversible by us and not merely obscure.
 */
export function wireToolName(name: string, salt: string): string {
  if (isBuiltInTool(name)) return name;
  return `tool:${contentHash(name, salt).slice(0, HASH_CHARS)}`;
}

/** `tool_calls` as it may leave the device. Counts are unchanged; only the keys are rewritten. */
export function wireToolCalls(
  toolCalls: Record<string, number>,
  salt: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(toolCalls)) {
    const key = wireToolName(name, salt);
    // Two distinct names cannot collide under a good hash, but a built-in and a hash never can
    // either — so this is an accumulation, not an overwrite, and stays correct if one ever did.
    out[key] = (out[key] ?? 0) + n;
  }
  return out;
}
