/**
 * From the sessions found in the task folder to the body of the upload, or to the reason there is
 * none. Pure: nothing here reads a file or the network.
 *
 *   1. every text is scanned for secrets (@mentat/wedge-core) — a hit anywhere stops the whole
 *      attachment, and what is reported is which session and what KIND of secret, never a character
 *      of it;
 *   2. the sessions are fitted to what the schema allows (at most `TASK_LIMITS.sessions` of them, at
 *      most `TASK_LIMITS.eventsPerSession` events each): neighbours of one agent are joined, nothing
 *      is dropped;
 *   3. the upload is cut to the size it may have, all events the same way, by the first of
 *      `CUT_TIERS` that fits `TASK_LIMITS.sessionBytes`;
 *   4. the body is checked against the same schema the server checks it against, so a bug here is
 *      a refusal here and not half an upload there.
 *
 * Only after that is the person asked.
 */
import {
  TASK_LIMITS,
  TaskSessionUpload,
  type Agent,
  type TaskSession,
} from "@mentat/schemas";
import { scanForSecrets } from "@mentat/wedge-core";

import { CUT_TIERS, recut, renderCut, type Limits } from "./text";
import type { FolderEvent, FolderSession } from "./types";

/** A session that holds something the secret scanner blocks, said without saying what. */
export type SecretHit = { agent: Agent; startedAt: string; kinds: string[] };

/** What the person is shown about one session before they say yes. */
export type SessionLine = { agent: Agent; startedAt: string; events: number };

export type Prepared =
  | {
      kind: "ready";
      body: TaskSessionUpload;
      sessions: SessionLine[];
      events: number;
      /** The size of the sessions as the server measures them: the JSON text, in bytes. */
      bytes: number;
    }
  | { kind: "secret"; hits: SecretHit[] }
  | { kind: "too_large"; bytes: number }
  | { kind: "too_many"; what: "sessions" | "events"; count: number }
  /** The body did not pass the schema: a defect of this program, never of the person's work. */
  | { kind: "invalid"; where: string };

/** Slack under the limit for the few bytes the server counts and this program does not. */
const BYTES_MARGIN = 1024;

/** What an event costs on the wire at the very least: its JSON frame, without the tool name or any text
 *  (`{"at":"…","kind":"reply","text":""}` is 58 bytes). */
const EVENT_FRAME_BYTES = 58;

/**
 * The least an upload of what has been read so far could come to, at the smallest size. A reader
 * adds each event as it makes it and stops as soon as even that is over the limit: a journal of a
 * hundred thousand events is too long to send at any size, and finding that out should not take
 * the time and the memory of reading all of it. A floor, never an estimate — the real size is at
 * least this, so a read that stops here would have been refused by `prepareUpload` as well.
 */
export class Budget {
  private floor = 0;
  constructor(readonly limit: number = TASK_LIMITS.sessionBytes - BYTES_MARGIN) {}

  /** Counts one event; false once the upload cannot fit any more. */
  add(event: FolderEvent): boolean {
    const smallest = CUT_TIERS[CUT_TIERS.length - 1]!;
    const kept = event.kind === "tool_result" ? smallest.resultHead + smallest.resultTail : smallest.other;
    const tool = event.tool ? `,"tool":""`.length + event.tool.length : 0;
    this.floor += EVENT_FRAME_BYTES + tool + Math.min(renderCut(event.text).length, kept);
    return this.floor <= this.limit;
  }

  get exceeded(): boolean {
    return this.floor > this.limit;
  }

  get bytes(): number {
    return this.floor;
  }
}

function secretHits(sessions: readonly FolderSession[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const session of sessions) {
    const kinds = new Set<string>();
    for (const event of session.events) {
      for (const kind of scanForSecrets(renderCut(event.text))) kinds.add(kind);
    }
    if (kinds.size > 0) hits.push({ agent: session.agent, startedAt: session.startedAt, kinds: [...kinds].sort() });
  }
  return hits;
}

/**
 * Neighbouring sessions of one agent joined, the pair with the fewest events first, until there
 * are no more than `max` sessions. Events stay in the order they happened. Null where it cannot be
 * done (the agents alternate): the caller says so instead of leaving some out.
 */
export function fitSessionCount(sessions: readonly FolderSession[], max: number): FolderSession[] | null {
  const out = [...sessions];
  while (out.length > max) {
    let best = -1;
    let fewest = Infinity;
    for (let i = 0; i + 1 < out.length; i += 1) {
      if (out[i]!.agent !== out[i + 1]!.agent) continue;
      const events = out[i]!.events.length + out[i + 1]!.events.length;
      if (events < fewest) {
        fewest = events;
        best = i;
      }
    }
    if (best === -1) return null;
    const [a, b] = [out[best]!, out[best + 1]!];
    out.splice(best, 2, { agent: a.agent, startedAt: a.startedAt, events: [...a.events, ...b.events] });
  }
  return out;
}

function wire(sessions: readonly FolderSession[], limits: Limits | null): TaskSession[] {
  return sessions.map((session) => ({
    agent: session.agent,
    events: session.events.map((event: FolderEvent) => ({
      at: event.at,
      kind: event.kind,
      ...(event.tool ? { tool: event.tool } : {}),
      text: renderCut(limits ? recut(event.text, event.kind, limits) : event.text),
    })),
  }));
}

export function prepareUpload(found: readonly FolderSession[]): Prepared {
  const hits = secretHits(found);
  if (hits.length > 0) return { kind: "secret", hits };

  const tooLong = found.find((s) => s.events.length > TASK_LIMITS.eventsPerSession);
  if (tooLong) return { kind: "too_many", what: "events", count: tooLong.events.length };
  const fitted = fitSessionCount(found, TASK_LIMITS.sessions);
  if (fitted === null) return { kind: "too_many", what: "sessions", count: found.length };
  if (fitted.some((s) => s.events.length > TASK_LIMITS.eventsPerSession)) {
    // joined neighbours may now be too long for one session
    const joined = fitted.find((s) => s.events.length > TASK_LIMITS.eventsPerSession)!;
    return { kind: "too_many", what: "events", count: joined.events.length };
  }

  let smallest = 0;
  for (const [i, limits] of CUT_TIERS.entries()) {
    const sessions = wire(fitted, i === 0 ? null : limits);
    const bytes = Buffer.byteLength(JSON.stringify(sessions), "utf8");
    smallest = bytes;
    if (bytes > TASK_LIMITS.sessionBytes - BYTES_MARGIN) continue;
    const body = { state: "attached" as const, consent: true as const, sessions };
    const checked = TaskSessionUpload.safeParse(body);
    if (!checked.success) {
      return { kind: "invalid", where: checked.error.issues[0]?.path.join(".") ?? "" };
    }
    return {
      kind: "ready",
      body: checked.data,
      sessions: fitted.map((s) => ({ agent: s.agent, startedAt: s.startedAt, events: s.events.length })),
      events: fitted.reduce((n, s) => n + s.events.length, 0),
      bytes,
    };
  }
  return { kind: "too_large", bytes: smallest };
}
