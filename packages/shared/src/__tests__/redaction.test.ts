import { describe, it, expect } from 'vitest';
import { redactEvent, scrubText, scrubUrl, __redactionTesting } from '../redaction.js';

const { luhnValid } = __redactionTesting;

describe('luhn validation', () => {
  it('accepts real card numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('5500 0000 0000 0004')).toBe(true);
  });
  it('rejects non-card digit runs', () => {
    expect(luhnValid('1234567890123456')).toBe(false);
    expect(luhnValid('1234567890123456789')).toBe(false);
  });
});

describe('scrubText', () => {
  it.each([
    ['github token', 'token ghp_abcdefghij1234567890abcd here'],
    ['aws key', 'AKIAIOSFODNN7EXAMPLE'],
    ['slack token', 'xoxb-1234567890-abcdefghij'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk'],
    ['ssn', 'ssn 123-45-6789'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['email', 'contact me at person@example.com'],
  ])('masks %s', (_label, input) => {
    expect(scrubText(input)).toContain('[redacted]');
  });

  it('masks a valid credit card but leaves an invalid digit run alone', () => {
    expect(scrubText('pay 4111 1111 1111 1111 now')).toBe('pay [redacted] now');
    expect(scrubText('order 1234567890123456789')).toBe('order 1234567890123456789');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'How do I use TypeScript generics with React hooks?';
    expect(scrubText(text)).toBe(text);
  });

  it('reports what it masked', () => {
    const reasons: string[] = [];
    scrubText('key ghp_abcdefghij1234567890abcd', reasons);
    expect(reasons).toContain('github_token');
  });
});

describe('scrubUrl', () => {
  it('masks sensitive query parameters', () => {
    const out = scrubUrl('https://x.com/cb?access_token=abc123&q=hello');
    expect(out).not.toContain('abc123');
    expect(out).toContain('q=hello');
  });

  it('drops OAuth tokens from the fragment', () => {
    expect(scrubUrl('https://x.com/#id_token=secret123')).not.toContain('secret123');
  });

  it('strips userinfo credentials', () => {
    const out = scrubUrl('https://user:hunter2@example.com/path');
    expect(out).not.toContain('hunter2');
  });

  it('preserves harmless URLs exactly', () => {
    const url = 'https://react.dev/learn/state';
    expect(scrubUrl(url)).toBe(url);
  });

  it('falls back to text scrubbing for non-URLs', () => {
    expect(scrubUrl('not a url ghp_abcdefghij1234567890abcd')).toContain('[redacted]');
  });
});

describe('redactEvent — drops', () => {
  it('drops blocked-category domains', () => {
    const r = redactEvent({
      type: 'browsing',
      payload: { url: 'https://chase.com/accounts', domain: 'chase.com' },
    });
    expect(r.decision.action).toBe('drop');
    expect(r.decision.reasons[0]).toContain('chase.com');
  });

  it('drops subdomains of blocked domains', () => {
    expect(redactEvent({
      type: 'browsing',
      payload: { url: 'https://secure.chase.com/x', domain: 'secure.chase.com' },
    }).decision.action).toBe('drop');
  });

  it('does not drop domains that merely end with similar text', () => {
    expect(redactEvent({
      type: 'browsing',
      payload: { url: 'https://notchase.com/x', domain: 'notchase.com' },
    }).decision.action).toBe('keep');
  });

  it.each([
    'https://site.com/login',
    'https://site.com/sign-in?next=/',
    'https://site.com/oauth/authorize',
    'https://shop.com/checkout',
    'https://site.com/password/reset',
  ])('drops auth/checkout URL %s', (url) => {
    expect(redactEvent({ type: 'browsing', payload: { url, domain: 'site.com' } })
      .decision.action).toBe('drop');
  });

  it('drops user-blocked domains and query terms', () => {
    expect(redactEvent(
      { type: 'browsing', payload: { url: 'https://reddit.com/x', domain: 'reddit.com' } },
      { domains: ['reddit.com'] },
    ).decision.action).toBe('drop');

    expect(redactEvent(
      { type: 'search', payload: { query: 'My Medical Symptom', engine: 'google' } },
      { queryTerms: ['medical'] },
    ).decision.action).toBe('drop');
  });

  it('drops key material paths', () => {
    expect(redactEvent({ type: 'file', payload: { name: 'id_rsa', path: '/Users/x/.ssh/id_rsa' } })
      .decision.action).toBe('drop');
    expect(redactEvent({ type: 'file', payload: { name: 'c.pem', path: '/tmp/c.pem' } })
      .decision.action).toBe('drop');
  });
});

describe('redactEvent — keeps and masks', () => {
  it('keeps ordinary browsing and does not mutate the input', () => {
    const event = {
      type: 'browsing',
      payload: { url: 'https://react.dev/learn', title: 'Learn', domain: 'react.dev' },
    };
    const snapshot = JSON.stringify(event);
    const r = redactEvent(event);
    expect(r.decision.action).toBe('keep');
    expect(JSON.stringify(event)).toBe(snapshot);
  });

  it('masks secrets inside a kept search query', () => {
    const r = redactEvent({
      type: 'search',
      payload: { query: 'why is ghp_abcdefghij1234567890abcd invalid', engine: 'google' },
    });
    expect(r.decision.action).toBe('keep');
    expect(r.event!.payload.query).toContain('[redacted]');
  });

  it('masks secrets in titles', () => {
    const r = redactEvent({
      type: 'browsing',
      payload: { url: 'https://ok.com/', title: 'ssn 123-45-6789', domain: 'ok.com' },
    });
    expect(r.event!.payload.title).toContain('[redacted]');
  });

  it('masks an unlabeled password in ai_session content via the high-entropy pass', () => {
    // A real-world shape: a secret typed inline with no recognizable prefix
    // (no "api-"/"key-"/etc.), so VALUE_PATTERNS' api_key rule would miss it —
    // this is exactly the gap scrubHighEntropyTokens exists to close.
    const r = redactEvent({
      type: 'ai_session',
      payload: {
        tool: 'claude-code', sessionId: 's-1', turnIndex: 0, chunkIndex: 0, chunkCount: 1,
        role: 'user', content: 'UHqBiz74xPEBR6em done here is pass',
      },
    });
    expect(r.decision.action).toBe('keep');
    expect(r.event!.payload.content).not.toContain('UHqBiz74xPEBR6em');
    expect(r.event!.payload.content).toContain('[redacted]');
  });

  it('does not over-redact ordinary prose in ai_session content', () => {
    const r = redactEvent({
      type: 'ai_session',
      payload: {
        tool: 'claude-code', sessionId: 's-1', turnIndex: 0, chunkIndex: 0, chunkCount: 1,
        role: 'assistant', content: 'Sure, I can help you fix that bug in the checkout flow.',
      },
    });
    expect(r.event!.payload.content).not.toContain('[redacted]');
  });
});
