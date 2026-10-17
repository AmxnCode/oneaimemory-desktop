import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FrontmostApp, BrowserTab } from './macos.js';

const exec = promisify(execFile);

/**
 * Windows collection via PowerShell.
 *
 * Mirrors the macOS collector's capabilities using the Win32 API through
 * Add-Type: GetForegroundWindow for the active process, and UI Automation for
 * the active browser tab's URL.
 *
 * NOT IMPLEMENTED HERE: reading Chrome's History SQLite file. On Windows it is
 * not TCC-protected the way it is on macOS, so it is technically easier — but
 * it is still locked while Chrome runs and only yields committed history, not
 * what the user is looking at now. The browser extension is the better answer
 * on both platforms.
 *
 * UNVERIFIED: this code has not been executed on Windows. It is written against
 * the documented APIs and mirrors the macOS collector's contract, but it needs
 * testing on a real Windows machine before being trusted.
 */

const PS_TIMEOUT_MS = 5000;

async function powershell(script: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Foreground window's process name and main window title, in one call —
 * spawning PowerShell twice per poll is too expensive.
 */
const FOREGROUND_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class OCWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$h = [OCWin]::GetForegroundWindow()
$pid_ = 0
[void][OCWin]::GetWindowThreadProcessId($h, [ref]$pid_)
$sb = New-Object System.Text.StringBuilder 512
[void][OCWin]::GetWindowText($h, $sb, 512)
$proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
if ($proc) {
  $name = $proc.ProcessName
  try { $desc = $proc.MainModule.FileVersionInfo.FileDescription } catch { $desc = $null }
  Write-Output ($(if ($desc) { $desc } else { $name }))
  Write-Output $name
  Write-Output $sb.ToString()
}
`.trim();

export interface WindowsForeground extends FrontmostApp {
  windowTitle: string;
  processName: string;
}

export async function getForegroundWindow(): Promise<WindowsForeground | null> {
  const out = await powershell(FOREGROUND_SCRIPT);
  if (!out) return null;
  const [display, processName, ...titleParts] = out.split(/\r?\n/);
  if (!display || !processName) return null;
  return {
    name: display,
    bundleId: processName,
    processName,
    windowTitle: titleParts.join(' ').trim(),
  };
}

/** Chromium and Firefox process names we can read a URL from. */
const BROWSER_PROCESSES: Record<string, string> = {
  chrome: 'Chrome',
  msedge: 'Edge',
  brave: 'Brave',
  firefox: 'Firefox',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
};

export function browserLabel(processName: string): string | null {
  return BROWSER_PROCESSES[processName.toLowerCase()] ?? null;
}

/**
 * Read the address bar via UI Automation.
 *
 * This is genuinely fragile: it depends on the browser exposing an edit control
 * named "Address and search bar", which varies by browser and locale, and the
 * value is what the user sees (often without the scheme). The extension is the
 * reliable path — this exists so a Windows user gets *something* before
 * installing it.
 */
const URL_SCRIPT = (processName: string) => `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { exit }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $root) { exit }
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit)
$edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if ($edit) {
  $pattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  Write-Output $pattern.Current.Value
}
`.trim();

export async function getActiveTabWindows(processName: string): Promise<BrowserTab | null> {
  const label = browserLabel(processName);
  if (!label) return null;

  const raw = await powershell(URL_SCRIPT(processName));
  if (!raw) return null;

  // The address bar usually omits the scheme.
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    if (!u.hostname.includes('.')) return null; // a search term, not a URL
    return { url: u.toString(), title: '', browser: label };
  } catch {
    return null;
  }
}

/**
 * Strip the trailing app name Windows browsers and editors append to their
 * window titles, e.g. "Docs - Google Chrome" or "main.ts - proj - VS Code".
 */
export function cleanWindowTitle(title: string, processName: string): string {
  const label = BROWSER_PROCESSES[processName.toLowerCase()];
  let out = title;
  if (label) out = out.replace(new RegExp(`\\s+[-–—]\\s*${label}.*$`, 'i'), '');
  return out.replace(/\s+[-–—]\s*(Visual Studio Code|Visual Studio|Notepad\+\+)\s*$/i, '').trim();
}

const EDITOR_PROCESSES: Record<string, string> = {
  code: 'vscode',
  'code - insiders': 'vscode',
  cursor: 'cursor',
  devenv: 'visualstudio',
  idea64: 'intellij',
  webstorm64: 'webstorm',
  pycharm64: 'pycharm',
  rider64: 'rider',
  sublime_text: 'sublime',
  notepad__: 'notepad++',
};

export function editorForWindows(processName: string): string | null {
  return EDITOR_PROCESSES[processName.toLowerCase()] ?? null;
}
