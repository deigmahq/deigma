// What differs on Windows (src/platform.ts, 2026-11-11: the first person on Windows). Everything
// here runs on every platform — the Windows shapes are built with `platform: "win32"` and the
// launcher is plain Node — and the last block runs only on a Windows runner, against the real
// cmd.exe, PowerShell and npx.cmd.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  claudeSettingsPath,
  HOOK_COMMAND,
  HOOK_MARK,
  hookEntry,
  installSyncHook,
  removeSyncHook,
  STOP_HOOK_COMMAND,
  STOP_STAMP,
  syncHookInstalled,
  syncHookStale,
} from "../src/claude-hook";
import {
  codexConfigPath,
  codexNotifyStale,
  installCodexNotify,
  NOTIFY_MARK,
  notifyArgv,
  removeCodexNotify,
} from "../src/codex-notify";
import { runProxy } from "../src/proxy-run";
import { BOM, renameWithRetry, resolveCommand, syncLauncherScript, writeFileAtomic } from "../src/platform";
import { makeNormalizer } from "../src/task/text";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `deigma-win-${p}-`));
const readJson = (h: string) => JSON.parse(readFileSync(claudeSettingsPath(h), "utf8"));

/** A home with a fake `npx` first on PATH that writes one line per call, and the launcher run in
 *  it by the real Node — what Claude Code's exec form and Codex do on Windows, minus Windows. */
function launcherRig(signedIn: boolean) {
  const home = tmp("home");
  const bin = tmp("bin");
  const calls = join(home, "calls.txt");
  if (signedIn) mkdirSync(join(home, ".config", "deigma"), { recursive: true });
  const fake = join(bin, process.platform === "win32" ? "npx.cmd" : "npx");
  writeFileSync(
    fake,
    process.platform === "win32" ? `@echo %* >> "${calls}"\r\n` : `#!/bin/sh\necho "$@" >> "${calls}"\n`,
  );
  chmodSync(fake, 0o755);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  const count = async (): Promise<number> => {
    // The sync is started detached: give it a moment to write its line.
    for (let i = 0; i < 40 && !existsSync(calls); i++) await new Promise((r) => setTimeout(r, 50));
    return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0;
  };
  const run = (script: string, extra: string[] = []) => {
    const r = spawnSync(process.execPath, ["-e", script, ...extra], { env, encoding: "utf8" });
    return r.status;
  };
  return { home, calls, count, run };
}

describe("the launcher node runs where there is no sh (Windows hooks and Codex notify)", () => {
  it("on a machine that is not signed in, it starts nothing and exits 0", async () => {
    const rig = launcherRig(false);
    expect(rig.run(syncLauncherScript({ stamp: STOP_STAMP, everyMinutes: 720 }))).toBe(0);
    expect(await rig.count()).toBe(0);
    expect(existsSync(join(rig.home, ".config", "deigma", STOP_STAMP))).toBe(false);
  });

  it("starts `npx --yes deigma sync` once per interval, stamping before it starts", async () => {
    const rig = launcherRig(true);
    const script = syncLauncherScript({ stamp: STOP_STAMP, everyMinutes: 720 });
    expect(rig.run(script)).toBe(0);
    expect(await rig.count()).toBe(1);
    expect(readFileSync(rig.calls, "utf8")).toContain("--yes deigma sync");
    // Inside the interval: nothing more.
    expect(rig.run(script)).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(await rig.count()).toBe(1);
    // Past it: one more.
    const stamp = join(rig.home, ".config", "deigma", STOP_STAMP);
    const old = (Date.now() - 721 * 60_000) / 1000;
    utimesSync(stamp, old, old);
    expect(rig.run(script)).toBe(0);
    for (let i = 0; i < 40 && (await rig.count()) < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await rig.count()).toBe(2);
  });

  it("ignores the JSON Codex appends, whatever it holds", async () => {
    const rig = launcherRig(true);
    const hostile = JSON.stringify({ "last-assistant-message": '"; rm -rf / ; echo "', "input-messages": ["$(whoami)"] });
    expect(rig.run(syncLauncherScript(), [NOTIFY_MARK, hostile])).toBe(0);
    expect(await rig.count()).toBe(1);
  });
});

