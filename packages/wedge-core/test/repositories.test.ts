/**
 * What decides whether a session's branch may travel (B4.3).
 *
 * The decision this encodes: a branch is worth sending only for a repository the server can bind
 * it to. Inside a connected repository the branch names are ones the server reads from the carrier
 * events anyway; outside one, `feature/acme-billing-migration` is an employer and a project with
 * nothing to resolve against. Hashing does not help — a hash cannot bind either — so the branch is
 * simply not sent, and the session arrives unresolved on purpose.
 */
import { describe, expect, it } from "vitest";

import { branchAt, carrierHintFor, repoAt, repoFromRemote } from "../src/repositories";

const CONNECTED = [
  { repo_id: 900, full_name: "acme/shop" },
  { repo_id: 901, full_name: "acme/platform" },
];

/** A fake filesystem: `.git/config` files by absolute path. */
function fs(files: Record<string, string>): (p: string) => string {
  return (p: string) => {
    const found = files[p];
    if (found === undefined) throw new Error(`ENOENT ${p}`);
    return found;
  };
}

const CONFIG = (url: string): string => `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*\n`;

describe("reading which repository a directory is", () => {
  it("understands both forms git writes a github remote in", () => {
    expect(repoFromRemote("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(repoFromRemote("https://github.com/acme/shop")).toBe("acme/shop");
    expect(repoFromRemote("ssh://git@github.com/acme/shop.git")).toBe("acme/shop");
    expect(repoFromRemote("https://gitlab.com/acme/shop")).toBeNull();
  });

  it("walks up from a subdirectory, because a session's cwd usually is one", () => {
    const read = fs({ "/w/repo/.git/config": CONFIG("git@github.com:acme/shop.git") });
    expect(repoAt("/w/repo/app/src", read)).toBe("acme/shop");
    expect(repoAt("/w/elsewhere", read)).toBeNull();
  });

  it("prefers origin when a checkout has several remotes", () => {
    const read = fs({
      "/w/repo/.git/config":
        '[remote "upstream"]\n\turl = git@github.com:someone/fork.git\n[remote "origin"]\n\turl = git@github.com:acme/shop.git\n',
    });
    expect(repoAt("/w/repo", read)).toBe("acme/shop");
  });
});

describe("whether a session's branch may travel", () => {
  const read = fs({
    "/w/shop/.git/config": CONFIG("git@github.com:acme/shop.git"),
    "/w/private/.git/config": CONFIG("git@github.com:acme/private-tools.git"),
  });

  it("sends branch and repository together for a connected repository", () => {
    expect(carrierHintFor("/w/shop/app", "release-2", CONNECTED, read)).toEqual({
      repoId: 900,
      branch: "release-2",
    });
  });

  it("sends nothing at all for a repository nobody connected", () => {
    /** The whole decision in one assertion: not a hash, not a redaction — absence. */
    expect(carrierHintFor("/w/private", "feature/acme-billing-migration", CONNECTED, read)).toBeNull();
  });

  it("sends nothing when the directory is not a checkout, or the branch is unknown", () => {
    expect(carrierHintFor("/w/nowhere", "main", CONNECTED, read)).toBeNull();
    expect(carrierHintFor("/w/shop", null, CONNECTED, read)).toBeNull();
    expect(carrierHintFor(null, "main", CONNECTED, read)).toBeNull();
  });

  it("sends nothing before the device has been told anything", () => {
    /** An empty list is the honest state at install: every session unresolved, no names on the
     *  wire, and the panel says so. */
    expect(carrierHintFor("/w/shop", "main", [], read)).toBeNull();
  });
});

describe("the two layouts a checkout comes in (audit 2026-10-09 #3)", () => {
  // Shapes read off real checkouts on 2026-10-09: a linked worktree's `.git` is a FILE pointing
  // at its git dir; HEAD lives there, and the shared config sits in `commondir` (`../..`).
  const worktree = fs({
    "/w/main/.git/config": CONFIG("git@github.com:acme/shop.git"),
    "/w/main/.git/HEAD": "ref: refs/heads/main\n",
    "/w/main/.git/worktrees/wt1/HEAD": "ref: refs/heads/fix/example-binding\n",
    "/w/main/.git/worktrees/wt1/commondir": "../..\n",
    "/w/wt1/.git": "gitdir: /w/main/.git/worktrees/wt1\n",
  });

  it("reads a worktree's own branch and the shared remote", () => {
    expect(repoAt("/w/wt1/app/web", worktree)).toBe("acme/shop");
    expect(branchAt("/w/wt1/app/web", worktree)).toBe("fix/example-binding");
    expect(branchAt("/w/main", worktree)).toBe("main");
  });

  it("a relative gitdir (a submodule) resolves against the directory that holds it", () => {
    const sub = fs({
      "/w/main/vendor/lib/.git": "gitdir: ../../.git/modules/lib\n",
      "/w/main/.git/modules/lib/HEAD": "ref: refs/heads/dev\n",
      "/w/main/.git/modules/lib/config": CONFIG("https://github.com/acme/lib.git"),
    });
    expect(repoAt("/w/main/vendor/lib", sub)).toBe("acme/lib");
    expect(branchAt("/w/main/vendor/lib", sub)).toBe("dev");
  });

  it("a detached HEAD is no branch", () => {
    const detached = fs({ "/w/r/.git/config": CONFIG("git@github.com:a/b.git"), "/w/r/.git/HEAD": "4f2c1e0\n" });
    expect(branchAt("/w/r", detached)).toBeNull();
  });
});
