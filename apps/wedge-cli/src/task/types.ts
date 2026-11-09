/**
 * The shapes the task commands pass between their parts. What
 * goes on the wire is `TaskSessionUpload` in @mentat/schemas; these are what the readers hand to
 * `prepare` before the texts are redacted, scanned and cut to the size of the upload.
 */
import type { Agent, TaskEventKind } from "@mentat/schemas";

import type { CutText } from "./text";

/** One event of a session in the task folder, text already normalized and cut at the first tier. */
export type FolderEvent = { at: string; kind: TaskEventKind; tool?: string; text: CutText };

/** One session of one agent whose working directory is the task folder. */
export type FolderSession = {
  agent: Agent;
  /** Local bookkeeping for the person's own list ("Claude Code · 2026-11-05 13:02 UTC"): never sent. */
  startedAt: string;
  events: FolderEvent[];
};

/** What a reader found, and what it could not read: a file it could not open is a number, never
 *  "no sessions". `overBudget`: it stopped reading because what it had read was already too long to
 *  send at any size (./prepare `Budget`), so `sessions` is not the whole of it. */
export type FolderRead = { sessions: FolderSession[]; unreadable: number; overBudget: boolean };

/** The ways a task folder and the person's home are spelled: what `makeNormalizer` hides. */
export type FolderIdentity = { folders: string[]; homes: string[] };