describe("Claude Code entries on Windows: exec form, no shell", () => {
  it("are `node -e <launcher>` with the mark, and found as ours", () => {
    const e = hookEntry("Stop", "win32");
    expect(e).toMatchObject({ type: "command", command: "node" });
    expect(e.args).toEqual(["-e", expect.stringContaining("deigma"), HOOK_MARK]);
    const h = tmp("cc");
    expect(installSyncHook(h, "win32")).toBe("added");
    expect(syncHookInstalled(h)).toBe(true);
    expect(syncHookStale(h, "win32")).toBe(false);
    expect(installSyncHook(h, "win32")).toBe("present");
    expect(removeSyncHook(h)).toBe(true);
    expect(existsSync(claudeSettingsPath(h)) && readJson(h).hooks).toBeUndefined();
  });

  it("a Windows machine set up by 0.5 (sh lines) gets them rewritten, every other hook kept", () => {
    const h = tmp("cc");
    mkdirSync(join(h, ".claude"), { recursive: true });
    const theirs = { hooks: [{ type: "command", command: "echo mine" }] };
    writeFileSync(
      claudeSettingsPath(h),
      JSON.stringify({
        model: "opus",
        hooks: {
          SessionEnd: [theirs, { hooks: [{ type: "command", command: HOOK_COMMAND }] }],
          Stop: [{ hooks: [{ type: "command", command: STOP_HOOK_COMMAND }] }],
        },
      }),
    );
    expect(syncHookStale(h, "win32")).toBe(true);
    expect(installSyncHook(h, "win32")).toBe("added");
    const s = readJson(h);
    expect(s.model).toBe("opus");
    expect(s.hooks.SessionEnd).toEqual([theirs, { hooks: [hookEntry("SessionEnd", "win32")] }]);
    expect(s.hooks.Stop).toEqual([{ hooks: [hookEntry("Stop", "win32")] }]);
    expect(syncHookStale(h, "win32")).toBe(false);
    // The same file on macOS is what that platform writes, so nothing there is rewritten.
    expect(syncHookStale(h, "darwin")).toBe(true);
  });

  it("a settings file with a byte-order mark is read, not skipped", () => {
    const h = tmp("cc");
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(claudeSettingsPath(h), `${BOM}{"model":"opus"}`);
    expect(installSyncHook(h, "win32")).toBe("added");
    expect(readJson(h).model).toBe("opus");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a settings file that exists but cannot be read is never written over",
    () => {
      const h = tmp("cc");
      mkdirSync(join(h, ".claude"), { recursive: true });
      const path = claudeSettingsPath(h);
      writeFileSync(path, '{"model":"opus"}');
      chmodSync(path, 0o000);
      try {
        expect(installSyncHook(h)).toBe("unreadable_settings");
      } finally {
        chmodSync(path, 0o644);
      }
      expect(readFileSync(path, "utf8")).toBe('{"model":"opus"}');
    },
  );
});

describe("the Codex notify entry on Windows", () => {
  const codex = () => {
    const d = tmp("codex");
    return { dir: d, config: tmp("cfg") };
  };

  it("is `node -e <launcher>`: Codex starts it with no shell, and there is no sh to start", () => {
    const argv = notifyArgv("C:\\Users\\x\\.config\\deigma", "win32");
    expect(argv[0]).toBe("node");
    expect(argv[1]).toBe("-e");
    expect(argv.at(-1)).toBe(NOTIFY_MARK);
    expect(notifyArgv("/home/x/.config/deigma", "linux")[0]).toBe("sh");
  });

  it("a 0.5 entry (sh) is rewritten in place on Windows, the rest of the file untouched", () => {
    const { dir, config } = codex();
    expect(installCodexNotify(dir, config, "linux")).toBe("added");
    const tail = 'model = "o3"\r\n[profiles.x]\r\nmodel = "o4"\r\n';
    writeFileSync(codexConfigPath(dir), readFileSync(codexConfigPath(dir), "utf8") + tail);
    expect(codexNotifyStale(dir, config, "win32")).toBe(true);
    expect(installCodexNotify(dir, config, "win32")).toBe("added");
    const text = readFileSync(codexConfigPath(dir), "utf8");
    expect(text).toContain('notify = ["node", "-e"');
    expect(text.endsWith(tail)).toBe(true);
    expect(codexNotifyStale(dir, config, "win32")).toBe(false);
    expect(installCodexNotify(dir, config, "win32")).toBe("present");
  });

  it("a byte-order mark stays the first thing in config.toml, through install and removal", () => {
    const { dir, config } = codex();
    writeFileSync(codexConfigPath(dir), `${BOM}model = "o3"\n`);
    expect(installCodexNotify(dir, config, "win32")).toBe("added");
    let text = readFileSync(codexConfigPath(dir), "utf8");
    expect(text.startsWith(`${BOM}# ${NOTIFY_MARK}`)).toBe(true);
    expect(text.indexOf(BOM, 1)).toBe(-1);
    expect(removeCodexNotify(dir)).toBe(true);
    text = readFileSync(codexConfigPath(dir), "utf8");
    expect(text).toBe(`${BOM}model = "o3"\n`);
  });
});

describe("starting a program by name on Windows (resolveCommand)", () => {
  const files = new Set([
    "C:\\Program Files\\nodejs\\npx.cmd",
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\x\\proj\\node_modules\\.bin\\server.cmd",
  ]);
  const env = { PATH: "C:\\Program Files\\nodejs;C:\\Users\\x\\proj\\node_modules\\.bin", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const resolve = (c: string, a: string[]) => resolveCommand(c, a, env, "win32", (p) => files.has(p));

  it("a batch file (npx.cmd) goes through cmd.exe, its arguments escaped so cmd reads text, not operators", () => {
    const r = resolve("npx", ["-y", "@scope/server", "a&b|c", 'say "hi"']);
    expect(r.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(r.options.windowsVerbatimArguments).toBe(true);
    expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const line = r.args[3]!;
    expect(line.startsWith('"C:\\Program^ Files\\nodejs\\npx.cmd ')).toBe(true);
    expect(line).toContain("^\"a^&b^|c^\"");
    expect(line).not.toMatch(/[^^][&|](?!\^)/);
  });

  it("a real program starts directly, found on PATH", () => {
    expect(resolve("node", ["x.js"])).toEqual({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["x.js"], options: {} });
  });

  it("an npm shim in node_modules/.bin is escaped twice, as cmd-shim needs", () => {
    const line = resolve("server", ["a&b"]).args[3]!;
    expect(line).toContain("^^^\"a^^^&b^^^\"");
  });

  it("a name found nowhere is passed on as given, so the error stays Node's own; off Windows nothing changes", () => {
    expect(resolve("nope", ["1"])).toEqual({ command: "nope", args: ["1"], options: {} });
    expect(resolveCommand("npx", ["-y"], env, "darwin")).toEqual({ command: "npx", args: ["-y"], options: {} });
  });
});

describe("the proxy, when the server cannot start", () => {
  it("says so and returns instead of waiting on the client's pipe", async () => {
    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    const failures: string[] = [];
    const started = Date.now();
    const result = await runProxy({
      command: "deigma-no-such-server-xyz",
      args: [],
      identity: { userId: "u", salt: "s".repeat(32) } as never,
      send: async () => {},
      stdin,
      stdout: new PassThrough(),
      onStartFailed: (e) => failures.push(e.message),
    });
    expect(result.started).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/ENOENT/);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("writing a file another process may hold (writeFileAtomic)", () => {
  it("replaces the file and leaves no temporary file", () => {
    const d = tmp("atomic");
    const path = join(d, "a.json");
    writeFileSync(path, "old");
    writeFileAtomic(path, "new", 0o600);
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(statSync(d).isDirectory()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("a rename that keeps failing for another reason is not retried", () => {
    const d = tmp("atomic");
    expect(() => renameWithRetry(join(d, "missing"), join(d, "b"))).toThrow(/ENOENT/);
  });
});

describe("a Windows home is hidden in every spelling a session writes it in (task text)", () => {
  const n = makeNormalizer({ redact: [], folders: ["C:\\Users\\maya\\task"], homes: ["C:\\Users\\maya"] });
  it.each([
    ["cd /c/Users/maya/task && ls", "cd . && ls"],
    ["c:\\users\\MAYA\\notes.txt", "~\\notes.txt"],
    ["C:/Users/maya/task/a.py", "./a.py"],
    ["/mnt/c/Users/maya/y", "~/y"],
    ["C:\\\\Users\\\\maya\\\\x", "~\\\\x"],
  ])("%s", (raw, want) => {
    expect(JSON.stringify(n(raw, "tool_result"))).toContain(JSON.stringify(want).slice(1, -1));
    expect(JSON.stringify(n(raw, "tool_result")).toLowerCase()).not.toContain("maya");
  });
});

describe.runIf(process.platform === "win32")("on a real Windows machine", () => {
  it("npx.cmd starts through spawnResolved, with no shell option given", async () => {
    const { spawnResolved } = await import("../src/platform");
    const out = await new Promise<string>((resolve, reject) => {
      const c = spawnResolved("npx", ["--version"], { stdio: ["ignore", "pipe", "inherit"] });
      let s = "";
      c.stdout?.on("data", (d) => (s += d));
      c.on("error", reject);
      c.on("exit", () => resolve(s));
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the launcher starts the fake npx.cmd through cmd.exe", async () => {
    const rig = launcherRig(true);
    expect(rig.run(syncLauncherScript({ stamp: STOP_STAMP, everyMinutes: 720 }))).toBe(0);
    expect(await rig.count()).toBe(1);
  });

  it("the 0.5 POSIX Stop line fails in Windows PowerShell — which is why the entries changed", () => {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", STOP_HOOK_COMMAND], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
  });
});
