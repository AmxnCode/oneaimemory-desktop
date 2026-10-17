import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactEvent, type ConsciousnessEvent, type UserBlocklist } from '@oneconscious/shared';
import type { MemoryIndex } from '@oneconscious/memory';
import type { SessionParser } from './types.js';
import { chunkTurn } from './chunker.js';
import { claudeCodeParser } from './claudeCode.js';
import { codexCliParser } from './codexCli.js';
import { geminiCliParser } from './geminiCli.js';

const PARSERS: SessionParser[] = [claudeCodeParser, codexCliParser, geminiCliParser];
const DEBOUNCE_MS = 400; // a single logical write often fires several fs.watch events

interface CursorState {
  /** file path -> byte offset already parsed */
  files: Record<string, number>;
  /** sessionId -> next turnIndex to assign (see types.ts on why this lives here, not in the parser) */
  turnCounters: Record<string, number>;
}

export interface AiSessionWatcherDeps {
  deviceId: string;
  emit: (event: ConsciousnessEvent) => void;
  getBlocklist: () => UserBlocklist;
  onBlocked?: (reason: string) => void;
  cursorPath: string;
  /** Optional so a construction failure (see main.ts) degrades to sync-only, not a hard crash. */
  memoryIndex?: MemoryIndex;
}

export interface AiSessionStats {
  emitted: number;
  droppedByFilter: number;
  lastEventAt: string | null;
  filesWatched: number;
}

async function walkJsonl(root: string, parser: SessionParser, maxDepth = 4): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // root doesn't exist (tool not installed/used) — not an error
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < maxDepth) await walk(p, depth + 1);
      else if (e.isFile() && parser.matches(p)) out.push(p);
    }
  }
  await walk(root, 0);
  return out;
}

/**
 * Watches known local AI-tool session-log directories and turns new lines
 * into `ai_session` events, same redact-then-emit contract as
 * CollectorEngine. Event-driven rather than polled (unlike CollectorEngine)
 * because session files change whenever the user is mid-conversation, not
 * on a fixed cadence — see collectors/engine.ts for the polling sibling.
 */
export class AiSessionWatcher {
  private watchers: FSWatcher[] = [];
  private fileParsers = new Map<string, SessionParser>();
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private processing = new Set<string>(); // reentrancy guard per file
  private cursors: CursorState = { files: {}, turnCounters: {} };
  private running = false;

  public stats: AiSessionStats = { emitted: 0, droppedByFilter: 0, lastEventAt: null, filesWatched: 0 };

  constructor(private deps: AiSessionWatcherDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.loadCursors();

    for (const parser of PARSERS) {
      for (const root of parser.rootDirs()) {
        const existing = await walkJsonl(root, parser);
        for (const f of existing) this.fileParsers.set(f, parser);

        try {
          const w = fsWatch(root, { recursive: true }, (_event, filename) => {
            if (!filename) return;
            const full = join(root, filename.toString());
            if (!parser.matches(full)) return;
            this.fileParsers.set(full, parser);
            this.scheduleProcess(full);
          });
          w.on('error', () => {
            /* root removed/unreadable mid-watch — leave other watchers running */
          });
          this.watchers.push(w);
        } catch {
          // Root doesn't exist yet (tool never used on this machine) or the
          // platform doesn't support recursive watch — skip, not fatal.
          // If the directory appears later, it's picked up next time the
          // user toggles collection (start()/stop() are re-run then).
        }
      }
    }

    this.stats.filesWatched = this.fileParsers.size;

    // Pick up anything already on disk, not just future changes — fs.watch
    // only fires on changes from this point forward.
    for (const f of this.fileParsers.keys()) this.scheduleProcess(f);
  }

  stop(): void {
    this.running = false;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
  }

  private scheduleProcess(filePath: string): void {
    const existing = this.pendingTimers.get(filePath);
    if (existing) clearTimeout(existing);
    this.pendingTimers.set(
      filePath,
      setTimeout(() => {
        this.pendingTimers.delete(filePath);
        void this.processFile(filePath);
      }, DEBOUNCE_MS),
    );
  }

  private async processFile(filePath: string): Promise<void> {
    if (this.processing.has(filePath)) return; // a previous call is still running
    const parser = this.fileParsers.get(filePath);
    if (!parser) return;

    this.processing.add(filePath);
    try {
      const fromByte = this.cursors.files[filePath] ?? 0;
      const { turns, endByte } = await parser.parseIncremental(filePath, fromByte);
      this.cursors.files[filePath] = endByte;

      for (const turn of turns) {
        const turnIndex = this.cursors.turnCounters[turn.sessionId] ?? 0;
        this.cursors.turnCounters[turn.sessionId] = turnIndex + 1;

        for (const chunkPayload of chunkTurn(turn, turnIndex)) {
          await this.pushChunk(parser.tool, chunkPayload);
        }
      }

      if (turns.length > 0) await this.saveCursors();
    } catch (err) {
      // I/O failure (permissions, file vanished mid-read) — log and move on.
      // A malformed *line* is already handled inside parseIncremental; this
      // catch is only for failures parseIncremental itself couldn't absorb.
      console.error(`[ai-sessions] failed to process ${filePath}:`, err);
    } finally {
      this.processing.delete(filePath);
    }
  }

  private async pushChunk(tool: SessionParser['tool'], payload: Record<string, unknown>): Promise<void> {
    const candidate = { type: 'ai_session' as const, payload: { tool, ...payload } };
    const result = redactEvent(candidate, this.deps.getBlocklist());

    if (result.decision.action === 'drop') {
      this.stats.droppedByFilter++;
      this.deps.onBlocked?.(result.decision.reasons[0] ?? 'blocked');
      return;
    }

    const redacted = result.event!.payload as Record<string, unknown>;

    this.deps.emit({
      eventUuid: randomUUID(),
      deviceId: this.deps.deviceId,
      timestamp: new Date().toISOString(),
      type: 'ai_session',
      payload: redacted,
    } as ConsciousnessEvent);

    // Local search index gets the SAME redacted payload as the sync queue —
    // never the pre-redaction original — so a chunk dropped or masked here
    // can't leak into search results even though this index never leaves
    // the device. Best-effort: an indexing failure must never block the
    // sync path, which is the source of truth.
    if (this.deps.memoryIndex) {
      try {
        await this.deps.memoryIndex.ingest({
          tool,
          sessionId: redacted.sessionId as string,
          turnIndex: redacted.turnIndex as number,
          chunkIndex: redacted.chunkIndex as number,
          chunkCount: redacted.chunkCount as number,
          role: redacted.role as string,
          content: redacted.content as string,
          project: redacted.project as string | undefined,
          cwd: redacted.cwd as string | undefined,
        });
      } catch (err) {
        console.error('[ai-sessions] memory index ingest failed:', err);
      }
    }

    this.stats.emitted++;
    this.stats.lastEventAt = new Date().toISOString();
  }

  private async loadCursors(): Promise<void> {
    try {
      const raw = await readFile(this.deps.cursorPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CursorState>;
      this.cursors = { files: parsed.files ?? {}, turnCounters: parsed.turnCounters ?? {} };
    } catch {
      this.cursors = { files: {}, turnCounters: {} };
    }
  }

  private async saveCursors(): Promise<void> {
    try {
      await mkdir(dirname(this.deps.cursorPath), { recursive: true });
      await writeFile(this.deps.cursorPath, JSON.stringify(this.cursors), 'utf8');
    } catch (err) {
      console.error('[ai-sessions] failed to persist cursor state:', err);
    }
  }
}
