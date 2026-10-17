import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface Session {
  email: string;
  userId: number;
  apiUrl: string;
  dataKeySalt: string;
  accessToken: string;
  refreshToken: string;
  /**
   * The desktop app's own MCP integration token, persisted here because it is
   * unrecoverable otherwise: the server returns a bearer token exactly once,
   * at creation, and the list endpoint never echoes it back. Without storing
   * it ourselves, every relaunch would either fail to start the MCP server or
   * have to mint (and orphan) a fresh integration each time.
   */
  mcpToken?: string;
}

export interface Settings {
  deviceId: string;
  /**
   * One deviceId per account that has ever signed in on this Mac, keyed by
   * lowercased email. The server treats deviceId as globally unique, so
   * without this, a second account signing into the same install would
   * collide with the first account's device row (device_id_taken). Reused
   * across sign-outs/sign-ins so the same account keeps its sync history;
   * a fresh id is minted only the first time a new account appears here.
   */
  deviceIdsByEmail: Record<string, string>;
  deviceName: string;
  apiUrl: string;
  paused: boolean;
  syncIntervalMs: number;
  collectBrowsing: boolean;
  collectSearches: boolean;
  collectYoutube: boolean;
  collectApps: boolean;
  collectCode: boolean;
  /**
   * Off by default, unlike every other collect* flag above. This one reads
   * real AI conversation content (code, pasted files, whatever you actually
   * discussed) from local Claude Code / Codex CLI / Gemini CLI session
   * logs — meaningfully more sensitive than a URL or search term, so it
   * needs explicit opt-in rather than inheriting the app's normal defaults.
   */
  collectAiSessions: boolean;
  blockedDomains: string[];
  blockedQueryTerms: string[];
  /** Bearer token the browser extension uses against the local ingest server. */
  extensionToken: string;
  extensionEnabled: boolean;
  /**
   * Require Touch ID before the passphrase is read from the Keychain at launch.
   *
   * This is a PRESENCE check, not a cryptographic binding: the Keychain item
   * stays readable by any process running as you (that is what lets the MCP
   * server start without a UI). It stops someone walking up to an unlocked
   * Mac; it does not stop malware already running as you.
   */
  requireBiometric: boolean;
}

const KEYCHAIN_SERVICE = 'oneconscious-data-key';

/**
 * The one production backend every install talks to. A customer never sees or
 * chooses this — it is baked into the app, the same way any shipped client
 * just knows its own API host.
 *
 * ONECON_API_URL exists only to let a developer building from source point at
 * a local backend instead. It is never surfaced in the UI; a real user has no
 * way to set it short of editing the app's environment before launch.
 */
const PRODUCTION_API_URL = 'https://oneaimemory.com';

function defaults(): Settings {
  return {
    // Random per install. NOT a hardware identifier — those are themselves
    // sensitive and restricted on mobile platforms.
    deviceId: `mac-${randomUUID()}`,
    deviceIdsByEmail: {},
    deviceName: `${process.env.USER ?? 'user'}'s Mac`,
    apiUrl: process.env.ONECON_API_URL ?? PRODUCTION_API_URL,
    paused: false,
    syncIntervalMs: 60_000,
    collectBrowsing: true,
    collectSearches: true,
    collectYoutube: true,
    collectApps: true,
    collectCode: true,
    collectAiSessions: false,
    blockedDomains: [],
    blockedQueryTerms: [],
    extensionToken: randomUUID().replace(/-/g, ''),
    extensionEnabled: true,
    requireBiometric: true,
  };
}

export class Store {
  private dir: string;
  private settingsPath: string;
  private sessionPath: string;
  private cachedSettings: Settings | null = null;

  constructor() {
    this.dir = app.getPath('userData');
    mkdirSync(this.dir, { recursive: true });
    this.settingsPath = join(this.dir, 'settings.json');
    this.sessionPath = join(this.dir, 'session.bin');
  }

  get dataDir(): string {
    return this.dir;
  }

  // --- settings ------------------------------------------------------------

  getSettings(): Settings {
    if (this.cachedSettings) return this.cachedSettings;

    let loaded: Partial<Settings> | null = null;
    try {
      loaded = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<Settings>;
    } catch {
      /* first run */
    }

    const base = defaults();
    this.cachedSettings = { ...base, ...(loaded ?? {}) };

    // Write back on first run AND whenever an upgrade introduced new keys.
    //
    // First run: defaults() mints a random deviceId, and if it is never written
    // the device gets a new identity on every launch, orphaning its synced
    // events. Upgrades: a generated value like extensionToken would otherwise
    // live only in memory, so the file and the running app disagree.
    const missingKeys = Object.keys(base).filter((k) => !(loaded ?? {}).hasOwnProperty(k));
    if (!loaded || missingKeys.length > 0) {
      writeFileSync(this.settingsPath, JSON.stringify(this.cachedSettings, null, 2));
    }
    return this.cachedSettings;
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.getSettings(), ...patch };
    this.cachedSettings = next;
    writeFileSync(this.settingsPath, JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * Looks up (or mints) this account's deviceId on this Mac and makes it the
   * active `deviceId`. Call before register/login so every request for this
   * sign-in uses the right id.
   */
  resolveDeviceId(email: string): string {
    const settings = this.getSettings();
    const key = email.trim().toLowerCase();
    const id = settings.deviceIdsByEmail[key] ?? `mac-${randomUUID()}`;
    this.saveSettings({
      deviceId: id,
      deviceIdsByEmail: { ...settings.deviceIdsByEmail, [key]: id },
    });
    return id;
  }

  // --- session (encrypted at rest) -----------------------------------------

  /**
   * Tokens are sealed with Electron's safeStorage, which is backed by the
   * system Keychain on macOS — so a stolen copy of the app-support directory
   * is not enough to impersonate the user.
   */
  saveSession(session: Session): void {
    const json = JSON.stringify(session);
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(this.sessionPath, safeStorage.encryptString(json));
    } else {
      // Should not happen on macOS; degrade loudly rather than silently.
      console.warn('[store] safeStorage unavailable — session stored unencrypted');
      writeFileSync(this.sessionPath, json, 'utf8');
    }
    chmodSync(this.sessionPath, 0o600);
  }

  getSession(): Session | null {
    if (!existsSync(this.sessionPath)) return null;
    try {
      const buf = readFileSync(this.sessionPath);
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buf)
        : buf.toString('utf8');
      return JSON.parse(json) as Session;
    } catch (err) {
      console.error('[store] could not read session:', err);
      return null;
    }
  }

  clearSession(): void {
    try {
      writeFileSync(this.sessionPath, '');
    } catch {
      /* ignore */
    }
  }

  // --- passphrase (macOS Keychain) -----------------------------------------

  /**
   * The passphrase lives in the Keychain, not in a file. The MCP server reads
   * it from there so it can derive the same key without a UI to prompt with.
   */
  savePassphrase(email: string, passphrase: string): void {
    if (process.platform !== 'darwin') return;
    execFileSync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', email,
      '-w', passphrase,
      '-U', // update if it already exists
    ]);
  }

  getPassphrase(email: string): string | null {
    if (process.platform !== 'darwin') return null;
    try {
      return execFileSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', email, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch {
      return null;
    }
  }

  deletePassphrase(email: string): void {
    if (process.platform !== 'darwin') return;
    try {
      execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', email], {
        stdio: 'ignore',
      });
    } catch {
      /* not present */
    }
  }
}
