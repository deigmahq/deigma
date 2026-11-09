// Offline queue and emit path (collector §8): batches of <= 500 events or 5 minutes, an on-disk
// queue that survives a crash, backoff with jitter, dedup by event_id on the server. The wedge
// assigns `event_id` once at capture and persists it, so a retry after a crash is a duplicate the
// server drops rather than a second observation.

import type { Event } from "@mentat/schemas";

export const MAX_BATCH = 500;
export const MAX_BATCH_AGE_MS = 5 * 60 * 1000;
/** Late events are rejected by the tombstone after this long (data & compliance §6). */
export const MAX_OFFLINE_AGE_MS = 72 * 60 * 60 * 1000;

export type QueueState = { pending: Event[]; firstQueuedAt: number | null };

export function emptyQueue(): QueueState {
  return { pending: [], firstQueuedAt: null };
}

export function enqueue(state: QueueState, event: Event, now = Date.now()): QueueState {
  return {
    pending: [...state.pending, event],
    firstQueuedAt: state.firstQueuedAt ?? now,
  };
}

/** A batch is due when it is full or old enough; returns null when there is nothing to send yet. */
export function dueBatch(state: QueueState, now = Date.now()): Event[] | null {
  if (state.pending.length === 0) return null;
  const full = state.pending.length >= MAX_BATCH;
  const old = state.firstQueuedAt !== null && now - state.firstQueuedAt >= MAX_BATCH_AGE_MS;
  if (!full && !old) return null;
  return state.pending.slice(0, MAX_BATCH);
}

export function afterSent(state: QueueState, sent: number, now = Date.now()): QueueState {
  const pending = state.pending.slice(sent);
  return { pending, firstQueuedAt: pending.length === 0 ? null : now };
}

/** Exponential backoff with full jitter, capped — never a tight retry loop against ingestion. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(60_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + 0.5 * random()));
}

/** Events older than the offline window are dropped locally: the server would reject them. */
export function dropExpired(state: QueueState, now = Date.now()): { state: QueueState; dropped: number } {
  const keep = state.pending.filter((e) => now - Date.parse(e.occurred_at) <= MAX_OFFLINE_AGE_MS);
  return {
    state: { pending: keep, firstQueuedAt: keep.length === 0 ? null : state.firstQueuedAt },
    dropped: state.pending.length - keep.length,
  };
}
