// A fake editor host: the collector under test is the real one, only the editor is simulated.
import type {
  Disposable,
  HostApi,
  Range,
  TextDocument,
  TextDocumentChangeEvent,
  TextEditorVisibleRangesChangeEvent,
} from "../../src/host";

type Listener<T> = (e: T) => void;

export class FakeDocument implements TextDocument {
  uri: { fsPath: string; scheme: string };
  languageId = "typescript";
  private lines: string[];

  constructor(text = "", fsPath = "/repo/src/app.ts") {
    this.uri = { fsPath, scheme: "file" };
    this.lines = text.split("\n");
  }

  get lineCount(): number {
    return this.lines.length;
  }

  getText(range?: Range): string {
    if (!range) return this.lines.join("\n");
    return this.lines.slice(range.start.line, range.end.line + 1).join("\n");
  }

  /** Replaces `[startLine, endLine]` with `text` and returns the change the editor would report. */
  applyEdit(startLine: number, endLine: number, text: string) {
    const replaced = this.lines.slice(startLine, endLine + 1).join("\n");
    this.lines.splice(startLine, endLine - startLine + 1, ...text.split("\n"));
    return {
      range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 0 } },
      rangeLength: replaced.length,
      text,
    };
  }
}

export class FakeHost implements HostApi {
  private changeListeners: Listener<TextDocumentChangeEvent>[] = [];
  private saveListeners: Listener<TextDocument>[] = [];
  private scrollListeners: Listener<TextEditorVisibleRangesChangeEvent>[] = [];
  private readonly handlers = new Map<string, (...args: unknown[]) => void>();
  statusBar = "";
  statusTooltip: string | undefined = undefined;
  active: TextDocument | null = null;

  root: string | null = "/repo";

  workspace = {
    rootPath: (): string | null => this.root,
    onDidChangeTextDocument: (l: Listener<TextDocumentChangeEvent>): Disposable => {
      this.changeListeners.push(l);
      return { dispose: () => (this.changeListeners = this.changeListeners.filter((x) => x !== l)) };
    },
    onDidSaveTextDocument: (l: Listener<TextDocument>): Disposable => {
      this.saveListeners.push(l);
      return { dispose: () => (this.saveListeners = this.saveListeners.filter((x) => x !== l)) };
    },
  };

  window = {
    onDidChangeTextEditorVisibleRanges: (
      l: Listener<TextEditorVisibleRangesChangeEvent>,
    ): Disposable => {
      this.scrollListeners.push(l);
      return { dispose: () => (this.scrollListeners = this.scrollListeners.filter((x) => x !== l)) };
    },
    activeDocument: (): TextDocument | null => this.active,
    setStatusBar: (text: string, tooltip?: string): void => {
      this.statusBar = text;
      this.statusTooltip = tooltip;
    },
  };

  commands = {
    registerCommand: (id: string, handler: (...args: unknown[]) => void): Disposable => {
      this.handlers.set(id, handler);
      return { dispose: () => this.handlers.delete(id) };
    },
  };

  /** The editor reports a change (an AI insertion or a human edit). */
  edit(doc: FakeDocument, startLine: number, endLine: number, text: string, reason?: 1 | 2): void {
    const change = doc.applyEdit(startLine, endLine, text);
    for (const l of this.changeListeners) l({ document: doc, contentChanges: [change], reason });
  }




  scroll(doc: TextDocument): void {
    for (const l of this.scrollListeners) l({ textEditor: { document: doc }, visibleRanges: [] });
  }

  save(doc: TextDocument): void {
    for (const l of this.saveListeners) l(doc);
  }

  run(command: string): void {
    const handler = this.handlers.get(command);
    if (!handler) throw new Error(`no such command: ${command}`);
    handler();
  }
}
