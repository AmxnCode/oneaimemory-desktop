import { randomUUID } from 'node:crypto';
import { redactEvent, type ConsciousnessEvent, type UserBlocklist } from '@oneconscious/shared';
import {
  getFrontmostApp, getActiveTab, getFrontWindowTitle, parseUrl,
  editorFor, parseEditorTitle, languageFor,
} from './macos.js';
import {
  getForegroundWindow, getActiveTabWindows, editorForWindows, cleanWindowTitle,
} from './windows.js';

const IS_WINDOWS = process.platform === 'win32';

export interface CollectorPrefs {
  collectBrowsing: boolean;
  collectSearches: boolean;
  collectYoutube: boolean;
  collectApps: boolean;
  collectCode: boolean;
}

export interface CollectorStats {
  emitted: number;
  droppedByFilter: number;
  lastEventAt: string | null;
  lastDropReason: string | null;
}

/**
 * A record that something was blocked, for the transparency view.
 *
 * Deliberately stores the REASON and TYPE only — never the URL, query, or
 * title. Logging the content of a blocked event would recreate on disk exactly
 * the data the filter just refused to keep.
 */
export interface BlockRecord {
  at: string;
  type: string;
  reason: string;
}

const MAX_BLOCK_HISTORY = 100;

type Emit = (event: ConsciousnessEvent) => void;

/**
 * Polling collector.
 *
 * Emits on CHANGE, not on every tick — otherwise a user reading one page for an
 * hour would generate hundreds of identical rows. This is the main lever on the
 * event-volume math in docs/PRD-REVIEW.md #6.
 */
export class CollectorEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Guards against overlapping ticks when osascript is slow. */
  private ticking = false;

  private lastApp: { name: string; bundleId?: string; since: number } | null = null;
  private lastUrl: string | null = null;
  private lastEditorFile: string | null = null;

  public stats: CollectorStats = {
    emitted: 0,
    droppedByFilter: 0,
    lastEventAt: null,
    lastDropReason: null,
  };

  /** Newest-first ring buffer of what the filter refused. */
  public blocks: BlockRecord[] = [];

  constructor(
    private deviceId: string,
    private emit: Emit,
    private getPrefs: () => CollectorPrefs,
    private getBlocklist: () => UserBlocklist,
    private intervalMs = 10_000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Flush the in-progress app session so its duration isn't lost.
    this.closeAppSession();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Build, redact, and emit. Returns false if the filter dropped it. */
  private push(type: ConsciousnessEvent['type'], payload: Record<string, unknown>): boolean {
    const candidate = { type, payload };
    const result = redactEvent(candidate, this.getBlocklist());

    if (result.decision.action === 'drop') {
      const reason = result.decision.reasons[0] ?? 'blocked';
      this.stats.droppedByFilter++;
      this.stats.lastDropReason = reason;
      // Reason and type only — never the content that was just refused.
      this.blocks.unshift({ at: new Date().toISOString(), type, reason });
      if (this.blocks.length > MAX_BLOCK_HISTORY) this.blocks.length = MAX_BLOCK_HISTORY;
      return false;
    }

    this.emit({
      eventUuid: randomUUID(),
      deviceId: this.deviceId,
      timestamp: new Date().toISOString(),
      type,
      payload: result.event!.payload,
    } as ConsciousnessEvent);

    this.stats.emitted++;
    this.stats.lastEventAt = new Date().toISOString();
    return true;
  }

  private closeAppSession(): void {
    if (!this.lastApp) return;
    const durationMs = Date.now() - this.lastApp.since;
    // Sub-5s focus is almost always incidental (cmd-tab passing through).
    if (durationMs >= 5000 && this.getPrefs().collectApps) {
      this.push('app', {
        name: this.lastApp.name,
        bundleId: this.lastApp.bundleId,
        durationMs,
      });
    }
    this.lastApp = null;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;

    try {
      const prefs = this.getPrefs();

      // Platform shims produce the same shape; everything below is shared.
      const win = IS_WINDOWS ? await getForegroundWindow() : null;
      const app = IS_WINDOWS
        ? win && { name: win.name, bundleId: win.bundleId }
        : await getFrontmostApp();
      if (!app) return;

      // --- app focus changes ------------------------------------------------
      if (!this.lastApp || this.lastApp.name !== app.name) {
        this.closeAppSession();
        this.lastApp = { name: app.name, bundleId: app.bundleId, since: Date.now() };
        // Focus changed, so any previous editor file context is stale.
        this.lastEditorFile = null;
      }

      // --- browser activity -------------------------------------------------
      const tab = IS_WINDOWS
        ? await getActiveTabWindows(win!.processName)
        : await getActiveTab(app.name);
      if (tab && tab.url !== this.lastUrl) {
        this.lastUrl = tab.url;
        const parsed = parseUrl(tab.url);

        if (parsed?.search && prefs.collectSearches) {
          this.push('search', { query: parsed.search.query, engine: parsed.search.engine, url: tab.url });
        } else if (parsed?.youtube && prefs.collectYoutube) {
          this.push('youtube', {
            videoId: parsed.youtube.videoId,
            title: tab.title,
            url: tab.url,
          });
        } else if (parsed && prefs.collectBrowsing) {
          this.push('browsing', {
            url: tab.url,
            title: tab.title || undefined,
            domain: parsed.domain,
            browser: tab.browser,
          });
        }
      }

      // --- editor activity --------------------------------------------------
      const editor = IS_WINDOWS ? editorForWindows(win!.processName) : editorFor(app.name);
      if (editor && prefs.collectCode) {
        const title = IS_WINDOWS
          ? cleanWindowTitle(win!.windowTitle, win!.processName)
          : await getFrontWindowTitle(app.name);
        if (title) {
          const { file, project } = parseEditorTitle(title);
          if (file && file !== this.lastEditorFile) {
            this.lastEditorFile = file;
            this.push('code', {
              editor,
              file,
              project,
              language: languageFor(file),
            });
          }
        }
      }
    } catch (err) {
      // A failed poll must never kill the loop.
      console.error('[collector] tick failed:', err);
    } finally {
      this.ticking = false;
    }
  }
}
