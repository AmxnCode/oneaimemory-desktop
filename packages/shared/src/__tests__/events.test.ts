import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  consciousnessEventSchema, encryptedEnvelopeSchema, syncRequestSchema, EVENT_TYPES,
} from '../events.js';
import { generateSalt, deriveKey, encryptEvent, decryptEvent } from '../crypto.js';

const base = {
  eventUuid: randomUUID(),
  deviceId: 'device-1',
  timestamp: new Date().toISOString(),
};

describe('consciousnessEventSchema', () => {
  it('accepts each event type with its payload', () => {
    const samples = [
      { type: 'browsing', payload: { url: 'https://a.com', domain: 'a.com', browser: 'Chrome' } },
      { type: 'search', payload: { query: 'q', engine: 'google' } },
      { type: 'youtube', payload: { title: 't', url: 'https://youtu.be/x' } },
      { type: 'file', payload: { name: 'a.txt', path: '/a.txt' } },
      { type: 'app', payload: { name: 'Safari' } },
      { type: 'code', payload: { editor: 'vscode' } },
      {
        type: 'ai_session',
        payload: {
          tool: 'claude-code', sessionId: 's-1', turnIndex: 0, chunkIndex: 0, chunkCount: 1,
          role: 'user', content: 'help me fix this bug',
        },
      },
    ];
    for (const s of samples) {
      expect(consciousnessEventSchema.safeParse({ ...base, ...s }).success).toBe(true);
    }
    expect(samples.map((s) => s.type).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('rejects an unknown event type', () => {
    expect(consciousnessEventSchema.safeParse({ ...base, type: 'keylog', payload: {} }).success)
      .toBe(false);
  });

  it('rejects a payload that does not match its type', () => {
    // search requires `query`; a browsing payload must not pass as search
    expect(consciousnessEventSchema.safeParse({
      ...base, type: 'search', payload: { url: 'https://a.com', domain: 'a.com', browser: 'C' },
    }).success).toBe(false);
  });

  it('requires a uuid event id and an offset-bearing timestamp', () => {
    expect(consciousnessEventSchema.safeParse({
      ...base, eventUuid: 'not-a-uuid', type: 'app', payload: { name: 'X' },
    }).success).toBe(false);

    expect(consciousnessEventSchema.safeParse({
      ...base, timestamp: '2026-01-01 10:00', type: 'app', payload: { name: 'X' },
    }).success).toBe(false);
  });

  it('caps oversized untrusted text', () => {
    expect(consciousnessEventSchema.safeParse({
      ...base, type: 'search', payload: { query: 'x'.repeat(3000), engine: 'google' },
    }).success).toBe(false);
  });

  it('caps an ai_session chunk at 4000 chars, wider than the 2048 untrustedText cap', () => {
    const payload = (content: string) => ({
      tool: 'claude-code', sessionId: 's-1', turnIndex: 0, chunkIndex: 0, chunkCount: 1,
      role: 'assistant', content,
    });
    // Longer than untrustedText's 2048 cap, but under ai_session's own 4000 — must pass.
    expect(consciousnessEventSchema.safeParse({
      ...base, type: 'ai_session', payload: payload('x'.repeat(3000)),
    }).success).toBe(true);
    // Over ai_session's own cap — must fail.
    expect(consciousnessEventSchema.safeParse({
      ...base, type: 'ai_session', payload: payload('x'.repeat(4001)),
    }).success).toBe(false);
  });

  it('defaults the file action', () => {
    const parsed = consciousnessEventSchema.parse({
      ...base, type: 'file', payload: { name: 'a.txt', path: '/a.txt' },
    });
    expect((parsed.payload as { action: string }).action).toBe('opened');
  });
});

describe('encryptedEnvelopeSchema', () => {
  const envelope = {
    ...base, type: 'browsing', ciphertext: 'AAAA', iv: 'BBBB', authTag: 'CCCC',
  };

  it('accepts a well-formed envelope', () => {
    expect(encryptedEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('rejects a missing auth tag', () => {
    const { authTag, ...rest } = envelope;
    void authTag;
    expect(encryptedEnvelopeSchema.safeParse(rest).success).toBe(false);
  });
});

describe('ai_session encrypt/decrypt round-trip', () => {
  it('survives a full encrypt -> decrypt cycle with a real key, including a chunk near the size cap', () => {
    const key = deriveKey('a passphrase, not the account password', generateSalt());
    const event = {
      ...base,
      type: 'ai_session' as const,
      payload: {
        tool: 'codex-cli' as const,
        sessionId: 's-42',
        turnIndex: 3,
        chunkIndex: 0,
        chunkCount: 1,
        role: 'assistant' as const,
        content: 'diff --git a/x.ts b/x.ts\n' + 'y'.repeat(3900),
        project: 'onecon',
        cwd: '/Users/dev/onecon',
      },
    };
    const envelope = encryptEvent(event, key);
    expect(envelope.type).toBe('ai_session');
    const decrypted = decryptEvent(envelope, key);
    expect(decrypted.payload).toEqual(event.payload);
  });
});

describe('syncRequestSchema', () => {
  const envelope = { ...base, type: 'app', ciphertext: 'A', iv: 'B', authTag: 'C' };

  it('accepts a batch', () => {
    expect(syncRequestSchema.safeParse({ events: [envelope] }).success).toBe(true);
  });

  it('caps batch size at 500 so a client cannot force an unbounded insert', () => {
    const big = Array.from({ length: 501 }, () => ({ ...envelope, eventUuid: randomUUID() }));
    expect(syncRequestSchema.safeParse({ events: big }).success).toBe(false);
  });
});
