// The only file that touches the real editor API. It adapts `vscode` to the narrow HostApi in
// host.ts and wires the collector to the offline queue; all behaviour worth testing lives behind
// that boundary and is exercised with a fake host.
import type { QueueState } from "@mentat/wedge-core";
import * as vscode from "vscode";

import { RepositoryHints, REPOSITORIES_REFRESH_MS } from "./carrier";
import { ideClientHeader, withClientHeader } from "./client-header";
import { Collector } from "./collector";
import { deviceSalt } from "./device-salt";
import {
  Connection,
  type ConnectionHost,
  type ConnectionState,
  type Credentials,
  statusText,
  storedCredentials,
} from "./connection";
import type { HostApi, TextDocument } from "./host";
import { Sender } from "./sender";

const FLUSH_INTERVAL_MS = 30_000;

function adapt(status: vscode.StatusBarItem): HostApi {
  return {
    workspace: {
      onDidChangeTextDocument: (l) => vscode.workspace.onDidChangeTextDocument(l),
      onDidSaveTextDocument: (l) => vscode.workspace.onDidSaveTextDocument(l),
      rootPath: (): string | null => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    },
    window: {
      onDidChangeTextEditorVisibleRanges: (l) => vscode.window.onDidChangeTextEditorVisibleRanges(l),
      activeDocument: (): TextDocument | null => vscode.window.activeTextEditor?.document ?? null,
      setStatusBar: (text: string, tooltip?: string) => {
        status.text = text;
        status.tooltip = tooltip;
        status.command = "deigma.status";
        status.show();
      },
    },
    commands: { registerCommand: (id, handler) => vscode.commands.registerCommand(id, handler) },
  };
}

function connectionHost(context: vscode.ExtensionContext, status: vscode.StatusBarItem, clientFetch: typeof fetch): ConnectionHost {
  return {
    secrets: {
      get: async (key) => context.secrets.get(key),
      store: async (key, value) => context.secrets.store(key, value),
      delete: async (key) => context.secrets.delete(key),
    },
    fetch: clientFetch,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    openExternal: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    notify: async (text, ...actions) => vscode.window.showInformationMessage(text, ...actions),
    setState: (state: ConnectionState) => {
      status.text = statusText(state);
      // The bar is the one place a not-connected editor shows anything, and clicking it is the
      // way to connect; once connected the collector owns the text and the click shows status.
      // While a code waits there is nothing to click through to: `deigma.status` exists only once
      // the collector runs, and a second Connect would only answer that one is in progress.
      status.command =
        state.kind === "not_connected" ? "deigma.connect" : state.kind === "connected" ? "deigma.status" : undefined;
      status.show();
      // Which commands the palette offers follows the state, so `pause` is never offered to an
      // editor that is collecting nothing (package.json `when` clauses).
      void vscode.commands.executeCommand("setContext", "deigma.connected", state.kind === "connected");
    },
  };
}

/** Where an account's unsent events are kept between editor sessions (globalState). */
export function queueStateKey(userId: string): string {
  return `deigma.queue.${userId}`;
}

/** A stored queue, or null when what is stored is not one (absent, or written by something else). */
export function restoredQueue(stored: unknown): QueueState | null {
  if (!stored || typeof stored !== "object") return null;
  const { pending, firstQueuedAt } = stored as { pending?: unknown; firstQueuedAt?: unknown };
  if (!Array.isArray(pending)) return null;
  return {
    pending: pending as QueueState["pending"],
    firstQueuedAt: typeof firstQueuedAt === "number" ? firstQueuedAt : pending.length ? Date.now() : null,
  };
}

/** Starts collecting for a connected account. `stop()` waits for the last flush, so a disconnect
 *  sends what was already gathered with the session it was gathered under, before revoking it. */
