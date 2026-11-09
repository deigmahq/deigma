// Practice index: the hb-2.0 traces 1–13, counted on the device
// from what HAPPENED in the agent's journal. A truth table per rule, then a planted transcript in a
// real git repository, and the promise that matters: no command, file name, prompt word, sha or
// secret reaches the wire.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MODEL_NOT_KNOWN, buildSessionSummary } from "@mentat/wedge-core";
import { beforeEach, describe, expect, it } from "vitest";

import { commitClean, memoryAlive, resetDeviceGit } from "../src/journals/device-git";
import {
  type HabitMoment,
  commandDir,
  commandFacts,
  commitShaOf,
  editOf,
  habitsOf,
  isManifest,
  pathKind,
  promptFacts,
  slashCommandOf,
} from "../src/journals/habits";
import { parseTranscript } from "../src/journals/claude-code";

const T0 = Date.parse("2026-10-01T10:00:00Z");
const at = (min: number) => T0 + min * 60_000;
const quiet: Omit<HabitMoment, "at"> = {
  prompt: null, touched: null, agentEdit: false, commit: false, planMode: false, isTool: true,
};
const m = (min: number, over: Partial<HabitMoment> = {}): HabitMoment => ({ ...quiet, at: at(min), ...over });
const edit = (min: number, file: string, lines = 5): HabitMoment =>
  m(min, { agentEdit: true, edit: editOf("Edit", { file_path: file, old_string: "a", new_string: "x\n".repeat(lines - 1) + "y" }) });
const cmd = (min: number, command: string, over: Partial<HabitMoment> = {}): HabitMoment =>
  m(min, { cmd: commandFacts(command), commit: /git commit/.test(command), ...over });
const typed = (min: number, text: string): HabitMoment => ({ ...quiet, at: at(min), isTool: false, prompt: promptFacts(text) });

