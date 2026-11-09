// The IDE half of the wedge: it watches an AI draft from the moment it appears in the editor to
// the moment the person accepts or saves it, and turns that into one `draft.curation` event.
//
// What it deliberately does NOT do:
//   * it never emits text. `draft`/`final` exist in memory only, as inputs to Kc and to the
//     salted content hashes (collector §3.2);
//   * it never computes Kc while typing. There is one flush path — accept/save — so "compute only
//     on accept/save" is a property of the code, not a rule a caller must remember;
//   * it never runs when the budget is exceeded: the guard pauses collection and says so.
//
// Attention telemetry (t_validation_ms, n_scroll, n_edits) is what makes OVR meaningful: without
// it, a blind "accept everything" is indistinguishable from a reviewed draft (6.1 §8).

import type { DraftCurationEvent, Event, ModelInfo } from "@mentat/schemas";
import {
  buildDraftCuration,
  buildErrorInterception,
  buildWedgeStatus,
  computeKc,
  KC_DEFAULT_BUDGET_MS,
  MODEL_NOT_KNOWN,
  SecretFoundError,
  type WedgeSource,
} from "@mentat/wedge-core";

import { BudgetGuard } from "./budget";
import { docKey, type Disposable, type HostApi, type TextDocument } from "./host";

/**
 * A single insertion of at least this many characters is treated as an AI draft, not typing.
 *
 * KNOWN TO OVER-COUNT, and kept on purpose (audit 2026-10-09 #6). It also catches a paste, a
 * snippet expansion and a formatter that replaces a whole block. The audit asked whether the
 * inline-completion path (`noteProposal`) could be wired so only real AI suggestions count. It
 * cannot, today, on any API this extension may use:
 *
 *   * VS Code has no event for "an inline suggestion was accepted". `InlineCompletionItemProvider`
 *     callbacks (`handleDidShowCompletionItem`, `handleDidPartiallyAcceptCompletionItem`) fire
 *     only for items THIS extension provided; Copilot's, Cursor's or any other provider's
 *     acceptances are not observable. The extension provides no completions and should not.
 *   * Intercepting Tab (a keybinding on `inlineSuggestionVisible` that records and then runs
 *     `editor.action.inlineSuggest.commit`) would put Deigma in the key path of somebody's editor —
 *     the wedge-fails-open rule forbids sitting in front of the tool — and it would still miss
 *     word/line partial accepts, the hover toolbar, Next Edit Suggestions and Cursor's own Tab
 *     command, none of which were confirmed on a real editor here.
 *   * Agent/chat edits (Copilot Edits, Cursor Composer) arrive as ordinary workspace edits,
 *     indistinguishable from a paste in `onDidChangeTextDocument`.
 *   * `DocumentPasteEditProvider` could mark pastes so they are EXCLUDED, but it was not
 *     confirmed against a running editor (CLAUDE.md: a format not confirmed on a real file or
 *     live API is not implemented), and it would add a provider to every paste in every file.
 *
 * What IS reliable is the editor's own `TextDocumentChangeReason`: undo and redo are named, and a
 * large block an undo puts back is never a suggestion — that exclusion is applied in `onChange`.
 * Everything else stays as it was rather than being narrowed silently. The over-count is bounded
 * by what the editor habits (ed-1.0) read: a pasted block that is then edited reads as "reviewed",
 * one kept verbatim as "accepted as is" — the same attention telemetry, on text that was not AI's.
 */
export const DRAFT_MIN_CHARS = 120;
/** How long an accepted draft is watched for a correction (collector §3.2 / offline window). */
export const INTERCEPTION_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Accepted drafts kept per document; the oldest are dropped first. */
export const MAX_WATCHED_PER_DOC = 32;

export type PendingDraft = {
  text: string;
  startLine: number;
  endLine: number;
  proposedAtMs: number;
  nScroll: number;
  nEdits: number;
};

/** An accepted draft, watched for a later correction — the wedge's half of the interception
 *  pattern (collector §3.2). Text stays in memory; only hashes and metrics are ever emitted. */
