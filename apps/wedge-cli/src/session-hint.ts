/**
 * Which carrier a journal session names (audit 2026-10-09 #4).
 *
 * Two ways, the exact one first:
 *
 *   1. A `pr-link` record (Claude Code writes one when the session opens or touches a pull
 *      request). When the stretch names EXACTLY ONE pull request and its repository is one the
 *      person connected, the session binds to that pull request: `{repoId, prNumber}` — the shape
 *      the server's `resolve_carrier_key` tries first. The
 *      branch rides along only when the session's own checkout is that same repository.
 *   2. Otherwise the old rule: the checkout's branch and the day (`carrierHintFor`).
 *
 * Why exactly one. On this machine 9 of the 22 sessions that named any pull request named two
 * to five of them: an afternoon that opened four pull requests is not "the work of" any one of
 * them, and choosing one would attach the whole session's telemetry to a guess. Those stretches
 * keep the branch-and-day rule they had, which is no worse than before.
 *
 * The branch rides beside the number whenever the checkout IS that repository (review of PR #29):
 * a pull request the session merely touched — somebody else's, one it reviewed — is not the
 * person's carrier, and the server then falls back to the run of that branch on that day
 * (`resolve_carrier_key`). A single pull request in a repository the person did NOT connect falls
 * back to the branch rule on the device.
 *
 * Nothing here travels but the numeric repository id of a connected repository and the number:
 * `prRepository` is matched on the device and dropped, like the remote URL.
 */
import { carrierHintFor, connectedRepoId, connectedRepoIdAt, type ConnectedRepo } from "@mentat/wedge-core";

import type { ClaudeCodeSession } from "./journals/claude-code";

export type SessionHint = { repoId: number; branch?: string; prNumber?: number };

export function sessionCarrierHint(
  session: Pick<ClaudeCodeSession, "cwd" | "branch" | "pullRequests">,
  connected: ReadonlyArray<ConnectedRepo>,
  readFile?: (p: string) => string,
): SessionHint | null {
  if (session.pullRequests.length === 1) {
    const pr = session.pullRequests[0]!;
    const repoId = connectedRepoId(pr.repository, connected);
    // A pull request somewhere the person did not connect: the server cannot see it, and the
    // checkout's own branch rule is what is left (review of PR #29).
    if (!repoId) return carrierHintFor(session.cwd, session.branch, connected, readFile);
    const ownRepo = connectedRepoIdAt(session.cwd, connected, readFile);
    return {
      repoId,
      prNumber: pr.number,
      ...(ownRepo === repoId && session.branch ? { branch: session.branch } : {}),
    };
  }
  return carrierHintFor(session.cwd, session.branch, connected, readFile);
}
