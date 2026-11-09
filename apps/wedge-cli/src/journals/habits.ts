// Habit traces (Engine Core 7 §4), counted on this machine from the agent's own journal.
//
// The rules are public and versioned (`HB_RULES.version` travels on the wire as `rules_version`),
// so a person can read here exactly what was counted. What a rule LOOKS AT — the text of a prompt,
// the path of a file the agent opened — is read in memory and dropped; what travels is two counts
// per trace: how many times the session offered the occasion, and how many times the person did
// the thing. A trace with no occasion travels as null, never as "0 of 0".
//
//   T1 names_files      occasion: a typed prompt after which the agent opened or edited a file
//                       before the next typed prompt; hit: the prompt names one of those files
//   T3 plan_before_edit occasion: a session in which the agent edited something (one per session);
//                       hit: plan mode, or a typed request for a plan, before the agent's first edit
//   T4 diff_before_commit occasion: a commit the agent ran; hit: since the previous commit (or the
//                       start), the person asked to see or explain the changes
//   T7 located_corrections occasion: a typed correction (the prompt-history rule ph-1.0: a short
//                       prompt soon after the previous one whose first word corrects); hit: it
//                       names a place — a file, a line, a function
//
// The definitions were measured on SWE-chat.
//
// Rules hb-2.0 add thirteen-trace numbering: the practices the labs
// recommend, each counted from what HAPPENED — a tool call, a command's class, an exit status, git
// on this machine — never from the wording of a prompt. The exceptions are T1 (names_files) and
// saw_diff_before_commit, where the person asking for the changes counts too. Every command is
// classified on the device by the regex lists below and dropped; what travels is integer pairs.
//
//   1  security_review      occasion: a session in which the agent edited code; hit: /security-review
//                           (or the review skill) or a subagent whose subagent_type names security,
//                           after the first edit
//   2  dependency_audit     occasion: a session in which a lock/manifest file changed (an edit tool on
//                           one, or a package-manager add/remove command); hit: an audit command ran
//   3  no_secrets           occasion: a commit the agent ran whose sha the result shows and whose
//                           added lines `git show` can read on this machine; hit: the device's secret
//                           patterns find nothing in them
//   4  permissions_on       occasion: a session with a tool call whose permission mode is visible;
//                           hit: never in bypassPermissions mode, or the cwd is a dev container
//   5  risky_confirmed      occasion: a risky command that actually ran (not one the person refused);
//                           hit: permissions were on at that moment
//   6  tests_after_edit     occasion: edits, then a commit that succeeded; hit: a test or build ran
//                           after the last edit before the final commit
//   7  tests_with_code      occasion: a commit after the agent edited code; hit: it also edited tests
//   8  saw_diff_before_commit occasion: a commit that succeeded; hit: git diff/show/status -v ran, or
//                           the person asked for the changes, since the previous commit
//   9  independent_review   occasion: edits totalling >= 200 changed lines; hit: reviewer subagent
//                           or /review after the first edit
//  10  explore_before_edit  occasion: a session with edits; hit: Read/Grep/Glob/LS (or a read-only
//                           shell lookup, or an Explore subagent) before the first edit
//  11  plan_complex         occasion: edits to >= 3 files; hit: plan mode, or the agent's own task
//                           list (TodoWrite), before the first edit
//  12  names_files          (T1)
//  13  memory_alive         occasion: a session whose project is a git repository on this machine;
//                           hit: CLAUDE.md/AGENTS.md changed by > 20 characters in the 30 days to
//                           the session's date (./memory.ts)

import { PH_RULES } from "./prompt-history";

// Rules hb-2.1 (practice index pi-1.2) add three COMMUNICATION traces, counted from the person's own
// typed prompt text. The text is read in memory by `promptFacts` and dropped; only integer pairs
// travel. All patterns are English + Russian + Ukrainian and deliberately CONSERVATIVE: a doubtful
// prompt is not a hit (clear_goal, gives_context) and not a miss (one_task).
//
//   14  clear_goal     occasion: the first typed prompt that asks for work, in a session and again
//                      after each /clear (a greeting or a bare "continue" is not work and the
//                      occasion waits for the first prompt that is); hit: it states what done looks
//                      like — a test to pass/write, expected behaviour or output, an example
//                      input/output, a concrete check (`HB21.clearGoal`)
//   15  one_task       occasion: a typed work prompt of >= 15 words; hit: it does NOT bundle several
//                      unrelated asks. MISS iff either (a) >= 3 enumerated items (numbered, bulleted
//                      or "first/second/third") that each carry a work verb and between them name
//                      >= 2 different files/directories, or (b) >= 2 "also"-joiners (also, plus, as
//                      well as / также, а также / також, а також) each followed by a work verb,
//                      in a prompt naming >= 2 different files/directories
//   16  gives_context  occasion: a typed work prompt; hit: it names a file/path/symbol, quotes an
//                      error message or stack line, or states expected-vs-actual

// Rules hb-2.2 (practice index pi-1.5, solo review 2026-10-18 wave 2) narrow what each trace counts
// to what the PERSON did, measured on 11 980 real transcripts:
//   * communication (clear_goal, gives_context, one_task, names_files) reads only the person's OWN
//     words: a prompt that starts with "#" or "Implement the following plan:", carries a code fence
//     or pasted log lines, or runs past `ownWordsMaxWords` is pasted text, not an occasion;
//   * plan_complex: plan mode or a typed request for a plan — the agent's own task list
//     (TodoWrite/TaskCreate) is not the person's plan;
//   * tests_after_edit: a test, lint or typecheck that ran AND passed (no failure in its result);
//   * tests_with_code: commits with at least `testsWithCodeMinLines` code lines; a test in that
//     commit or the next one counts;
//   * risky_confirmed: an unknown mode is no occasion; deleting a temporary or build directory is
//     not a risky command;
//   * dependency_audit: a dependency added, removed or updated (not a lock refresh);
//   * security_review / independent_review: slash commands in either frame order, "audit" no longer
//     names a security reviewer, the review occasion counts code lines only;
//   * saw_diff_before_commit: a stat-only diff is not reading the changes, and a commit with no
//     agent edit since the previous one is no occasion;
//   * memory_alive: a memory file exists and was changed in 90 days or loaded in the session;
//   * no_secrets: high-precision secret kinds only, outside docs, tests and fixtures (./device-git).

