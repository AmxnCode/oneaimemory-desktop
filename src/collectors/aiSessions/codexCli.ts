import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionParser, RawTurn } from './types.js';

/**
 * Codex CLI session logs: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 *
 * UNVERIFIED against real local data — this machine has no Codex CLI
 * session files to check against (confirmed during Phase 1 investigation:
 * ~/.codex/sessions doesn't exist here, only telemetry/cache files at the
 * top level). Built from published reverse-engineering write-ups instead:
 * https://dev.to/milkoor/reverse-engineering-codex-cli-rollout-traces-3b9b
 * and https://asksurf.ai/pulse/en/codex-cli-stores-chat-history-locally —
 * both describe the format as undocumented and subject to change (unlike
 * Claude Code's, which has a documented, stable shape). Kept deliberately
 * loose/permissive in what it accepts, and — like every parser here — a
 * malformed or unexpected line is skipped, never thrown. Whoever hits this
 * with real Codex CLI data first should tighten it against reality.
 *
 * Believed shape, one JSON object per line:
 *   {"type":"response_item","payload":{"type":"message","role":"assistant",
 *     "content":[{"type":"output_text","text":"..."}]}}
 *   {"type":"response_item","payload":{"type":"message","role":"user"|"developer",
 *     "content":[{"type":"input_text","text":"..."}]}}
 * Also present but intentionally skipped: session_meta, event_msg,
 * turn_context, compacted, function_call/function_call_output records.
 */

interface ContentBlock {
  type?: string;
  text?: string;
}

interface CodexLine {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: ContentBlock[];
  };
}

function extractText(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && typeof b.text === 'string' && /text/i.test(b.type ?? ''))
    .map((b) => b.text)
    .join('\n\n');
}

export const codexCliParser: SessionParser = {
  tool: 'codex-cli',

  rootDirs() {
    return [join(homedir(), '.codex', 'sessions')];
  },

  matches(filePath: string) {
    return filePath.endsWith('.jsonl') && basename(filePath).startsWith('rollout-');
  },

  async parseIncremental(filePath: string, fromByte: number) {
    const st = await stat(filePath);
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
    const sessionId = basename(filePath, '.jsonl');

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: CodexLine;
      try {
        obj = JSON.parse(trimmed) as CodexLine;
      } catch {
        continue;
      }

      if (obj.type !== 'response_item' || obj.payload?.type !== 'message') continue;

      const role = obj.payload.role;
      const mappedRole = role === 'assistant' ? 'assistant' : role === 'user' || role === 'developer' ? 'user' : null;
      if (!mappedRole) continue;

      const text = extractText(obj.payload.content).trim();
      if (!text) continue;

      turns.push({ sessionId, role: mappedRole, content: text });
    }

    return { turns, endByte: st.size };
  },
};
