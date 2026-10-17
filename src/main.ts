import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog, systemPreferences } from 'electron';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { deriveKey, keyFingerprint, decryptEvent, type DataKey, type UserBlocklist } from '@oneconscious/shared';
import { Store, type Session } from './store.js';
import { ApiClient, ApiError } from './api.js';
import { EventQueue } from './queue.js';
import { SyncService } from './sync.js';
import { CollectorEngine } from './collectors/engine.js';
import { AiSessionWatcher } from './collectors/aiSessions/watcher.js';
import { MemoryIndex } from '@oneconscious/memory';
import { startLocalServer, LOCAL_PORT } from './localServer.js';
import { McpServerManager } from './mcpServer.js';
import type { Server } from 'node:http';

const store = new Store();
const api = new ApiClient(store);
const mcpServer = new McpServerManager();

/**
 * The queue file is scoped per account, not per machine: it holds captured
 * events as plaintext until synced, so leftover unsynced events from one
 * account must never be picked up and shipped under a different account's
 * session after a sign-out/sign-in on the same Mac.
 */
function queueFilename(email: string): string {
  return `queue-${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}.ndjson`;
}
function scopedQueue(email: string): EventQueue {
  return new EventQueue(store.dataDir, queueFilename(email));
}

// Placeholder until a session is resolved — safeStorage/Keychain access is
// not reliable this early (before app.whenReady()), so we cannot call
// store.getSession() here. unlockWithPassphrase() and the sign-in handler
// both rescope `queue` before anything is ever enqueued into it.
let queue = new EventQueue(store.dataDir);

let dataKey: DataKey | null = null;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let collector: CollectorEngine | null = null;
let aiSessionWatcher: AiSessionWatcher | null = null;
let sync: SyncService | null = null;
let localServer: Server | null = null;
/** Events accepted from the extension, for the status display. */
const extensionStats = { accepted: 0, lastAt: null as string | null };

// --- state broadcast -------------------------------------------------------

function currentState() {
  const settings = store.getSettings();
  const session = store.getSession();
  return {
    signedIn: Boolean(session && dataKey),
    // Signed in but the key is not loaded — the Touch ID gate is showing.
    locked: Boolean(session && !dataKey),
    biometric: {
      available: biometricAvailable(),
      required: settings.requireBiometric,
    },
    email: session?.email ?? null,
    apiUrl: settings.apiUrl,
    deviceId: settings.deviceId,
    deviceName: settings.deviceName,
    paused: settings.paused,
    collecting: collector?.isRunning ?? false,
    settings,
    collectorStats: collector?.stats ?? { emitted: 0, droppedByFilter: 0, lastEventAt: null, lastDropReason: null },
    aiSessions: {
      watching: aiSessionWatcher?.isRunning ?? false,
      stats: aiSessionWatcher?.stats ?? { emitted: 0, droppedByFilter: 0, lastEventAt: null, filesWatched: 0 },
    },
    extension: {
      enabled: settings.extensionEnabled,
      listening: Boolean(localServer),
      port: LOCAL_PORT,
      token: settings.extensionToken,
      accepted: extensionStats.accepted,
      lastAt: extensionStats.lastAt,
    },
    syncState: sync?.state ?? { lastSyncAt: null, lastError: null, pendingCount: queue.size(), syncedTotal: 0, online: true },
    mcp: mcpServer.getState(),
  };
}

function broadcast() {
  win?.webContents.send('state', currentState());
  updateTray();
}

// --- collector / sync lifecycle -------------------------------------------

function blocklist(): UserBlocklist {
  const s = store.getSettings();
  return { domains: s.blockedDomains, queryTerms: s.blockedQueryTerms };
}

/**
 * Unlike `collector` (a poller that re-reads prefs every tick), the AI
 * session watcher is event-driven — whether it's subscribed to filesystem
 * changes is decided once, not re-checked per event. So toggling
 * `collectAiSessions` needs an explicit start/stop here, called both from
 * the normal service lifecycle and directly from the settings-update
 * handler below, so the toggle takes effect live without an app restart.
 */
