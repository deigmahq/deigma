// `deigma status`: your Deigma in the terminal (Playbook v1.5 §2.1, §4), on Engine Core 7.
//
// One claim, so the terminal says whether it is proven and prints its value only then, always with
// its interval in words; otherwise how far it is from proven. A CLI that printed a bare number
// would be the fastest way to teach people that our numbers mean nothing. The sentences live in
// @mentat/coach (`words.ts`), shared with the pulse and its email.

import { decisionsLine, practiceLines } from "@mentat/coach";
import { snapshotStampText, type PassportView, type Snapshot } from "@mentat/schemas";

export type StatusInput = {
  view: PassportView;
  telemetryDays: number;
};

export function renderStatus(input: StatusInput): string {
  const { view, telemetryDays } = input;
  if (view.status === "init") {
    return ["Your Deigma: draft", "We are reading your connected history; nothing is published yet."].join("\n");
  }
  const s: Snapshot = view.snapshot;
  const claim = s.claims.decisions_by_others;
  const lines = [
    `Your Deigma: ${snapshotStampText(s)}`,
    `${s.volumes.n_carriers} pieces of work read, ${s.volumes.n_outcomes_final} with a confirmed result` +
      `${claim.proven && s.context_breadth.label ? ` · ${s.context_breadth.label}` : ""}` +
      ` · ${telemetryDays} day${telemetryDays === 1 ? "" : "s"} of work read from this machine`,
  ];
  // A proven claim leads; otherwise the practice index does — for somebody who works alone it is
  // the number there is (solo review, 2026-10-18).
  const practice = practiceLines(s.practice_index);
  if (claim.proven) lines.push(...decisionsLine(claim), ...practice);
  else lines.push(...practice, ...decisionsLine(claim));
  return lines.join("\n");
}
