// The subset of the VS Code editor API this extension uses, declared structurally.
//
// Two reasons for a local interface instead of `@types/vscode`:
//   * it is an exhaustive, reviewable list of what the wedge can see. Anything not in this file
//     is not reachable from the collector — there is, for example, no keystroke-level hook here
//     and no terminal, debug, SCM or telemetry surface;
//   * the collector can then be driven by a fake host in tests, so the invariants (no content on
//     the wire, Kc on accept/save only, the budget) are asserted on the real code path.
// `src/extension.ts` is the only file that touches the real `vscode` module and it does nothing
// but adapt it to this shape.

export type Disposable = { dispose(): void };

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };

export type TextDocument = {
  uri: { fsPath: string; scheme: string };
  languageId: string;
  lineCount: number;
  /** Full text, or the text of a range. Used locally only — never emitted. */
  getText(range?: Range): string;
};

export type TextDocumentContentChange = { range: Range; rangeLength: number; text: string };

export type TextDocumentChangeEvent = {
  document: TextDocument;
  contentChanges: readonly TextDocumentContentChange[];
  /** Why the document changed, when the editor knows: 1 = undo, 2 = redo (VS Code's stable
   *  `TextDocumentChangeReason`, since 1.64). Undefined for everything else, typing and pastes and
   *  completions alike. */
  reason?: 1 | 2 | undefined;
};

export type TextEditorVisibleRangesChangeEvent = {
  textEditor: { document: TextDocument };
  visibleRanges: readonly Range[];
};

export type HostApi = {
  workspace: {
    onDidChangeTextDocument(listener: (e: TextDocumentChangeEvent) => void): Disposable;
    onDidSaveTextDocument(listener: (doc: TextDocument) => void): Disposable;
    /** Absolute path of the workspace root, used to read the current branch NAME from .git/HEAD
     *  (a carrier hint; no repository content is read). Null outside a folder. */
    rootPath(): string | null;
  };
  window: {
    onDidChangeTextEditorVisibleRanges(
      listener: (e: TextEditorVisibleRangesChangeEvent) => void,
    ): Disposable;
    /** The document the person is looking at; the accept command flushes that one. */
    activeDocument(): TextDocument | null;
    /** The bar's text, and the tooltip behind it (copy v4: the secret-scanner count lives there). */
    setStatusBar(text: string, tooltip?: string): void;
  };
  commands: {
    registerCommand(id: string, handler: (...args: unknown[]) => void): Disposable;
  };
};

export function docKey(doc: TextDocument): string {
  return `${doc.uri.scheme}:${doc.uri.fsPath}`;
}
