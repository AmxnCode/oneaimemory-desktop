import { encryptEvent, type DataKey } from '@oneconscious/shared';
import type { ApiClient } from './api.js';
import type { EventQueue } from './queue.js';

export interface SyncState {
  lastSyncAt: string | null;
  lastError: string | null;
  pendingCount: number;
  syncedTotal: number;
  online: boolean;
}

const BATCH_SIZE = 200;
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Drains the local queue to the backend on an interval.
 *
 * Encryption happens HERE, not at collection time, so that rotating the
 * passphrase does not strand already-queued events.
 */
export class SyncService {
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  private backoffMs = 0;

  public state: SyncState = {
    lastSyncAt: null,
    lastError: null,
    pendingCount: 0,
    syncedTotal: 0,
    online: true,
  };

  constructor(
    private api: ApiClient,
    private queue: EventQueue,
    private getKey: () => DataKey | null,
    private intervalMs = 60_000,
    private onChange?: () => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    void this.flush();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<void> {
    if (this.syncing) return;

    const key = this.getKey();
    if (!key) return; // locked — nothing we can encrypt with

    // Respect backoff after a failure so we don't hammer a down server.
    if (this.backoffMs > 0 && this.state.lastSyncAt) {
      const since = Date.now() - Date.parse(this.state.lastSyncAt);
      if (since < this.backoffMs) return;
    }

    this.syncing = true;
    try {
      let drained = 0;

      // Loop so a device returning from offline catches up in one pass.
      for (;;) {
        const batch = this.queue.peek(BATCH_SIZE);
        if (batch.length === 0) break;

        const envelopes = batch.map((e) => encryptEvent(e, key));
        const result = await this.api.syncEvents(envelopes);

        // Duplicates count as delivered — the server already has them.
        this.queue.ack(batch.map((e) => e.eventUuid));
        drained += batch.length;
        this.state.syncedTotal += result.inserted;

        if (batch.length < BATCH_SIZE) break;
      }

      this.state.lastSyncAt = new Date().toISOString();
      this.state.lastError = null;
      this.state.online = true;
      this.backoffMs = 0;
      if (drained > 0) console.log(`[sync] delivered ${drained} event(s)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.lastError = message;
      this.state.online = false;
      this.state.lastSyncAt = new Date().toISOString();
      // Exponential backoff, capped. Events stay queued meanwhile.
      this.backoffMs = Math.min(this.backoffMs === 0 ? this.intervalMs : this.backoffMs * 2, MAX_BACKOFF_MS);
      console.error(`[sync] failed (retry in ${Math.round(this.backoffMs / 1000)}s):`, message);
    } finally {
      this.state.pendingCount = this.queue.size();
      this.syncing = false;
      this.onChange?.();
    }
  }
}
