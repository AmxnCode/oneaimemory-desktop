/**
 * Collection-time redaction.
 *
 * This runs ON DEVICE, before an event is written to the local queue — never
 * server-side. If it ran on the server the sensitive data would already have
 * transited and landed, which defeats the purpose. The server copy of user
 * blocklists (see `blocked_patterns`) exists only to sync rules across devices;
 * this module is the enforcement point.
 *
 * Two outcomes:
 *   - DROP:   the event is discarded entirely and never leaves the device.
 *   - REDACT: the event is kept with offending substrings masked.
 */

export type RedactionDecision =
  | { action: 'drop'; reasons: string[] }
  | { action: 'keep'; reasons: string[] };

export interface UserBlocklist {
  /** Hostnames (and their subdomains) to never collect. */
  domains?: string[];
  /** Substrings that, if present in a search query, drop the event. */
  queryTerms?: string[];
  /** Path prefixes to never collect file events for. */
  pathPrefixes?: string[];
}

const MASK = '[redacted]';

/** Patterns whose presence means the value is masked, not dropped. */
const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Long random tokens: API keys, bearer tokens, session ids.
  { name: 'api_key', re: /\b(?:sk|pk|rk|api|key|token|secret)[-_][A-Za-z0-9_-]{16,}\b/gi },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // 13–19 digit runs, Luhn-checked below before masking. Trailing digit is
  // matched separately so the group cannot swallow the following separator.
  { name: 'credit_card', re: /\b(?:\d[ -]?){12,18}\d\b/g },
];

/**
 * Catches likely secrets that don't carry a labeled prefix (`VALUE_PATTERNS`
 * above needs "api-", "key-", etc. to fire). That gap matters far more for
 * free-form AI conversation content than for the app's other fields: a
 * password or token in casual text is often just typed inline ("here's the
 * pass: X", "X — use that for the DB") with no recognizable label at all.
 *
 * Deliberately over-inclusive — a false-positive redaction just masks a
 * harmless-looking word; a false negative leaks a real credential into
 * every AI tool that reads this content. Only applied to `content` (see
 * `redactEvent` below), not the lighter-weight fields like `title`/`name`,
 * where it would over-redact ordinary short identifiers.
 */
const HIGH_ENTROPY_TOKEN_RE = /\b[A-Za-z0-9]{16,64}\b/g;

export function scrubHighEntropyTokens(input: string, reasons: string[] = []): string {
  return input.replace(HIGH_ENTROPY_TOKEN_RE, (token) => {
    const hasDigit = /[0-9]/.test(token);
    const hasAlpha = /[A-Za-z]/.test(token);
    // Pure-digit or pure-letter runs are far more likely to be a normal word,
    // phone number, or ID than a generated secret — leave them alone.
    if (!hasDigit || !hasAlpha) return token;
    if (!reasons.includes('high_entropy_token')) reasons.push('high_entropy_token');
    return MASK;
  });
}

/** URL query/fragment params that carry credentials. Value is always masked. */
const SENSITIVE_PARAMS = new Set([
  'password', 'passwd', 'pwd', 'pass',
  'token', 'access_token', 'refresh_token', 'id_token', 'auth', 'authorization',
  'api_key', 'apikey', 'key', 'secret', 'client_secret',
  'session', 'sessionid', 'sid', 'code', 'state', 'otp', 'mfa', '2fa',
  'signature', 'sig', 'credential',
]);

/**
 * URL path segments that indicate an authentication flow. These pages routinely
 * carry credentials in the URL, so the whole event is dropped.
 */
const AUTH_PATH_RE = /\/(?:login|signin|sign-in|signup|sign-up|auth|oauth|sso|password|reset|verify|checkout|payment|billing)(?:\/|$|\?)/i;

/**
 * Categories dropped wholesale by default. This is a starting list, not a
 * complete one — users extend it via their blocklist. Health and finance are
 * default-on because they are the two categories most likely to cause concrete
 * harm if leaked into an AI context window.
 */
const DEFAULT_BLOCKED_DOMAIN_SUFFIXES = [
  // Finance
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'paypal.com', 'stripe.com',
  'coinbase.com', 'hdfcbank.com', 'icicibank.com', 'sbi.co.in',
  // Health
  'mychart.com', 'healthcare.gov', 'webmd.com', 'nih.gov', 'plannedparenthood.org',
  // Credential managers
  '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com',
];

