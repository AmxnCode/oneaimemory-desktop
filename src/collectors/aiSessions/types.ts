import type { AiSessionPayload } from '@oneconscious/shared';

/**
 * One raw turn extracted from a tool's session log, before chunking.
 *
 * No `turnIndex` here deliberately: `parseIncremental` only sees whatever
 * new lines exist since the last cursor, and a per-call-local counter would
 * collide across separate incremental reads of the same session (batch 1
 * and batch 2 would each start counting from 0). The watcher owns a
 * persistent per-session counter instead — see watcher.ts — since it
 * already tracks cursor state that needs to survive app restarts anyway.
 */
export interface RawTurn {
  sessionId: string;
  role: AiSessionPayload['role'];
  content: string;
  project?: string;
  cwd?: string;
}

/**
 * One tool's session-log format, isolated behind this interface so a parse
 * failure or format change in one tool can never affect another (each tool
 * gets its own try/catch at the call site — see watcher.ts).
 */
export interface SessionParser {
  readonly tool: AiSessionPayload['tool'];

  /** Directories to watch. May not exist — the watcher skips missing ones. */
  rootDirs(): string[];

  /** Whether this parser owns the given file path (by extension/location). */
  matches(filePath: string): boolean;

  /**
   * Parse only the NEW lines of a session file, starting at byte offset
   * `fromByte`. Returns the extracted turns plus the new end-of-file byte
   * offset to persist as the next cursor.
   *
   * Must never throw on a malformed individual line — skip it and keep
   * going, matching CollectorEngine's "a failed poll must never kill the
   * loop" philosophy. A thrown error here is reserved for i/o failures
   * (unreadable file), which the caller catches separately.
   */
  parseIncremental(filePath: string, fromByte: number): Promise<{ turns: RawTurn[]; endByte: number }>;
}