function syncAiSessionWatcher() {
  const settings = store.getSettings();
  if (!dataKey || settings.paused || !settings.collectAiSessions) {
    aiSessionWatcher?.stop();
    return;
  }

  if (!aiSessionWatcher) {
    // MemoryIndex loads a native module (better-sqlite3) — construction can
    // fail if the Electron ABI rebuild didn't work on this install. Degrade
    // to sync-only (no local search) rather than taking the whole app down;
    // the encrypted sync path is unaffected either way.
    let memoryIndex: MemoryIndex | undefined;
    try {
      memoryIndex = new MemoryIndex();
    } catch (err) {
      console.error('[ai-sessions] local memory index unavailable, continuing sync-only:', err);
    }

    aiSessionWatcher = new AiSessionWatcher({
      deviceId: settings.deviceId,
      emit: (event) => {
        queue.enqueue(event);
        broadcast();
      },
      getBlocklist: blocklist,
      onBlocked: (reason) => {
        // Same shared "recently blocked" feed the local extension server
        // reports into — one unified list in the UI regardless of source.
        if (collector) {
          collector.blocks.unshift({ at: new Date().toISOString(), type: 'ai_session', reason });
          collector.blocks.length = Math.min(collector.blocks.length, 100);
        }
        broadcast();
      },
      cursorPath: join(store.dataDir, 'ai-session-cursors.json'),
      memoryIndex,
    });
  }
  void aiSessionWatcher.start();
}

function startServices() {
  const settings = store.getSettings();
  const session = store.getSession();
  if (!dataKey || settings.paused) return;

  // Re-register the device with the backend whenever services come up. Device
  // records can be lost server-side (a backend/DB redeploy, or a deactivation
  // in the dashboard) — without this a resumed session would sync forever and
  // mark the app "Offline" with "device not registered". Registration is an
  // idempotent upsert, so this is safe to run on every startup, and it is
  // best-effort: a failure here must not abort the rest of startup.
  void ensureDeviceRegistered().catch((err) => {
    console.error('[devices] background registration failed:', err);
  });

  if (!collector) {
    collector = new CollectorEngine(
      settings.deviceId,
      (event) => {
        queue.enqueue(event);
        broadcast();
      },
      () => {
        const s = store.getSettings();
        return {
          collectBrowsing: s.collectBrowsing,
          collectSearches: s.collectSearches,
          collectYoutube: s.collectYoutube,
          collectApps: s.collectApps,
          collectCode: s.collectCode,
        };
      },
      blocklist,
    );
  }
  collector.start();

  if (!sync) {
    sync = new SyncService(api, queue, () => dataKey, settings.syncIntervalMs, broadcast);
  }
  sync.start();

  if (!localServer && settings.extensionEnabled) {
    try {
      localServer = startLocalServer({
        getToken: () => store.getSettings().extensionToken,
        getBlocklist: blocklist,
        isPaused: () => store.getSettings().paused,
        deviceId: () => store.getSettings().deviceId,
        isTypeEnabled: (type) => {
          const s = store.getSettings();
          if (type === 'browsing') return s.collectBrowsing;
          if (type === 'search') return s.collectSearches;
          if (type === 'youtube') return s.collectYoutube;
          return false; // the extension may only submit web-derived types
        },
        onEvent: (event) => {
          queue.enqueue(event);
          extensionStats.accepted++;
          extensionStats.lastAt = new Date().toISOString();
          if (collector) {
            collector.stats.emitted++;
            collector.stats.lastEventAt = extensionStats.lastAt;
          }
          broadcast();
        },
        onBlocked: (type, reason) => {
          if (!collector) return;
          collector.stats.droppedByFilter++;
          collector.stats.lastDropReason = reason;
          collector.blocks.unshift({ at: new Date().toISOString(), type, reason });
          collector.blocks.length = Math.min(collector.blocks.length, 100);
          broadcast();
        },
      });
      console.log(`[local] extension ingest listening on 127.0.0.1:${LOCAL_PORT}`);
    } catch (err) {
      console.error('[local] could not start ingest server:', err);
    }
  }

  // Start MCP server if we have a session and it's not already running
  if (session && !mcpServer.getState().running) {
    try {
      // Ensure we have an integration token for the MCP server
      startMcpServer(session);
    } catch (err) {
      console.error('[mcp] could not start:', err);
    }
  }

  syncAiSessionWatcher();

  broadcast();
}

