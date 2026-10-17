import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionParser, RawTurn } from './types.js';

/**
 * Gemini CLI session logs: ~/.gemini/chats/*.jsonl.
 *
 * UNVERIFIED against real local data — same caveat as codexCli.ts, this
 * machine has no Gemini CLI chat files to check against. Built from the
 * actual upstream type definitions though (stronger footing than Codex
 * CLI's parser): packages/core/src/services/chatRecordingTypes.ts in
 * google-gemini/gemini-cli — `MessageRecord`'s `type` field discriminates
 * 'user' | 'gemini' | 'info' | 'error' | 'warning', and `content` is a
 * PartListUnion (either a plain string or an array of Google GenAI `Part`
 * objects, most of which carry a `.text` field). Assumed here that each
 * JSONL line is one streamed MessageRecord — matches the "stream-based
 * approach, appending JSON records to a .jsonl file" description found in
 * project docs, though this hasn't been confirmed against a real file.
 */

type GenAiPart = { text?: string } | string;

interface GeminiLine {
  type?: string;
  content?: GenAiPart | GenAiPart[];
  sessionId?: string;
  projectHash?: string;
}

function extractText(content: GenAiPart | GenAiPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

export const geminiCliParser: SessionParser = {
  tool: 'gemini-cli',

  rootDirs() {
    return [join(homedir(), '.gemini', 'chats')];
  },

  matches(filePath: string) {
    return filePath.endsWith('.jsonl');
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

      let obj: GeminiLine;
      try {
        obj = JSON.parse(trimmed) as GeminiLine;
      } catch {
        continue;
      }

      const mappedRole = obj.type === 'gemini' ? 'assistant' : obj.type === 'user' ? 'user' : null;
      if (!mappedRole) continue; // skip info/error/warning records

      const text = extractText(obj.content).trim();
      if (!text) continue;

      turns.push({ sessionId: obj.sessionId || sessionId, role: mappedRole, content: text });
    }

    return { turns, endByte: st.size };
  },
};