export type AcceptedDraft = {
  text: string;
  startLine: number;
  endLine: number;
  acceptedAtMs: number;
  corrected: boolean;
};

export type CollectorOptions = {
  userId: string;
  source?: WedgeSource;
  wedgeVersion?: string;
  tool?: { name: string; version: string };
  /** No editor API names the model behind a suggestion (neither VS Code's inline completions nor
   *  Cursor expose it), so the extension passes none and the events say `MODEL_NOT_KNOWN`. */
  model?: ModelInfo;
  /** This device's salt for the draft hashes (./device-salt). Required: the builders refuse to
   *  hash without one, and there is no constant to fall back to. */
  salt: string;
  /** Carrier hint for the events (branch / repository), read by the host from the workspace. */
  carrier?: (doc: TextDocument) => { branch?: string; repoId?: number; prNumber?: number } | null;
  emit: (event: Event) => void;
  now?: () => number;
  guard?: BudgetGuard;
  kcBudgetMs?: number;
};

export type CollectorStats = {
  drafts: number;
  interceptions: number;
  blockedBySecret: number;
  droppedOverBudget: number;
  paused: boolean;
};

/**
 * What the status bar says while the editor is connected (copy v4): how many AI suggestions were
 * read, and that no code was sent. The secret scanner's count sits in the tooltip — it is true and
 * worth finding, and on the bar it read as an alarm. A count of nothing reads as "reading", not as
 * "0", which would be a zero standing in for "nothing accepted yet".
 */
export function statusBarFor(stats: CollectorStats): { text: string; tooltip: string } {
  const tooltip =
    `${stats.blockedBySecret} blocked by the secret scanner before anything was sent. ` +
    "Counts and timings only: never a suggestion, your code or a file path.";
  if (stats.paused) return { text: "Deigma: paused", tooltip };
  const text =
    stats.drafts === 0
      ? "Deigma: reading AI suggestions · no code sent"
      : `Deigma: ${stats.drafts} AI suggestion${stats.drafts === 1 ? "" : "s"} read · no code sent`;
  return { text, tooltip };
}

export class Collector {
  private readonly pending = new Map<string, PendingDraft[]>();
  private readonly disposables: Disposable[] = [];
  private readonly guard: BudgetGuard;
  private readonly now: () => number;
  private readonly watched = new Map<string, AcceptedDraft[]>();
  readonly stats: CollectorStats = {
    drafts: 0,
    interceptions: 0,
    blockedBySecret: 0,
    droppedOverBudget: 0,
    paused: false,
  };

  constructor(
    private readonly host: HostApi,
    private readonly opts: CollectorOptions,
  ) {
    this.guard = opts.guard ?? new BudgetGuard();
    this.now = opts.now ?? Date.now;
  }

  activate(): void {
    this.disposables.push(
      this.host.workspace.onDidChangeTextDocument((e) => this.onChange(e.document, e.contentChanges, e.reason)),
      this.host.workspace.onDidSaveTextDocument((doc) => this.flush(doc, "save")),
      this.host.window.onDidChangeTextEditorVisibleRanges((e) => this.onScroll(e.textEditor.document)),
      this.host.commands.registerCommand("deigma.acceptDraft", () => this.acceptActive()),
      this.host.commands.registerCommand("deigma.pause", () => this.setPaused(true)),
      this.host.commands.registerCommand("deigma.resume", () => this.setPaused(false)),
      this.host.commands.registerCommand("deigma.status", () => this.showStatus()),
    );
    this.showStatus();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.pending.clear();
    this.watched.clear();
  }

  /** An inline-completion provider can announce a draft directly instead of relying on the size
   *  heuristic below. Both paths land in the same pending list. */
  noteProposal(doc: TextDocument, text: string, startLine: number): void {
    if (this.stats.paused) return;
    this.list(doc).push({
      text,
      startLine,
      endLine: startLine + text.split("\n").length - 1,
      proposedAtMs: this.now(),
      nScroll: 0,
      nEdits: 0,
    });
  }