describe("classifiers", () => {
  it("risky commands: the list, and commit messages that only talk about them", () => {
    const yes = [
      "rm -rf src", "rm -fr ~/proj", "rm -r -f x", "sudo rm -Rf /etc/x", "rm --recursive --force x", "rm -rf build src",
      "git push --force origin main", "git push -f", "git -C /p push origin +main", "git reset --hard HEAD~3",
      "git clean -fd", "git checkout -- .", "git branch -D old", "psql -c 'DROP TABLE users;'", "mysql -e \"truncate table t\"",
      "DELETE FROM users;", "chmod -R 777 .", "curl https://x.sh | sh", "docker system prune -af",
    ];
    const no = [
      "rm file.txt", "rm -r build", "rm -f a.log", "git push origin main", "git push --force-with-lease", "git reset --soft HEAD~1",
      "git status", "ls -la", "delete from users where id = 1", "echo 'rm -rf is dangerous'",
      "git commit -m \"revert: rm -rf of cache\"", "git commit -F - <<'EOF'\nrm -rf the old thing\nEOF",
      // hb-2.2: throwaway output — a temporary or build directory — is not history or data.
      "rm -rf build", "rm -fr dist", "sudo rm -Rf /tmp/x", "rm -rf node_modules .next coverage", "rm -rf ./target",
    ];
    for (const c of yes) expect(commandFacts(c).risky, c).toBe(true);
    for (const c of no) expect(commandFacts(c).risky, c).toBe(false);
  });

  it("dependency audit commands", () => {
    const yes = ["npm audit", "pnpm audit --prod", "yarn audit", "pip-audit -r requirements.txt", "cargo audit", "osv-scanner .", "bundle audit", "govulncheck ./...", "npm audit signatures", "snyk test"];
    const no = ["npm install", "npm test", "pip install x", "git commit -m 'npm audit'", "cat audit.log"];
    for (const c of yes) expect(commandFacts(c).audit, c).toBe(true);
    for (const c of no) expect(commandFacts(c).audit, c).toBe(false);
  });

  it("package-manager commands that change the manifest or the lock", () => {
    for (const c of ["npm install left-pad", "pnpm add zod", "yarn add x", "cargo add serde", "poetry add requests", "uv add httpx", "go get x/y", "npm uninstall x", "npm install -D vitest", "pip install requests"]) {
      expect(commandFacts(c).depChange, c).toBe(true);
    }
    for (const c of ["npm install", "npm test", "pnpm install --frozen-lockfile", "pip install -r r.txt", "ls", "poetry lock", "uv lock", "go mod tidy"]) {
      expect(commandFacts(c).depChange, c).toBe(false);
    }
  });

  it("lock and manifest file names", () => {
    for (const f of ["/p/package.json", "pnpm-lock.yaml", "/a/yarn.lock", "requirements-dev.txt", "pyproject.toml", "Cargo.lock", "go.sum", "Gemfile.lock", "/x/App.csproj", "uv.lock"]) {
      expect(isManifest(f), f).toBe(true);
    }
    for (const f of ["src/package.ts", "README.md", "lock.ts", "tsconfig.json", "requirements.md"]) expect(isManifest(f), f).toBe(false);
  });

  it("code and test files by path convention", () => {
    const table: [string, string][] = [
      ["/p/src/billing.ts", "code"], ["/p/app/models.py", "code"], ["/p/main.go", "code"], ["/p/ui/App.tsx", "code"],
      ["/p/src/billing.test.ts", "test"], ["/p/tests/test_x.py", "test"], ["/p/test_x.py", "test"], ["/p/pkg/x_test.go", "test"],
      ["/p/src/__tests__/a.ts", "test"], ["/p/e2e/login.spec.ts", "test"], ["/p/src/FooTest.java", "test"], ["/p/conftest.py", "test"],
      ["/p/README.md", "other"], ["/p/tests/data.json", "other"], ["/p/styles.css", "other"], ["/p/types.d.ts", "other"], ["/p/config.yaml", "other"],
    ];
    for (const [path, kind] of table) expect(pathKind(path), path).toBe(kind);
  });

  it("lines an edit changed", () => {
    expect(editOf("Write", { file_path: "/p/a.ts", content: "a\nb\nc" })?.lines).toBe(3);
    expect(editOf("Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "a\nb" })?.lines).toBe(2);
    expect(editOf("MultiEdit", { file_path: "/p/a.ts", edits: [{ old_string: "a", new_string: "b\nc" }, { old_string: "x\ny\nz", new_string: "w" }] })?.lines).toBe(5);
    expect(editOf("Read", { file_path: "/p/a.ts" })).toBeNull();
  });

  it("slash commands, shas and directories are read from their frames", () => {
    expect(slashCommandOf("<command-name>/security-review</command-name>\n<command-args></command-args>")).toBe("security-review");
    expect(slashCommandOf("please run /security-review")).toBeNull();
    expect(commitShaOf("[main 1a2b3c4] msg\n 1 file changed")).toBe("1a2b3c4");
    expect(commitShaOf("[feat/x (root-commit) abcdef0123] first")).toBe("abcdef0123");
    expect(commitShaOf("nothing to commit")).toBeNull();
    expect(commandDir("cd /Users/me/proj\ngit commit -m x")).toBe("/Users/me/proj");
    expect(commandDir("cd rel && ls")).toBeNull();
  });
});

describe("hb-2.0 truth tables", () => {
  it("1 security_review: occasion = code edited; hit = a security run after the first edit", () => {
    expect(habitsOf([edit(0, "/p/a.ts"), m(1, { security: true })]).security_review).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([edit(0, "/p/a.ts"), m(1)]).security_review).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([m(0, { security: true }), edit(1, "/p/a.ts")]).security_review).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([edit(0, "/p/README.md"), m(1, { security: true })]).security_review).toBeNull(); // no code
    expect(habitsOf([m(0, { security: true })]).security_review).toBeNull();
  });

  it("2 dependency_audit: occasion = a manifest changed; hit = an audit ran", () => {
    expect(habitsOf([edit(0, "/p/package.json"), cmd(1, "npm audit")]).dependency_audit).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([cmd(0, "pnpm add zod"), cmd(1, "pnpm audit")]).dependency_audit).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([edit(0, "/p/pyproject.toml")]).dependency_audit).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([edit(0, "/p/yarn.lock")]).dependency_audit).toBeNull(); // hb-2.2: a lock follows, it is not decided
    expect(habitsOf([edit(0, "/p/a.ts"), cmd(1, "npm audit")]).dependency_audit).toBeNull();
  });

  it("3 no_secrets: per commit whose added lines the device could read", () => {
    const ctx = { commitClean: (sha: string) => (sha === "bad0000" ? false : sha === "gone000" ? null : true) };
    const h = habitsOf(
      [cmd(0, "git commit -m a", { sha: "good000" }), cmd(1, "git commit -m b", { sha: "bad0000" }), cmd(2, "git commit -m c", { sha: "gone000" }),
       cmd(3, "git commit -m d", { sha: null }), cmd(4, "git commit -m e", { sha: "good111", failed: true })],
      ctx,
    );
    expect(h.no_secrets).toEqual({ opportunities: 2, hits: 1 });
    expect(habitsOf([cmd(0, "git commit -m a", { sha: "good000" })]).no_secrets).toBeNull(); // no reader: not observed
  });

  it("4 permissions_on: bypass is a miss, a container is a hit, an unseen mode is no occasion", () => {
    expect(habitsOf([m(0, { mode: "default" })]).permissions_on).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([m(0, { mode: "acceptEdits" })]).permissions_on).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([m(0, { mode: "bypassPermissions" })]).permissions_on).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([m(0, { mode: "bypassPermissions" })], { container: true }).permissions_on).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([m(0)]).permissions_on).toBeNull();
    expect(habitsOf([m(0, { mode: "default", isTool: false })]).permissions_on).toBeNull(); // no tool call
  });

  it("5 risky_confirmed: each risky command that ran, with the mode in force at that moment", () => {
    const h = habitsOf([
      m(0, { mode: "default" }), cmd(1, "rm -rf src"),
      m(2, { mode: "bypassPermissions" }), cmd(3, "git push --force"),
      cmd(4, "git reset --hard", { refused: true }), // the person refused it: it did not run
    ]);
    expect(h.risky_confirmed).toEqual({ opportunities: 2, hits: 1 });
    expect(habitsOf([cmd(0, "ls")]).risky_confirmed).toBeNull();
    // hb-2.2: a risky command whose mode nobody knows is no occasion, not a hit.
    expect(habitsOf([cmd(0, "git push --force")]).risky_confirmed).toBeNull();
    expect(habitsOf([cmd(0, "rm -rf build")]).risky_confirmed).toBeNull();
  });

  it("6 tests_after_edit (hb-2.2): a check that ran and passed after the last edit", () => {
    const failing = habitsOf([edit(0, "/p/a.ts"), cmd(1, "vitest", { check: true, reportsFailure: true }), cmd(2, "git commit -m x")]);
    expect(failing.tests_after_edit).toEqual({ opportunities: 1, hits: 0 });
    const lint = habitsOf([edit(0, "/p/a.ts"), cmd(1, "eslint .", { check: true }), cmd(2, "git commit -m x")]);
    expect(lint.tests_after_edit).toEqual({ opportunities: 1, hits: 1 });
    const build = habitsOf([edit(0, "/p/a.ts"), cmd(1, "npm run build", { testOrBuild: true, check: false }), cmd(2, "git commit -m x")]);
    expect(build.tests_after_edit).toEqual({ opportunities: 1, hits: 0 });
  });

  it("6 tests_after_edit: edits ending in a commit; a test or build after the last edit", () => {
    const ok = habitsOf([edit(0, "/p/a.ts"), cmd(1, "vitest", { testOrBuild: true }), cmd(2, "git commit -m x")]);
    expect(ok.tests_after_edit).toEqual({ opportunities: 1, hits: 1 });
    const stale = habitsOf([edit(0, "/p/a.ts"), cmd(1, "vitest", { testOrBuild: true }), edit(2, "/p/a.ts"), cmd(3, "git commit -m x")]);
    expect(stale.tests_after_edit).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([edit(0, "/p/a.ts"), cmd(1, "vitest", { testOrBuild: true })]).tests_after_edit).toBeNull(); // no commit
    expect(habitsOf([edit(0, "/p/a.ts"), cmd(1, "git commit -m x", { failed: true })]).tests_after_edit).toBeNull();
    expect(habitsOf([cmd(0, "git commit -m x")]).tests_after_edit).toBeNull(); // no edits
  });

  it("7 tests_with_code (hb-2.2): per commit of 30+ code lines; a test in it or in the next commit", () => {
    const h = habitsOf([
      edit(0, "/p/src/a.ts", 40), edit(1, "/p/src/a.test.ts"), cmd(2, "git commit -m 1"),
      edit(3, "/p/src/b.ts", 40), cmd(4, "git commit -m 2"),
      edit(5, "/p/README.md", 40), cmd(6, "git commit -m 3"), // docs only: no occasion
      edit(7, "/p/src/c.ts", 3), cmd(8, "git commit -m 4"), // a three-line fix: no occasion
    ]);
    expect(h.tests_with_code).toEqual({ opportunities: 2, hits: 1 });
    const next = habitsOf([
      edit(0, "/p/src/a.ts", 40), cmd(1, "git commit -m code"),
      edit(2, "/p/src/a.test.ts", 10), cmd(3, "git commit -m test"),
    ]);
    expect(next.tests_with_code).toEqual({ opportunities: 1, hits: 1 });
  });

  it("8 saw_diff_before_commit: a diff ran, or the person asked, since the previous commit", () => {
    const h = habitsOf([
      edit(0, "/p/a.ts"), cmd(1, "git diff"), cmd(2, "git commit -m 1"),
      edit(3, "/p/a.ts"), cmd(4, "git commit -m 2"),
      edit(5, "/p/a.ts"), typed(6, "show me the diff"), cmd(7, "git commit -m 3"),
      edit(8, "/p/a.ts"), cmd(9, "git diff --stat"), cmd(10, "git commit -m 4"), // hb-2.2: names and counts only
      cmd(11, "git commit -m 5"), // hb-2.2: no agent edit since the previous commit: no occasion
      edit(12, "/p/a.ts"), cmd(13, "git commit -m 6", { failed: true }),
    ]);
    expect(h.saw_diff_before_commit).toEqual({ opportunities: 4, hits: 2 });
    expect(habitsOf([edit(0, "/p/a.ts")]).saw_diff_before_commit).toBeNull();
  });

  it("9 independent_review: >= 200 changed lines; a reviewer after the first edit", () => {
    expect(habitsOf([edit(0, "/p/a.ts", 200), m(1, { review: true })]).independent_review).toEqual({ opportunities: 1, hits: 1 });
    // hb-2.2: code lines only, and a review of the first part is not a review of the change.
    expect(habitsOf([edit(0, "/p/README.md", 300), m(1, { review: true })]).independent_review).toBeNull();
    expect(habitsOf([edit(0, "/p/a.ts", 50), m(1, { review: true }), edit(2, "/p/b.ts", 200)]).independent_review).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([edit(0, "/p/a.ts", 120), edit(1, "/p/b.ts", 120)]).independent_review).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([edit(0, "/p/a.ts", 199), m(1, { review: true })]).independent_review).toBeNull();
    expect(habitsOf([m(0, { review: true }), edit(1, "/p/a.ts", 300)]).independent_review).toEqual({ opportunities: 1, hits: 0 });
  });

  it("10 explore_before_edit: a read before the first edit", () => {
    expect(habitsOf([m(0, { explore: true }), edit(1, "/p/a.ts")]).explore_before_edit).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([edit(0, "/p/a.ts"), m(1, { explore: true })]).explore_before_edit).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([m(0, { explore: true })]).explore_before_edit).toBeNull();
  });

  it("11 plan_complex (hb-2.2): 3+ files; plan mode or a typed request for a plan before the first edit", () => {
    const three = [edit(1, "/p/a.ts"), edit(2, "/p/b.ts"), edit(3, "/p/c.ts")];
    expect(habitsOf([m(0, { plans: true }), ...three]).plan_complex).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([m(0, { planMode: true }), ...three]).plan_complex).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([...three, m(4, { plans: true })]).plan_complex).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([typed(0, "make a plan first"), ...three]).plan_complex).toEqual({ opportunities: 1, hits: 1 }); // the person asked for one
    expect(habitsOf([m(0, { plans: true }), edit(1, "/p/a.ts"), edit(2, "/p/a.ts"), edit(3, "/p/b.ts")]).plan_complex).toBeNull(); // 2 files
  });

  it("13 memory_alive: from the context; null when git could not say", () => {
    expect(habitsOf([m(0)], { memoryAlive: true }).memory_alive).toEqual({ opportunities: 1, hits: 1 });
    expect(habitsOf([m(0)], { memoryAlive: false }).memory_alive).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([m(0)], { memoryAlive: null }).memory_alive).toBeNull();
    expect(habitsOf([m(0)]).memory_alive).toBeNull();
  });

  it("a refused call did not happen", () => {
    expect(habitsOf([edit(0, "/p/a.ts"), { ...edit(1, "/p/b.ts"), refused: true }]).explore_before_edit).toEqual({ opportunities: 1, hits: 0 });
    expect(habitsOf([{ ...edit(0, "/p/a.ts"), refused: true }]).explore_before_edit).toBeNull();
  });

  it("an empty session offers no occasion anywhere", () => {
    const h = habitsOf([]);
    expect(Object.entries(h).filter(([k, v]) => k !== "rules_version" && v !== null)).toEqual([]);
    expect(h.rules_version).toBe("hb-2.3");
  });
});

