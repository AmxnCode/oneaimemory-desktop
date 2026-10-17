import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import type { ConsciousnessEvent, EncryptedEnvelope } from './events.js';

/**
 * Client-side envelope encryption.
 *
 * The data key is derived on-device from the user's passphrase and NEVER sent
 * to the server. The server stores ciphertext plus the (non-secret) salt, and
 * cannot decrypt. This is the option-(B) architecture from docs/PRD-REVIEW.md:
 * true end-to-end, with the consequence that search and summarization run
 * locally in the MCP server rather than server-side.
 *
 * NOTE ON SCALING: local decrypt-then-search is fine for dev and for a single
 * user's working set. It does not scale to the "<100ms over 1-year history"
 * NFR without a local index. That tradeoff is deliberate and documented.
 */

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;

// scrypt cost parameters. N=2^15 keeps derivation near ~100ms on a modern
// laptop — slow enough to matter offline, fast enough to run at unlock.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export type DataKey = Buffer & { readonly __brand: 'DataKey' };

export function generateSalt(): string {
  return randomBytes(16).toString('base64');
}

/** Derive the AES key from a passphrase + the user's salt. */
export function deriveKey(passphrase: string, saltB64: string): DataKey {
  const salt = Buffer.from(saltB64, 'base64');
  const key = scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return key as DataKey;
}

/**
 * A non-reversible fingerprint of the key, safe to store server-side. Lets a
 * client detect "wrong passphrase" before it downloads and fails to decrypt a
 * few thousand events. Domain-separated so it can never collide with the key.
 */
export function keyFingerprint(key: DataKey): string {
  return createHash('sha256')
    .update('oneconscious:key-fingerprint:v1')
    .update(key)
    .digest('base64')
    .slice(0, 22);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Encrypt one event. `type`, `timestamp`, `deviceId` and `eventUuid` stay in
 * the clear so the server can index and range-scan; everything descriptive
 * lives inside the ciphertext.
 *
 * The cleartext metadata is bound in as AAD, so a tampered `timestamp` or
 * `type` on the server causes decryption to fail rather than silently
 * returning a mislabeled event.
 */
export function encryptEvent(event: ConsciousnessEvent, key: DataKey): EncryptedEnvelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);

  const aad = Buffer.from(`${event.eventUuid}|${event.type}|${event.timestamp}|${event.deviceId}`);
  cipher.setAAD(aad);

  const plaintext = Buffer.from(JSON.stringify(event.payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    eventUuid: event.eventUuid,
    deviceId: event.deviceId,
    type: event.type,
    timestamp: event.timestamp,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export class DecryptionError extends Error {
  constructor(public readonly eventUuid: string, cause?: unknown) {
    super(`Failed to decrypt event ${eventUuid}: wrong key or tampered data`);
    this.name = 'DecryptionError';
    this.cause = cause;
  }
}

export function decryptEvent(envelope: EncryptedEnvelope, key: DataKey): ConsciousnessEvent {
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(envelope.iv, 'base64'));
    const aad = Buffer.from(
      `${envelope.eventUuid}|${envelope.type}|${envelope.timestamp}|${envelope.deviceId}`,
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);

    return {
      eventUuid: envelope.eventUuid,
      deviceId: envelope.deviceId,
      type: envelope.type,
      timestamp: envelope.timestamp,
      payload: JSON.parse(plaintext.toString('utf8')),
    } as ConsciousnessEvent;
  } catch (err) {
    throw new DecryptionError(envelope.eventUuid, err);
  }
}
