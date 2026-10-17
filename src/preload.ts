import { contextBridge, ipcRenderer } from 'electron';

/**
 * IPC bridge. contextIsolation is on and nodeIntegration off, so the renderer
 * gets exactly this surface and nothing else — no fs, no child_process.
 */
contextBridge.exposeInMainWorld('onecon', {
  getState: () => ipcRenderer.invoke('get-state'),
  signIn: (args: unknown) => ipcRenderer.invoke('sign-in', args),
  signOut: () => ipcRenderer.invoke('sign-out'),
  biometricUnlock: () => ipcRenderer.invoke('biometric-unlock'),
  passphraseUnlock: (p: string) => ipcRenderer.invoke('passphrase-unlock', p),
  lock: () => ipcRenderer.invoke('lock'),
  togglePause: () => ipcRenderer.invoke('toggle-pause'),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  updateSettings: (patch: unknown) => ipcRenderer.invoke('update-settings', patch),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getActivity: (args: unknown) => ipcRenderer.invoke('get-activity', args),
  deleteEvents: (uuids: string[]) => ipcRenderer.invoke('delete-events', uuids),
  getAudit: () => ipcRenderer.invoke('get-audit'),
  listIntegrations: () => ipcRenderer.invoke('list-integrations'),
  revokeIntegration: (id: number) => ipcRenderer.invoke('revoke-integration', id),
  connectAiTool: (args: unknown) => ipcRenderer.invoke('connect-ai-tool', args),
  revealConfig: () => ipcRenderer.invoke('reveal-config'),
  regenerateExtensionToken: () => ipcRenderer.invoke('regenerate-extension-token'),
  getExtensionPath: () => ipcRenderer.invoke('get-extension-path'),
  revealExtension: () => ipcRenderer.invoke('reveal-extension'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  // MCP server controls
  getMcpState: () => ipcRenderer.invoke('get-mcp-state'),
  startMcpServer: () => ipcRenderer.invoke('start-mcp-server'),
  stopMcpServer: () => ipcRenderer.invoke('stop-mcp-server'),
  // Remote AI access (ChatGPT etc.)
  getRemoteAccessStatus: () => ipcRenderer.invoke('get-remote-access-status'),
  enableRemoteAccess: () => ipcRenderer.invoke('enable-remote-access'),
  disableRemoteAccess: () => ipcRenderer.invoke('disable-remote-access'),
  // AI session memory (search + graph view)
  searchMemory: (args: unknown) => ipcRenderer.invoke('search-memory', args),
  getMemoryGraph: (args?: unknown) => ipcRenderer.invoke('get-memory-graph', args),
  onState: (cb: (state: unknown) => void) => {
    const handler = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
});
