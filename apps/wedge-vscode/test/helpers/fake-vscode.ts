// A fake of the `vscode` module, aliased in vitest.config.ts, so `activate()` itself runs in tests.
//
// The collector and the connection are tested behind their narrow hosts; this exists for the one
// thing those tests cannot see: that `extension.ts` actually wires them (RD-16b). A connect
// command written, tested and registered by nobody is the defect "written and called by nobody".
type Listener = (...args: unknown[]) => void;

export const state = {
  config: new Map<string, unknown>(),
  secrets: new Map<string, string>(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  context: new Map<string, unknown>(),
  /** The extension's globalState (survives a restart: `reset()` leaves it alone unless asked). */
  globalState: new Map<string, unknown>(),
  messages: [] as string[],
  /** What the next notification resolves with (the button the person "clicks"). */
  pick: undefined as string | undefined,
  opened: [] as string[],
  status: { text: "", command: undefined as string | undefined, visible: false, tooltip: undefined as string | undefined },
  /** The editor's document listeners, so a test can type into the real wiring. */
  onChange: [] as Listener[],
  onSave: [] as Listener[],
};

export function reset(): void {
  state.onChange.length = 0;
  state.onSave.length = 0;
  workspace.workspaceFolders = undefined;
  state.config.clear();
  state.secrets.clear();
  state.commands.clear();
  state.context.clear();
  state.globalState.clear();
  state.messages.length = 0;
  state.pick = undefined;
  state.opened.length = 0;
  state.status = { text: "", command: undefined, visible: false, tooltip: undefined };
}

const noop = { dispose: () => undefined };

const listen = (list: Listener[], l: Listener) => {
  list.push(l);
  return { dispose: () => void list.splice(list.indexOf(l), 1) };
};

export const workspace = {
  onDidChangeTextDocument: (l: Listener) => listen(state.onChange, l),
  onDidSaveTextDocument: (l: Listener) => listen(state.onSave, l),
  getConfiguration: (_section: string) => ({
    get: <T>(key: string, fallback: T): T => (state.config.has(key) ? (state.config.get(key) as T) : fallback),
  }),
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
};

export const window = {
  activeTextEditor: undefined,
  onDidChangeTextEditorVisibleRanges: (_l: Listener) => noop,
  createStatusBarItem: () => ({
    get text() {
      return state.status.text;
    },
    set text(v: string) {
      state.status.text = v;
    },
    get command() {
      return state.status.command;
    },
    set command(v: string | undefined) {
      state.status.command = v;
    },
    get tooltip() {
      return state.status.tooltip;
    },
    set tooltip(v: string | undefined) {
      state.status.tooltip = v;
    },
    show: () => {
      state.status.visible = true;
    },
    dispose: () => {
      state.status.visible = false;
    },
  }),
  showInformationMessage: async (message: string, ..._items: string[]) => {
    state.messages.push(message);
    return state.pick;
  },
};

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
    if (state.commands.has(id)) throw new Error(`command '${id}' already exists`);
    state.commands.set(id, handler);
    return { dispose: () => state.commands.delete(id) };
  },
  executeCommand: async (command: string, key: string, value: unknown) => {
    if (command === "setContext") state.context.set(key, value);
  },
};

export const env = {
  openExternal: async (uri: { toString(): string }) => {
    state.opened.push(uri.toString());
    return true;
  },
  /** What a real editor answers: the extension names it on every request (client-header.ts). */
  appName: "Visual Studio Code",
};

/** The `extension` field a real ExtensionContext carries: the manifest the version is read from. */
export const extensionManifest = { packageJSON: { version: "0.3.0" } };

export const Uri = {
  parse: (value: string) => ({ scheme: new URL(value).protocol.replace(":", ""), toString: () => value }),
};

/** A Memento over `state.globalState`, as `context.globalState` is in the real editor. */
export function globalStateMemento(): { get<T>(key: string): T | undefined; update(key: string, value: unknown): Promise<void> } {
  return {
    get: <T>(key: string) => state.globalState.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) state.globalState.delete(key);
      else state.globalState.set(key, structuredClone(value));
    },
  };
}