// Rules hb-2.3 (2026-10-18, measured on the founder's own sessions — counts only):
//   * independent_review: a review launched through an agent or a workflow counts when its short
//     description or name says review / verify / audit (en/ru/uk). The type of a general-purpose
//     agent says nothing; what it was asked to do is in its description, and a Workflow was not
//     recognised at all — two of two large changes were reviewed that way and read as misses;
//   * names_files: a file named without its extension counts ("fix habits" names habits.ts), and
//     the occasion is the first work prompt of a task (as for clear_goal) — a short reply in the
//     middle of a conversation is not a place anybody names a file.

export const HB_RULES = Object.freeze({
  version: "hb-2.3" as const,
  /** A file named in a prompt: a path-like token with an extension. Compared by basename. */
  fileToken: /[\w@.\/-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7}\b/g,
  /** An explicit request for a plan. */
  asksPlan: /\b(make|write|give|draft|propose|outline)\b[^.?!]{0,40}\bplan\b|\bplan (it|this|first|out)\b|\bplan before\b|составь план|сначала план|сплан/i,
  /** A request to see or explain the changes. */
  asksDiff:
    /\bgit diff\b|\bshow (me )?(the |your )?(diff|changes)\b|\bwhat (did|have) you (change|changed)\b|\b(review|explain|walk me through) (the |your )?(diff|changes)\b|покажи (изменения|дифф|diff)|что ты (изменил|поменял)/i,
  /** A place in the code: a file, a line, a function call. */
  located: /[\w-]\.[A-Za-z][A-Za-z0-9]{0,7}\b|\blines? \d+|строк[аеиу]? \d+|:\d+\b|\b[A-Za-z_]\w*\(\)/i,
  /** hb-2.2: a prompt longer than this is pasted text, not the person's own words. */
  ownWordsMaxWords: 120,
  /** hb-2.2: lines that look like pasted output (a log, a stack, a test runner). */
  logLine: /^\s*(?:at \S|\[\d|\d{4}-\d\d-\d\d[T ]\d|(?:ERROR|WARN|WARNING|INFO|DEBUG|FAIL|PASS)\b|Traceback|File "|\$ |> |npm (?:ERR|WARN)|error(?:\[|:)|\s{4,}\S)/,
  logLinesMax: 2,
  /** hb-2.2: the frame a pasted plan or report starts with. */
  pastedStart: /^\s*(?:#|implement the following plan\b|here is the plan\b|<[a-z-]+>)/i,
});

/** hb-2.2: whether a typed prompt is the person's own words — not a pasted plan, report, log or
 *  skill expansion. Only own words are occasions of the communication traces. */
export function ownWords(text: string): boolean {
  const t = text.trim();
  if (!t || HB_RULES.pastedStart.test(t) || t.includes("```")) return false;
  if (wordCount(t) > HB_RULES.ownWordsMaxWords) return false;
  const logLines = t.split("\n").filter((l) => HB_RULES.logLine.test(l)).length;
  return logLines <= HB_RULES.logLinesMax;
}

/** URLs and bare domains are not files: "github.com/x" and "example.org" name no file of the
 *  project. */
function withoutUrls(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|ai|app|co|ru|ua|de|uk|gov|edu)\b(?!\.)/gi, " ");
}

// Read at call time, not at load: prompt-history and the journal reader import each other, and a
// value taken from PH_RULES while the modules are still loading would be undefined.
let corrective: Set<string> | null = null;
function isCorrective(word: string): boolean {
  corrective ??= new Set<string>(PH_RULES.correctiveWords);
  return corrective.has(word);
}


const L = "(?<![\\p{L}\\p{N}_])";
const W = (src: string) => new RegExp(`${L}(?:${src})`, "iu");

/** hb-2.1 communication rules. `\p{L}*` after a Russian/Ukrainian stem takes the ending. */
export const HB21 = Object.freeze({
  /** The prompt asks for work: a work verb (en/ru/uk). Not a slash command, not a bare "ok". */
  workVerb: W(
    "(?:add|edit|tidy|adjust|tweak|improve|drop|fix|implement|create|write|refactor|change|update|remove|delete|rename|make|build|test|debug|migrate|replace|rewrite|extract|move|optimi[sz]e|handle|support|set up|wire|port|clean up|investigate|find|show|explain|review|run|generate|convert|split|merge|install|configure|deploy|поправ\\p{L}*|исправ\\p{L}*|добав\\p{L}*|сдела\\p{L}*|напиш\\p{L}*|реализ\\p{L}*|измен\\p{L}*|обнов\\p{L}*|удал\\p{L}*|перепиш\\p{L}*|созда\\p{L}*|перенес\\p{L}*|убер\\p{L}*|замен\\p{L}*|найд\\p{L}*|покаж\\p{L}*|объясн\\p{L}*|запуст\\p{L}*|настро\\p{L}*|отрефактор\\p{L}*|почин\\p{L}*|выдел\\p{L}*|подключ\\p{L}*|створ\\p{L}*|додай\\p{L}*|виправ\\p{L}*|зроб\\p{L}*|напиш\\p{L}*|реаліз\\p{L}*|зміни\\p{L}*|онови\\p{L}*|видал\\p{L}*|перепиш\\p{L}*|перенес\\p{L}*|замін\\p{L}*|знайд\\p{L}*|покаж\\p{L}*|поясн\\p{L}*|запуст\\p{L}*|налашт\\p{L}*|полаг\\p{L}*)(?![\\p{L}])",
  ),
  /** What done looks like: a test, an expected behaviour or output, an example, a concrete check. */
  clearGoal: [
    W("(?:should|must|needs? to) (?:return|be|output|print|show|display|fail|pass|work|not|throw|keep|stay|handle|give|produce)(?![\\p{L}])"),
    W("(?:expected|expecting|acceptance|definition of done|done when|so that|such that)(?![\\p{L}])"),
    W("until\\b[^.?!\\n]{0,60}?\\b(?:pass(?:es|ed)?|green|succeed(?:s)?|compiles?|builds?)\\b"),
    W("(?:tests? (?:should |must |to )?pass|make (?:the |all )?tests? pass|(?:write|add|create) (?:a |the |some )?(?:failing )?(?:unit |regression |integration )?tests?|failing test)(?![\\p{L}])"),
    W("(?:for example|for instance|e\\.g\\.|i\\.e\\.)"),
    W("(?:input|output|expected output|example)\\s*:"),
    W("(?:run|using) (?:the )?(?:tests?|pytest|vitest|jest|npm test|build|lint|typecheck)\\b[^.?!\\n]{0,30}(?:pass|green|succeed|clean)"),
    // Russian
    W("должн[аоыи]?\\s+(?:вернуть|возвращать|быть|выводить|показывать|падать|проходить|работать|выдавать|остаться|сохранять)"),
    W("(?:ожида\\p{L}*|ожидаю|критери\\p{L}* приём\\p{L}*|критери\\p{L}* прием\\p{L}*|готово,? когда|так,? чтобы)(?![\\p{L}])"),
    W("чтобы (?:тест\\p{L}*|вернул\\p{L}*|возвращал\\p{L}*|не падал\\p{L}*|проходил\\p{L}*|работал\\p{L}*)"),
    W("(?:пока|до тех пор,? пока) (?:тест\\p{L}*|не пройд\\p{L}*|не заработ\\p{L}*|не позеленеет)"),
    W("тесты? (?:должны )?(?:проходить|прошли|зелен\\p{L}*|проходят)"),
    W("напиши (?:мне )?(?:юнит-?|регрессионн\\p{L}* )?тест\\p{L}*"),
    W("(?:пример|вход|выход|ввод|вывод)\\s*:"),
    // Ukrainian
    W("має\\s+(?:повертати|повернути|бути|виводити|показувати|падати|проходити|працювати|видавати|зберігати)"),
    W("(?:очіку\\p{L}*|критері\\p{L}* прийняття|готово,? коли|так,? щоб)(?![\\p{L}])"),
    W("щоб (?:тест\\p{L}*|повертав\\p{L}*|не падав\\p{L}*|проходив\\p{L}*|працював\\p{L}*)"),
    W("(?:доки|поки) (?:тест\\p{L}*|не пройд\\p{L}*|не запрацю\\p{L}*)"),
    W("тести? (?:мають )?(?:проходити|пройшли|зелен\\p{L}*|проходять)"),
    W("(?:приклад|вхід|вихід|ввід|вивід)\\s*:"),
  ],
  /** A line that enumerates: "1." "2)" "- " "* " at the start of a line, or inline "(1)". */
  enumerated: /(?:^|\n)\s*(?:\d{1,2}[.)]|[-*•]|\(\d{1,2}\))\s+\S+/g,
  ordinals: W("(?:first|second|third|fourth|сначала|потом|затем|в-третьих|спочатку|потім|далі)(?![\\p{L}])"),
  /** "also"-style joiners that tack on another ask. */
  alsoJoiner: W("(?:also|plus|as well as|additionally|and then|также|а также|ещё|еще и|кроме того|також|а також|ще й|крім того)(?![\\p{L}])"),
  /** The prompt names a symbol: `code`, name(), camelCase, snake_case. */
  symbol: /`[^`\n]{2,}`|\b[A-Za-z_]\w*\(\)|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b/,
  /** A quoted error message or a stack line. */
  error: new RegExp(
    [
      "(?:error|exception|traceback|failed|failure|panic|ошибк\\p{L}*|помилк\\p{L}*|исключени\\p{L}*|падает с|падає з)\\s*[:\"'`«„]",
      "\\b\\w*(?:Error|Exception)\\b\\s*:",
      "(?:^|\\n)\\s*at \\S+ \\([^)\\n]*:\\d+(?::\\d+)?\\)",
      "File \"[^\"\\n]+\", line \\d+",
      "(?:^|\\n)\\s*(?:Traceback|Caused by)\\b",
    ].join("|"),
    "iu",
  ),
  /** Expected versus actual. */
  expectedVsActual: new RegExp(
    [
      `${L}(?:expected|expecting)\\b[^.?!\\n]{0,80}\\b(?:but|got|actual(?:ly)?|instead|receiv\\w+|get(?:s|ting)?)\\b`,
      `${L}(?:should|must)\\b[^.?!\\n]{0,80}\\bbut\\b`,
      `${L}(?:actual(?:ly)?)\\b[^.?!\\n]{0,60}\\bexpected\\b`,
      `${L}instead of\\b`,
      `${L}(?:ожида\\p{L}*|ожидаю|должн\\p{L}*)[^.?!\\n]{0,80}(?:а получ\\p{L}*|но получ\\p{L}*|а выход\\p{L}*|получаю|получил\\p{L}*|а не)`,
      `${L}вместо(?![\\p{L}])`,
      `${L}(?:очіку\\p{L}*|має)[^.?!\\n]{0,80}(?:а отриму\\p{L}*|але отриму\\p{L}*|отримую|отримав\\p{L}*|а не)`,
      `${L}замість(?![\\p{L}])`,
    ].join("|"),
    "iu",
  ),
  oneTaskMinWords: 15,
  bundleMinItems: 3,
  bundleMinAlso: 2,
  bundleMinTargets: 2,
});

