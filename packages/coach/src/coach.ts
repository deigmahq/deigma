// Coach v0 (Playbook §3, §3.1), on Engine Core 7.
//
// The coach speaks the language of the core and nothing else: the claim decisions by others, the
// facts and the habits. Two things it must never say, and they are the reason this file is a fixed
// vocabulary rather than a template with numbers in it:
//
//   * causal claims — "this saved you N hours", "you are N % faster". We measure association on
//     one person's own history; the causal question waits for a common yardstick;
//   * percentiles or comparisons with other people — "top N %", "better than N % of engineers".
//     The claim is a level in a typical project, not a rank (Core 7 §3.4).
//
// Everything the coach says is either a fact from the snapshot or a direction with no magnitude.

import { snapshotStampText, type Snapshot } from "@mentat/schemas";

import { CLAIM_TITLES, pendingText, practiceLines, provenLines } from "./words";

export type CoachLine = { topic: "decisions_by_others" | "habits" | "composition" | "practice"; text: string };

/** What a Deigma can honestly say about itself, in order of usefulness to the owner. */
export function coach(snapshot: Snapshot): CoachLine[] {
  const lines: CoachLine[] = [];
  const claim = snapshot.claims.decisions_by_others;
  if (claim.proven) {
    lines.push({
      topic: "composition",
      text: `${snapshotStampText(snapshot)}, ${snapshot.context_breadth.label}.`,
    });
    lines.push({
      topic: "decisions_by_others",
      text: `${provenLines(claim).join(" ")} · on ${claim.n_observations} pull requests other people decided. A level in a typical project, not a rank among people.`,
    });
  } else if (claim.n_observations > 0) {
    lines.push({
      topic: "decisions_by_others",
      text: `${CLAIM_TITLES.decisions_by_others} is ${pendingText(claim)}. It counts only pull requests somebody other than you merged or closed.`,
    });
  }
  // pi-1.6: the practice index is what a solo developer has; it leads where the claim cannot.
  const practice = practiceLines(snapshot.practice_index);
  for (const text of practice) lines.push({ topic: "practice", text });
  if (!claim.proven && claim.n_observations === 0 && practice.length === 0) {
    lines.push({
      topic: "composition",
      text: "Nothing is proven yet, so nothing is published. What exists so far is how much work was read, and your Deigma shows it as that.",
    });
  }
  return lines;
}

/** The two families of sentence the coach may never produce. Exported so the test can be read as
 *  the rule itself rather than as a list of regexes buried in a spec file. */
export const FORBIDDEN_PATTERNS: RegExp[] = [
  /saved?\s+(you\s+)?\d/i,
  /\d+\s*(hours?|hrs?|days?)\s+(saved|faster|quicker)/i,
  /\b\d+\s*%\s*(faster|more productive|better)\b/i,
  /\btop\s*\d+\s*%/i,
  /better than\s+\d+\s*%/i,
  /\bpercentile\b/i,
  /\bcompared to (other|your peers|the average)\b/i,
];

export function violatesSpeechRules(text: string): RegExp | null {
  return FORBIDDEN_PATTERNS.find((re) => re.test(text)) ?? null;
}
