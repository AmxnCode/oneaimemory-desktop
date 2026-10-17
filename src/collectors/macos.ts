import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * macOS collection via AppleScript.
 *
 * Deliberately NOT reading Chrome's History SQLite file. That approach needs
 * Full Disk Access — a permission the user must grant by hand in System
 * Settings, which cannot be requested programmatically and which measurably
 * costs installs (docs/PRD-REVIEW.md #8). AppleScript needs only Automation
 * permission, which macOS prompts for inline on first use.
 *
 * The tradeoff: we see the ACTIVE tab while the browser is running, not full
 * history. For "what is the user doing right now" — the actual product question
 * — the active tab is the better signal anyway.
 */

const OSA_TIMEOUT_MS = 3000;

async function osascript(script: string): Promise<string | null> {
  try {
    const { stdout } = await exec('osascript', ['-e', script], { timeout: OSA_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    // Browser not running, no window open, or permission not yet granted.
    // All are normal and must not be treated as errors.
    return null;
  }
}

export interface FrontmostApp {
  name: string;
  bundleId?: string;
}

export async function getFrontmostApp(): Promise<FrontmostApp | null> {
  const out = await osascript(
    `tell application "System Events"
       set frontApp to first application process whose frontmost is true
       return (name of frontApp) & "\\n" & (bundle identifier of frontApp)
     end tell`,
  );
  if (!out) return null;
  const [name, bundleId] = out.split('\n');
  if (!name) return null;
  return { name, bundleId: bundleId || undefined };
}

export interface BrowserTab {
  url: string;
  title: string;
  browser: string;
}

const BROWSERS: Array<{ app: string; label: string; script: (app: string) => string }> = [
  {
    app: 'Google Chrome',
    label: 'Chrome',
    script: (app) =>
      `tell application "${app}"
         if (count of windows) is 0 then return ""
         set t to active tab of front window
         return (URL of t) & "\\n" & (title of t)
       end tell`,
  },
  {
    app: 'Brave Browser',
    label: 'Brave',
    script: (app) =>
      `tell application "${app}"
         if (count of windows) is 0 then return ""
         set t to active tab of front window
         return (URL of t) & "\\n" & (title of t)
       end tell`,
  },
  {
    app: 'Microsoft Edge',
    label: 'Edge',
    script: (app) =>
      `tell application "${app}"
         if (count of windows) is 0 then return ""
         set t to active tab of front window
         return (URL of t) & "\\n" & (title of t)
       end tell`,
  },
  {
    // Safari's dictionary differs: current tab, and `name` rather than `title`.
    app: 'Safari',
    label: 'Safari',
    script: (app) =>
      `tell application "${app}"
         if (count of windows) is 0 then return ""
         set t to current tab of front window
         return (URL of t) & "\\n" & (name of t)
       end tell`,
  },
];

/** Is this app running? Checked first so we never launch a browser by asking. */
async function isRunning(appName: string): Promise<boolean> {
  const out = await osascript(
    `tell application "System Events" to return (exists (processes where name is "${appName}"))`,
  );
  return out === 'true';
}

/**
 * Read the active tab of whichever supported browser is frontmost. Returns null
 * when the frontmost app is not a browser we can read.
 */
export async function getActiveTab(frontmostAppName: string): Promise<BrowserTab | null> {
  const match = BROWSERS.find((b) => b.app === frontmostAppName);
  if (!match) return null;
  if (!(await isRunning(match.app))) return null;

  const out = await osascript(match.script(match.app));
  if (!out) return null;

  const idx = out.indexOf('\n');
  const url = (idx >= 0 ? out.slice(0, idx) : out).trim();
  const title = idx >= 0 ? out.slice(idx + 1).trim() : '';

  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { url, title, browser: match.label };
}

/** Search engines whose query parameter we can recover from the URL. */
const SEARCH_ENGINES: Array<{ host: RegExp; param: string; name: string }> = [
  { host: /(^|\.)google\.[a-z.]+$/i, param: 'q', name: 'google' },
  { host: /(^|\.)bing\.com$/i, param: 'q', name: 'bing' },
  { host: /(^|\.)duckduckgo\.com$/i, param: 'q', name: 'duckduckgo' },
  { host: /(^|\.)search\.brave\.com$/i, param: 'q', name: 'brave' },
  { host: /(^|\.)ecosia\.org$/i, param: 'q', name: 'ecosia' },
  { host: /(^|\.)startpage\.com$/i, param: 'query', name: 'startpage' },
  { host: /(^|\.)search\.yahoo\.com$/i, param: 'p', name: 'yahoo' },
  { host: /(^|\.)perplexity\.ai$/i, param: 'q', name: 'perplexity' },
];

export interface ParsedUrl {
  domain: string;
  search?: { query: string; engine: string };
  youtube?: { videoId: string };
}

export function parseUrl(rawUrl: string): ParsedUrl | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }

  const domain = u.hostname;
  const result: ParsedUrl = { domain };

  for (const engine of SEARCH_ENGINES) {
    if (engine.host.test(domain)) {
      const q = u.searchParams.get(engine.param);
      if (q && q.trim()) result.search = { query: q.trim(), engine: engine.name };
      break;
    }
  }

  if (/(^|\.)youtube\.com$/i.test(domain)) {
    const v = u.searchParams.get('v');
    if (v) result.youtube = { videoId: v };
  } else if (/(^|\.)youtu\.be$/i.test(domain)) {
    const v = u.pathname.slice(1);
    if (v) result.youtube = { videoId: v };
  }

  return result;
}

/** Map an app to an editor label, for `code` events. */
const EDITORS: Record<string, string> = {
  'Visual Studio Code': 'vscode',
  'Cursor': 'cursor',
  'Xcode': 'xcode',
  'IntelliJ IDEA': 'intellij',
  'WebStorm': 'webstorm',
  'PyCharm': 'pycharm',
  'Zed': 'zed',
  'Sublime Text': 'sublime',
  'Neovim': 'neovim',
};

export function editorFor(appName: string): string | null {
  return EDITORS[appName] ?? null;
}

/**
 * Window title of the frontmost app. Editors put the file and project in the
 * title bar, which is the only way to get that detail without an IDE plugin.
 */
export async function getFrontWindowTitle(appName: string): Promise<string | null> {
  const out = await osascript(
    `tell application "System Events"
       tell process "${appName}"
         if (count of windows) is 0 then return ""
         return name of front window
       end tell
     end tell`,
  );
  return out || null;
}

/**
 * Parse a VS Code / Cursor style title: "file.ts — project" or
 * "● file.ts - project - Visual Studio Code".
 */
export function parseEditorTitle(title: string): { file?: string; project?: string } {
  const cleaned = title
    .replace(/^[●•*]\s*/, '')
    .replace(/\s*[-—]\s*(Visual Studio Code|Cursor|Zed|Sublime Text)\s*$/i, '')
    .trim();

  const parts = cleaned.split(/\s+[-—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { file: parts[0] };
  return { file: parts[0], project: parts[parts.length - 1] };
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp',
  php: 'php', sql: 'sql', sh: 'shell', zsh: 'shell', html: 'html',
  css: 'css', scss: 'scss', json: 'json', yml: 'yaml', yaml: 'yaml',
  md: 'markdown', tf: 'terraform', dart: 'dart', ex: 'elixir', exs: 'elixir',
};

export function languageFor(file: string): string | undefined {
  const ext = file.split('.').pop()?.toLowerCase();
  return ext ? EXT_LANGUAGE[ext] : undefined;
}
