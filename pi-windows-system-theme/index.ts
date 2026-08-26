/**
 * pi-windows-system-theme — sync Pi's theme with Windows system app mode.
 *
 * Why: Pi's `"theme": "light/dark"` auto-detection queries the terminal via
 * DSR 996 / OSC 11. Terminal multiplexers such as herdr don't forward those
 * queries to the outer terminal, so detection times out and Pi falls back to
 * "dark" — dark tool/user-message blocks appear while the rest of the UI
 * follows the terminal's light colors.
 *
 * How: spawns a PowerShell watcher that uses the Win32
 * `RegNotifyChangeKeyValue` API to block until the Personalize registry key
 * changes — pure event-driven, no polling. Each line it prints is the new
 * mode ("light"/"dark"), the first being the initial sync. The matching side
 * of the configured light/dark theme pair is applied as a Theme instance
 * (in-memory only), so the pair setting in settings.json is preserved.
 *
 * Windows-only: on any other platform the factory returns without subscribing.
 *
 * @packageDocumentation
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Guard: the entire extension is a no-op off Windows.
const isWindows = process.platform === "win32";

/**
 * PowerShell watcher script. Uses RegNotifyChangeKeyValue (advapi32) to block
 * on the Personalize registry key — no WMI/WQL dependency (which is broken
 * on some installs, forcing herdr-theme's watcher into a 10s poll fallback).
 *
 * Emits the initial mode on stdout, then one line per change: "light" or "dark".
 * Inlined as a string so the package ships a single index.ts with no asset files.
 */
const WATCHER_PS = String.raw`
#Requires -Version 7
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;

public static class RegWatch {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint RegOpenKeyEx(IntPtr hKey, string subKey, uint options, int samDesired, out IntPtr phkResult);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint RegNotifyChangeKeyValue(IntPtr hKey, bool bWatchSubtree, int dwNotifyFilter, IntPtr hEvent, bool fAsynchronous);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern int RegCloseKey(IntPtr hKey);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateEvent(IntPtr lpEventAttributes, bool bManualReset, bool bInitialState, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ResetEvent(IntPtr hEvent);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue

$HKEY_CURRENT_USER = [IntPtr]0x80000001
$KEY_NOTIFY = 0x0010
$KEY_QUERY  = 0x0001
$SUBKEY = 'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$INFINITE = [uint32]4294967295  # 0xFFFFFFFF
# REG_NOTIFY_CHANGE_NAME(1) | REG_NOTIFY_CHANGE_ATTRIBUTES(2) | REG_NOTIFY_CHANGE_LAST_SET(4)
$FILTER = 7

function Get-Mode {
    try {
        $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).AppsUseLightTheme
        return $(if ($v -eq 0) { 'dark' } else { 'light' })
    } catch { return 'light' }
}

$hKey = [IntPtr]::Zero
$status = [RegWatch]::RegOpenKeyEx($HKEY_CURRENT_USER, $SUBKEY, 0, ($KEY_NOTIFY -bor $KEY_QUERY), [ref]$hKey)
if ($status -ne 0) {
    [Console]::Error.WriteLine("watch-appearance: RegOpenKeyEx failed ($status)")
    exit 1
}

$hEvent = [RegWatch]::CreateEvent([IntPtr]::Zero, $true, $false, $null)
if ($hEvent -eq [IntPtr]::Zero) {
    [Console]::Error.WriteLine("watch-appearance: CreateEvent failed")
    [RegWatch]::RegCloseKey($hKey) | Out-Null
    exit 1
}

$null = [RegWatch]::RegNotifyChangeKeyValue($hKey, $false, $FILTER, $hEvent, $true)
[Console]::Out.WriteLine((Get-Mode))
[Console]::Out.Flush()

try {
    while ($true) {
        $wait = [RegWatch]::WaitForSingleObject($hEvent, $INFINITE)
        if ($wait -ne 0) { break }
        $null = [RegWatch]::ResetEvent($hEvent)
        $null = [RegWatch]::RegNotifyChangeKeyValue($hKey, $false, $FILTER, $hEvent, $true)
        [Console]::Out.WriteLine((Get-Mode))
        [Console]::Out.Flush()
    }
} finally {
    [RegWatch]::RegCloseKey($hKey) | Out-Null
    [RegWatch]::CloseHandle($hEvent) | Out-Null
}
`;

/** Resolve the light/dark theme pair from Pi's settings.json. */
function themePair(): { light: string; dark: string } {
	try {
		const settings = JSON.parse(
			readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"),
		) as { theme?: unknown };
		const setting = typeof settings.theme === "string" ? settings.theme : "";
		const slash = setting.indexOf("/");
		if (slash > 0 && !setting.includes("/", slash + 1)) {
			const light = setting.slice(0, slash).trim();
			const dark = setting.slice(slash + 1).trim();
			if (light && dark) return { light, dark };
		}
	} catch {
		// fall through to built-ins
	}
	return { light: "light", dark: "dark" };
}

/** Write the embedded watcher to a temp .ps1 and return its path. */
function materializeWatcher(): string {
	const path = join(tmpdir(), `pi-windows-system-theme-${process.pid}.ps1`);
	writeFileSync(path, WATCHER_PS, "utf8");
	return path;
}

export default function (pi: ExtensionAPI) {
	// Platform guard: do nothing off Windows.
	if (!isWindows) return;

	let proc: ChildProcess | null = null;
	let scriptPath: string | null = null;
	let applied: string | null = null;
	type Ui = {
		getTheme(name: string): unknown;
		setTheme(theme: unknown): { success: boolean };
	};
	let ui: Ui | null = null;

	const apply = (mode: string) => {
		if (!ui) return;
		const pair = themePair();
		const name = mode === "light" ? pair.light : pair.dark;
		if (name === applied) return;
		const theme = ui.getTheme(name);
		if (!theme) return;
		// Apply as a Theme instance (in-memory) so the "light/dark" pair setting
		// in settings.json is preserved (a bare name would be persisted).
		const result = ui.setTheme(theme);
		if (result.success) applied = name;
	};

	const cleanup = () => {
		proc?.kill();
		proc = null;
		if (scriptPath) {
			try {
				unlinkSync(scriptPath);
			} catch {
				// already gone
			}
			scriptPath = null;
		}
		ui = null;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ui = ctx.ui as Ui;

		try {
			scriptPath = materializeWatcher();
			proc = spawn("pwsh", ["-NoProfile", "-File", scriptPath], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			cleanup();
			return;
		}

		let buf = "";
		const stdout = proc.stdout;
		if (!stdout) return;
		stdout.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
			const lines = buf.split(/\r?\n/);
			buf = lines.pop() ?? "";
			for (const line of lines) {
				const mode = line.trim();
				if (mode === "light" || mode === "dark") apply(mode);
			}
		});
		// Surface watcher startup errors (e.g. missing pwsh) to pi's own log.
		proc.on("error", () => cleanup());
		proc.on("exit", () => {
			proc = null;
		});
		// Ensure the stream above resolved against the spawn result.
		void proc;
	});

	pi.on("session_shutdown", cleanup);
}
