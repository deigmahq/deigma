/**
 * Closed name vocabularies and the device-local project hash.
 *
 * Core 7 retired E-1.1 (project equipping: what a project has configured and what a session used),
 * and with it everything that read a project's files on this machine. What remains is what other
 * code still needs:
 *   - `REVIEWER_WORDS` / `matchesAny` classify a subagent or tool by NAME as a review (PtL-1.0's
 *     `review` verification category, counted from the journal and the live proxy);
 *   - `projectHash` is the salted directory hash `prompt.history` events carry.
 * Names are matched against a closed vocabulary; the bodies of subagents, skills and hooks are
 * never opened.
 */

import { createHash } from "node:crypto";

/** What a reviewing subagent is called: `review` / `security` / `test`, and nothing else.
 *
 *  6.2 §11.1 fixes those three words. An open-ended vocabulary is precisely what a closed one
 *  exists to prevent: `qa-helper` and `lint-fix` once collected the category on a word the spec
 *  never named. Matching on the NAME is what lets the subagent's own definition stay unread. */
export const REVIEWER_WORDS = ["review", "security", "test"] as const;

export function matchesAny(name: string, words: readonly string[]): boolean {
  const low = name.toLowerCase();
  return words.some((w) => low.includes(w));
}

/** A salted, device-local hash of the project directory: enough for the server to count the
 *  prompts of one project together, never enough to learn which project it is. Same mechanism
 *  as a non-built-in tool name. */
export function projectHash(root: string, salt: string): string {
  return createHash("sha256").update(salt).update(root, "utf8").digest("hex").slice(0, 12);
}
