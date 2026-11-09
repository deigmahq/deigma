// The practice index's public words (pi-1.0), in one place: the
// card, the badge and the OG image all print the same label and the same interval sentence, and
// only one of them is React — so the words live with the data, like `measuredOnText`.

import { AGENT_NAMES, AGENTS, DEVICE_PRACTICES, NOT_EXPRESSIBLE, type Agent } from "./agents";
import { DECISIONS_RULE, PRACTICE_RULE } from "./measurement";
import type { PRACTICE_KEYS, PRACTICE_LEVELS, PublicPracticeIndex, READABLE_PRACTICE_LEVELS } from "./snapshot";

export const PRACTICE_NAME = "Practice index";
/** What the number is, to its owner. */
export const PRACTICE_LABEL = "how closely you follow best practices for working with AI agents";
/** pi-1.6 (review): the same, to a stranger — a public card is about @handle, not about "you". */
export const PRACTICE_LABEL_PUBLIC = "how closely they follow best practices for working with AI agents";
/** pi-1.6 (review M10): a number from GitHub alone counts engineering practice on every landing,
 *  with or without an agent, so it does not claim to be about working with AI. */
export const PRACTICE_LABEL_GITHUB = "engineering practice read from GitHub";

/** The label for a number, by what it rests on and who reads it. */
export function practiceLabelFor(source: string | null | undefined, audience: "owner" | "public"): string {
  if (source === "github") return PRACTICE_LABEL_GITHUB;
  return audience === "public" ? PRACTICE_LABEL_PUBLIC : PRACTICE_LABEL;
}

/** pi-1.6: "12 of 31 with an AI agent" beside a number that rests on landings — the share of AI
 *  work is a fact next to the index, never in it. Null when nothing landed. */
export function practiceAiFact(nLandings: number | null | undefined, nAi: number | null | undefined): string | null {
  const n = nLandings ?? 0;
  if (n <= 0 || nAi === undefined || nAi === null) return null;
  return `${nAi} of ${n} with an AI agent`;
}

/** The level word for a value, from the scorer's own bands (`PRACTICE_RULE.level_bands`, pi-1.6:
 *  0–29, 30–44, 45–59, 60–100). Printed only where the number is; derived, so it also serves
 *  snapshots written without it. */
export function practiceLevelOf(value: number): (typeof PRACTICE_LEVELS)[number] {
  const [solid, strong, expert] = PRACTICE_RULE.level_bands;
  if (value >= expert) return "Expert";
  if (value >= strong) return "Strong";
  if (value >= solid) return "Solid";
  return "Building";
}

/** "64 · Strong" — the display line of the index: the value and its level word. */
export function practiceHeadline(value: number, level?: (typeof READABLE_PRACTICE_LEVELS)[number] | null): string {
  return `${value} \u00b7 ${level ?? practiceLevelOf(value)}`;
}