/** Files and directories a prompt names: file tokens (not "e.g."), and path-like segments. */
function targetsOf(raw: string): Set<string> {
  const text = withoutUrls(raw);
  const out = new Set<string>();
  for (const tok of text.match(HB_RULES.fileToken) ?? []) {
    const b = basename(tok);
    if (/^(?:e\.g|i\.e)$/i.test(b) || !/[a-z]/i.test(b)) continue;
    out.add(b);
  }
  for (const d of text.match(/(?<![\p{L}\p{N}_.])[\w@-]+\/(?=[\w@.-])/gu) ?? []) out.add(`${d.toLowerCase()}`);
  return out;
}

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'_.-]*/gu) ?? []).length;
}

/** The three hb-2.1 facts of one typed prompt. `oneTask` is null when the prompt is not an occasion
 *  (not work, or under 15 words). */
function communicationFacts(text: string): {
  work: boolean;
  clearGoal: boolean;
  oneTask: boolean | null;
  givesContext: boolean;
} {
  const t = text.trim();
  // hb-2.2: pasted text is no occasion (the review's measurement: hit rates rose with length to
  // 99 %, and every sampled one_task miss was a pasted plan or report).
  const work = t.length > 0 && !t.startsWith("/") && ownWords(t) && HB21.workVerb.test(t);
  if (!work) return { work: false, clearGoal: false, oneTask: null, givesContext: false };
  const clearGoal = HB21.clearGoal.some((r) => r.test(t));
  const targets = targetsOf(t);
  const givesContext =
    [...targets].some((x) => !x.endsWith("/") || x.length > 1) ||
    HB21.symbol.test(t) ||
    HB21.error.test(t) ||
    HB21.expectedVsActual.test(t);
  let oneTask: boolean | null = null;
  if (wordCount(t) >= HB21.oneTaskMinWords) {
    const lines = t.split(/\n/);
    const items = lines.filter((l) => /^\s*(?:\d{1,2}[.)]|[-*•]|\(\d{1,2}\))\s+\S/.test(l));
    // Inline "(1) … (2) … (3) …" and "first … second … third" count as enumerations too.
    const inline = t.split(/\(\d{1,2}\)|\b\d{1,2}\)\s/).slice(1);
    const ord = t.split(HB21.ordinals).slice(1);
    const enumerated = [items, inline, ord].reduce((a, b) => (b.length > a.length ? b : a), [] as string[]);
    const workItems = enumerated.filter((i) => HB21.workVerb.test(i));
    const itemTargets = new Set<string>();
    for (const i of workItems) for (const x of targetsOf(i)) itemTargets.add(x);
    const bundledList = workItems.length >= HB21.bundleMinItems && itemTargets.size >= HB21.bundleMinTargets;
    const chunks = t.split(HB21.alsoJoiner).slice(1);
    const alsoAsks = chunks.filter((c) => HB21.workVerb.test(c.slice(0, 40))).length;
    const bundledAlso = alsoAsks >= HB21.bundleMinAlso && targets.size >= HB21.bundleMinTargets;
    oneTask = !(bundledList || bundledAlso);
  }
  return { work, clearGoal, oneTask, givesContext };
}

