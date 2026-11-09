/**
 * What a tool call and a tool result say, as the text of an event (packages/schemas/src/task.ts,
 * "THE NORMALIZED SESSION"). The conventions:
 *
 *   * a shell tool: the command line as it was run;
 *   * a tool that writes a file: the path on the FIRST line, then what the call wrote (the new
 *     text); a patch (Codex's `apply_patch`) names its files inside it, in the envelope's own words;
 *   * any other tool: its arguments, briefly, one `name: value` per line, every string as it is
 *     (never JSON-escaped, so the secret scanner sees what the person would see);
 *   * a result: what the tool printed, and a command that did not exit 0 starts with
 *     `exit code <n>`.
 *
 * Nothing here chooses what to keep: the cut to size is `./text`.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Claude Code's own edit tools, and the field that holds the path. */
const WRITES_A_FILE = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash"]);

/** A value as lines of text: strings as they are, lists one item to a line, objects `name: value`. */
export function flatten(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flatten).filter((line) => line !== "").join("\n");
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([name, inner]) => {
        const text = flatten(inner);
        return text === "" ? "" : `${name}: ${text}`;
      })
      .filter((line) => line !== "")
      .join("\n");
  }
  return "";
}

/** The text of a Claude Code tool call. */
export function claudeToolCallText(tool: string, input: unknown): string {
  const args = isRecord(input) ? input : {};
  if (SHELL_TOOLS.has(tool)) return str(args.command) ?? flatten(input);
  if (tool === "ExitPlanMode") return str(args.plan) ?? flatten(input);
  if (WRITES_A_FILE.has(tool)) {
    const path = str(args.file_path) ?? str(args.notebook_path) ?? str(args.path) ?? "";
    let wrote: string;
    if (tool === "Write") wrote = str(args.content) ?? "";
    else if (tool === "Edit") wrote = str(args.new_string) ?? "";
    else if (tool === "NotebookEdit") wrote = str(args.new_source) ?? "";
    else {
      // MultiEdit: every replacement's new text, one after another.
      const edits = Array.isArray(args.edits) ? args.edits : [];
      wrote = edits
        .map((e) => (isRecord(e) ? (str(e.new_string) ?? "") : ""))
        .filter((s) => s !== "")
        .join("\n\n");
    }
    return wrote ? `${path}\n${wrote}` : path;
  }
  if (tool === "Read") return str(args.file_path) ?? flatten(input);
  if (tool === "TodoWrite" && Array.isArray(args.todos)) {
    return args.todos
      .map((t) => (isRecord(t) ? `[${str(t.status) ?? "pending"}] ${str(t.content) ?? ""}`.trimEnd() : ""))
      .filter((line) => line !== "")
      .join("\n");
  }
  return flatten(input);
}

/** What a tool printed: a string, or the text blocks of a list (an image is named, not carried). */
export function resultContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * A Claude Code result. A shell command that failed starts with `Exit code <n>` in the journal;
 * the convention of the task is lower case, and nothing else about the text is touched. A result
 * that is an error of another kind (a call the person refused, a file that is not there) keeps its
 * own words: there was no exit code to state.
 */
export function claudeResultText(tool: string | undefined, content: unknown, isError: boolean): string {
  const text = resultContentText(content);
  if (isError && tool !== undefined && SHELL_TOOLS.has(tool)) return text.replace(/^Exit code (\d+)/, "exit code $1");
  return text;
}

/** The text of a Codex shell command: `[shell, -lc, script]` is the script; anything else is its
 *  arguments joined — the command line as it was run. */
export function codexCommandText(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const argv = command.filter((x): x is string => typeof x === "string");
  if (argv.length >= 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) {
    return argv.slice(2).join(" ");
  }
  return argv.join(" ");
}

/** A Codex shell result: what the command printed, and `exit code <n>` first when it did not exit 0. */
export function codexResultText(output: string, exitCode: number | null): string {
  return exitCode !== null && exitCode !== 0 ? `exit code ${exitCode}\n${output}`.trimEnd() : output;
}

/**
 * A Codex file change, in the words of Codex's own patch envelope: `*** Update File: <path>` (or
 * `Add` / `Delete`) on the first line, then what it wrote — the patch of an update, the whole text
 * of a new file. A patch names its files inside it, and this is how Codex's `apply_patch` does.
 */
export function codexChangeText(path: string, change: unknown): string {
  const c = isRecord(change) ? change : {};
  const type = str(c.type);
  const verb = type === "add" ? "Add" : type === "delete" ? "Delete" : "Update";
  const header = `*** ${verb} File: ${path}`;
  const body = str(c.unified_diff) ?? str(c.diff) ?? str(c.content) ?? "";
  return body ? `${header}\n${body}` : header;
}
