// The stamp: the one sentence every artifact prints about a passport's status (Core 7 §5).
//
// Plain TypeScript, deliberately outside the zod schemas and the JSON Schema codegen: nothing here
// travels on the wire. It lives in this package because five surfaces print it — the card, the
// badge, the OG image, the LinkedIn card and the terminal — and only one of them is React.

import type { Snapshot } from "./snapshot";

/**
 * How a mode of working reads. Since Core 7 the mode is a FACT about the work (it does not enter
 * the claim), so the stamp no longer carries it; the facts layer and the History page still say it.
 */
export const MODE_LABELS: Record<Snapshot["work_mode"], string> = {
  assist: "in the editor",
  delegate: "through agents",
  orchestrate: "orchestrating agents",
  unattributed: "from GitHub alone",
  mixed: "editor and agents",
};

const STATUS_WORD: Record<Snapshot["status"], string> = {
  verified: "Verified",
  calibrating: "Calibrating",
  draft: "Draft",
};

/** What qualifies the word Verified (Core 7 §5): it never stands bare, and it says who decided. */
export const VERIFIED_BY = "decided by other people";

export type StampParts = {
  /** What leads: the status word. */
  head: string;
  /** What qualifies it: for Verified, who decided; otherwise nothing. */
  tail: string[];
};

/** The stamp, in parts, for a surface that sets the qualifier in a quieter ink. */
export function stampParts(status: Snapshot["status"]): StampParts {
  const word = STATUS_WORD[status] ?? STATUS_WORD.calibrating;
  return status === "verified" ? { head: word, tail: [VERIFIED_BY] } : { head: word, tail: [] };
}

/** The stamp as one line: "Verified · decided by other people", "Calibrating", "Draft". */
export function stampText(status: Snapshot["status"]): string {
  const { head, tail } = stampParts(status);
  return [head, ...tail].join(" · ");
}

/** pi-1.6 (solo review blocker): where the evidence of a practice index was read. */
const PRACTICE_SOURCE_WORD: Record<string, string> = {
  device: "read on the developer's machine",
  github: "read from GitHub",
  both: "read on the machine and from GitHub",
};

/**
 * The stamp when a PUBLISHED practice index stands on the card and the claim is not Verified: the
 * index's own line, never "Calibrating". "Calibrating" is the claim's state; printed beside a
 * published "71 · Strong" it read as "this number is not ready" on the landing, the badge, the OG
 * image and the public page — the most shared surfaces said the opposite of what was true.
 */
export function stampPartsFor(input: {
  status: Snapshot["status"];
  practicePublished: boolean;
  practiceSource?: string | null | undefined;
}): StampParts {
  if (input.status === "verified" || !input.practicePublished) return stampParts(input.status);
  const where = PRACTICE_SOURCE_WORD[input.practiceSource ?? ""];
  return { head: "Practice index", tail: where ? [where] : [] };
}

function stampLine(parts: StampParts): string {
  return [parts.head, ...parts.tail].join(" · ");
}

type WithPractice = {
  status: Snapshot["status"];
  practice_index?: { state?: string; value?: number | null; source?: string | null } | null;
};

/** The stamp of an owner's snapshot — the terminal and the coach read it from here. */
export function snapshotStampText(snapshot: WithPractice): string {
  const p = snapshot.practice_index;
  return stampLine(
    stampPartsFor({ status: snapshot.status, practicePublished: p?.state === "published", practiceSource: p?.source }),
  );
}

/** The stamp of a passport as a STRANGER receives it (`/p/:handle`). The public projection
 *  carries the index only once published, so its presence is the test. */
export function publicStampText(passport: {
  status: Snapshot["status"];
  practice_index?: { value: number; source?: string | null } | null;
}): string {
  return stampLine(
    stampPartsFor({
      status: passport.status,
      practicePublished: !!passport.practice_index,
      practiceSource: passport.practice_index?.source,
    }),
  );
}