/** What a typed prompt's text says, for the rules above — derived in memory, the text dropped. */
export type PromptFacts = {
  /** hb-2.2: the person's own words (`ownWords`); pasted text opens no names_files occasion. */
  own?: boolean;
  files: string[];
  /** hb-2.3: the prompt's words of four letters or more, lower-cased — to find a file named
   *  without its extension. Held in memory on the device; never sent. */
  words?: string[];
  asksPlan: boolean;
  asksDiff: boolean;
  /** First word corrects and the prompt is short; the timing half is decided in `habitsOf`. */
  correctiveWord: boolean;
  located: boolean;
  /** hb-2.1: the prompt asks for work; it states what done looks like; it is one task (null: not an
   *  occasion); it names a file/symbol, quotes an error, or states expected-vs-actual. */
  work: boolean;
  clearGoal: boolean;
  oneTask: boolean | null;
  givesContext: boolean;
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return (parts[parts.length - 1] ?? path).toLowerCase();
}

export function promptFacts(text: string): PromptFacts {
  const files = [...new Set((withoutUrls(text).match(HB_RULES.fileToken) ?? []).map(basename))];
  const first = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^\p{L}']/gu, "") ?? "";
  return {
    own: ownWords(text),
    files,
    words: [...new Set((withoutUrls(text).toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []))],
    asksPlan: HB_RULES.asksPlan.test(text),
    asksDiff: HB_RULES.asksDiff.test(text),
    correctiveWord: text.length <= PH_RULES.correctiveMaxChars && isCorrective(first),
    located: HB_RULES.located.test(text),
    ...communicationFacts(text),
  };
}