export function practiceSessionsText(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

export function practiceLandingsText(n: number): string {
  // "landing" is the engine's word (copy v4, e2e/31-words): a person reads "pieces of shipped work".
  return `${n} shipped ${n === 1 ? "change" : "changes"}`;
}

/** What the number rests on, in the units it was counted in: "46 sessions", "31 landings" for a
 *  person with GitHub only, "46 sessions · 31 landings" for both (pi-1.3). */
export function practiceBasisCount(nSessions: number, nLandings: number | null | undefined): string {
  const landings = nLandings ?? 0;
  if (nSessions > 0 && landings > 0) return `${practiceSessionsText(nSessions)} \u00b7 ${practiceLandingsText(landings)}`;
  if (nSessions === 0 && landings > 0) return practiceLandingsText(landings);
  return practiceSessionsText(nSessions);
}

/**
 * What an image may print of a PUBLISHED index (never preliminary — the projection is null for
 * anything else): the value, its interval as words and compressed for a badge segment, and the
 * label line. The number never travels without its interval.
 */
export function publicPracticeWords(p: PublicPracticeIndex): {
  value: string;
  /** "64 · Strong". */
  headline: string;
  beside: string;
  inline: string;
  basis: string;
  sentence: string;
} | null {
  if (!p) return null;
  const value = String(p.value);
  const beside = `between ${p.ci90.lo} and ${p.ci90.hi}`;
  const ai = p.source === "github" ? practiceAiFact(p.n_landings, p.n_landings_ai) : null;
  const basis = `${practiceLabelFor(p.source, "public")} · ${practiceBasisCount(p.n_sessions, p.n_landings)}${ai ? ` · ${ai}` : ""}`;
  const headline = practiceHeadline(p.value, p.level);
  // One name on every surface (review): the card said "Practice index", the badge "AI practice".
  return {
    value,
    headline,
    beside,
    inline: `${PRACTICE_NAME} ${headline} (${p.ci90.lo}–${p.ci90.hi})`,
    basis,
    sentence: `${PRACTICE_NAME} ${headline}, ${beside} · ${basis}`,
  };
}

/** Each practice in the plain words the weekly movement names it by ("+3 this week · tests after
 *  edits"). Owner surfaces only: the movement is never public. */
export const PRACTICE_MOVE_WORDS: Record<(typeof PRACTICE_KEYS)[number], string> = {
  security_review: "security reviews",
  dependency_audit: "dependency audits",
  no_secrets: "no secrets in commits",
  permissions_on: "permissions on",
  risky_confirmed: "risky commands confirmed",
  tests_after_edit: "tests after edits",
  tests_with_code: "tests committed with code",
  saw_diff_before_commit: "looking at changes before commits",
  independent_review: "second reviews of large changes",
  explore_before_edit: "reading before editing",
  plan_complex: "plans for larger changes",
  names_files: "naming files in prompts",
  memory_alive: "keeping CLAUDE.md or AGENTS.md current",
  code_stands_14d: "code that stands",
  clear_goal: "saying what done looks like",
  one_task: "one task per prompt",
  gives_context: "giving context in prompts",
  located_corrections: "corrections that point at a place",
  gh_security_scanning: "security scanning in your repositories",
  gh_tests_with_code: "tests landed with code",
  gh_green_before_merge: "green checks before merging",
  gh_small_changes: "small, focused changes",
};

/** "+3 this week · tests after edits" — the owner's weekly movement of the index, or null when
 *  there is none. A reason is only named when the index moved. */
export function practiceMovementText(delta: number | null | undefined, reason: string | null | undefined): string | null {
  if (delta === null || delta === undefined) return null;
  if (delta === 0) return "No change this week";
  const head = `${delta > 0 ? "+" : "\u2212"}${Math.abs(delta)} this week`;
  const word = reason ? (PRACTICE_MOVE_WORDS as Record<string, string | undefined>)[reason] : undefined;
  return word ? `${head} \u00b7 ${word}` : head;
}

/** The practices as a person names them in "Strong at: tests after edits, clear goals" and
 *  "Next step: security review". Owner surfaces only. */
export const PRACTICE_PLAIN_WORDS: Record<(typeof PRACTICE_KEYS)[number], string> = {
  security_review: "security review",
  dependency_audit: "dependency audits",
  no_secrets: "no secrets in commits",
  permissions_on: "permissions on",
  risky_confirmed: "risky commands confirmed",
  tests_after_edit: "tests after edits",
  tests_with_code: "tests committed with code",
  saw_diff_before_commit: "looking at changes before commits",
  independent_review: "second reviews of large changes",
  explore_before_edit: "reading before editing",
  plan_complex: "plans for larger changes",
  names_files: "naming files in prompts",
  memory_alive: "keeping CLAUDE.md or AGENTS.md current",
  code_stands_14d: "code that stands",
  clear_goal: "clear goals",
  one_task: "one task per prompt",
  gives_context: "giving context",
  located_corrections: "corrections that point at a place",
  gh_security_scanning: "security scanning on",
  gh_tests_with_code: "tests landed with code",
  gh_green_before_merge: "green checks before merging",
  gh_small_changes: "small, focused changes",
};

/** "Strong at: tests after edits, clear goals", or null when there is none. Owner only. */
export function practiceStrengthsText(keys: readonly string[] | null | undefined): string | null {
  const words = (keys ?? []).map((k) => (PRACTICE_PLAIN_WORDS as Record<string, string | undefined>)[k]).filter((w): w is string => !!w);
  return words.length ? `Strong at: ${words.join(", ")}` : null;
}

/** "Next step: security review", or null. Owner only. */
export function practiceNextStepText(key: string | null | undefined): string | null {
  const word = key ? (PRACTICE_PLAIN_WORDS as Record<string, string | undefined>)[key] : undefined;
  return word ? `Next step: ${word}` : null;
}

// pi-1.6 (solo review M17): the sentences about what each source gives, written once. Twelve
// surfaces still said the terminal "changes no number" and the habits are "shown only to you" a
// week after the practice index made the terminal the number a solo developer has.

/** What the terminal gives. Schema 2.10: the agents it reads are named — Claude Code and Codex. */
export const TERMINAL_GIVES_LINE =
  "Your Claude Code and Codex sessions are your practice index: counted on your machine, never your prompts or code.";

/** pi-1.7, decision 3 — the owner's line when Codex (or Claude Code) entered and moved the number by
 *  more than half its interval: "Recomputed with Codex sessions." */
export function practiceRecomputedText(agent: Agent | null | undefined): string | null {
  return agent ? `Recomputed with ${AGENT_NAMES[agent]} sessions.` : null;
}

/** "46 sessions from Claude Code and 3 from Codex", "3 sessions from Codex" — the agents a person
 *  has, with counts, from the scorer's own count. Null when there is none. */
export function practiceAgentsText(agents: Partial<Record<Agent, number>> | null | undefined): string | null {
  const present = AGENTS.filter((a) => (agents?.[a] ?? 0) > 0);
  if (present.length === 0) return null;
  const parts = present.map((a, i) => {
    const n = agents![a]!;
    return i === 0 ? `${n} session${n === 1 ? "" : "s"} from ${AGENT_NAMES[a]}` : `${n} from ${AGENT_NAMES[a]}`;
  });
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The methodology's table: for each device practice, the agents whose sessions can show it, and
 *  for each one that cannot, why — read from `NOT_EXPRESSIBLE`, never typed beside the page. */
export type PracticeAgentRow = {
  key: string;
  word: string;
  agents: { agent: Agent; name: string; visible: boolean; reason: string | null }[];
};
export function practiceAgentRows(): PracticeAgentRow[] {
  const out: PracticeAgentRow[] = [];
  for (const key of DEVICE_PRACTICES) {
    const word = (PRACTICE_PLAIN_WORDS as Record<string, string | undefined>)[key];
    if (!word) continue; // a trace no surface names (hb-1.0's plan_before_edit, diff_before_commit)
    out.push({
      key,
      word,
      agents: AGENTS.map((agent) => {
        const reason = (NOT_EXPRESSIBLE[agent] as Record<string, string | undefined>)[key] ?? null;
        return { agent, name: AGENT_NAMES[agent], visible: reason === null, reason };
      }),
    });
  }
  return out;
}
/** What the editor gives. */
export const EDITOR_GIVES_LINE =
  "Whether you read an AI suggestion before accepting it counts in your practice index, counted on your machine.";
/** Who sees what of the practices. */
export const PRACTICE_PRIVACY_LINE =
  "Only the number, its range and the level are public; which practices make it up is yours.";
/** When a number appears, for both: the index and the claim. */
export const FIRST_NUMBER_LINE =
  `Your practice index appears from ${PRACTICE_RULE.preliminary_sessions} sessions or pieces of shipped work; ` +
  `others see it from ${PRACTICE_RULE.min_sessions}.`;

/** pi-1.6 (review M17): what a stranger's link shows of the index, said to the owner before they
 *  share it — the owner sees a reading from 5 sessions, a stranger nothing until the public floor,
 *  and the share dialog used to say neither. Null when there is no index at all. */
export function practiceShareLine(
  p:
    | {
        state: string;
        n_sessions: number;
        min_sessions: number;
        n_landings?: number;
        min_landings?: number;
        n_days?: number;
        min_days?: number;
      }
    | null
    | undefined,
): string | null {
  if (!p) return null;
  if (p.state === "published") return "Your practice index is on it: the number, its range and the level.";
  const have = [`${p.n_sessions} session${p.n_sessions === 1 ? "" : "s"}`];
  if ((p.n_landings ?? 0) > 0) have.push(practiceLandingsText(p.n_landings ?? 0));
  const days = (p.min_days ?? 0) > 0 ? ` over ${p.min_days} days` : "";
  const onDays = (p.min_days ?? 0) > 0 ? ` on ${p.n_days ?? 0} day${(p.n_days ?? 0) === 1 ? "" : "s"}` : "";
  return (
    `Your practice index shows to others from ${p.min_sessions} sessions or pieces of shipped work${days} ` +
    `(you have ${have.join(" and ")}${onDays}); until then they see what you shipped.`
  );
}
