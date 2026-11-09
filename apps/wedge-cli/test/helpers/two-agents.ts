/**
 * One piece of SYNTHETIC work, written down the way each agent writes it (schema 2.10).
 *
 * Every word, path and command here is invented. What is real is the SHAPE: the Claude Code
 * records are the shape `claude-code.ts` was written against, and the Codex records are the shape
 * read off real rollout files on 2026-10-20 (field names and counts only):
 * `{timestamp, ordinal, type, payload}`, `event_msg/item_completed` with `UserMessage`,
 * `CommandExecution` (argv `command`, `parsed_cmd`, integer `exit_code`, `aggregated_output`) and
 * `FileChange` (`changes` keyed by path), `turn_context` with the approval and sandbox policies.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as zlib from "node:zlib";

/** zstd of a text: Node's own (22.15+), else the `zstd` binary; null when neither exists. */
export function zstd(text: string): Buffer | null {
  const z = zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer };
  if (typeof z.zstdCompressSync === "function") return z.zstdCompressSync(Buffer.from(text));
  const r = spawnSync("zstd", ["-q", "-c"], { input: text });
  return r.status === 0 ? r.stdout : null;
}

/** One step of the work, agent-neutral. */
export type Step =
  | { kind: "prompt"; text: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; lines: number }
  | { kind: "run"; command: string; exit?: number; output?: string }
  | { kind: "interrupt" };

export const CWD = "/nonexistent/deigma-two-agents";
export const CLAUDE_ID = "aaaaaaaa-1111-4222-8333-444444444444";
export const CODEX_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

const iso = (t0: number, i: number) => new Date(t0 + i * 30_000).toISOString();
const content = (n: number) => Array.from({ length: n }, (_, k) => `line ${k}`).join("\n");

/** The work as a Claude Code transcript (one file), in a fresh projects root. */
export function claudeTranscript(steps: Step[], opts: { t0?: number; mode?: string } = {}): { root: string; file: string } {
  const t0 = opts.t0 ?? Date.parse("2026-10-01T10:00:00Z");
  const mode = opts.mode ?? "default";
  const lines: string[] = [];
  const common = (i: number) => ({ timestamp: iso(t0, i), sessionId: CLAUDE_ID, cwd: CWD, gitBranch: "main" });
  steps.forEach((s, i) => {
    if (s.kind === "prompt") {
      lines.push(JSON.stringify({ type: "user", ...common(i), permissionMode: mode, promptSource: "typed", message: { role: "user", content: s.text } }));
      return;
    }
    if (s.kind === "interrupt") {
      lines.push(JSON.stringify({ type: "user", ...common(i), permissionMode: mode, interruptedMessageId: `m${i}`, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
      return;
    }
    const id = `toolu_${i}`;
    let name: string;
    let input: Record<string, unknown>;
    let result = "ok";
    let isError = false;
    if (s.kind === "read") {
      name = "Read";
      input = { file_path: `${CWD}/${s.path}` };
    } else if (s.kind === "write") {
      name = "Write";
      input = { file_path: `${CWD}/${s.path}`, content: content(s.lines) };
    } else {
      name = "Bash";
      input = { command: s.command };
      result = s.output ?? "ok";
      isError = (s.exit ?? 0) !== 0;
    }
    lines.push(
      JSON.stringify({
        type: "assistant",
        ...common(i),
        requestId: `req_${i}`,
        message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id, name, input }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "user",
        ...common(i),
        permissionMode: mode,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: isError }] },
      }),
    );
  });
  const root = mkdtempSync(join(tmpdir(), "deigma-claude-"));
  const dir = join(root, "-nonexistent-deigma-two-agents");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${CLAUDE_ID}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { root, file };
}