function startCollecting(
  config: vscode.WorkspaceConfiguration,
  status: vscode.StatusBarItem,
  credentials: Credentials,
  salt: string,
  globalState: vscode.Memento,
  onUnauthorized: () => void,
  clientFetch: typeof fetch,
): { stop(): Promise<void> } {
  const host = adapt(status);
  const apiBaseUrl = config.get<string>("apiBaseUrl", "https://api.deigma.net");
  const queueKey = queueStateKey(credentials.userId);
  const sender = new Sender({
    apiBaseUrl,
    session: credentials.session,
    fetch: clientFetch,
    // The offline queue survives a restart of the editor: unsent events used to
    // live only in memory and were lost with the window. It is kept in the extension's own
    // globalState under the account it was gathered for, so another account signing in on this
    // machine never sends it. An event carries counts, hashes and enums — no text — so nothing
    // kept here is content. Events past the 72 h offline window are dropped by the queue itself
    // on the next tick, exactly as the server would reject them.
    persist: (state) => void globalState.update(queueKey, state),
    restore: () => restoredQueue(globalState.get<unknown>(queueKey)),
    onUnauthorized,
  });
  const repositories = new RepositoryHints({
    apiBaseUrl,
    session: credentials.session,
    fetch: clientFetch,
  });
  const collector = new Collector(host, {
    userId: credentials.userId,
    salt,
    emit: (event) => sender.add(event),
    // The document's own checkout (a multi-root workspace has several), else the first folder.
    carrier: (doc) =>
      doc.uri.scheme === "file"
        ? repositories.hintFor(doc.uri.fsPath)
        : repositories.hintFor(host.workspace.rootPath(), false),
  });
  collector.activate();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let repoTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const refreshRepositories = async (): Promise<void> => {
    await repositories.refresh();
    if (!stopped) repoTimer = setTimeout(() => void refreshRepositories(), REPOSITORIES_REFRESH_MS);
  };
  void refreshRepositories();
  const loop = async (): Promise<void> => {
    await sender.tick();
    if (!stopped) timer = setTimeout(() => void loop(), Math.max(FLUSH_INTERVAL_MS, sender.nextDelayMs()));
  };
  timer = setTimeout(() => void loop(), FLUSH_INTERVAL_MS);

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      if (repoTimer) clearTimeout(repoTimer);
      collector.dispose();
      await sender.tick(true);
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("deigma");
  if (!config.get<boolean>("enabled", true)) return;

  const status = vscode.window.createStatusBarItem();
  // Every request names the extension's version and the editor it runs in (client-header.ts).
  const clientFetch = withClientHeader(
    () => globalThis.fetch,
    ideClientHeader(String(context.extension.packageJSON.version ?? "0.0.0"), vscode.env.appName),
  );
  const host = connectionHost(context, status, clientFetch);
  const connection = new Connection(host, config.get<string>("apiBaseUrl", "https://api.deigma.net"));
  let collecting: { stop(): Promise<void> } | null = null;

  const begin = async (credentials: Credentials): Promise<void> => {
    host.setState({ kind: "connected" });
    // Made (or read) only now, signed in: nothing is kept on this machine before a sign-in.
    const salt = await deviceSalt(context.secrets);
    if (collecting) return; // another path started collecting while the keychain answered
    const running = startCollecting(config, status, credentials, salt, context.globalState, () => {
      // The session was ended on deigma.net. Only the run it belongs to stops: a reconnect since
      // then has its own session and its own run.
      if (collecting !== running) return;
      collecting = null;
      void running.stop().then(() => connection.endedElsewhere());
    }, clientFetch);
    collecting = running;
  };

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("deigma.connect", async () => {
      const outcome = await connection.connect();
      // Collecting starts here, not at the next window reload: a sign-in that does nothing until
      // a restart reads as a sign-in that did not work.
      if (outcome.status === "connected" && !collecting) await begin(outcome.credentials);
      // Another window of this editor signed in after this one opened (SecretStorage is shared).
      // This window still said "not connected"; its click now starts collecting here and says so,
      // instead of doing nothing on a bar that claims there is no connection.
      if (outcome.status === "already_connected" && !collecting) {
        await begin(outcome.credentials);
        void host.notify("Deigma: this editor is already connected from another window. Collecting here too.");
      }
    }),
    vscode.commands.registerCommand("deigma.disconnect", async () => {
      const running = collecting;
      collecting = null;
      if (running) await running.stop();
      await connection.disconnect();
    }),
    { dispose: () => void (collecting as { stop(): Promise<void> } | null)?.stop() },
  );

  // Not connected yet: nothing is collected. Holding process metadata for an account that may
  // never exist would be collecting with no destination; the bar says so and a click connects.
  const stored = await storedCredentials(host);
  if (stored) await begin(stored);
  else host.setState({ kind: "not_connected" });
}

export function deactivate(): void {
  /* every disposable is registered in context.subscriptions */
}
