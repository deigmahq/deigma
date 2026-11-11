// Decision 4 (2026-10-20): the Codex `notify` entry `init` adds — only where `notify` is free,
// edited minimally, recognised by its marker, removed by `logout`, throttled to once an hour.
// Mirrors ./claude-hook.test.ts. All files are synthetic, in temporary directories.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  codexConfigPath,
  codexNotifyState,
  installCodexNotify,
  NOTIFY_MARK,
  NOTIFY_STAMP,
  notifyScript,
  removeCodexNotify,
} from "../src/codex-notify";

const codexDir = () => {
  const d = join(mkdtempSync(join(tmpdir(), "deigma-codex-notify-")), ".codex");
  mkdirSync(d, { recursive: true });
  return d;
};
const configDir = () => mkdtempSync(join(tmpdir(), "deigma-config-"));
const read = (d: string) => readFileSync(codexConfigPath(d), "utf8");

const PERSONS_CONFIG = [
  'model = "gpt-5.5-sol"',
  'approval_policy = "on-request"',
  "",
  "[mcp_servers.docs]",
  'command = "docs-server"',
  "",
  "[tui]",
  "notifications = true",
  "",
].join("\n");

describe("the notify entry init adds (decision 4)", () => {
  it("adds one entry to an absent config, once", () => {
    const d = codexDir();
    const c = configDir();
    expect(installCodexNotify(d, c)).toBe("added");
    expect(installCodexNotify(d, c)).toBe("present");
    const text = read(d);
    expect(text.match(/^notify\s*=/gm)).toHaveLength(1);
    expect(text).toContain(NOTIFY_MARK);
    expect(text).toContain("deigma sync");
    expect(codexNotifyState(d)).toBe(true);
  });

  it("keeps every other line byte for byte, and logout removes only its own", () => {
    const d = codexDir();
    writeFileSync(codexConfigPath(d), PERSONS_CONFIG);
    expect(installCodexNotify(d, configDir())).toBe("added");
    const mid = read(d);
    // Ours sits before the first table (a top-level TOML key), and the person's file follows intact.
    expect(mid.indexOf("notify =")).toBeLessThan(mid.indexOf("[mcp_servers.docs]"));
    expect(mid.endsWith(PERSONS_CONFIG)).toBe(true);
    expect(removeCodexNotify(d)).toBe(true);
    expect(read(d)).toBe(PERSONS_CONFIG);
    expect(removeCodexNotify(d)).toBe(false);
  });

  it("a notify program the person already runs is left alone, and logout does not touch it", () => {
    const d = codexDir();
    const theirs = `notify = ["notify-send", "codex"]\n${PERSONS_CONFIG}`;
    writeFileSync(codexConfigPath(d), theirs);
    expect(codexNotifyState(d)).toBe("taken");
    expect(installCodexNotify(d, configDir())).toBe("taken");
    expect(read(d)).toBe(theirs);
    expect(removeCodexNotify(d)).toBe(false);
    expect(read(d)).toBe(theirs);
  });

  it("a `notify` inside a table is not the top-level one", () => {
    const d = codexDir();
    writeFileSync(codexConfigPath(d), "[profiles.x]\nnotify = [\"a\"]\n");
    expect(installCodexNotify(d, configDir())).toBe("added");
    expect(read(d).startsWith(`# ${NOTIFY_MARK}`)).toBe(true);
  });

  it("nothing is created where Codex is not installed", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "deigma-nocodex-")), ".codex");
    expect(installCodexNotify(missing, configDir())).toBe("no_codex");
    expect(existsSync(missing)).toBe(false);
    expect(codexNotifyState(missing)).toBeNull();
  });

  it("the entry is valid TOML for Codex: an array of four strings, the script last-but-one", () => {
    const d = codexDir();
    installCodexNotify(d, "/tmp/it's here");
    const line = read(d).split("\n").find((l) => l.startsWith("notify ="))!;
    // A TOML array of basic strings is a JSON array of strings for every character we emit.
    const argv = JSON.parse(line.replace(/^notify\s*=\s*/, "")) as string[];
    expect(argv).toHaveLength(4);
    expect(argv[0]).toBe("sh");
    expect(argv[3]).toBe(NOTIFY_MARK);
  });
});

describe("the throttle: at most one sync an hour from Codex turns", () => {
  const sh = spawnSync("sh", ["-c", "exit 0"]).status === 0;
  it.skipIf(!sh)("the script starts the sync once, then not again within the hour, then again after", () => {
    const cfg = configDir();
    const bin = mkdtempSync(join(tmpdir(), "deigma-bin-"));
    const calls = join(bin, "calls");
    // A stand-in for npx that only records that it was called.
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho called >> '${calls}'\n`);
    chmodSync(join(bin, "npx"), 0o755);
    const run = () =>
      spawnSync("sh", ["-c", notifyScript(cfg), NOTIFY_MARK, '{"type":"agent-turn-complete"}'], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
    const count = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0);
    // The sync is started in the background: wait for it (up to 5 s) rather than guess a delay.
    const settle = (want: number, tries = 50) => {
      for (let i = 0; i < tries && count() < want; i++) spawnSync("sh", ["-c", "sleep 0.1"]);
      spawnSync("sh", ["-c", "sleep 0.2"]);
    };
    expect(run().status).toBe(0);
    settle(1);
    expect(count()).toBe(1);
    expect(readdirSync(cfg)).toContain(NOTIFY_STAMP);
    expect(run().status).toBe(0);
    settle(2, 8); // a call it should NOT make would have landed within this
    expect(count()).toBe(1);
    // Two hours later: the stamp is old, the next turn syncs again.
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(cfg, NOTIFY_STAMP), old, old);
    expect(run().status).toBe(0);
    settle(2);
    expect(count()).toBe(2);
  }, 20_000);
});