function stopServices() {
  collector?.stop();
  aiSessionWatcher?.stop();
  sync?.stop();
  localServer?.close();
  localServer = null;
  mcpServer.stop();
  broadcast();
}

/**
 * Best-effort registration of the current Mac's device with the backend.
 * The backend treats device ids as globally unique and validates them on every
 * sync upload ("unknown_device" otherwise), and the record can be lost or
 * deactivated server-side. Calling this idempotent upsert whenever services
 * start (not only at a fresh sign-in) lets a resumed session keep syncing.
 */
async function ensureDeviceRegistered(): Promise<void> {
  const session = store.getSession();
  if (!session || !dataKey) return;
  const settings = store.getSettings();
  await api.registerDevice({
    deviceId: settings.deviceId,
    deviceName: settings.deviceName,
    deviceType: 'mac',
    osVersion: process.getSystemVersion(),
    appVersion: app.getVersion(),
  });
}


/**
 * Start the MCP server with the current session's credentials.
 *
 * The bearer token is returned by the server exactly once, at creation — the
 * list endpoint never echoes it back (by design: a token leak there would
 * defeat the point of scoping access to a revocable credential). So the ONLY
 * place this token can come from on a relaunch is our own encrypted session
 * store; there is no way to "look it up" from the server.
 */
async function startMcpServer(session: Session): Promise<void> {
  if (session.mcpToken) {
    mcpServer.start(session.apiUrl, session.mcpToken, session.dataKeySalt, session.email);
    return;
  }

  // No local token. If a same-labeled integration already exists server-side
  // from a previous install/session, it is permanently unusable to us now —
  // revoke it rather than leave an orphaned credential sitting around, then
  // mint a fresh one and persist it so this only happens once.
  const { integrations } = await api.listIntegrations();
  const orphaned = integrations.find((i) => i.label === 'Desktop MCP Server' && !i.revokedAt);
  if (orphaned) {
    await api.revokeIntegration(orphaned.id).catch(() => {});
  }

  const integration = await api.createIntegration('Desktop MCP Server', [
    'consciousness:summary',
    'activity:read',
    'activity:search',
    'devices:read',
  ]);

  store.saveSession({ ...session, mcpToken: integration.token });
  mcpServer.start(session.apiUrl, integration.token, session.dataKeySalt, session.email);
}

// --- biometrics ------------------------------------------------------------

function biometricAvailable(): boolean {
  return process.platform === 'darwin' && systemPreferences.canPromptTouchID();
}

function unlockWithPassphrase(passphrase: string, salt: string) {
  dataKey = deriveKey(passphrase, salt);
  const session = store.getSession();
  if (session) queue = scopedQueue(session.email);
  startServices();
  broadcast();
}

// --- tray ------------------------------------------------------------------

const TRAY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
);

