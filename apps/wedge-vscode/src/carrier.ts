// Which carrier an accepted suggestion belongs to — the editor's half of the binding (audit
// 2026-10-09 #3).
//
// Until this, the extension sent the branch of the first workspace folder and no repository, and
// the server's join (`carrier_key_from_hint`) needs a
// `repo_id` before it looks at anything else: not one IDE draft ever reached an episode, so the
// verification-discipline claim had evidence that could never meet a result. And the branch went
// out for EVERY repository, connected or not — a name with no use on the wire.
//
// Now it is the CLI's rule, through the CLI's own functions (wedge-core/src/repositories.ts):
// the document's checkout -> its git remote -> `owner/name` -> the person's connected list from
// `GET /v1/me/repositories` -> the numeric repository id. Branch and id travel together, and only
// for a repository the person connected; anywhere else the hint is absent and the draft arrives
// unattached. The remote URL, `owner/name` and the path never leave the machine.
import { dirname } from "node:path";

import { branchAt, carrierHintFor, type ConnectedRepo } from "@mentat/wedge-core";

/** How often the connected list is asked for again while the editor collects. */
export const REPOSITORIES_REFRESH_MS = 30 * 60 * 1000;

export type RepositoryHintsDeps = {
  apiBaseUrl: string;
  session: string;
  fetch: typeof globalThis.fetch;
  /** Injected in tests; the real one reads the files under `.git`. */
  readFile?: (p: string) => string;
};

export class RepositoryHints {
  private connected: ConnectedRepo[] = [];

  constructor(private readonly deps: RepositoryHintsDeps) {}

  /** Asks the server which repositories this person connected. A failure keeps what was known:
   *  an unreachable API must not turn bound drafts into unbound ones, and must never throw into
   *  the editor. */
  async refresh(): Promise<void> {
    try {
      const res = await this.deps.fetch(`${this.deps.apiBaseUrl}/v1/me/repositories`, {
        headers: { authorization: `Bearer ${this.deps.session}` },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { repositories?: unknown };
      if (!Array.isArray(body.repositories)) return;
      this.connected = body.repositories.filter(
        (r): r is ConnectedRepo =>
          !!r &&
          typeof (r as ConnectedRepo).repo_id === "number" &&
          Number.isInteger((r as ConnectedRepo).repo_id) &&
          (r as ConnectedRepo).repo_id > 0 &&
          typeof (r as ConnectedRepo).full_name === "string",
      );
    } catch {
      // fail open: the hint is telemetry, the editor is the person's work
    }
  }

  /** The hint for a document at `filePath` (or a directory), or null when it cannot bind. */
  hintFor(path: string | null, isFile = true): { repoId: number; branch: string } | null {
    if (!path) return null;
    const dir = isFile ? dirname(path) : path;
    try {
      return carrierHintFor(dir, branchAt(dir, this.deps.readFile), this.connected, this.deps.readFile);
    } catch {
      return null;
    }
  }
}
