// The `vscode` module is provided by the extension host at runtime and is marked external in the
// bundle. This declaration is the subset the adapter binds — intentionally narrow: it is the list
// of editor capabilities the wedge asks for, and it is reviewed as such. The real API is a
// superset; nothing outside this file may reach for it.
declare module "vscode" {
  export type Disposable = { dispose(): void };
  export type Position = { line: number; character: number };
  export type Range = { start: Position; end: Position };
  export type TextDocument = {
    uri: { fsPath: string; scheme: string };
    languageId: string;
    lineCount: number;
    getText(range?: Range): string;
  };
  export type TextDocumentContentChangeEvent = { range: Range; rangeLength: number; text: string };
  export type TextDocumentChangeEvent = {
    document: TextDocument;
    contentChanges: readonly TextDocumentContentChangeEvent[];
    /** `TextDocumentChangeReason`: 1 Undo, 2 Redo; undefined otherwise. */
    reason?: 1 | 2 | undefined;
  };
  export type TextEditor = { document: TextDocument };
  export type TextEditorVisibleRangesChangeEvent = {
    textEditor: TextEditor;
    visibleRanges: readonly Range[];
  };
  export type StatusBarItem = {
    text: string;
    tooltip: string | undefined;
    command: string | undefined;
    show(): void;
    dispose(): void;
  };
  /** SecretStorage: the OS keychain behind the editor. It holds the session and the account id,
   *  and nothing else (RD-16b). */
  export type SecretStorage = {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
  };
  /** Per-extension key/value storage that survives restarts (not synced, not a secret store). */
  export type Memento = { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> };
  export type ExtensionContext = {
    subscriptions: Disposable[];
    secrets: SecretStorage;
    globalState: Memento;
    /** The extension's own manifest: its version names this client on every request. */
    extension: { packageJSON: { version?: string } };
  };
  export type Uri = { readonly scheme: string };
  export const Uri: { parse(value: string): Uri };
  /** Opening the approval page in the browser — the one external call the sign-in makes — and the
   *  editor's name ("Visual Studio Code", "Cursor"), which names the editor on every request. */
  export const env: { openExternal(target: Uri): Thenable<boolean>; readonly appName: string };
  export type WorkspaceConfiguration = { get<T>(section: string, fallback: T): T };

  export const workspace: {
    onDidChangeTextDocument(listener: (e: TextDocumentChangeEvent) => void): Disposable;
    onDidSaveTextDocument(listener: (doc: TextDocument) => void): Disposable;
    getConfiguration(section: string): WorkspaceConfiguration;
    workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined;
  };
  export const window: {
    activeTextEditor: TextEditor | undefined;
    onDidChangeTextEditorVisibleRanges(
      listener: (e: TextEditorVisibleRangesChangeEvent) => void,
    ): Disposable;
    createStatusBarItem(): StatusBarItem;
    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  };
  export const commands: {
    registerCommand(id: string, handler: (...args: unknown[]) => void): Disposable;
    /** Used for `setContext` only: the palette's `when` clauses read `deigma.connected`. */
    executeCommand(command: "setContext", key: string, value: boolean): Thenable<unknown>;
  };
}
