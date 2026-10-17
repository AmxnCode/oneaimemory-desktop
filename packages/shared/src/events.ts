import { z } from 'zod';

/**
 * Event taxonomy. Kept deliberately small for the MVP — every type here has a
 * working collector. Types from the PRD without a collector yet (calendar,
 * email) are intentionally absent rather than defined-and-unimplemented.
 */
export const EVENT_TYPES = ['browsing', 'search', 'youtube', 'file', 'app', 'code', 'ai_session', 'ai_conversation'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const isoTimestamp = z.string().datetime({ offset: true });

/** Text that originated outside the user's control (page titles, URLs, queries). */
const untrustedText = z.string().max(2048);

/**
 * One turn of an AI coding session, already split into a bounded chunk by
 * the collector (see desktop/src/collectors/aiSessions/chunker.ts). Wider
 * than `untrustedText` because a single turn (a diff, a pasted file, a tool
 * result) routinely exceeds 2048 chars — sized so a sync batch of these
 * still stays comfortably under the backend's 8MB request body limit.
 */
const chunkText = z.string().max(4000);

export const browsingPayloadSchema = z.object({
  url: untrustedText,
  title: untrustedText.optional(),
  domain: z.string().max(255),
  browser: z.string().max(64),
});

export const searchPayloadSchema = z.object({
  query: untrustedText,
  engine: z.string().max(64),
  url: untrustedText.optional(),
});

export const youtubePayloadSchema = z.object({
  videoId: z.string().max(64).optional(),
  title: untrustedText,
  channel: untrustedText.optional(),
  url: untrustedText,
});

export const filePayloadSchema = z.object({
  name: z.string().max(512),
  path: z.string().max(2048),
  extension: z.string().max(32).optional(),
  action: z.enum(['opened', 'modified', 'created']).default('opened'),
});

export const appPayloadSchema = z.object({
  name: z.string().max(255),
  bundleId: z.string().max(255).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const codePayloadSchema = z.object({
  editor: z.string().max(64),
  file: z.string().max(2048).optional(),
  language: z.string().max(64).optional(),
  project: z.string().max(512).optional(),
});

/**
 * One chunk of one turn of a local AI coding session (Claude Code, Codex
 * CLI, Gemini CLI — see desktop/src/collectors/aiSessions/). `turnIndex`
 * orders chunks within a session; `chunkIndex`/`chunkCount` order sub-splits
 * within an oversized turn. `content` already passed through the same
 * secret-scrubbing pass as every other free-text field (see redaction.ts).
 */
export const aiSessionPayloadSchema = z.object({
  tool: z.enum(['claude-code', 'codex-cli', 'gemini-cli']),
  sessionId: z.string().max(255),
  turnIndex: z.number().int().nonnegative(),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: chunkText,
  project: z.string().max(512).optional(),
  cwd: z.string().max(2048).optional(),
});

/**
 * A captured conversation from a web-based AI (ChatGPT, Claude.ai, etc.).
 * Stores the full thread for cross-AI handoff — so you can start where you
 * left off on a different platform.
 */
export const aiConversationPayloadSchema = z.object({
  platform: z.enum(['chatgpt', 'claude', 'gemini', 'perplexity', 'other']),
  title: z.string().max(256),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(100),
  url: untrustedText.optional(),
  messageCount: z.number().int().positive().optional(),
});

export const eventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('browsing'), payload: browsingPayloadSchema }),
  z.object({ type: z.literal('search'), payload: searchPayloadSchema }),
  z.object({ type: z.literal('youtube'), payload: youtubePayloadSchema }),
  z.object({ type: z.literal('file'), payload: filePayloadSchema }),
  z.object({ type: z.literal('app'), payload: appPayloadSchema }),
  z.object({ type: z.literal('code'), payload: codePayloadSchema }),
  z.object({ type: z.literal('ai_session'), payload: aiSessionPayloadSchema }),
  z.object({ type: z.literal('ai_conversation'), payload: aiConversationPayloadSchema }),
]);

/**
 * A collected event before encryption. `eventUuid` is generated on-device and
 * is the idempotency key — resent batches collapse via ON CONFLICT DO NOTHING,
 * so sync retries cannot duplicate rows.
 */
export const consciousnessEventSchema = z
  .object({
    eventUuid: z.string().uuid(),
    deviceId: z.string().min(1).max(255),
    timestamp: isoTimestamp,
  })
  .and(eventPayloadSchema);

export type ConsciousnessEvent = z.infer<typeof consciousnessEventSchema>;
export type BrowsingPayload = z.infer<typeof browsingPayloadSchema>;
export type SearchPayload = z.infer<typeof searchPayloadSchema>;
export type AppPayload = z.infer<typeof appPayloadSchema>;
export type AiSessionPayload = z.infer<typeof aiSessionPayloadSchema>;
export type AiConversationPayload = z.infer<typeof aiConversationPayloadSchema>;

/**
 * Wire format. The server sees only `type`, `timestamp`, `deviceId` and an
 * opaque ciphertext blob — never the payload. Type and timestamp stay in the
 * clear so the server can index and range-scan without decrypting.
 */
export const encryptedEnvelopeSchema = z.object({
  eventUuid: z.string().uuid(),
  deviceId: z.string().min(1).max(255),
  type: z.enum(EVENT_TYPES),
  timestamp: isoTimestamp,
  ciphertext: z.string(), // base64
  iv: z.string(), // base64, 12 bytes
  authTag: z.string(), // base64, 16 bytes
});

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

export const syncRequestSchema = z.object({
  events: z.array(encryptedEnvelopeSchema).max(500),
});

export type SyncRequest = z.infer<typeof syncRequestSchema>;
