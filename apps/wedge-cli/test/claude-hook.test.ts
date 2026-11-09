import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  claudeSettingsPath,
  HOOK_COMMAND,
  HOOK_MARK,
  installSyncHook,
  removeSyncHook,
  STOP_HOOK_COMMAND,
  STOP_READ_EVERY_MINUTES,
  STOP_STAMP,
  stopHookInstalled,
  syncHookInstalled,
} from "../src/claude-hook";

const home = () => mkdtempSync(join(tmpdir(), "deigma-hook-"));
const read = (h: string) => JSON.parse(readFileSync(claudeSettingsPath(h), "utf8"));

describe("the SessionEnd hook init adds (solo review B2)", () => {
  it("adds its entry to an absent settings file, once", () => {
    const h = home();
    expect(installSyncHook(h)).toBe("added");
    expect(installSyncHook(h)).toBe("present");
    const s = read(h);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.SessionEnd[0].hooks[0]).toEqual({ type: "command", command: HOOK_COMMAND });
    expect(HOOK_COMMAND).toContain("deigma sync");
    expect(HOOK_COMMAND).toContain(HOOK_MARK);
  });

  it("keeps every other setting and hook, and logout removes only its own", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    const before = {
      model: "opus",
      permissions: { allow: ["Bash(git *)"] },
      hooks: {
        SessionEnd: [{ hooks: [{ type: "command", command: "say done" }] }],
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }],
      },
    };
    writeFileSync(claudeSettingsPath(h), JSON.stringify(before));
    expect(installSyncHook(h)).toBe("added");
    const mid = read(h);
    expect(mid.model).toBe("opus");
    expect(mid.permissions).toEqual(before.permissions);
    expect(mid.hooks.PostToolUse).toEqual(before.hooks.PostToolUse);
    expect(mid.hooks.SessionEnd).toHaveLength(2);
    expect(removeSyncHook(h)).toBe(true);
    expect(read(h)).toEqual(before);
    expect(removeSyncHook(h)).toBe(false);
  });

  it("never rewrites a settings file it cannot parse", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(claudeSettingsPath(h), "{ not json");
    expect(installSyncHook(h)).toBe("unreadable_settings");
    expect(readFileSync(claudeSettingsPath(h), "utf8")).toBe("{ not json");
  });

  it("removing from a home with no settings creates nothing", () => {
    const h = home();
    expect(removeSyncHook(h)).toBe(false);
    expect(existsSync(claudeSettingsPath(h))).toBe(false);
  });
});

// Founder, 2026-10-31: a session kept open for weeks never fires SessionEnd, and nothing was read
// for 12 days. The Stop entry rides with it and reads an open session about twice a day.
describe("the Stop entry that reads an open session twice a day", () => {
  it("is added with the SessionEnd entry, and a machine set up before it gets only the missing one", () => {
    const h = home();
    expect(installSyncHook(h)).toBe("added");
    const s = read(h);
    expect(s.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: HOOK_COMMAND }] }]);
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: STOP_HOOK_COMMAND }] }]);
    expect(stopHookInstalled(h)).toBe(true);
    // A 0.4.0 machine: our SessionEnd entry only.
    const old = home();
    mkdirSync(join(old, ".claude"), { recursive: true });
    writeFileSync(claudeSettingsPath(old), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] } }));
    expect(syncHookInstalled(old)).toBe(true);
    expect(stopHookInstalled(old), "input: set up before the Stop entry").toBe(false);
    expect(installSyncHook(old)).toBe("added");
    const after = read(old);
    expect(after.hooks.SessionEnd, "the SessionEnd entry is not doubled").toHaveLength(1);
    expect(after.hooks.Stop).toHaveLength(1);
    expect(installSyncHook(old)).toBe("present");
    // Logout takes both and leaves nothing of ours.
    expect(removeSyncHook(old)).toBe(true);
    expect(read(old)).toEqual({});
  });

  /** The Stop command run as Claude Code runs it, with a stand-in `npx` that logs its calls. */
  function stopHookRun(homeDir: string): { status: number | null; calls: () => string[] } {
    const bin = mkdtempSync(join(tmpdir(), "deigma-bin-"));
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    chmodSync(join(bin, "npx"), 0o755);
    const r = spawnSync("sh", ["-c", STOP_HOOK_COMMAND], {
      env: { HOME: homeDir, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
    return { status: r.status, calls };
  }
  /** The sync starts in the background; give it a moment to write its line. */
  function settle(calls: () => string[], want: number): string[] {
    for (let i = 0; i < 60 && calls().length < want; i++) spawnSync("sleep", ["0.05"]);
    return calls();
  }
  /** Nothing started: what a background start would have written by now, it has not. */
  function quiet(calls: () => string[]): string[] {
    spawnSync("sleep", ["0.4"]);
    return calls();
  }

  it("starts the sync when it has never run or the last attempt is older than the interval, and not in between", () => {
    const h = home();
    mkdirSync(join(h, ".config", "deigma"), { recursive: true });
    const stamp = join(h, ".config", "deigma", STOP_STAMP);
    const first = stopHookRun(h);
    expect(first.status).toBe(0);
    expect(settle(first.calls, 1)).toEqual(["--yes deigma sync"]);
    expect(existsSync(stamp), "the attempt is stamped").toBe(true);
    // The next turn, a minute later: one `find`, nothing started.
    const next = stopHookRun(h);
    expect(next.status).toBe(0);
    expect(quiet(next.calls), "a sync started again within the interval").toEqual([]);
    // Past the interval: the next turn starts it again.
    const old = new Date(Date.now() - (STOP_READ_EVERY_MINUTES + 60) * 60_000);
    utimesSync(stamp, old, old);
    const later = stopHookRun(h);
    expect(later.status).toBe(0);
    expect(settle(later.calls, 1)).toEqual(["--yes deigma sync"]);
  }, 20_000);

  it("never fails a turn: with no Deigma directory it starts nothing and still exits 0", () => {
    const h = home();
    expect(existsSync(join(h, ".config", "deigma")), "input: no Deigma directory").toBe(false);
    const r = stopHookRun(h);
    expect(r.status).toBe(0);
    expect(quiet(r.calls)).toEqual([]);
  }, 20_000);
});