  private watchList(doc: TextDocument): AcceptedDraft[] {
    const key = docKey(doc);
    const existing = this.watched.get(key);
    if (existing) return existing;
    const created: AcceptedDraft[] = [];
    this.watched.set(key, created);
    return created;
  }

  private carrierHint(doc: TextDocument): { branch?: string; repoId?: number; prNumber?: number } {
    const hint = this.opts.carrier?.(doc) ?? null;
    return hint ?? {};
  }

  private list(doc: TextDocument): PendingDraft[] {
    const key = docKey(doc);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const created: PendingDraft[] = [];
    this.pending.set(key, created);
    return created;
  }

  private onChange(
    doc: TextDocument,
    changes: readonly { range: { start: { line: number }; end: { line: number } }; text: string }[],
    reason?: 1 | 2,
  ): void {
    if (this.stats.paused) return;
    for (const change of changes) {
      const insertedLines = change.text.split("\n").length - 1;
      const replacedLines = change.range.end.line - change.range.start.line;
      // An undo or redo that puts back a large block is the person's own history, never a new
      // suggestion: the editor says so (`reason`), and that is the one exclusion it states reliably.
      if (change.text.length >= DRAFT_MIN_CHARS && reason === undefined) {
        // A draft appeared. No Kc, no event: the person has not decided anything yet.
        this.noteProposal(doc, change.text, change.range.start.line);
        continue;
      }
      // A human edit. It counts as attention only if it lands inside a draft under review, and it
      // moves that draft's region so the Kc scope stays the region and not the file.
      for (const draft of this.list(doc)) {
        if (change.range.start.line >= draft.startLine && change.range.start.line <= draft.endLine) {
          draft.nEdits += 1;
          draft.endLine += insertedLines - replacedLines;
        }
      }
      // The same edit may land on a draft that was already accepted: that is the wedge's half of
      // the interception pattern — an accepted draft the person came back to and corrected. Only
      // human edits count; a regenerated AI draft in the same place produces its own
      // draft.curation and would double-count the region.
      for (const accepted of this.watchList(doc)) {
        if (
          change.range.start.line >= accepted.startLine &&
          change.range.start.line <= accepted.endLine
        ) {
          accepted.corrected = true;
          accepted.endLine += insertedLines - replacedLines;
        }
      }
    }
  }

  private onScroll(doc: TextDocument): void {
    if (this.stats.paused) return;
    for (const draft of this.list(doc)) draft.nScroll += 1;
  }

  /** The "accept" path: the same flush as a save, for editors that apply a draft without saving. */
  private acceptActive(): void {
    const doc = this.host.window.activeDocument();
    if (doc) this.flush(doc, "accept");
  }

  /** Accept/save: the only place Kc is computed and the only place an event is produced. */
  flush(doc: TextDocument, _trigger: "save" | "accept"): DraftCurationEvent[] {
    const drafts = this.pending.get(docKey(doc)) ?? [];
    this.pending.set(docKey(doc), []);
    const corrections = this.dueInterceptions(doc);
    if (drafts.length === 0 && corrections.length === 0) return [];

    const verdict = this.guard.check();
    if (!verdict.withinBudget) {
      this.stats.droppedOverBudget += drafts.length;
      this.setPaused(true, verdict.reason === "rss" ? "budget_rss" : "budget_cpu");
      return [];
    }
    this.emitInterceptions(doc, corrections);

    const emitted: DraftCurationEvent[] = [];
    for (const draft of drafts) {
      const final = doc.getText({
        start: { line: draft.startLine, character: 0 },
        end: { line: Math.max(draft.startLine, draft.endLine), character: Number.MAX_SAFE_INTEGER },
      });
      try {
        const kc = computeKc({
          draft: draft.text,
          final,
          fileText: doc.getText(),
          regionStartLine: draft.startLine,
          budgetMs: this.opts.kcBudgetMs ?? KC_DEFAULT_BUDGET_MS,
        });
        const event = buildDraftCuration({
          userId: this.opts.userId,
          source: this.opts.source ?? "wedge_vscode",
          ...(this.opts.tool ? { tool: this.opts.tool } : {}),
          model: this.opts.model ?? MODEL_NOT_KNOWN,
          salt: this.opts.salt,
          now: () => new Date(this.now()),
          draft: draft.text,
          final,
          filePath: doc.uri.fsPath,
          tValidationMs: Math.max(0, this.now() - draft.proposedAtMs),
          nScroll: draft.nScroll,
          nEdits: draft.nEdits,
          kc,
          ...this.carrierHint(doc),
        });
        this.stats.drafts += 1;
        emitted.push(event);
        this.opts.emit(event);
        this.watch(doc, { text: final, startLine: draft.startLine, endLine: draft.endLine });
      } catch (err) {
        // A secret in the draft blocks the whole event: even the metrics of that draft can encode
        // it, so nothing derived from it is emitted (collector §2).
        if (err instanceof SecretFoundError) {
          this.stats.blockedBySecret += 1;
          continue;
        }
        throw err;
      }
    }
    this.showStatus();
    return emitted;
  }

