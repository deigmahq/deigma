// The words a claim is said in, outside the web: the terminal (`deigma status`, `deigma pulse`)
// and the pulse email read them from here.
//
// The numbers come from the snapshot; this file only decides how they read. Three rules hold every
// sentence below, and test/words.test.ts holds the rules:
//
//   * a value is printed only for a proven claim, and never alone: beside it stands its interval
//     in words ("between 82 and 91");
//   * a habit is a count of sessions, never a grade, a percentage of a target or a bar;
//   * the inside of the program does not reach a person: no "passport", no "landing", "carrier",
//     "witness" or "wedge" — code identifiers keep their names.

import {
  CLAIM_NAMES,
  claimTitle,
  PRACTICE_NAME,
  practiceHeadline,
  practiceAgentsText,
  practiceMovementText,
  practiceRecomputedText,
  practiceNextStepText,
  practiceStrengthsText,
  type Claim,
  type ClaimKey,
  type Snapshot,
} from "@mentat/schemas";

/** Claim titles: the shared names (@mentat/schemas `CLAIM_NAMES`) set as titles, so the terminal
 *  and the web cannot name one claim two ways. */
export const CLAIM_TITLES: Record<ClaimKey, string> = Object.fromEntries(
  Object.keys(CLAIM_NAMES).map((key) => [key, claimTitle(key as ClaimKey)]),
) as Record<ClaimKey, string>;

/** Every unit the scorer writes into `progress.unit`, as a person says it: [one, many]. */
const UNIT_WORDS: Record<string, [string, string]> = {
  "pull requests decided by other people": [
    "pull request decided by another person",
    "pull requests decided by other people",
  ],
};

/** A unit in words. An unknown unit is de-underscored, so a unit added tomorrow reads as English
 *  rather than as an identifier until somebody writes it a phrase. */
export function unitWords(unit: string, n: number): string {
  const words = UNIT_WORDS[unit.trim()];
  if (!words) return unit.trim().replace(/_/g, " ");
  return n === 1 ? words[0] : words[1];
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function points(x: number): string {
  return String(Math.round(x * 100));
}

/** What a PROVEN claim says. Empty for a claim that is not proven: nothing on this path can print
 *  the value of an unproven claim, because nothing on it reads one. */
export function provenLines(claim: Claim): string[] {
  if (!claim.proven || claim.value === null || !claim.ci90) return [];
  const { lo, hi } = claim.ci90;
  return [`${CLAIM_TITLES[claim.key]}: ${pct(claim.value)}, between ${points(lo)} and ${points(hi)}`];
}

/** What a claim that is NOT proven says: how far it is from proven, never a value and never the
 *  bounds of its interval. "about" appears only where the scorer marked the figure a projection. */
export function pendingText(claim: Claim): string {
  const p = claim.progress;
  if (!p || p.need <= 0) return "not proven yet: nothing counted towards it yet";
  const left = Math.ceil(p.need - p.have);
  if (left <= 0) return "not proven yet: the range is still too wide to show a number";
  return `not proven yet: ${p.approximate ? "about " : ""}${left} more ${unitWords(p.unit, left)} to go`;
}

// The hb-1.0 habit traces are no longer printed anywhere (founder, 2026-10-18): they were counted
// by their own older rules and contradicted the practice index beside them ("0 of 476" next to
// "55 of 183" for the same practice). What the index is made of is the owner's breakdown dialog.

/** The basis of the index in the terminal's words: the web's "landings" is the inside of the
 *  program here (test/copy-v4), so a landing is "a shipped piece of work". */
function terminalBasis(sessions: number, landings: number): string {
  const s = `${sessions} session${sessions === 1 ? "" : "s"}`;
  const l = `${landings} shipped piece${landings === 1 ? "" : "s"} of work`;
  if (sessions > 0 && landings > 0) return `${s} · ${l}`;
  return sessions === 0 && landings > 0 ? l : s;
}

/**
 * The practice index in the terminal and the email (solo review B2/M17, 2026-10-18). Status and
 * pulse never mentioned it, and for a person who works alone the only thing they printed was a
 * countdown of pull requests nobody else would ever decide. Owner surfaces: the preliminary reading
 * (with its interval, stamped) and the movement are allowed here exactly as on the dashboard.
 *
 * "collecting" names only the floor that is still short — never "40 of 20 sessions" when the
 * sessions are there and the days are not.
 */
export function practiceLines(p: Snapshot["practice_index"] | null | undefined): string[] {
  if (!p) return [];
  const basis = terminalBasis(p.n_sessions, p.n_landings ?? 0);
  if (p.state === "collecting" || p.value === null || !p.ci90) {
    const short: string[] = [];
    if (p.n_sessions < p.min_sessions && (p.n_landings ?? 0) < (p.min_landings ?? 0)) {
      short.push(
        p.n_sessions > 0 || !p.min_landings
          ? `${p.n_sessions} of ${p.min_sessions} sessions`
          : `${p.n_landings} of ${p.min_landings} shipped pieces of work`,
      );
    }
    if ((p.min_days ?? 0) > 0 && (p.n_days ?? 0) < (p.min_days ?? 0)) short.push(`${p.n_days} of ${p.min_days} days`);
    const from = practiceAgentsText(p.agents);
    return [`${PRACTICE_NAME}: collecting${short.length ? ` — ${short.join(", ")}` : ""}`, ...(from ? [`Read: ${from}`] : [])];
  }
  const head = `${practiceHeadline(p.value, p.level)}, between ${p.ci90.lo} and ${p.ci90.hi} · ${basis}`;
  const lines =
    p.state === "published"
      ? [`${PRACTICE_NAME}: ${head}`]
      : [`${PRACTICE_NAME} (preliminary, only you see it): ${head} · narrows as more work is read`];
  // Schema 2.10: the agents the number was read from, with counts — only those the person has.
  const from = practiceAgentsText(p.agents);
  if (from) lines.push(`Read: ${from}`);
  const recomputed = practiceRecomputedText(p.recomputed_with);
  if (recomputed) lines.push(recomputed);
  const moved = practiceMovementText(p.delta_7d, p.delta_reason);
  if (moved) lines.push(moved);
  const strong = practiceStrengthsText(p.strengths);
  if (strong) lines.push(strong);
  const next = practiceNextStepText(p.next_step);
  if (next) lines.push(next);
  return lines;
}

/** The line about decisions by others: the claim when proven, a countdown while it is reachable,
 *  and — for a person whose work nobody else has decided yet — a fact, not a countdown. */
export function decisionsLine(claim: Claim): string[] {
  const proven = provenLines(claim);
  if (proven.length) return proven;
  if ((claim.progress?.have ?? 0) <= 0) return [`${CLAIM_TITLES[claim.key]}: none decided yet`];
  return [`${CLAIM_TITLES[claim.key]}: ${pendingText(claim)}`];
}