/** A tool call's file, as the rules read it: the basename of the path the agent opened. */
export function touchedFile(tool: string, input: Record<string, unknown>): string | null {
  if (!["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return null;
  const path = input.file_path ?? input.notebook_path;
  return typeof path === "string" && path ? basename(path) : null;
}


// ---------------------------------------------------------------------------------------------
// hb-2.0: what a tool call IS, decided on the device from closed lists. The command text is read
// here and dropped.
// ---------------------------------------------------------------------------------------------

export const HB2_RULES = Object.freeze({
  /** A command that can destroy work or history. Matched on the command with commit messages and
   *  heredoc bodies removed (`stripProse`), so a message that talks about `rm -rf` is not one. */
  risky: [
    /\brm\b(?=[^\n;&|]*(?:\s-[a-zA-Z]*[rR]|--recursive))(?=[^\n;&|]*(?:\s-[a-zA-Z]*[fF]|--force))/,
    /\bgit\s+(?:-C\s+\S+\s+)?push\b[^\n;&|]*(?:--force(?!-with-lease)\b|\s-f\b|\s\+\S)/,
    /\bgit\s+(?:-C\s+\S+\s+)?reset\s+[^\n;&|]*--hard\b/,
    /\bgit\s+(?:-C\s+\S+\s+)?clean\s+[^\n;&|]*-[a-z]*f/,
    /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout\s+--\s+\.|restore\s+(?:--source\S*\s+)?\.\s*$|branch\s+-D\b|stash\s+(?:drop|clear)\b)/m,
    /\bdrop\s+(?:table|database|schema)\b/i,
    /\btruncate\s+table\b|\btruncate\s+[\w."`]+\s*;/i,
    /\bdelete\s+from\s+[\w."`]+\s*(?:;|$)/im,
    /\bchmod\s+-R\s+0?777\b/,
    /\bmkfs(?:\.\w+)?\b|\bdd\s+[^\n;&|]*\bof=\/dev\//,
    /\bdocker\s+(?:system|volume)\s+prune\b/,
    /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
  ] as readonly RegExp[],
  /** A dependency audit. */
  audit:
    /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:npm\s+)?audit|pip-audit|pipaudit|safety\s+(?:check|scan)|cargo[\s-]audit|cargo[\s-]deny|osv-scanner|snyk\s+(?:test|monitor)|trivy\s+(?:fs|repo)|bundle[r]?[\s-]audit|govulncheck|composer\s+audit|dotnet\s+list\s+package\s+--vulnerable|audit-ci|retirejs|retire\s+--|grype|dependency-check)\b/i,
  /** A package-manager command that changes the manifest or the lock file. */
  // hb-2.2: a dependency added, removed or updated — flags may sit before the package; a lock
  // refresh (`poetry lock`, `uv lock`, `go mod tidy`, `pip-compile`) changes no dependency.
  depChange:
    /\b(?:(?:npm|pnpm)\s+(?:install|i|add|remove|rm|uninstall|update|up)(?:\s+-\S+)*\s+[^\s-]|(?:yarn|bun)\s+(?:add|remove|upgrade)\b|cargo\s+(?:add|remove|update)\b|poetry\s+(?:add|remove|update)\b|uv\s+(?:add|remove)\b|pip3?\s+install\b(?![^\n;&|]*\s-(?:r|e|-requirement|-editable)\b)(?:\s+-\S+)*\s+[^\s-]|go\s+get\b|bundle\s+(?:add|update)\b|composer\s+(?:require|remove|update)\b)/,
  /** Reading the changes before they are committed. */
  diff: /\bgit\s+(?:-C\s+\S+\s+)?(?:diff|show|log\s+[^\n;&|]*-p|status\s+[^\n;&|]*-v)\b/,
  /** hb-2.2: a diff that shows names or counts only is not reading the changes. */
  diffSummaryOnly: /\bgit\s+(?:-C\s+\S+\s+)?(?:diff|show)\b[^\n;&|]*--(?:stat|shortstat|numstat|name-only|name-status)\b/,
  /** A read-only lookup in the shell, as opposed to a change. */
  lookup: /^\s*(?:cd\s+\S+\s*&&\s*)?(?:ls|grep|rg|ag|find|fd|cat|head|tail|tree|wc|git\s+(?:log|grep|ls-files))\b/,
  /** Lock and manifest files, by basename. */
  manifests:
    /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[\w.-]*\.txt|pyproject\.toml|poetry\.lock|pipfile(?:\.lock)?|uv\.lock|setup\.py|setup\.cfg|cargo\.toml|cargo\.lock|go\.mod|go\.sum|gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile|packages\.lock\.json|[\w.-]+\.csproj)$/,
  /** Directories and file names that make a path a test. */
  testDirs: new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__mocks__", "testing"]),
  testFile:
    /(?:^|[._-])(?:test|tests|spec)\.[a-z0-9]+$|^test_[\w.-]+\.py$|_test\.(?:go|py|rs|rb|exs?)$|(?:Test|Tests|IT)\.(?:java|kt|cs|scala|swift)$|^conftest\.py$/,
  /** Extensions of source code. Prose, data, config and styles are not code. */
  codeExt: new Set([
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "kts", "rb", "php", "cs", "swift",
    "c", "cc", "cpp", "h", "hpp", "scala", "vue", "svelte", "sql", "sh", "dart", "ex", "exs", "lua", "m", "mm",
  ]),
  /** A subagent whose declared type names a security reviewer. */
  securitySubagent: /secur|vuln/i,
  /** A subagent whose declared type names a reviewer. */
  reviewSubagent: /review/i,
  /** A subagent that explores. */
  exploreSubagent: /explor/i,
  /** The tools that read the project. */
  exploreTools: new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "ListDir"]),
  /** The agent writing its own plan down. */
  // hb-2.2: plan mode only. The agent's own task list (TodoWrite/TaskCreate) is the agent's
  // bookkeeping, and 94 % of plan_complex hits on real transcripts were that list.
  planTools: new Set(["ExitPlanMode", "EnterPlanMode"]),
  /** Slash commands (and skills of the same name). Matched on the last `:` segment, so a plugin's
   *  `code-review:code-review` or `pr-review-toolkit:review-pr` is the review it names. */
  securityCommands: new Set(["security-review", "security-reviewer"]),
  reviewCommands: new Set(["review", "code-review", "ultrareview", "pr-review", "review-pr", "simplify"]),
  /** hb-2.3: what an agent or a workflow was asked to do, by its short description or name. */
  reviewTask: /\b(?:review|reviewer|verif\w*|audit\w*|double-check|second opinion|critic\w*)\b|провер\p{L}*|ревью|аудит\p{L}*|перевір\p{L}*/iu,
  securityTask: /secur\w*|vulnerab\w*|безопасн\p{L}*|уязвим\p{L}*|безпек\p{L}*/iu,
  /** hb-2.2: any other command whose name says review, and security by name. */
  reviewName: /^(?:[\w.-]*-)?(?:review|reviewer)$|ultrareview|adversarial-review|^review-pr$/,
  securityName: /secur[\w-]*(?:review|audit|scan)|(?:review|audit|scan)[\w-]*secur/,
  /** hb-2.2: what deleting a directory of throwaway output looks like (not a risky command). */
  throwawayPath: /^(?:\/tmp\/|\/var\/folders\/|\$TMPDIR|\$\{TMPDIR\}|\.?\/?(?:node_modules|dist|build|out|\.next|\.nuxt|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|target|\.cache|\.turbo|\.parcel-cache|tmp)(?:\/|$))/,
  /** hb-2.2: a test, lint or typecheck run whose result reports a failure. */
  failureReport: /(?:^|\n)\s*(?:FAIL|FAILED|ERROR)\b|\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b|\berror TS\d{3,5}\b|\bTests?:\s+[1-9]\d* failed|✗|✘/,
  /** hb-2.2: tests_with_code needs a commit of at least this many code lines. */
  testsWithCodeMinLines: 30,
  /** What a person's refusal of a tool call looks like in its result. */
  refusal: /doesn't want to proceed|Request interrupted by user for tool use|tool use was rejected|was rejected by the user/i,
  /** Working directories that are a container: dev containers, Codespaces, sandboxes. */
  containerCwd: /^\/(?:workspaces?|sandbox|workspace)(?:\/|$)/,
  /** The changed lines at which a review becomes an occasion. */
  reviewLines: 200,
  /** Files at which a plan becomes an occasion. */
  planFiles: 3,
});

/** A command text with what is prose in it removed: heredoc bodies and the message of a commit. */
export function stripProse(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, " ")
    .replace(/(?:-m|--message|-F|--file)(?:\s+|=)(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g, " ")
    .replace(/\b(?:echo|printf)\s+(?:"(?:[^"\\]|\\.)*"|'[^']*')/g, " ");
}

