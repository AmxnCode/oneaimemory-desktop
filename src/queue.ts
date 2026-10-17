import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsciousnessEvent } from '@oneconscious/shared';

/**
 * Append-only local queue.
 *
 * Events land here the moment they are collected and are removed only after the
 * server confirms receipt, so the app survives being offline, killed, or
 * crashed mid-sync. NDJSON keeps appends O(1) and makes a partially written
 * final line recoverable — we simply drop it on read.
 *
 * Events are queued as PLAINTEXT and encrypted at sync time. That is deliberate:
 * re-encrypting at sync means a passphrase change doesn't strand queued events.
 * The file is inside the app's sandboxed data directory and mode 0600.
 */
export class EventQueue {
  private path: string;
  private maxBytes: number;

  constructor(dir: string, filename = 'queue.ndjson', maxBytes = 32 * 1024 * 1024) {
    this.path = join(dir, filename);
    this.maxBytes = maxBytes;
  }

  enqueue(event: ConsciousnessEvent): void {
    this.rotateIfOversized();
    appendFileSync(this.path, JSON.stringify(event) + '\n', { mode: 0o600 });
  }

  /** Read up to `limit` events. Malformed trailing lines are skipped. */
  peek(limit: number): ConsciousnessEvent[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    const out: ConsciousnessEvent[] = [];
    for (const line of lines) {
      if (out.length >= limit) break;
      try {
        out.push(JSON.parse(line) as ConsciousnessEvent);
      } catch {
        /* truncated write; skip */
      }
    }
    return out;
  }

  /**
   * Remove the given events after the server has confirmed them. Matching by
   * uuid rather than by count means an interleaved enqueue during sync cannot
   * cause data loss.
   */
  ack(uuids: string[]): void {
    if (!existsSync(this.path) || uuids.length === 0) return;
    const done = new Set(uuids);
    const kept = readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        try {
          return !done.has((JSON.parse(line) as ConsciousnessEvent).eventUuid);
        } catch {
          return false; // drop unparseable lines while we're here
        }
      });
    writeFileSync(this.path, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
  }

  size(): number {
    if (!existsSync(this.path)) return 0;
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).length;
  }

  /**
   * Guard against unbounded growth if the backend is unreachable for a long
   * time. Drops the OLDEST half — recent context is what the product is for.
   */
  private rotateIfOversized(): void {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size < this.maxBytes) return;

    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    const kept = lines.slice(Math.floor(lines.length / 2));
    writeFileSync(this.path, kept.join('\n') + '\n', { mode: 0o600 });
    console.warn(`[queue] exceeded ${this.maxBytes} bytes; dropped ${lines.length - kept.length} oldest events`);
  }
}
