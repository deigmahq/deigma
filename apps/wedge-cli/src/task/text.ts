/**
 * The text of one event of a task session, from the journal's string to the string that may leave
 * (packages/schemas/src/task.ts).
 *
 * Everything that happens to a text happens here, in this order, and nowhere else:
 *
 *   1. made well-formed: a lone surrogate half becomes U+FFFD and a NUL is dropped, so the text can
 *      be sealed and shown;
 *   2. a tool's own colour codes are dropped (tool results only): `\x1b[31m` is not something the
 *      person or the agent said;
 *   3. every string of the task's redact list is replaced by the placeholder the server gives for it,
 *      BEFORE the text is cut, so a cut can never leave half of a listed string;
 *   4. paths: the task folder is written `.` and the home directory `~`, so the operating-system user
 *      name does not travel and a path reads the same on every machine (`./src/app.py`);
 *   5. the text is cut to size: the schema allows 8 000 characters per event and the cut leaves room
 *      for its marker. A result keeps its start and its end, everything else keeps its start.
 *
 * The secret scanner runs on the cut text of the FIRST tier, which holds every character a smaller
 * tier can keep, so a text that passed is clean at every size it may be sent in.
 */
import { TASK_LIMITS, type TaskEventKind } from "@mentat/schemas";

/** A text cut to size: what is kept of its start, of its end, and how many characters lay between. */
export type CutText = { head: string; tail: string; cut: number };

/** How much of a text each size of the upload keeps. */
export type Limits = { other: number; resultHead: number; resultTail: number };

/**
 * The sizes an upload is tried at, largest first. The first fits almost every session; a longer
 * one is cut harder, all at once and the same way, until it fits the budget. Each leaves room for
 * the cut marker inside `TASK_LIMITS.eventText` (held by a test).
 */
export const CUT_TIERS: readonly Limits[] = [
  { other: 7_900, resultHead: 5_400, resultTail: 2_400 },
  { other: 3_000, resultHead: 1_500, resultTail: 500 },
  { other: 1_000, resultHead: 400, resultTail: 200 },
];

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The characters that must not end or start a kept piece, and the pairs that must stay whole. */
function trimmed(head: string, tail: string): { head: string; tail: string } {
  const h = head && isHighSurrogate(head.charCodeAt(head.length - 1)) ? head.slice(0, -1) : head;
  const t = tail && isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
  return { head: h, tail: t };
}

function cut(text: string, headLength: number, tailLength: number): CutText {
  if (text.length <= headLength + tailLength) return { head: text, tail: "", cut: 0 };
  const kept = trimmed(text.slice(0, headLength), tailLength > 0 ? text.slice(text.length - tailLength) : "");
  return { ...kept, cut: text.length - kept.head.length - kept.tail.length };
}

export function limitsFor(kind: TaskEventKind, limits: Limits): { head: number; tail: number } {
  return kind === "tool_result"
    ? { head: limits.resultHead, tail: limits.resultTail }
    : { head: limits.other, tail: 0 };
}

export function cutText(text: string, kind: TaskEventKind, limits: Limits): CutText {
  const { head, tail } = limitsFor(kind, limits);
  return cut(text, head, tail);
}

/** A text that was cut once, cut again at a smaller size: exact, and the marker does not nest. */
export function recut(text: CutText, kind: TaskEventKind, limits: Limits): CutText {
  const { head, tail } = limitsFor(kind, limits);
  if (text.cut === 0) return cut(text.head, head, tail);
  const kept = trimmed(text.head.slice(0, head), tail > 0 ? text.tail.slice(Math.max(0, text.tail.length - tail)) : "");
  return {
    ...kept,
    cut: text.cut + (text.head.length - kept.head.length) + (text.tail.length - kept.tail.length),
  };
}

/** The string that travels: the kept start, a marker saying how much was cut, the kept end. */
export function renderCut(text: CutText): string {
  if (text.cut === 0) return text.head;
  const marker = `\n[... ${text.cut} characters cut ...]`;
  return text.tail ? `${text.head}${marker}\n${text.tail}` : `${text.head}${marker}`;
}

// ---- the normalizer ----------------------------------------------------------------------------

/** A lone half of a surrogate pair: not a character, and JSON would write it as an escape no
 *  decoder has to accept. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** A terminal control sequence (CSI): colours, cursor moves. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const NUL = /\u0000/g;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `(?<![name chars])path(?![name chars])`: a path, not the start of a longer name. */
function pathPattern(paths: readonly string[]): RegExp | null {
  const unique = [...new Set(paths.filter((p) => p.length > 1))].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return null;
  // A Windows path names the same folder in any case (NTFS), and Claude Code's own records spell
  // one cwd as both C:\ and c:\: there the match ignores case.
  const flags = unique.some((p) => WINDOWS_DRIVE.test(p)) ? "gi" : "g";
  return new RegExp(`(?<![A-Za-z0-9._~-])(?:${unique.map(escapeRegExp).join("|")})(?![A-Za-z0-9._-])`, flags);
}

const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]/;

/** The ways a path is written: as given, and with forward slashes; a Windows path also as Git Bash
 *  writes it (/c/Users/…), as WSL does (/mnt/c/Users/…) and with its backslashes doubled, as a
 *  JSON or a shell string carries it. */
function spellings(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  const forward = trimmed.replace(/\\/g, "/");
  const drive = WINDOWS_DRIVE.exec(trimmed);
  if (!drive) return [trimmed, forward];
  const rest = forward.slice(2);
  const letter = drive[1]!.toLowerCase();
  return [trimmed, forward, trimmed.replace(/\\/g, "\\\\"), `/${letter}${rest}`, `/mnt/${letter}${rest}`];
}

export type Replacement = { text: string; replaceWith: string };

export type Normalizer = (raw: string, kind: TaskEventKind) => CutText;

/**
 * The normalizer of one run: what to replace, where the task folder is and where home is. `folders`
 * and `homes` are the spellings of the task folder and of the home directory (the path given, and
 * its real path); there is no home to hide where `homes` is empty.
 */
export function makeNormalizer(input: {
  redact: readonly Replacement[];
  folders: readonly string[];
  homes: readonly string[];
  limits?: Limits;
}): Normalizer {
  const limits = input.limits ?? CUT_TIERS[0]!;
  // Longest first: a key that contains another redact string is replaced whole.
  const redact = [...input.redact].filter((r) => r.text.length > 0).sort((a, b) => b.text.length - a.text.length);
  const folder = pathPattern(input.folders.flatMap(spellings));
  const home = pathPattern(input.homes.flatMap(spellings));
  return (raw, kind) => {
    let text = raw.replace(LONE_SURROGATE, "�").replace(NUL, "");
    if (kind === "tool_result") text = text.replace(ANSI, "");
    for (const { text: secret, replaceWith } of redact) text = text.split(secret).join(replaceWith);
    if (folder) text = text.replace(folder, ".");
    if (home) text = text.replace(home, "~");
    return cutText(text, kind, limits);
  };
}

/** The size a cut text has on the wire, for the budget: the rendered text, as JSON would write it. */
export function renderedLength(text: CutText): number {
  return renderCut(text).length;
}

/** The longest an event's text may be. */
export const EVENT_TEXT_LIMIT = TASK_LIMITS.eventText;