function updateTray() {
  if (!tray) return;
  const s = currentState();
  const glyph = !s.signedIn ? '○' : s.paused ? '‖' : s.syncState.online ? '●' : '⚠';
  tray.setTitle(` ${glyph}`);
  tray.setToolTip(
    !s.signedIn
      ? 'OneAIMemory — signed out'
      : `OneAIMemory — ${s.paused ? 'paused' : 'collecting'}, ${s.syncState.pendingCount} pending`,
  );

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s.signedIn ? `Signed in as ${s.email}` : 'Not signed in', enabled: false },
      { type: 'separator' },
      {
        label: s.paused ? 'Resume collection' : 'Pause collection',
        enabled: s.signedIn,
        click: () => togglePause(),
      },
      { label: 'Sync now', enabled: s.signedIn, click: () => void sync?.flush() },
      { type: 'separator' },
      { label: `Pending: ${s.syncState.pendingCount}`, enabled: false },
      { label: `Collected: ${s.collectorStats.emitted}  Blocked: ${s.collectorStats.droppedByFilter}`, enabled: false },
      { type: 'separator' },
      { label: 'Open OneAIMemory', click: () => showWindow() },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function togglePause() {
  const paused = !store.getSettings().paused;
  store.saveSettings({ paused });
  if (paused) stopServices();
  else startServices();
  broadcast();
}

// --- window ----------------------------------------------------------------

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: 'OneAIMemory',
    titleBarStyle: 'hiddenInset', // sidebar reads as one surface with the chrome
    backgroundColor: '#0e0e11',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
sandbox: false,
    },
  });
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
  win.webContents.once('did-finish-load', broadcast);
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle('get-state', () => currentState());

ipcMain.handle(
  'sign-in',
  async (
    _e,
    args: { email: string; password: string; passphrase: string; mode: 'login' | 'register' },
  ) => {
    // apiUrl is never taken from the renderer — a customer does not choose or
    // see it. It comes from the app's own settings, which default to the
    // production backend (see store.ts) and can only be overridden by a
    // developer via ONECON_API_URL before launch.
    const settings = store.getSettings();
    const apiUrl = settings.apiUrl;

    if (args.passphrase === args.password) {
      // The password is sent to the server. If the passphrase matched it, the
      // server could derive the data key and the E2E guarantee would be void.
      throw new Error('Your encryption passphrase must be different from your account password.');
    }

    // Scoped to the account, not the Mac: the server treats deviceId as
    // globally unique, so a second account signing in here must get its own
    // id rather than colliding with whichever account used this Mac first.
    const deviceId = store.resolveDeviceId(args.email);

    const result =
      args.mode === 'register'
        ? await api.register(apiUrl, args.email, args.password, deviceId)
        : await api.login(apiUrl, args.email, args.password, deviceId);

    store.saveSession({
      email: result.email,
      userId: result.userId,
      apiUrl,
      dataKeySalt: result.dataKeySalt,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });

    const key = deriveKey(args.passphrase, result.dataKeySalt);
    const fingerprint = keyFingerprint(key);

    if (result.keyFingerprint && result.keyFingerprint !== fingerprint) {
      store.clearSession();
      throw new Error(
        'That passphrase does not match the one used on your other devices. ' +
          'Events synced from them would not be readable here.',
      );
    }

    dataKey = key;
    queue = scopedQueue(result.email);
    store.savePassphrase(result.email, args.passphrase);
    await api.submitKeyFingerprint(fingerprint);

    await ensureDeviceRegistered();

    store.saveSettings({ paused: false });
    startServices();
    return currentState();
  },
);

/**
 * Touch ID unlock. The prompt gates access to the stored passphrase; it does
 * not itself protect the Keychain item, which stays readable by processes
 * running as this user (the MCP server depends on that).
 */
ipcMain.handle('biometric-unlock', async () => {
  const session = store.getSession();
  if (!session) throw new Error('Not signed in.');
  if (!biometricAvailable()) throw new Error('Touch ID is not available on this Mac.');

  try {
    await systemPreferences.promptTouchID('unlock your OneAIMemory activity');
  } catch {
    // Cancelled or failed — stay locked, and say so plainly.
    throw new Error('Touch ID was not recognised.');
  }

  const passphrase = store.getPassphrase(session.email);
  if (!passphrase) throw new Error('No stored passphrase. Sign in again to re-enter it.');

  unlockWithPassphrase(passphrase, session.dataKeySalt);
  return currentState();
});

