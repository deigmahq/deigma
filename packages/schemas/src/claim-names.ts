// The claims' names in plain words — ONE source for every surface that says them to a person:
// the web's cells, notes and stamp (packages/ui `CLAIM_LABELS`, lowercase as a cell sets them),
// and the terminal and the pulse email (packages/coach `CLAIM_TITLES`, the same words as a title).
// Not a wire type: nothing here is validated or exported to JSON Schema.
//
// They lived in two files and had already drifted apart (the security claim was "ships without an
// incident" on the web and "Security hygiene" in the terminal). One list, two casings, and a test
// in each package that its own table is this one.

import type { ClaimKey } from "./snapshot";

export const CLAIM_NAMES: Record<ClaimKey, string> = {
  // Core 7 (2026-10-15): the one claim. Said as what a reader can check on GitHub — other people
  // merged the work rather than closing it — and never as "quality" or "skill".
  decisions_by_others: "accepted by other people",
};

/** The same name as a title: its first letter capitalised, nothing else changed. */
export function claimTitle(key: ClaimKey): string {
  const name = CLAIM_NAMES[key];
  return name.charAt(0).toUpperCase() + name.slice(1);
}