function luhnValid(digits: string): boolean {
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hostMatches(host: string, suffix: string): boolean {
  const h = host.toLowerCase();
  const s = suffix.toLowerCase();
  return h === s || h.endsWith('.' + s);
}

/** Mask credential-bearing patterns in free text. Returns the cleaned text. */
export function scrubText(input: string, reasons: string[] = []): string {
  let out = input;
  for (const { name, re } of VALUE_PATTERNS) {
    out = out.replace(re, (match) => {
      if (name === 'credit_card' && !luhnValid(match)) return match;
      if (!reasons.includes(name)) reasons.push(name);
      return MASK;
    });
  }
  return out;
}

/**
 * Strip credentials from a URL: masks sensitive query params, drops the
 * fragment (implicit-flow tokens live there), and removes userinfo.
 */
export function scrubUrl(rawUrl: string, reasons: string[] = []): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return scrubText(rawUrl, reasons);
  }

  if (u.username || u.password) {
    u.username = '';
    u.password = '';
    if (!reasons.includes('url_userinfo')) reasons.push('url_userinfo');
  }

  for (const key of [...u.searchParams.keys()]) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
      u.searchParams.set(key, MASK);
      if (!reasons.includes('url_param:' + key.toLowerCase())) {
        reasons.push('url_param:' + key.toLowerCase());
      }
    }
  }

  // OAuth implicit flow returns tokens in the fragment. Never keep it.
  if (u.hash && /(?:access_token|id_token|token)=/i.test(u.hash)) {
    u.hash = '';
    if (!reasons.includes('url_fragment_token')) reasons.push('url_fragment_token');
  }

  return scrubText(u.toString(), reasons);
}

export interface RedactionResult<T> {
  decision: RedactionDecision;
  /** Present only when decision.action === 'keep'. */
  event?: T;
}

type AnyEvent = {
  type: string;
  payload: Record<string, unknown>;
  [k: string]: unknown;
};

/**
 * Apply redaction to a single event. Returns either a drop decision or a
 * cleaned copy of the event. The input is never mutated.
 */
export function redactEvent<T extends AnyEvent>(
  event: T,
  blocklist: UserBlocklist = {},
): RedactionResult<T> {
  const reasons: string[] = [];
  const payload: Record<string, unknown> = { ...event.payload };

  const blockedDomains = [...DEFAULT_BLOCKED_DOMAIN_SUFFIXES, ...(blocklist.domains ?? [])];

  // --- URL-bearing events -------------------------------------------------
  if (typeof payload.url === 'string') {
    let host = '';
    try {
      host = new URL(payload.url).hostname;
    } catch {
      /* non-URL string; fall through to text scrubbing */
    }

    if (host) {
      for (const suffix of blockedDomains) {
        if (hostMatches(host, suffix)) {
          return { decision: { action: 'drop', reasons: [`blocked_domain:${suffix}`] } };
        }
      }
    }

    if (AUTH_PATH_RE.test(payload.url)) {
      return { decision: { action: 'drop', reasons: ['auth_flow_url'] } };
    }

    payload.url = scrubUrl(payload.url, reasons);
  }

  if (typeof payload.domain === 'string') {
    for (const suffix of blockedDomains) {
      if (hostMatches(payload.domain, suffix)) {
        return { decision: { action: 'drop', reasons: [`blocked_domain:${suffix}`] } };
      }
    }
  }

  // --- Search queries -----------------------------------------------------
  if (typeof payload.query === 'string') {
    const q = payload.query.toLowerCase();
    for (const term of blocklist.queryTerms ?? []) {
      if (term && q.includes(term.toLowerCase())) {
        return { decision: { action: 'drop', reasons: [`blocked_query_term:${term}`] } };
      }
    }
    payload.query = scrubText(payload.query, reasons);
  }

  // --- File paths ---------------------------------------------------------
  if (typeof payload.path === 'string') {
    for (const prefix of blocklist.pathPrefixes ?? []) {
      if (prefix && payload.path.startsWith(prefix)) {
        return { decision: { action: 'drop', reasons: [`blocked_path:${prefix}`] } };
      }
    }
    // Dotfiles and key material are never worth collecting.
    if (/\/\.(?:ssh|gnupg|aws|kube|docker)\//.test(payload.path) || /\.(?:pem|key|p12|keychain)$/i.test(payload.path)) {
      return { decision: { action: 'drop', reasons: ['sensitive_file_path'] } };
    }
  }

  // AI session working directory — same blocklist as `path`: a user who has
  // blocked a project's path prefix almost certainly doesn't want that
  // project's AI conversations collected either.
  if (typeof payload.cwd === 'string') {
    for (const prefix of blocklist.pathPrefixes ?? []) {
      if (prefix && payload.cwd.startsWith(prefix)) {
        return { decision: { action: 'drop', reasons: [`blocked_path:${prefix}`] } };
      }
    }
  }

  // --- Free-text fields ---------------------------------------------------
  for (const field of ['title', 'name', 'channel', 'project', 'file', 'content', 'cwd'] as const) {
    if (typeof payload[field] === 'string') {
      payload[field] = scrubText(payload[field] as string, reasons);
    }
  }

  // AI session content also gets the high-entropy pass — see
  // scrubHighEntropyTokens' comment for why this field needs a wider net
  // than everywhere else.
  if (typeof payload.content === 'string') {
    payload.content = scrubHighEntropyTokens(payload.content, reasons);
  }

  return {
    decision: { action: 'keep', reasons },
    event: { ...event, payload } as T,
  };
}

export const __redactionTesting = { luhnValid, DEFAULT_BLOCKED_DOMAIN_SUFFIXES, AUTH_PATH_RE };