/** Fallback when Touch ID fails or is switched off. */
ipcMain.handle('passphrase-unlock', (_e, passphrase: string) => {
  const session = store.getSession();
  if (!session) throw new Error('Not signed in.');

  const key = deriveKey(passphrase, session.dataKeySalt);
  if (session && store.getSession()) {
    const stored = store.getPassphrase(session.email);
    // Compare against the stored passphrase when we have one, so a typo is
    // reported immediately rather than surfacing later as undecryptable events.
    if (stored && stored !== passphrase) throw new Error('That passphrase does not match.');
  }
  dataKey = key;
  store.savePassphrase(session.email, passphrase);
  startServices();
  broadcast();
  return currentState();
});

ipcMain.handle('lock', () => {
  dataKey = null;
  stopServices();
  broadcast();
  return currentState();
});

ipcMain.handle('sign-out', () => {
  stopServices();
  const session = store.getSession();
  if (session) store.deletePassphrase(session.email);
  store.clearSession();
  dataKey = null;
  collector = null;
  sync = null;
  broadcast();
  return currentState();
});

ipcMain.handle('toggle-pause', () => {
  togglePause();
  return currentState();
});

ipcMain.handle('sync-now', async () => {
  await sync?.flush();
  return currentState();
});

ipcMain.handle('update-settings', (_e, patch: Record<string, unknown>) => {
  store.saveSettings(patch);
  if ('collectAiSessions' in patch) syncAiSessionWatcher();
  broadcast();
  return currentState();
});

/**
 * The transparency view: exactly what has been recorded.
 *
 * Merges two sources — events already on the server (fetched as ciphertext and
 * decrypted here, since only this process holds the key) and events still
 * sitting in the local queue, which are shown as "pending" so nothing is
 * invisible just because it hasn't uploaded yet.
 */
ipcMain.handle('get-activity', async (_e, args: { types?: string[]; limit?: number } = {}) => {
  if (!dataKey) return { events: [], blocked: [], error: 'locked' };

  const pending = queue.peek(200).map((e) => ({
    eventUuid: e.eventUuid,
    type: e.type,
    timestamp: e.timestamp,
    deviceId: e.deviceId,
    payload: e.payload,
    pending: true,
  }));

  let synced: Array<Record<string, unknown>> = [];
  let error: string | null = null;
  let undecryptable = 0;

  try {
    const page = await api.getHistory({ limit: args.limit ?? 150, types: args.types });
    for (const env of page.events) {
      try {
        const ev = decryptEvent(env, dataKey);
        synced.push({ ...ev, pending: false });
      } catch {
        // Synced from a device using a different passphrase, or corrupted.
        undecryptable++;
      }
    }
  } catch (err) {
    error = err instanceof ApiError ? err.code : String(err);
  }

  // Pending events are not yet on the server, so no dedupe is needed — but
  // guard anyway in case a sync landed mid-call.
  const seen = new Set(synced.map((e) => e.eventUuid as string));
  const merged = [...pending.filter((p) => !seen.has(p.eventUuid)), ...synced].sort((a, b) =>
    String(b.timestamp).localeCompare(String(a.timestamp)),
  );

  const filtered = args.types?.length
    ? merged.filter((e) => args.types!.includes(e.type as string))
    : merged;

  return {
    events: filtered,
    blocked: collector?.blocks ?? [],
    undecryptable,
    error,
  };
});

ipcMain.handle('delete-events', async (_e, uuids: string[]) => {
  const res = await api.deleteEvents(uuids);
  return res;
});

ipcMain.handle('get-status', async () => {
  try {
    return await api.status();
  } catch (err) {
    return { error: err instanceof ApiError ? err.code : String(err) };
  }
});

ipcMain.handle('get-audit', async () => {
  try {
    return await api.getAudit(50);
  } catch (err) {
    return { entries: [], error: err instanceof ApiError ? err.code : String(err) };
  }
});

ipcMain.handle('list-integrations', async () => {
  try {
    return await api.listIntegrations();
  } catch (err) {
    return { integrations: [], error: String(err) };
  }
});

