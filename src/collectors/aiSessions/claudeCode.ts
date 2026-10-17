import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionParser, RawTurn } from './types.js';

/**
 * Claude Code session logs: ~/.claude/projects/<project>/<session>.jsonl,
 * one JSON object per line. Format verified directly against real local
 * session files this session (not just documentation) — see the line
 * shapes below.
 *
 * Relevant line shapes seen in practice:
 *   {"type":"user","message":{"role":"user","content":"..."},"cwd":"...",
 *    "sessionId":"...","isSidechain":false,...}
 *   {"type":"assistant","message":{"role":"assistant","content":[
 *      {"type":"text","text":"..."},{"type":"thinking","thinking":"..."},
 *      {"type":"tool_use",...},{"type":"tool_result",...}]},...}
 * Plus many non-conversation line types (custom-title, ai-title, mode,
 * queue-operation, system, attachment, last-prompt, ...) which are
 * intentionally ignored — only "user"/"assistant" lines carry a turn.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  content?: unknown;
}

interface ClaudeLine {
  type?: string;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    // Deliberately text + tool_result only for v1 — "thinking" is internal
    // reasoning, not something said, and raw tool_use params are often huge
    // and low-signal on their own. See Phase 1 plan notes.
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_result') {
      const c = block.content;
      if (typeof c === 'string') parts.push(c);
      else if (Array.isArray(c)) {
        for (const inner of c) {
          if (inner && typeof inner === 'object' && typeof (inner as ContentBlock).text === 'string') {
            parts.push((inner as ContentBlock).text!);
          }
        }
      }
    }
  }
  return parts.join('\n\n');
}

export const claudeCodeParser: SessionParser = {
  tool: 'claude-code',

  rootDirs() {
    return [join(homedir(), '.claude', 'projects')];
  },

  matches(filePath: string) {
    return filePath.endsWith('.jsonl');
  },

  async parseIncremental(filePath: string, fromByte: number) {
    const st = await stat(filePath);
    // File got shorter than our cursor — rotated/truncated, start over
    // rather than seeking past the end.
    const start = st.size < fromByte ? 0 : fromByte;
    if (st.size <= start) return { turns: [], endByte: st.size };

    const handle = await open(filePath, 'r');
    let raw: string;
    try {
      const length = st.size - start;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      raw = buf.toString('utf8');
    } finally {
      await handle.close();
    }

    const turns: RawTurn[] = [];
    const sessionIdFromFile = basename(filePath, '.jsonl');

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: ClaudeLine;
      try {
        obj = JSON.parse(trimmed) as ClaudeLine;
      } catch {
        continue; // a partially-written last line, or a genuinely malformed one — skip, don't crash
      }

      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      if (obj.isSidechain) continue; // sub-agent/background chatter, not the main thread

      const text = extractText(obj.message?.content).trim();
      if (!text) continue;

      const role = obj.message?.role === 'assistant' ? 'assistant' : 'user';
      const cwd = obj.cwd;

      turns.push({
        sessionId: obj.sessionId || sessionIdFromFile,
        role,
        content: text,
        project: cwd ? basename(cwd) : undefined,
        cwd,
      });
    }

    return { turns, endByte: st.size };
  },
};
