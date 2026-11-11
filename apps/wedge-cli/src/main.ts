#!/usr/bin/env node
// `npx deigma init` and friends. The process and nothing else: every command is `run` in ./cli,
// called here with the real config directory, network, streams and child process.
import { spawn } from "node:child_process";
import { homedir, setPriority } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { run, spawnPassThrough } from "./cli";
import { cliClientHeader, withClientHeader } from "./client-header";
import { codexHome } from "./journals/codex";
import { localBackfill } from "./local-backfill";
import { runProxy } from "./proxy-run";

/**
 * `deigma sync` as a detached, lowest-priority process (./journal-sync): it outlives nothing it
 * should not — it reads, sends, writes its state and exits — and the proxy that started it never
 * waits for it. stdio is ignored, so nothing of it can reach the MCP client's channel.
 */
function startSync(): void {
  const script = process.argv[1];
  if (!script) return;
  const child = spawn(process.execPath, [...process.execArgv, script, "sync"], {
    detached: true,
    stdio: "ignore",
    // no console window flashes up on Windows for a process nobody is meant to see
    windowsHide: true,
    env: process.env,
  });
  child.on("error", () => {});
  try {
    if (child.pid) setPriority(child.pid, 19);
  } catch {
    // not permitted here: it still runs, just at normal priority
  }
  child.unref();
}

/** "Press ENTER to open it in your browser", as `npm login` offers: only on a terminal, and the
 *  key is read once. The approval itself happens on the page, never by opening it. */
function offerOpen(url: string): () => void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return () => {};
  console.log("Press ENTER to open it in your browser…");
  const onData = () => {
    stop();
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.on("error", () => console.log(`Could not open a browser; open ${url} yourself.`));
      child.unref();
    } catch {
      console.log(`Could not open a browser; open ${url} yourself.`);
    }
  };
  const stop = () => {
    process.stdin.off("data", onData);
    process.stdin.pause();
  };
  process.stdin.resume();
  process.stdin.once("data", onData);
  return stop;
}

/**
 * A yes/no question at the terminal, for `deigma task submit`. Only an explicit "y" or "yes" is a
 * yes; Enter, Ctrl-C and a closed input are no. It is never called where `canAsk` is false.
 */
function askYesNo(question: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => {
      resolve(false);
      rl.close();
    });
    rl.on("close", () => resolve(false));
    rl.question(`${question} [y/N] `, (answer) => {
      resolve(/^\s*y(es)?\s*$/i.test(answer));
      rl.close();
    });
  });
}

process.exitCode = await run(process.argv.slice(2), {
  configDir: join(homedir(), ".config", "deigma"),
  // Where a new sign-in talks to. The default used to be localhost, which is right for a
  // developer running the stand and wrong for everybody who types `npx deigma init`. The
  // override stays for the stand.
  apiBaseUrl: process.env.MENTAT_API_URL ?? "https://api.deigma.net",
  webUrlOverride: process.env.MENTAT_WEB_URL,
  fetch: withClientHeader(() => globalThis.fetch, cliClientHeader()),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  passThrough: (command, args) => spawnPassThrough(command, args, (line) => console.error(line)),
  runProxy,
  localBackfill,
  startSync,
  offerOpen,
  claudeSettingsHome: homedir(),
  codexConfigHome: codexHome(homedir()),
  cwd: process.cwd(),
  // GitHub's public addresses, with nothing of ours added to the request (./task/github).
  publicFetch: (input, init) => globalThis.fetch(input, init),
  // `deigma task submit` sends nothing without a yes, and a yes needs a person at a terminal.
  canAsk: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: askYesNo,
});