/** What a shell command is, for the rules. The text is read and dropped. */
export type CommandFacts = {
  risky: boolean;
  audit: boolean;
  depChange: boolean;
  diff: boolean;
  lookup: boolean;
};

/** hb-2.2: every `rm -rf` in the command removes only throwaway output (a temporary or build
 *  directory). Most "risky" commands on real transcripts were exactly that. */
function removesOnlyThrowaway(bare: string): boolean {
  const rms = bare.match(/\brm\s+[^\n;&|]*/g) ?? [];
  if (rms.length === 0) return false;
  return rms.every((rm) => {
    const targets = rm.split(/\s+/).slice(1).filter((a) => a && !a.startsWith("-"));
    return targets.length > 0 && targets.every((t) => HB2_RULES.throwawayPath.test(t.replace(/^["']|["']$/g, "")));
  });
}

export function commandFacts(command: string): CommandFacts {
  const bare = stripProse(command);
  const [rmRule, ...others] = HB2_RULES.risky;
  const risky = others.some((re) => re.test(bare)) || (!!rmRule && rmRule.test(bare) && !removesOnlyThrowaway(bare));
  return {
    risky,
    audit: HB2_RULES.audit.test(bare),
    depChange: HB2_RULES.depChange.test(bare),
    diff: HB2_RULES.diff.test(bare) && !HB2_RULES.diffSummaryOnly.test(bare),
    lookup: HB2_RULES.lookup.test(bare),
  };
}

/** hb-2.2: whether a slash command or skill name is a review, and a security review. The name is
 *  matched on its last `:` segment and on the closed sets above. */
export function commandIsReview(name: string): boolean {
  const n = name.toLowerCase();
  const last = n.split(":").pop() ?? n;
  return HB2_RULES.reviewCommands.has(last) || HB2_RULES.reviewName.test(last) || HB2_RULES.reviewName.test(n);
}
export function commandIsSecurity(name: string): boolean {
  const n = name.toLowerCase();
  const last = n.split(":").pop() ?? n;
  return HB2_RULES.securityCommands.has(last) || HB2_RULES.securityName.test(n);
}

export type PathKind = "test" | "code" | "other";

/** A file path as code, a test, or neither, by convention (directory names, file name patterns,
 *  extension). Whether a file is a lock or manifest is `isManifest`. */
export function pathKind(path: string): PathKind {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((p) => HB2_RULES.testDirs.has(p.toLowerCase())) || HB2_RULES.testFile.test(name)) {
    return HB2_RULES.codeExt.has(name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "") ? "test" : "other";
  }
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return HB2_RULES.codeExt.has(ext) && !/\.d\.ts$/i.test(name) ? "code" : "other";
}

export function isManifest(path: string): boolean {
  return HB2_RULES.manifests.test(basename(path));
}

/** A lock file (written by the package manager, never decided by a person). */
export function isLockFile(path: string): boolean {
  return /(?:\.lock|\.lockb|-lock\.json|-lock\.yaml|shrinkwrap\.json|\.lockfile|go\.sum|packages\.lock\.json)$/.test(basename(path));
}

const countLines = (s: unknown): number => (typeof s === "string" && s.length > 0 ? s.split("\n").length : 0);

/** The lines an edit tool call changed: for each replacement the longer of what left and what
 *  came, for a whole-file write its length. Null when the call is not an edit. */
export function editOf(tool: string, input: Record<string, unknown>): { file: string; kind: PathKind; manifest: boolean; lines: number } | null {
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return null;
  const path = input.file_path ?? input.notebook_path;
  if (typeof path !== "string" || !path) return null;
  let lines = 0;
  if (tool === "Write") lines = countLines(input.content);
  else if (tool === "Edit") lines = Math.max(countLines(input.old_string), countLines(input.new_string));
  else if (tool === "NotebookEdit") lines = countLines(input.new_source);
  else if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e === "object") {
        const r = e as Record<string, unknown>;
        lines += Math.max(countLines(r.old_string), countLines(r.new_string));
      }
    }
  }
  return { file: path.replace(/\\/g, "/").toLowerCase(), kind: pathKind(path), manifest: isManifest(path), lines };
}

/** The directory a shell command starts by changing into (`cd /abs/path && …`), or null. */
export function commandDir(command: string): string | null {
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\/[^\s;&|]+))/.exec(command);
  const dir = m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
  return dir && dir.startsWith("/") ? dir : null;
}

/** The sha a `git commit` reports: `[branch abc1234] message`. Read from the tool's result on this
 *  machine to find the commit again with `git show`; it never travels. */
export function commitShaOf(result: string): string | null {
  const m = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/m.exec(result);
  return m ? m[1]! : null;
}

