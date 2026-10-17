import type { AiSessionPayload } from '@oneconscious/shared';
import type { RawTurn } from './types.js';

const MAX_CHARS = 4000; // matches aiSessionPayloadSchema's content cap
const OVERLAP = 200; // so a search hit near a split boundary isn't lost

/**
 * Split one turn into one or more chunks, each within the payload's size
 * cap. Most turns are a single chunk; only unusually long ones (a big
 * pasted file, a long diff) split further, with a small overlap so context
 * isn't cleanly severed at the boundary.
 *
 * `turnIndex` is assigned by the caller (see watcher.ts) — a persistent
 * per-session counter, not something the parser or chunker can derive on
 * their own from a single incremental batch.
 */
export function chunkTurn(turn: RawTurn, turnIndex: number): Array<Omit<AiSessionPayload, 'tool'>> {
  const text = turn.content;
  if (text.length <= MAX_CHARS) {
    return [
      {
        sessionId: turn.sessionId,
        turnIndex,
        chunkIndex: 0,
        chunkCount: 1,
        role: turn.role,
        content: text,
        project: turn.project,
        cwd: turn.cwd,
      },
    ];
  }

  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + MAX_CHARS, text.length);
    pieces.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - OVERLAP;
  }

  return pieces.map((content, chunkIndex) => ({
    sessionId: turn.sessionId,
    turnIndex,
    chunkIndex,
    chunkCount: pieces.length,
    role: turn.role,
    content,
    project: turn.project,
    cwd: turn.cwd,
  }));
}
