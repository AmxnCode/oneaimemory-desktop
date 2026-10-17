import type { EncryptedEnvelope } from '@oneconscious/shared';
import type { Session, Store } from './store.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export interface LoginResult {
  userId: number;
  email: string;
  dataKeySalt: string;
  keyFingerprint?: string | null;
  accessToken: string;
  refreshToken: string;
}

export class ApiClient {
  constructor(private store: Store) {}

  /**
   * Serializes concurrent token refreshes. The backend rotates (single-use)
   * refresh tokens, so two requests that hit 401 at the same moment must not
   * each call /refresh with the same stale token — the loser would burn/revoke
   * it and strand the session offline until a fresh login. Sharing one
   * in-flight refresh keeps every concurrent caller on the same rotated token.
   */
  private refreshInFlight: Promise<Session | null> | null = null;

  private async refreshOnce(session: Session): Promise<Session | null> {
    try {
      const res = await fetch(session.apiUrl + '/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (!res.ok) return null;
      const tokens = (await res.json()) as { accessToken: string; refreshToken: string };
      const next: Session = { ...session, ...tokens };
      this.store.saveSession(next);
      return next;
    } catch {
      return null;
    }
  }

  /** Returns a session with a fresh access token, deduplicating refetch. */
  private async refresh(session: Session): Promise<Session | null> {
    // If another request is already refreshing right now, join it instead of
    // issuing a second /refresh with the same (about-to-be-rotated) token.
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.refreshOnce(session).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private get baseUrl(): string {
    return this.store.getSession()?.apiUrl ?? this.store.getSettings().apiUrl;
  }

  private async request<T>(
    path: string,
    opts: { method?: string; body?: unknown; auth?: boolean; baseUrl?: string } = {},
  ): Promise<T> {
    const base = opts.baseUrl ?? this.baseUrl;
    const send = async (token?: string): Promise<Response> =>
      fetch(base + path, {
        method: opts.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });

    let session = opts.auth ? this.store.getSession() : null;
    if (opts.auth && !session) throw new ApiError(401, 'not_signed_in');

    let res = await send(session?.accessToken);

    // Access tokens are short-lived by design; refresh once and retry.
    if (res.status === 401 && opts.auth && session) {
      const refreshed = await this.refresh(session);
      if (!refreshed) throw new ApiError(401, 'session_expired', 'Please sign in again.');
      res = await send(refreshed.accessToken);
    }

    const rawText = await res.text().catch(() => '(unreadable)');
    let data: Record<string, unknown>;
    try {
      data = rawText === '(unreadable)' ? {} : (JSON.parse(rawText) as Record<string, unknown>);
    } catch {
      data = {};
    }

    if (!res.ok) {
      if (!data.error) {
        // No parseable error body (gateway/502/HTML/etc.) — capture the real
        // status + raw body so an opaque "request_failed" is diagnosable.
        console.error(`[api] ${opts.method ?? 'GET'} ${base}${path} -> HTTP ${res.status} (no JSON error; body head: ${rawText.slice(0, 200)})`);
      }
      // Zod's flattened field errors (the errorHandler's 400 shape) carry the
      // actual reason validation_failed happened — surfacing them here means
      // "Last sync failed: ..." in the UI is diagnostic instead of a dead end.
      const detail = (data.message as string) ?? (data.details ? JSON.stringify(data.details) : undefined);
      throw new ApiError(res.status, (data.error as string) ?? 'request_failed', detail);
    }
    return data as T;
  }

  async register(apiUrl: string, email: string, password: string, deviceId: string): Promise<LoginResult> {
    return this.request<LoginResult>('/api/auth/register', {
      method: 'POST',
      body: { email, password, deviceId },
      baseUrl: apiUrl,
    });
  }

  async login(apiUrl: string, email: string, password: string, deviceId: string): Promise<LoginResult> {
    return this.request<LoginResult>('/api/auth/login', {
      method: 'POST',
      body: { email, password, deviceId },
      baseUrl: apiUrl,
    });
  }

  async submitKeyFingerprint(fingerprint: string): Promise<void> {
    await this.request('/api/auth/key-fingerprint', {
      method: 'POST',
      body: { fingerprint },
      auth: true,
    });
  }

  async registerDevice(params: {
    deviceId: string;
    deviceName: string;
    deviceType: string;
    osVersion?: string;
    appVersion?: string;
  }): Promise<void> {
    await this.request('/api/sync/devices/register', { method: 'POST', body: params, auth: true });
  }

  async syncEvents(events: EncryptedEnvelope[]): Promise<{ inserted: number; duplicates: number; paused?: boolean }> {
    return this.request('/api/sync/events', { method: 'POST', body: { events }, auth: true });
  }

  /** Encrypted history for this user. Decryption happens in the main process. */
  async getHistory(params: { limit?: number; types?: string[]; cursor?: string } = {}): Promise<{
    events: EncryptedEnvelope[];
    nextCursor: string | null;
  }> {
    const q = new URLSearchParams({ limit: String(params.limit ?? 100) });
    if (params.types?.length) q.set('types', params.types.join(','));
    if (params.cursor) q.set('cursor', params.cursor);
    return this.request(`/api/sync/events?${q}`, { auth: true });
  }

  async deleteEvents(eventUuids: string[]): Promise<{ deleted: number }> {
    return this.request('/api/account/events', {
      method: 'DELETE',
      body: { eventUuids },
      auth: true,
    });
  }

  async status(): Promise<{
    totalEvents: number;
    breakdown: Record<string, number>;
    devices: Array<{ deviceId: string; deviceName: string; lastSync: string | null }>;
  }> {
    return this.request('/api/sync/status', { auth: true });
  }

  async createIntegration(label: string, scopes: string[]): Promise<{ id: number; token: string; scopes: string[] }> {
    return this.request('/api/account/integrations', {
      method: 'POST',
      body: { label, scopes },
      auth: true,
    });
  }

  async listIntegrations(): Promise<{ integrations: Array<{ id: number; label: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> }> {
    return this.request('/api/account/integrations', { auth: true });
  }

  async revokeIntegration(id: number): Promise<void> {
    await this.request(`/api/account/integrations/${id}`, { method: 'DELETE', auth: true });
  }

  async getAudit(limit = 50): Promise<{ entries: Array<Record<string, unknown>> }> {
    return this.request(`/api/account/audit?limit=${limit}`, { auth: true });
  }

  /**
   * Sends a copy of the (already-derived) data key to the server so remote AI
   * tools like ChatGPT can decrypt on the user's behalf — a deliberate,
   * explicit weakening of E2E for this account only. See main.ts's
   * 'enable-remote-access' handler for the confirmation dialog this sits
   * behind. Local MCP tools never call this and are unaffected either way.
   */
  async enableRemoteAccess(dataKeyBase64: string): Promise<{ enabled: true; enabledAt: string | null }> {
    return this.request('/api/account/remote-access/enable', {
      method: 'POST',
      body: { dataKey: dataKeyBase64 },
      auth: true,
    });
  }

  async disableRemoteAccess(): Promise<void> {
    await this.request('/api/account/remote-access/disable', { method: 'POST', auth: true });
  }

  async getRemoteAccessStatus(): Promise<{ enabled: boolean; enabledAt: string | null }> {
    return this.request('/api/account/remote-access/status', { auth: true });
  }
}