/** The work as a Codex rollout. `bypass`: the turn runs with no approval and no sandbox. */
export function codexRolloutLines(
  steps: Step[],
  opts: { t0?: number; bypass?: boolean; threadId?: string; approval?: unknown; plan?: boolean } = {},
): string[] {
  const t0 = opts.t0 ?? Date.parse("2026-10-01T10:00:00Z");
  const thread = opts.threadId ?? CODEX_ID;
  let ordinal = 0;
  const lines: string[] = [];
  const push = (i: number, type: string, payload: Record<string, unknown>) =>
    lines.push(JSON.stringify({ timestamp: iso(t0, i), ordinal: ordinal++, type, payload }));
  push(0, "session_meta", { session_id: thread, id: thread, timestamp: iso(t0, 0), cwd: CWD, originator: "codex-tui", cli_version: "0.0.0", source: "cli", thread_source: "user", model_provider: "openai" });
  const turn = (i: number) =>
    push(i, "turn_context", {
      turn_id: `turn-${i}`,
      cwd: CWD,
      approval_policy: opts.approval ?? (opts.bypass ? "never" : "on-request"),
      sandbox_policy: { type: opts.bypass ? "danger-full-access" : "workspace-write" },
      collaboration_mode: { mode: opts.plan ? "plan" : "default", settings: {} },
      model: "gpt-5.5-sol",
    });
  push(0, "world_state", { full: true, state: { agents_md: {} } });
  steps.forEach((s, i) => {
    const item = (it: Record<string, unknown>) => push(i, "event_msg", { type: "item_completed", thread_id: thread, turn_id: `turn-${i}`, item: it });
    if (s.kind === "prompt") {
      turn(i);
      item({ type: "UserMessage", id: `u${i}`, client_id: `c${i}`, content: [{ type: "text", text: s.text, text_elements: [] }] });
      return;
    }
    if (s.kind === "interrupt") {
      push(i, "event_msg", { type: "turn_aborted", turn_id: `turn-${i}`, reason: "interrupted" });
      return;
    }
    push(i, "token_usage_record", { response_id: `resp_${i}`, usage: { input_tokens: 110, cached_input_tokens: 100, output_tokens: 5 } });
    push(i, "response_item", { type: "custom_tool_call", call_id: `call_${i}`, name: "exec", input: "(synthetic)", status: "completed" });
    if (s.kind === "read") {
      item({ type: "CommandExecution", id: `x${i}`, command: ["/bin/zsh", "-lc", `cat ${s.path}`], cwd: ".", parsed_cmd: [{ type: "read", cmd: `cat ${s.path}`, name: s.path.split("/").pop(), path: s.path }], exit_code: 0, status: "completed", aggregated_output: "", duration: { secs: 0, nanos: 1 } });
    } else if (s.kind === "write") {
      item({ type: "FileChange", id: `f${i}`, changes: { [`${CWD}/${s.path}`]: { type: "add", content: content(s.lines) } }, status: "completed", stdout: "", stderr: "" });
    } else {
      const exit = s.exit ?? 0;
      item({ type: "CommandExecution", id: `x${i}`, command: ["/bin/zsh", "-lc", s.command], cwd: ".", parsed_cmd: [{ type: "unknown", cmd: s.command }], exit_code: exit, status: exit === 0 ? "completed" : "failed", aggregated_output: s.output ?? "ok", duration: { secs: 1, nanos: 0 } });
    }
  });
  return lines;
}

/** A `$CODEX_HOME` with one rollout, plain or zstd-compressed. */
export function codexHomeWith(lines: string[], opts: { zst?: boolean; name?: string } = {}): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "deigma-codex-"));
  const dir = join(home, "sessions", "2026", "10", "01");
  mkdirSync(dir, { recursive: true });
  const name = opts.name ?? `rollout-2026-10-01T10-00-00-${CODEX_ID}.jsonl`;
  const text = `${lines.join("\n")}\n`;
  const file = join(dir, opts.zst ? `${name}.zst` : name);
  const packed = opts.zst ? zstd(text) : null;
  if (opts.zst && !packed) throw new Error("no zstd on this machine");
  writeFileSync(file, packed ?? text);
  return { home, file };
}

/** The synthetic piece of work both agents do in the parity test. */
export const WORK: Step[] = [
  { kind: "prompt", text: "Fix the parser in parser.ts so that empty input should return an empty list, and add a test." },
  { kind: "read", path: "src/parser.ts" },
  { kind: "write", path: "src/parser.ts", lines: 40 },
  { kind: "write", path: "src/util.ts", lines: 5 },
  { kind: "write", path: "test/parser.test.ts", lines: 12 },
  { kind: "run", command: "npm test", output: "Tests: 12 passed" },
  { kind: "run", command: "git diff" },
  { kind: "run", command: 'git commit -am "parser"', output: "[main abc1234] parser\n 3 files changed" },
  { kind: "prompt", text: "no, use parseLine() in parser.ts instead" },
  { kind: "write", path: "src/parser.ts", lines: 200 },
  { kind: "run", command: "rm -rf src/legacy" },
  { kind: "run", command: "npm install left-pad" },
  { kind: "run", command: "npm audit" },
  { kind: "run", command: "npx vitest run", output: "FAIL src/parser.test.ts\n 1 failed" , exit: 1 },
  { kind: "run", command: 'git commit -am "parse lines"', output: "[main def5678] parse lines" },
];
