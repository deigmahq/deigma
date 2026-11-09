// The emit path: events go into the offline queue first and are flushed in batches. Nothing here
// knows what an event contains — the queue and the batching rules live in @mentat/wedge-core, so
// the CLI and the extension behave identically when the network is gone.

import type { Event } from "@mentat/schemas";
import {
  afterSent,
  backoffMs,
  dropExpired,
  dueBatch,
  emptyQueue,
  enqueue,
  type QueueState,
} from "@mentat/wedge-core";

export type SenderDeps = {
  apiBaseUrl: string;
  session: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  /** Persists the queue across restarts; the wedge must not lose events on a crash. */
  persist?: (state: QueueState) => void;
  restore?: () => QueueState | null;
  /** The server no longer accepts this session (401): it was ended in Settings, by a sign-out on
   *  this machine, or by the account's deletion. Retrying cannot succeed, so the queue is dropped
   *  and the owner is told — an editor that keeps saying it collects while every batch bounces
   *  claims a connection it does not have. */
  onUnauthorized?: () => void;
};

export class Sender {
  private state: QueueState;
  private attempt = 0;
  private readonly now: () => number;

  constructor(private readonly deps: SenderDeps) {
    this.now = deps.now ?? Date.now;
    this.state = deps.restore?.() ?? emptyQueue();
  }

  get pending(): number {
    return this.state.pending.length;
  }

  add(event: Event): void {
    this.state = enqueue(this.state, event, this.now());
    this.deps.persist?.(this.state);
  }

  /** Sends one due batch if there is one. Returns the number of events accepted by the server. */
  async tick(force = false): Promise<number> {
    const expired = dropExpired(this.state, this.now());
    this.state = expired.state;
    const batch = force ? (this.state.pending.length ? this.state.pending.slice(0, 500) : null) : dueBatch(this.state, this.now());
    if (!batch) {
      if (expired.dropped > 0) this.deps.persist?.(this.state);
      return 0;
    }
    try {
      const res = await this.deps.fetch(`${this.deps.apiBaseUrl}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.deps.session}` },
        body: JSON.stringify({ events: batch }),
      });
      // 410 = the account was deleted; the tombstone rejects late events and so do we, locally.
      if (res.status === 410) {
        this.state = emptyQueue();
        this.deps.persist?.(this.state);
        return 0;
      }
      if (res.status === 401) {
        this.state = emptyQueue();
        this.deps.persist?.(this.state);
        this.attempt = 0;
        this.deps.onUnauthorized?.();
        return 0;
      }
      if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
      this.state = afterSent(this.state, batch.length, this.now());
      this.attempt = 0;
      this.deps.persist?.(this.state);
      return batch.length;
    } catch {
      this.attempt += 1;
      return 0;
    }
  }

  /** How long to wait before the next attempt after a failure (full jitter, capped). */
  nextDelayMs(): number {
    return this.attempt === 0 ? 30_000 : backoffMs(this.attempt);
  }
}
