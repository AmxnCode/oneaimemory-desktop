import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { app } from 'electron';

const KEYCHAIN_SERVICE = 'oneconscious-data-key';
const MCP_CONFIG_DIR = join(homedir(), '.oneconscious');
const MCP_CONFIG_PATH = join(MCP_CONFIG_DIR, 'mcp.json');

export interface McpServerState {
  running: boolean;
  pid: number | null;
  error: string | null;
}

/**
 * Manages the embedded MCP server process.
 *
 * The MCP server runs as a child process within the Electron app, providing
 * context to AI tools via the Model Context Protocol. It reads the encryption
 * passphrase from the macOS Keychain and connects to the backend to serve
 * decrypted activity data.
 */
export class McpServerManager {
  private process: ChildProcess | null = null;
  private state: McpServerState = { running: false, pid: null, error: null };
  private onStateChange: ((state: McpServerState) => void) | null = null;

  constructor() {}

  setStateChangeHandler(handler: (state: McpServerState) => void): void {
    this.onStateChange = handler;
  }

  getState(): McpServerState {
    return { ...this.state };
  }

  /**
   * Write the MCP config file that the server reads on startup.
   */
  writeConfig(apiUrl: string, token: string, dataKeySalt: string, email: string): void {
    mkdirSync(MCP_CONFIG_DIR, { recursive: true });
    writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ apiUrl, token, dataKeySalt, email }, null, 2));
    chmodSync(MCP_CONFIG_PATH, 0o600);
  }

  /**
   * Start the MCP server. Requires:
   * - A valid config at ~/.oneconscious/mcp.json
   * - The passphrase stored in macOS Keychain
   */
  start(apiUrl: string, token: string, dataKeySalt: string, email: string): void {
    if (this.process) {
      console.log('[mcp] already running');
      return;
    }

    // Write config
    this.writeConfig(apiUrl, token, dataKeySalt, email);

    // Get passphrase from Keychain
    const passphrase = this.getPassphrase(email);
    if (!passphrase) {
      this.state = { running: false, pid: null, error: 'Passphrase not found in Keychain. Unlock the app first.' };
      this.onStateChange?.(this.state);
      return;
    }

    // Find the MCP server bundle
    const mcpServerPath = this.getMcpServerPath();
    if (!mcpServerPath) {
      this.state = { running: false, pid: null, error: 'MCP server not found. Rebuild the app.' };
      this.onStateChange?.(this.state);
      return;
    }

    console.log('[mcp] starting server...');

    this.process = spawn(process.execPath, [mcpServerPath], {
      env: {
        ...process.env,
        ONECON_PASSPHRASE: passphrase,
        ONECON_API_URL: apiUrl,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.state = { running: true, pid: this.process.pid ?? null, error: null };
    this.onStateChange?.(this.state);

    this.process.stdout?.on('data', (data) => {
      console.log('[mcp]', data.toString().trim());
    });

    this.process.stderr?.on('data', (data) => {
      console.error('[mcp]', data.toString().trim());
    });

    this.process.on('error', (err) => {
      console.error('[mcp] process error:', err);
      this.state = { running: false, pid: null, error: err.message };
      this.onStateChange?.(this.state);
      this.process = null;
    });

    this.process.on('exit', (code) => {
      console.log(`[mcp] exited with code ${code}`);
      this.state = { running: false, pid: null, error: code !== 0 ? `Exit code ${code}` : null };
      this.onStateChange?.(this.state);
      this.process = null;
    });

    console.log(`[mcp] started (pid=${this.process.pid})`);
  }

  /**
   * Stop the MCP server.
   */
  stop(): void {
    if (!this.process) return;

    console.log('[mcp] stopping...');
    this.process.kill('SIGTERM');

    // Force kill after 5 seconds if it doesn't stop gracefully
    setTimeout(() => {
      if (this.process) {
        this.process.kill('SIGKILL');
      }
    }, 5000);
  }

  /**
   * Restart the MCP server.
   */
  restart(apiUrl: string, token: string, dataKeySalt: string, email: string): void {
    this.stop();
    // Wait a bit for the process to exit before restarting
    setTimeout(() => {
      this.start(apiUrl, token, dataKeySalt, email);
    }, 1000);
  }

  private getMcpServerPath(): string | null {
    // In development, look in the desktop dist directory
    const devPath = join(__dirname, 'mcp-server.cjs');
    if (existsSync(devPath)) return devPath;

    // In production (packaged app), look in resources
    const prodPath = join(process.resourcesPath, 'mcp-server', 'mcp-server.cjs');
    if (existsSync(prodPath)) return prodPath;

    // Fallback: look relative to app
    const altPath = join(app.getAppPath(), 'dist', 'mcp-server.cjs');
    if (existsSync(altPath)) return altPath;

    return null;
  }

  private getPassphrase(email: string): string | null {
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
}