// --- git on the device ------------------------------------------------------------------------

function git(dir: string, args: string[], date?: string): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  }).trim();
}

const FAKE_TOKEN = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

function makeRepo(): { dir: string; clean: string; dirty: string } {
  const dir = mkdtempSync(join(tmpdir(), "hb2-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "CLAUDE.md"), "# Rules\nAlways run the tests before you commit anything.\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "memory"], "2026-09-20T09:00:00Z");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "clean"], "2026-10-01T10:09:00Z");
  const clean = git(dir, ["rev-parse", "--short", "HEAD"]);
  writeFileSync(join(dir, "b.ts"), `export const t = "${FAKE_TOKEN}";\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "dirty"], "2026-10-01T10:11:00Z");
  const dirty = git(dir, ["rev-parse", "--short", "HEAD"]);
  return { dir, clean, dirty };
}

describe("device git", () => {
  beforeEach(() => resetDeviceGit());

  it("memory_alive (hb-2.2): a memory file changed in the 90 days to the session, or loaded in it", () => {
    const { dir } = makeRepo();
    expect(memoryAlive(dir, Date.parse("2026-10-01T12:00:00Z"))).toBe(true);
    expect(memoryAlive(dir, Date.parse("2026-11-15T12:00:00Z"))).toBe(true); // 56 days: still kept
    expect(memoryAlive(dir, Date.parse("2027-01-15T12:00:00Z"))).toBe(false); // older than 90 days
    expect(memoryAlive(dir, Date.parse("2027-01-15T12:00:00Z"), true)).toBe(true); // the agent read it
    const bare = mkdtempSync(join(tmpdir(), "hb2-nomem-"));
    git(bare, ["init", "-q", "-b", "main"]);
    writeFileSync(join(bare, "a.ts"), "x\n");
    git(bare, ["add", "."]);
    git(bare, ["commit", "-q", "-m", "a"], "2026-09-30T09:00:00Z");
    expect(memoryAlive(bare, Date.parse("2026-10-01T12:00:00Z"), true)).toBe(false); // no memory file at all
    expect(memoryAlive(dir, Date.parse("2026-09-01T12:00:00Z"))).toBe(false); // before it existed
    expect(memoryAlive(join(dir, "nope"), Date.now())).toBeNull(); // not readable: not observed
    expect(memoryAlive(mkdtempSync(join(tmpdir(), "hb2-nogit-")), Date.now())).toBeNull();
  });

  it("memory_alive: a tiny edit does not count", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb2-tiny-"));
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "AGENTS.md"), "x\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "m"], "2026-09-30T09:00:00Z");
    expect(memoryAlive(dir, Date.parse("2026-10-01T12:00:00Z"))).toBe(false);
  });

  it("no_secrets (hb-2.2): precise kinds only, and not in docs, tests or fixtures", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb2-sec-"));
    git(dir, ["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "fixture.ts"), `export const t = "${FAKE_TOKEN}";\n`);
    writeFileSync(join(dir, "README.md"), `token: ${FAKE_TOKEN}\n`);
    writeFileSync(join(dir, "conf.ts"), `const api_key = "abcdefghijklmnopqrstuvwx";\n`); // generic: not counted
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "fixtures"], "2026-10-01T10:00:00Z");
    expect(commitClean(git(dir, ["rev-parse", "--short", "HEAD"]), dir)).toBe(true);
  });

  it("no_secrets: the added lines of a commit, by the device's own patterns", () => {
    const { dir, clean, dirty } = makeRepo();
    expect(commitClean(clean, dir)).toBe(true);
    expect(commitClean(dirty, dir)).toBe(false);
    expect(commitClean("deadbeef", dir)).toBeNull();
    expect(commitClean("not a sha; rm -rf /", dir)).toBeNull();
    expect(commitClean(clean, null)).toBeNull();
  });
});

// --- the whole path ---------------------------------------------------------------------------

describe("the whole path, on a planted transcript", () => {
  beforeEach(() => resetDeviceGit());
  const ID = "22222222-3333-4444-8555-666666666666";
  const WORDS = "zebrafish marmalade";
  const CMD_WORD = "xyzzy-private-script";

  function transcript(cwd: string, mode: string, sha: { clean: string; dirty: string }): string {
    const rec = (min: number, r: Record<string, unknown>) =>
      JSON.stringify({ timestamp: new Date(at(min)).toISOString(), sessionId: ID, cwd, ...r });
    let n = 0;
    const use = (min: number, name: string, input: Record<string, unknown>, id = `toolu_${++n}`) =>
      rec(min, { type: "assistant", requestId: `r${n}`, message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (min: number, id: string, text: string, isError = false) =>
      rec(min, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] } });
    const big = Array.from({ length: 220 }, (_, i) => `const v${i} = ${i};`).join("\n");
    return (
      [
        rec(0, { type: "user", permissionMode: mode, message: { content: `implement ${WORDS} in billing.ts` } }),
        use(1, "Read", { file_path: "/p/src/billing.ts" }),
        use(2, "TodoWrite", { todos: [{ content: WORDS }] }),
        use(3, "Edit", { file_path: "/p/src/billing.ts", old_string: "a", new_string: "b\nc\nd" }),
        use(4, "Edit", { file_path: "/p/tests/billing.test.ts", old_string: "a", new_string: "b" }),
        use(5, "Edit", { file_path: "/p/package.json", old_string: "1", new_string: "2" }),
        use(6, "Bash", { command: "npm audit" }),
        use(7, "Bash", { command: `npx vitest run ${CMD_WORD}` }),
        use(8, "Bash", { command: "git diff" }),
        use(9, "Bash", { command: `cd ${cwd}\ngit commit -q -m "first"` }, "toolu_c1"),
        result(9, "toolu_c1", `[main ${sha.clean}] first\n 1 file changed`),
        use(10, "Write", { file_path: "/p/src/b.ts", content: big }),
        use(11, "Bash", { command: `cd ${cwd}\ngit commit -q -m "second"` }, "toolu_c2"),
        result(11, "toolu_c2", `[main ${sha.dirty}] second\n 1 file changed`),
        use(12, "Bash", { command: "rm -rf build" }),
        use(13, "Bash", { command: "git push --force" }),
        use(14, "Agent", { subagent_type: "security-reviewer", description: "look", prompt: WORDS }),
        use(15, "Bash", { command: "git commit -m third" }, "toolu_c3"),
        result(15, "toolu_c3", "nothing to commit", true),
        rec(16, { type: "user", message: { content: "<command-name>/review</command-name>\n<command-args></command-args>" } }),
      ].join("\n") + "\n"
    );
  }

  function read(mode: string, cwdOverride?: string) {
    const repo = makeRepo();
    const dir = mkdtempSync(join(tmpdir(), "hb2-t-"));
    const file = join(dir, `${ID}.jsonl`);
    writeFileSync(file, transcript(cwdOverride ?? repo.dir, mode, repo));
    const [session] = parseTranscript(file);
    expect(session, "input: the planted transcript parses").toBeTruthy();
    expect(session!.humanPrompts, "input: one typed prompt").toBe(1);
    return { session: session!, repo };
  }

  it("counts every trace from what happened", () => {
    const { session } = read("default");
    expect(session.habits).toEqual({
      rules_version: "hb-2.3",
      names_files: { opportunities: 1, hits: 1 },
      plan_before_edit: { opportunities: 1, hits: 0 }, // hb-1.0 T3: plan mode or a typed plan request only
      diff_before_commit: { opportunities: 3, hits: 0 }, // hb-1.0 T4 counts the failed commit command too
      located_corrections: null,
      security_review: { opportunities: 1, hits: 1 },
      dependency_audit: { opportunities: 1, hits: 1 },
      no_secrets: { opportunities: 2, hits: 1 },
      permissions_on: { opportunities: 1, hits: 1 },
      risky_confirmed: { opportunities: 1, hits: 1 }, // hb-2.2: `rm -rf build` is throwaway output
      tests_after_edit: { opportunities: 1, hits: 0 },
      tests_with_code: { opportunities: 1, hits: 0 }, // hb-2.2: the 3-line first commit is no occasion
      saw_diff_before_commit: { opportunities: 2, hits: 1 },
      independent_review: { opportunities: 1, hits: 1 },
      explore_before_edit: { opportunities: 1, hits: 1 },
      plan_complex: { opportunities: 1, hits: 0 }, // hb-2.2: TodoWrite is the agent's list, not a plan
      memory_alive: { opportunities: 1, hits: 1 },
      clear_goal: { opportunities: 1, hits: 0 }, // hb-2.1: "implement … in billing.ts" asks for work, states no done
      one_task: null, // under 15 words: not an occasion
      gives_context: { opportunities: 1, hits: 1 }, // names billing.ts
    });
  });

  it("bypassing permissions is a miss, for the session and for the risky commands in it", () => {
    const { session } = read("bypassPermissions");
    expect(session.habits.permissions_on).toEqual({ opportunities: 1, hits: 0 });
    expect(session.habits.risky_confirmed).toEqual({ opportunities: 1, hits: 0 });
  });

  it("a session outside any repository has no memory occasion; the rest still counts", () => {
    const { session } = read("default", join(tmpdir(), "hb2-does-not-exist"));
    expect(session.habits.memory_alive).toBeNull();
    expect(session.habits.no_secrets).toBeNull(); // the commits cannot be read: skipped, not clean
    expect(session.habits.explore_before_edit).toEqual({ opportunities: 1, hits: 1 });
  });

  it("no command, file name, prompt word, sha or secret reaches the wire", () => {
    const { session, repo } = read("default");
    const event = buildSessionSummary({
      userId: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
      sessionId: session.sessionId,
      model: MODEL_NOT_KNOWN,
      prompts: [],
      toolCalls: session.toolCalls,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: session.durationMs,
      iterations: session.iterations,
      env: { mcpTools: [], projectInstructionsLoaded: false, reusableSkillCalls: 0 },
      habits: session.habits,
    });
    const wire = JSON.stringify(event.payload.habits);
    expect(wire.length, "input: the habits travel").toBeGreaterThan(200);
    const forbidden = [
      ...WORDS.split(" "), CMD_WORD, "billing", "package.json", "b.ts", "npm", "audit", "vitest", "rm -rf", "push", "--force",
      "git", "security-reviewer", "review", repo.clean, repo.dirty, "ghp_", FAKE_TOKEN, repo.dir, "CLAUDE.md", "Todo",
    ];
    const values = wire.replace(/"[a-z_]+":/g, ""); // the trace names are public; what is under them is checked
    for (const word of forbidden) expect(values, word).not.toContain(word);
    // Only integers, nulls and the version.
    expect(values.replace(/[{}\[\],:0-9]|null|"hb-2\.3"/g, "")).toBe("");
  });
});