ipcMain.handle('revoke-integration', async (_e, id: number) => {
  await api.revokeIntegration(id);
  return api.listIntegrations();
});

/**
 * Issue a scoped token and write the MCP config the local MCP server reads.
 * The passphrase is NOT written to this file — the MCP server pulls it from the
 * Keychain, so a leaked config alone cannot decrypt anything.
 */
ipcMain.handle('connect-ai-tool', async (_e, args: { label: string; scopes: string[] }) => {
  const session = store.getSession();
  if (!session) throw new Error('Not signed in.');

  const integration = await api.createIntegration(args.label, args.scopes);

  const dir = join(homedir(), '.oneconscious');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'mcp.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      { apiUrl: session.apiUrl, token: integration.token, dataKeySalt: session.dataKeySalt, email: session.email },
      null,
      2,
    ),
  );
  chmodSync(configPath, 0o600);

  return { configPath, scopes: integration.scopes, label: args.label };
});

/** Rotating the token immediately locks out the currently paired extension. */
ipcMain.handle('regenerate-extension-token', () => {
  store.saveSettings({ extensionToken: randomUUID().replace(/-/g, '') });
  broadcast();
  return currentState();
});

function extensionDir(): string {
  // Packaged builds ship the folder in resources; in dev it sits in the repo.
  return app.isPackaged
    ? join(process.resourcesPath, 'extension')
    : join(__dirname, '..', '..', 'extension');
}

ipcMain.handle('get-extension-path', () => extensionDir());
ipcMain.handle('reveal-extension', () => shell.openPath(extensionDir()));

ipcMain.handle('reveal-config', () => {
  shell.showItemInFolder(join(homedir(), '.oneconscious', 'mcp.json'));
});

ipcMain.handle('open-data-dir', () => {
  shell.openPath(store.dataDir);
});

// --- MCP server controls ---------------------------------------------------

ipcMain.handle('get-mcp-state', () => {
  return mcpServer.getState();
});

ipcMain.handle('start-mcp-server', async () => {
  const session = store.getSession();
  if (!session) throw new Error('Not signed in.');
  if (!dataKey) throw new Error('App is locked. Unlock first.');

  try {
    await startMcpServer(session);
    return mcpServer.getState();
  } catch (err) {
    throw new Error(`Failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`);
  }
});

ipcMain.handle('stop-mcp-server', () => {
  mcpServer.stop();
  return mcpServer.getState();
});

// --- remote AI access (ChatGPT etc.) ----------------------------------------
//
// Off by default. Turning this on sends a copy of the already-derived data
// key to the server ONCE, over TLS, so remote/unattended AI clients can be
// answered with real (server-decrypted) data — a deliberate, disclosed
// weakening of E2E for this account only. Local MCP tools (this app's own
// embedded server, Claude Desktop, Cursor, Kiro) never touch this and stay
// fully encrypted regardless. The confirmation dialog making this tradeoff
// explicit lives in the renderer, right before this handler is invoked.

ipcMain.handle('get-remote-access-status', async () => {
  try {
    return await api.getRemoteAccessStatus();
  } catch (err) {
    return { enabled: false, enabledAt: null, error: String(err) };
  }
});

ipcMain.handle('enable-remote-access', async () => {
  if (!dataKey) throw new Error('App is locked. Unlock first.');
  return api.enableRemoteAccess(dataKey.toString('base64'));
});

ipcMain.handle('disable-remote-access', async () => {
  await api.disableRemoteAccess();
  return { enabled: false };
});

// --- memory graph (AI session search/visualization) -------------------------
//
// Separate lazy singleton from syncAiSessionWatcher's own MemoryIndex: that
// one lives inside the watcher's closure and only gets constructed once
// collection is toggled on. The UI needs to read the index (search, list for
// the graph) independent of whether the watcher itself is currently running
// — e.g. viewing previously-ingested chunks after turning collection back
// off. Same degrade-gracefully-if-unavailable handling as the watcher's copy.

