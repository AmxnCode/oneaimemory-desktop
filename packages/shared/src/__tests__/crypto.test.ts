import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  deriveKey, generateSalt, keyFingerprint, encryptEvent, decryptEvent, DecryptionError,
} from '../crypto.js';
import type { ConsciousnessEvent } from '../events.js';

const PASS = 'correct horse battery staple';

function sampleEvent(overrides: Partial<ConsciousnessEvent> = {}): ConsciousnessEvent {
  return {
    eventUuid: randomUUID(),
    deviceId: 'device-1',
    timestamp: new Date().toISOString(),
    type: 'browsing',
    payload: {
      url: 'https://example.com/page?a=1',
      title: 'Example',
      domain: 'example.com',
      browser: 'Chrome',
    },
    ...overrides,
  } as ConsciousnessEvent;
}

describe('key derivation', () => {
  it('is deterministic for the same passphrase and salt', () => {
    const salt = generateSalt();
    expect(deriveKey(PASS, salt).toString('base64')).toBe(deriveKey(PASS, salt).toString('base64'));
  });

  it('differs across salts', () => {
    expect(deriveKey(PASS, generateSalt()).toString('base64'))
      .not.toBe(deriveKey(PASS, generateSalt()).toString('base64'));
  });

  it('normalizes unicode so equivalent passphrases produce the same key', () => {
    const salt = generateSalt();
    // café as precomposed vs decomposed
    const a = deriveKey('café', salt);
    const b = deriveKey('café', salt);
    expect(a.toString('base64')).toBe(b.toString('base64'));
  });

  it('produces a 256-bit key', () => {
    expect(deriveKey(PASS, generateSalt()).length).toBe(32);
  });
});

describe('key fingerprint', () => {
  it('matches for identical keys and differs otherwise', () => {
    const salt = generateSalt();
    expect(keyFingerprint(deriveKey(PASS, salt))).toBe(keyFingerprint(deriveKey(PASS, salt)));
    expect(keyFingerprint(deriveKey(PASS, salt))).not.toBe(keyFingerprint(deriveKey('other', salt)));
  });

  it('does not leak the key', () => {
    const key = deriveKey(PASS, generateSalt());
    expect(keyFingerprint(key)).not.toContain(key.toString('base64').slice(0, 10));
  });
});

describe('event encryption', () => {
  it('round-trips a payload', () => {
    const salt = generateSalt();
    const key = deriveKey(PASS, salt);
    const event = sampleEvent();
    const decrypted = decryptEvent(encryptEvent(event, key), key);
    expect(decrypted.payload).toEqual(event.payload);
    expect(decrypted.eventUuid).toBe(event.eventUuid);
  });

  it('leaves no plaintext in the ciphertext', () => {
    const key = deriveKey(PASS, generateSalt());
    const envelope = encryptEvent(sampleEvent(), key);
    const blob = JSON.stringify(envelope);
    expect(blob).not.toContain('example.com');
    expect(blob).not.toContain('Example');
  });

  it('produces a distinct IV per encryption', () => {
    const key = deriveKey(PASS, generateSalt());
    const event = sampleEvent();
    expect(encryptEvent(event, key).iv).not.toBe(encryptEvent(event, key).iv);
  });

  it('rejects the wrong key', () => {
    const salt = generateSalt();
    const envelope = encryptEvent(sampleEvent(), deriveKey(PASS, salt));
    expect(() => decryptEvent(envelope, deriveKey('wrong passphrase', salt)))
      .toThrow(DecryptionError);
  });

  // The cleartext metadata is bound as AAD specifically so the server cannot
  // relabel an event without breaking decryption.
  it.each(['timestamp', 'type', 'deviceId', 'eventUuid'] as const)(
    'rejects a tampered %s',
    (field) => {
      const key = deriveKey(PASS, generateSalt());
      const envelope = encryptEvent(sampleEvent(), key);
      const tampered = {
        ...envelope,
        [field]: field === 'timestamp' ? new Date(0).toISOString()
          : field === 'type' ? 'search'
          : 'tampered-value',
      };
      expect(() => decryptEvent(tampered as typeof envelope, key)).toThrow(DecryptionError);
    },
  );

  it('rejects a tampered ciphertext', () => {
    const key = deriveKey(PASS, generateSalt());
    const envelope = encryptEvent(sampleEvent(), key);
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    expect(() => decryptEvent({ ...envelope, ciphertext: bytes.toString('base64') }, key))
      .toThrow(DecryptionError);
  });

  it('rejects a tampered auth tag', () => {
    const key = deriveKey(PASS, generateSalt());
    const envelope = encryptEvent(sampleEvent(), key);
    const tag = Buffer.from(envelope.authTag, 'base64');
    tag[0] ^= 0xff;
    expect(() => decryptEvent({ ...envelope, authTag: tag.toString('base64') }, key))
      .toThrow(DecryptionError);
  });

  it('preserves cleartext metadata for server-side indexing', () => {
    const key = deriveKey(PASS, generateSalt());
    const event = sampleEvent({ type: 'search', payload: { query: 'secret', engine: 'google' } } as never);
    const envelope = encryptEvent(event, key);
    expect(envelope.type).toBe('search');
    expect(envelope.timestamp).toBe(event.timestamp);
    expect(envelope.deviceId).toBe(event.deviceId);
  });
});