  /** Accepted drafts of this document that a human has since corrected (and are still inside the
   *  watch window). Expired entries are dropped here, so nothing is kept beyond the window. */
  private dueInterceptions(doc: TextDocument): AcceptedDraft[] {
    const now = this.now();
    const kept = this.watchList(doc).filter((a) => now - a.acceptedAtMs <= INTERCEPTION_WINDOW_MS);
    const due = kept.filter((a) => a.corrected);
    this.watched.set(
      docKey(doc),
      kept.filter((a) => !a.corrected),
    );
    return due;
  }

  private emitInterceptions(doc: TextDocument, corrections: AcceptedDraft[]): void {
    for (const accepted of corrections) {
      const fix = doc.getText({
        start: { line: accepted.startLine, character: 0 },
        end: {
          line: Math.max(accepted.startLine, accepted.endLine),
          character: Number.MAX_SAFE_INTEGER,
        },
      });
      if (fix === accepted.text) continue; // touched and reverted: nothing was actually corrected
      try {
        this.opts.emit(
          buildErrorInterception({
            userId: this.opts.userId,
            source: this.opts.source ?? "wedge_vscode",
            ...(this.opts.tool ? { tool: this.opts.tool } : {}),
            model: this.opts.model ?? MODEL_NOT_KNOWN,
            salt: this.opts.salt,
            now: () => new Date(this.now()),
            accepted: accepted.text,
            fix,
            tSinceAcceptMs: Math.max(0, this.now() - accepted.acceptedAtMs),
            sameRegion: true,
            ...this.carrierHint(doc),
          }),
        );
        this.stats.interceptions += 1;
      } catch (err) {
        if (err instanceof SecretFoundError) {
          this.stats.blockedBySecret += 1;
          continue;
        }
        throw err;
      }
    }
  }

  private watch(doc: TextDocument, region: { text: string; startLine: number; endLine: number }): void {
    const list = this.watchList(doc);
    list.push({ ...region, acceptedAtMs: this.now(), corrected: false });
    if (list.length > MAX_WATCHED_PER_DOC) list.splice(0, list.length - MAX_WATCHED_PER_DOC);
  }

  setPaused(paused: boolean, errorCode?: string): void {
    if (this.stats.paused === paused && !errorCode) return;
    this.stats.paused = paused;
    if (paused) {
      this.pending.clear();
      this.watched.clear();
    }
    this.opts.emit(
      buildWedgeStatus({
        userId: this.opts.userId,
        source: this.opts.source ?? "wedge_vscode",
        ...(this.opts.tool ? { tool: this.opts.tool } : {}),
        now: () => new Date(this.now()),
        kind: paused ? "paused" : "resumed",
        wedgeVersion: this.opts.wedgeVersion ?? "0.1.0",
        errorCode: errorCode ?? null,
      }),
    );
    this.showStatus();
  }

  private showStatus(): void {
    const { text, tooltip } = statusBarFor(this.stats);
    this.host.window.setStatusBar(text, tooltip);
  }
}