let uiMemoryIndex: MemoryIndex | null | undefined;
function getUiMemoryIndex(): MemoryIndex | null {
  if (uiMemoryIndex !== undefined) return uiMemoryIndex;
  try {
    uiMemoryIndex = new MemoryIndex();
  } catch (err) {
    console.error('[memory] local index unavailable:', err);
    uiMemoryIndex = null;
  }
  return uiMemoryIndex;
}

ipcMain.handle('search-memory', async (_e, args: { query: string; limit?: number; project?: string }) => {
  const index = getUiMemoryIndex();
  if (!index) return { results: [], error: 'unavailable' };
  if (!args.query?.trim()) return { results: [] };
  try {
    const results = await index.search(args.query, { limit: args.limit ?? 20, project: args.project });
    return { results };
  } catch (err) {
    return { results: [], error: String(err) };
  }
});

/**
 * Nodes = recent chunks (capped, see MemoryIndex.listChunks default), edges =
 * each node's nearest neighbors above a similarity floor. Computing edges is
 * O(n^2) brute-force cosine (same approach MemoryIndex.search already uses
 * internally) — fine at the ~300-node cap, not something to scale past that
 * without a real index.
 */
ipcMain.handle('get-memory-graph', async (_e, args: { project?: string } = {}) => {
  const index = getUiMemoryIndex();
  if (!index) return { nodes: [], edges: [], error: 'unavailable' };
  try {
    const chunks = index.listChunks({ limit: 300, project: args.project });
    const nodes = chunks.map((c) => ({
      id: c.id,
      tool: c.tool,
      role: c.role,
      content: c.content,
      project: c.project,
      createdAt: c.createdAt,
    }));

    const edges: Array<{ source: number; target: number; score: number }> = [];
    const seen = new Set<string>();
    for (const c of chunks) {
      // 0.25, not search()'s 0.15 default — edges should read as "genuinely
      // related", and a graph wants to stay sparser than a search result
      // list. Checked against real embeddings of related-but-differently-
      // worded same-topic turns (~0.29-0.46) vs unrelated ones (~0.03-0.17)
      // during manual verification; 0.35 turned out to cut off real
      // same-topic pairs, 0.25 does not.
      const neighbors = await index.neighbors(c.id, 5, 0.25);
      for (const n of neighbors) {
        const key = c.id < n.id ? `${c.id}-${n.id}` : `${n.id}-${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: c.id, target: n.id, score: n.score });
      }
    }

    return { nodes, edges };
  } catch (err) {
    return { nodes: [], edges: [], error: String(err) };
  }
});

// --- app lifecycle ---------------------------------------------------------

// Background collector: a second instance would double-collect.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    tray = new Tray(TRAY_ICON);
    updateTray();
    tray.on('click', () => showWindow());

    const session = store.getSession();
    if (session) {
      const settings = store.getSettings();
      const hasPassphrase = Boolean(store.getPassphrase(session.email));

      // Deliberately does NOT consult canPromptTouchID() here: that probe is
      // unreliable this early in startup (it reported false at whenReady while
      // returning true moments later), and a security gate must not depend on
      // a capability check that may not be ready. If the user asked to be
      // locked, stay locked; the locked screen offers Touch ID when available
      // and falls back to the passphrase when not.
      if (hasPassphrase && settings.requireBiometric) {
        // Collection does not start until unlock — an unattended Mac should not
        // keep recording into an account nobody has authenticated to.
        showWindow();
      } else if (hasPassphrase) {
        unlockWithPassphrase(store.getPassphrase(session.email)!, session.dataKeySalt);
      }
    }

    if (!session || !dataKey) showWindow();
  });

  // Subscribing at all overrides Electron's default quit-on-last-window-closed,
  // which is what keeps the collector alive in the tray.
  app.on('window-all-closed', () => {
    /* stay resident */
  });

  app.on('before-quit', () => {
    mcpServer.stop();
    stopServices();
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
  if (win) dialog.showErrorBox('OneAIMemory error', String(reason));
});