/** The first word of a slash command the person ran, as Claude Code records it. */
export function slashCommandOf(text: string): string | null {
  const m = /<command-name>\s*\/?([\w:.-]+)\s*<\/command-name>/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** The moments the rules read, in order. A moment is a typed prompt, a tool call, or plan mode. */
export type HabitMoment = {
  at: number;
  prompt: PromptFacts | null;
  touched: string | null;
  agentEdit: boolean;
  commit: boolean;
  planMode: boolean;
  // --- hb-2.0. All optional: a moment that sets none of them reads as hb-1.0 did.
  /** The moment is a tool call. */
  isTool?: boolean;
  /** The agent's edit: the file (lower-cased path, held in memory only), its kind, lines changed. */
  edit?: { file: string; kind: PathKind; manifest: boolean; lines: number } | null;
  /** A shell command's class. */
  cmd?: CommandFacts | null;
  /** The command was a test or a build (PtL-1.0's categories). */
  testOrBuild?: boolean;
  /** hb-2.2: the command was a test, a lint or a typecheck (a build is not a check of the work). */
  check?: boolean;
  /** hb-2.2: the call's result reports a failure (a runner's summary), whatever its exit status. */
  reportsFailure?: boolean;
  /** The tool's result was an error, or the person refused the call. A commit that failed is not a
   *  commit; a call the person refused did not run. */
  failed?: boolean;
  refused?: boolean;
  /** The sha a commit reported; read on this machine, never sent. */
  sha?: string | null;
  /** The tool read the project (Read/Grep/Glob/LS, a lookup, an Explore subagent). */
  explore?: boolean;
  /** The agent wrote its own plan (task list). */
  plans?: boolean;
  /** A security review ran (command, skill or subagent_type). */
  security?: boolean;
  /** A review ran (command, skill or subagent_type). */
  review?: boolean;
  /** The record's permissionMode, when it carries one. */
  mode?: string | null;
  /** The record is the person's /clear: the next work prompt opens a new task. */
  clear?: boolean;
  /** The directory a command ran git in (a leading `cd <abs>` or the record's cwd); device-only. */
  dir?: string | null;
};

/** What the rules need from outside the transcript, resolved on the device by the reader. */
export type HabitContext = {
  /** The session ran in a container (its cwd says so). */
  container?: boolean;
  /** CLAUDE.md/AGENTS.md alive for this project at this date; null when it could not be read. */
  memoryAlive?: boolean | null;
  /** Whether the added lines of a commit are free of secrets; null when they could not be read. */
  commitClean?: (sha: string, dir: string | null) => boolean | null;
};

export type HabitCount = { opportunities: number; hits: number };
export type Habits = {
  rules_version: "hb-2.3";
  names_files: HabitCount | null;
  plan_before_edit: HabitCount | null;
  diff_before_commit: HabitCount | null;
  located_corrections: HabitCount | null;
  security_review: HabitCount | null;
  dependency_audit: HabitCount | null;
  no_secrets: HabitCount | null;
  permissions_on: HabitCount | null;
  risky_confirmed: HabitCount | null;
  tests_after_edit: HabitCount | null;
  tests_with_code: HabitCount | null;
  saw_diff_before_commit: HabitCount | null;
  independent_review: HabitCount | null;
  explore_before_edit: HabitCount | null;
  plan_complex: HabitCount | null;
  memory_alive: HabitCount | null;
  clear_goal: HabitCount | null;
  one_task: HabitCount | null;
  gives_context: HabitCount | null;
};

function count(opportunities: number, hits: number): HabitCount | null {
  return opportunities > 0 ? { opportunities, hits: Math.min(hits, opportunities) } : null;
}

export function habitsOf(moments: readonly HabitMoment[], ctx: HabitContext = {}): Habits {
  // T1: each typed prompt against the files touched before the next one.
  let t1Occasions = 0;
  let t1Hits = 0;
  let open: { files: Set<string>; words: Set<string>; touched: Set<string>; own: boolean; task: boolean } | null = null;
  // hb-2.3: a touched file is named when its basename is in the prompt, or its name without the
  // extension (four letters or more) is one of the prompt's words.
  const stem = (f: string) => f.replace(/\.[^.]+$/, "");
  const closeT1 = () => {
    if (open && open.own && open.task && open.touched.size > 0) {
      t1Occasions += 1;
      if ([...open.touched].some((f) => open!.files.has(f) || (stem(f).length >= 4 && open!.words.has(stem(f))))) t1Hits += 1;
    }
  };
  // T3
  let planned = false;
  let edited = false;
  let plannedBeforeEdit = false;
  // T4
  let t4Occasions = 0;
  let t4Hits = 0;
  let askedSinceCommit = false;
  // T7
  let t7Occasions = 0;
  let t7Hits = 0;
  let lastPromptAt: number | null = null;
  // hb-2.1 communication
  let goalPending = true;
  let cgO = 0;
  let cgH = 0;
  let otO = 0;
  let otH = 0;
  let gcO = 0;
  let gcH = 0;

  for (const m of moments) {
    if (m.clear) goalPending = true;
    // hb-2.3: names_files asks the first work prompt of a task, the same place clear_goal does.
    const firstOfTask = !!m.prompt?.work && goalPending;
    if (m.prompt?.work) {
      if (goalPending) {
        goalPending = false;
        cgO += 1;
        if (m.prompt.clearGoal) cgH += 1;
      }
      gcO += 1;
      if (m.prompt.givesContext) gcH += 1;
      if (m.prompt.oneTask !== null) {
        otO += 1;
        if (m.prompt.oneTask) otH += 1;
      }
    }
    if (m.planMode) planned = true;
    if (m.prompt) {
      closeT1();
      open = {
        files: new Set(m.prompt.files),
        words: new Set(m.prompt.words ?? []),
        touched: new Set(),
        own: m.prompt.own !== false,
        task: firstOfTask,
      };
      if (m.prompt.asksPlan) planned = true;
      if (m.prompt.asksDiff) askedSinceCommit = true;
      const soon = lastPromptAt !== null && m.at - lastPromptAt <= PH_RULES.correctiveMaxGapMs;
      if (m.prompt.correctiveWord && soon) {
        t7Occasions += 1;
        if (m.prompt.located) t7Hits += 1;
      }
      lastPromptAt = m.at;
    }
    if (m.touched && open) open.touched.add(m.touched);
    if (m.agentEdit && !edited) {
      edited = true;
      plannedBeforeEdit = planned;
    }
    if (m.commit) {
      t4Occasions += 1;
      if (askedSinceCommit) t4Hits += 1;
      askedSinceCommit = false;
    }
  }
  closeT1();
  const h2 = habits2(moments, ctx);
  return {
    rules_version: HB_RULES.version,
    ...h2,
    names_files: count(t1Occasions, t1Hits),
    plan_before_edit: edited ? count(1, plannedBeforeEdit ? 1 : 0) : null,
    diff_before_commit: count(t4Occasions, t4Hits),
    located_corrections: count(t7Occasions, t7Hits),
    clear_goal: count(cgO, cgH),
    one_task: count(otO, otH),
    gives_context: count(gcO, gcH),
  };
}

/** The hb-2.0 traces 1–11. Order is the order of the moments; a call that failed to run (refused
 *  by the person) is treated as not having happened. */
function habits2(moments: readonly HabitMoment[], ctx: HabitContext) {
  const ran = moments.filter((m) => !m.refused);
  const edits = ran.filter((m) => m.edit);
  const firstEdit = ran.findIndex((m) => m.edit);
  const files = new Set(edits.map((m) => m.edit!.file));
  const isCode = (m: HabitMoment) => m.edit!.kind === "code" || m.edit!.kind === "test";
  const codeLines = edits.filter(isCode).reduce((n, m) => n + m.edit!.lines, 0);
  const hasCodeEdit = edits.some((m) => m.edit!.kind === "code" || m.edit!.kind === "test");
  const after = (from: number, pred: (m: HabitMoment) => boolean) => ran.some((m, i) => i > from && pred(m));
  const before = (to: number, pred: (m: HabitMoment) => boolean) => ran.some((m, i) => i < to && pred(m));

  // 1
  const security_review = hasCodeEdit ? count(1, after(firstEdit, (m) => !!m.security) ? 1 : 0) : null;

  // 2: a dependency changed: a package-manager command that names one, or an edit of a manifest
  // (hb-2.2: not of a lock file — the lock follows the manifest, it is not a decision).
  const depChanged = ran.some((m) => (m.edit?.manifest && !isLockFile(m.edit.file)) || m.cmd?.depChange);
  const dependency_audit = depChanged ? count(1, ran.some((m) => m.cmd?.audit) ? 1 : 0) : null;

  // 3: each commit whose sha is known and whose added lines the device could read.
  let t3o = 0;
  let t3h = 0;
  for (const m of ran) {
    if (!m.commit || m.failed || !m.sha || !ctx.commitClean) continue;
    const clean = ctx.commitClean(m.sha, m.dir ?? null);
    if (clean === null) continue;
    t3o += 1;
    if (clean) t3h += 1;
  }

  // 4: the mode is a property of the record; one bypassing record makes the session bypass.
  const tools = ran.some((m) => m.isTool);
  const modes = ran.map((m) => m.mode).filter((x): x is string => typeof x === "string");
  const bypass = modes.includes("bypassPermissions");
  const permissions_on =
    tools && (modes.length > 0 || ctx.container) ? count(1, !bypass || ctx.container ? 1 : 0) : null;

  // 5: the mode in force at the moment of each risky command that ran. hb-2.2: a command whose
  // mode is not known is no occasion (it used to count as "permissions on").
  let mode: string | null = null;
  let t5o = 0;
  let t5h = 0;
  for (const m of ran) {
    if (typeof m.mode === "string") mode = m.mode;
    if (!m.cmd?.risky) continue;
    if (mode === null && !ctx.container) continue;
    t5o += 1;
    if (mode !== "bypassPermissions" || ctx.container) t5h += 1;
  }

  // 6: the last edit before the final successful commit, and whether a test or build came after it.
  const commits = ran.map((m, i) => (m.commit && !m.failed ? i : -1)).filter((i) => i >= 0);
  let tests_after_edit: HabitCount | null = null;
  if (commits.length > 0) {
    const finalCommit = commits[commits.length - 1]!;
    const lastBefore = ran.map((m, i) => (m.edit && i < finalCommit ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    // hb-2.2: a test, lint or typecheck that ran AND passed — a run that failed is not a check of
    // the work, and a build only says it compiles.
    const passed = (m: HabitMoment) => (m.check ?? m.testOrBuild ?? false) && !m.failed && !m.reportsFailure;
    if (lastBefore >= 0) tests_after_edit = count(1, after(lastBefore, passed) ? 1 : 0);
  }

  // 7 and 8: per commit, what happened since the previous one.
  let t7o = 0;
  let t7h = 0;
  let t8o = 0;
  let t8h = 0;
  let from = -1;
  let asked = false;
  // hb-2.2: the commits and what came before each, so a test committed with the NEXT commit of
  // the same change counts too (people commit code, then its test).
  const slices: HabitMoment[][] = [];
  for (let i = 0; i < ran.length; i++) {
    const m = ran[i]!;
    if (m.prompt?.asksDiff) asked = true;
    if (!m.commit || m.failed) continue;
    const slice = ran.slice(from + 1, i);
    slices.push(slice);
    // hb-2.2: a commit with no agent edit since the previous one shows no change of the agent's
    // to look at.
    if (slice.some((x) => x.edit)) {
      t8o += 1;
      if (asked || slice.some((x) => x.cmd?.diff)) t8h += 1;
    }
    asked = false;
    from = i;
  }
  slices.forEach((slice, k) => {
    // hb-2.2: an occasion is a commit of at least `testsWithCodeMinLines` code lines — a one-line
    // fix with no test is not the same miss as a feature with none (the rule rose with size).
    const code = slice.filter((x) => x.edit?.kind === "code").reduce((n, x) => n + x.edit!.lines, 0);
    if (code < HB2_RULES.testsWithCodeMinLines) return;
    t7o += 1;
    const next = slices[k + 1] ?? [];
    if ([...slice, ...next].some((x) => x.edit?.kind === "test")) t7h += 1;
  });

  // 9 (hb-2.2): an occasion when the CODE lines reach `reviewLines`; a review counts once the
  // change is that large — a review of the first ten lines is not a review of the change.
  let reached = -1;
  let acc = 0;
  for (let i = 0; i < ran.length && reached < 0; i++) {
    const m = ran[i]!;
    if (m.edit && isCode(m)) {
      acc += m.edit.lines;
      if (acc >= HB2_RULES.reviewLines) reached = i;
    }
  }
  const independent_review =
    codeLines >= HB2_RULES.reviewLines && reached >= 0 ? count(1, after(reached, (m) => !!m.review) ? 1 : 0) : null;
  // 10
  const explore_before_edit = firstEdit >= 0 ? count(1, before(firstEdit, (m) => !!m.explore) ? 1 : 0) : null;
  // 11
  // hb-2.2: plan mode, or the person typing a request for a plan — not the agent's task list.
  const plan_complex =
    files.size >= HB2_RULES.planFiles
      ? count(1, before(firstEdit, (m) => m.planMode || !!m.plans || !!m.prompt?.asksPlan) ? 1 : 0)
      : null;

  return {
    security_review,
    dependency_audit,
    no_secrets: count(t3o, t3h),
    permissions_on,
    risky_confirmed: count(t5o, t5h),
    tests_after_edit,
    tests_with_code: count(t7o, t7h),
    saw_diff_before_commit: count(t8o, t8h),
    independent_review,
    explore_before_edit,
    plan_complex,
    memory_alive: ctx.memoryAlive === undefined || ctx.memoryAlive === null ? null : count(1, ctx.memoryAlive ? 1 : 0),
  };
}
