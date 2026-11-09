// Weekly Pulse in the terminal (Playbook v1.4 §3.1), on Engine Core 7. The speech rules are the
// product, not a detail, so they live in one pure function with tests:
//
//   (a) the counters of the week, then the stamp;
//   (b) the claim: its value with its interval once proven, otherwise how far it is from proven —
//       never a value of an unproven claim;
//   (c) empty weeks are skipped, never reported as a zero;
//   (d) the habits, as counts of sessions, never a grade.
//
// Nothing here may print a metric value that the engine has not confirmed (honest sharing).

import { snapshotStampText, type PassportView, type Snapshot } from "@mentat/schemas";

import { decisionsLine, practiceLines } from "./words";

export type PulseInput = {
  view: PassportView;
  /** Episodes closed in the reported week and how many of them reached a final status. */
  week: { episodes: number; finalised: number; from: string; to: string };
  /** Days of wedge telemetry so far. */
  telemetryDays: number;
};

export type Pulse = { skipped: true } | { skipped: false; lines: string[] };

export function weeklyPulse(input: PulseInput): Pulse {
  // (c) an empty week is skipped, not reported as a zero. A week of terminal sessions with no
  // shipped work is not empty when the practice index has a reading: it is what moved (review).
  const reading =
    input.view.status !== "init" && input.view.snapshot.practice_index?.value !== null && input.view.snapshot.practice_index !== null;
  if (input.week.episodes === 0 && !reading) return { skipped: true };

  const lines: string[] = [`Week ${input.week.from} — ${input.week.to}`];
  if (input.week.episodes > 0) {
    lines.push(
      `+${input.week.episodes} piece${input.week.episodes === 1 ? "" : "s"} of work · ` +
        `${input.week.finalised} got a confirmed result`,
    );
  }

  if (input.view.status === "init") {
    lines.push("Your Deigma is still a draft: no numbers until something is proven.");
    return { skipped: false, lines };
  }

  const s: Snapshot = input.view.snapshot;
  const claim = s.claims.decisions_by_others;
  lines.push(
    snapshotStampText(s) +
      // A breadth of nothing must not leave a separator hanging off the end of the line.
      `${claim.proven && s.context_breadth.label ? ` · ${s.context_breadth.label}` : ""}`,
  );
  const practice = practiceLines(s.practice_index);
  if (claim.proven) lines.push(...decisionsLine(claim), ...practice);
  else lines.push(...practice, ...decisionsLine(claim));
  return { skipped: false, lines };
}

export function renderPulse(pulse: Pulse): string {
  return pulse.skipped ? "" : pulse.lines.join("\n");
}
