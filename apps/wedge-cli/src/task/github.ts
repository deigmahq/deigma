/**
 * The pull request of the current branch, from GitHub's public REST API.
 *
 * The task repository is public (the candidate's copy of a public template), so the lookup needs no
 * token: one unauthenticated read of `GET /repos/{owner}/{name}/pulls?head={owner}:{branch}`. It is
 * asked of GitHub directly and not through Deigma's API, and with the network the command was given
 * for public addresses — not the one that adds Deigma's client header to its own requests, which
 * GitHub has no use for. Only the repository's name and a branch name are in the request, both of
 * them already public on that repository.
 *
 * Where GitHub cannot be asked (offline, rate-limited, the repository is not public), the answer is
 * `unreachable`, and the command says how to name the pull request instead (`--pr`).
 */

export type PullLookup =
  | { kind: "found"; number: number }
  | { kind: "none" }
  | { kind: "several"; numbers: number[] }
  | { kind: "unreachable" };

type Pull = { number: number; state: string };

function pullsOf(body: unknown, repo: string, branch: string): Pull[] {
  if (!Array.isArray(body)) return [];
  const out: Pull[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const p = item as { number?: unknown; state?: unknown; head?: { ref?: unknown; repo?: { full_name?: unknown } | null } };
    if (typeof p.number !== "number" || !Number.isInteger(p.number) || p.number < 1) continue;
    // From a branch of THIS repository: a pull request from somebody's fork to it is not the work.
    if (p.head?.ref !== branch) continue;
    const from = p.head.repo?.full_name;
    if (typeof from !== "string" || from.toLowerCase() !== repo.toLowerCase()) continue;
    out.push({ number: p.number, state: typeof p.state === "string" ? p.state : "" });
  }
  return out.sort((a, b) => a.number - b.number);
}

export async function findPullRequest(
  publicFetch: typeof globalThis.fetch,
  repo: string,
  branch: string,
): Promise<PullLookup> {
  const owner = repo.split("/")[0] ?? "";
  const url =
    `https://api.github.com/repos/${repo}/pulls?state=all&per_page=30` +
    `&head=${encodeURIComponent(`${owner}:${branch}`)}`;
  let body: unknown;
  try {
    const res = await publicFetch(url, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "deigma-cli" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { kind: "unreachable" };
    body = await res.json();
  } catch {
    return { kind: "unreachable" };
  }
  const pulls = pullsOf(body, repo, branch);
  if (pulls.length === 0) return { kind: "none" };
  if (pulls.length === 1) return { kind: "found", number: pulls[0]!.number };
  // Several from one branch: the open one, if there is exactly one. Otherwise the person says which.
  const open = pulls.filter((p) => p.state === "open");
  if (open.length === 1) return { kind: "found", number: open[0]!.number };
  return { kind: "several", numbers: pulls.map((p) => p.number) };
}
