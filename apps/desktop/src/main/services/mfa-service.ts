import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

export type MfaResult = 'ok' | 'failed' | 'unavailable' | 'cancelled';

export interface MfaProvider {
  available(): Promise<boolean>;
  verify(reason: string): Promise<MfaResult>;
  label: string; // "Touch ID" | "Windows Hello" | "system password"
}

/** macOS: Touch ID via Electron's systemPreferences (LocalAuthentication); the OS handles the password fallback. */
export class TouchIdProvider implements MfaProvider {
  label = 'Touch ID';
  constructor(
    private readonly sp: { canPromptTouchID(): boolean; promptTouchID(reason: string): Promise<void> },
  ) {}
  async available(): Promise<boolean> {
    return this.sp.canPromptTouchID();
  }
  async verify(reason: string): Promise<MfaResult> {
    if (!this.sp.canPromptTouchID()) return 'unavailable';
    try {
      await this.sp.promptTouchID(reason);
      return 'ok';
    } catch (e) {
      return /cancel/i.test(String((e as Error).message)) ? 'cancelled' : 'failed';
    }
  }
}

/**
 * The consent prompt script. `-Reason` arrives as a bound parameter of a `-File` invocation, so its value is never
 * parsed as PowerShell (M4: the old `-Command <script> <reason>` form spliced the reason into a command line).
 */
const HELLO_PS = `param([string]$Reason = '')
[Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ($avail -ne 'Available') { Write-Output "UNAVAILABLE:$avail"; exit 0 }
$r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($Reason)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output "RESULT:$r"
`;

export type PsRunner = (file: string, args: string[]) => Promise<string>;

const defaultPsRunner: PsRunner = async (file, args) => {
  const r = await execa(file, args, { reject: false, timeout: 120_000 });
  return String(r.stdout ?? '');
};

/** Windows Hello via WinRT UserConsentVerifier. Prefers the native addon when present, else a PowerShell 5.1 shim. */
export class WindowsHelloProvider implements MfaProvider {
  label = 'Windows Hello';
  private native: {
    checkAvailability(): Promise<string>;
    requestVerification(reason: string): Promise<string>;
  } | null = null;

  constructor(private readonly opts: { run?: PsRunner; tmpDir?: string; loadNative?: boolean } = {}) {}

  private async loadNative(): Promise<typeof this.native> {
    if (this.native) return this.native;
    if (this.opts.loadNative === false) return null;
    try {
      const mod = '@styx/native-winhello'; // optional napi addon; resolved at runtime only, hidden from the bundler
      this.native = (await import(/* @vite-ignore */ mod)) as typeof this.native;
    } catch {
      this.native = null;
    }
    return this.native;
  }

  async available(): Promise<boolean> {
    const n = await this.loadNative();
    if (n) return (await n.checkAvailability()) === 'Available';
    const r = await this.runPs('__check__');
    return !r.startsWith('UNAVAILABLE');
  }

  async verify(reason: string): Promise<MfaResult> {
    const n = await this.loadNative();
    if (n) return mapHello(await n.requestVerification(reason));
    const out = await this.runPs(reason);
    if (out.startsWith('UNAVAILABLE')) return 'unavailable';
    const m = /RESULT:(\w+)/.exec(out);
    return m?.[1] ? mapHello(m[1]) : 'failed';
  }

  /**
   * Writes the script to a private temp file (0600 dir + file) and runs it with `-File … -Reason <value>`: the reason
   * is an argv element bound to the script's `param` block, never text PowerShell parses. Removed afterwards.
   */
  private async runPs(reason: string): Promise<string> {
    const dir = mkdtempSync(join(this.opts.tmpDir ?? tmpdir(), 'styx-hello-'));
    const file = join(dir, 'hello.ps1');
    try {
      writeFileSync(file, HELLO_PS, { mode: 0o600 });
      const run = this.opts.run ?? defaultPsRunner;
      return await run('powershell.exe', helloArgs(file, reason));
    } catch {
      return 'UNAVAILABLE:error';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** argv for the consent script; control characters are stripped so the prompt shows one line of plain text. */
export function helloArgs(file: string, reason: string): string[] {
  const clean = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Styx';
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Reason', clean];
}

function mapHello(r: string): MfaResult {
  switch (r) {
    case 'Verified':
      return 'ok';
    case 'Canceled':
      return 'cancelled';
    case 'DeviceNotPresent':
    case 'NotConfiguredForUser':
    case 'DisabledByPolicy':
      return 'unavailable';
    default:
      return 'failed';
  }
}

/** The polkit action the .deb installs (build/linux/polkit/com.heystyx.styx.policy): "auth_self", your own password. */
export const POLKIT_ACTION = 'com.heystyx.styx.approve-grant';

export type PolkitRunner = (bin: string, args: string[]) => Promise<{ exitCode: number; stderr: string }>;

const defaultPolkitRunner: PolkitRunner = async (bin, args) => {
  const r = await execa(bin, args, { reject: false, timeout: 120_000 });
  return { exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1, stderr: String(r.stderr ?? '') };
};

/**
 * Linux: the desktop's polkit authentication dialog (your password, or a fingerprint where PAM has one set up).
 * With the .deb's action installed, `pkcheck` asks for *your own* password under a Styx-named prompt; without it
 * (AppImage), `pkexec /bin/true` falls back to the standard admin prompt. No graphical session or no polkit at all
 * is `unavailable`, which refuses the prod grant (as a Mac without Touch ID would).
 */
export class PolkitProvider implements MfaProvider {
  label = 'system password';
  constructor(
    private readonly opts: {
      run?: PolkitRunner;
      which?: (bin: string) => Promise<string | null>;
      env?: NodeJS.ProcessEnv;
      pid?: number;
    } = {},
  ) {}

  private async has(bin: string): Promise<string | null> {
    if (this.opts.which) return this.opts.which(bin);
    const r = await execa('which', [bin], { reject: false });
    return r.exitCode === 0 ? String(r.stdout).trim() || null : null;
  }

  private graphical(): boolean {
    const env = this.opts.env ?? process.env;
    return Boolean(env['DISPLAY'] || env['WAYLAND_DISPLAY']);
  }

  async available(): Promise<boolean> {
    if (!this.graphical()) return false;
    return (await this.has('pkcheck')) !== null || (await this.has('pkexec')) !== null;
  }

  async verify(): Promise<MfaResult> {
    if (!this.graphical()) return 'unavailable';
    const run = this.opts.run ?? defaultPolkitRunner;
    const pkcheck = await this.has('pkcheck');
    if (pkcheck) {
      const pid = String(this.opts.pid ?? process.pid);
      const r = await run(pkcheck, [
        '--action-id',
        POLKIT_ACTION,
        '--process',
        pid,
        '--allow-user-interaction',
      ]);
      // 0 authorized · 1 not authorized · 2 challenge without interaction · 3 dismissed · 4 error
      if (r.exitCode === 0) return 'ok';
      if (r.exitCode === 3) return 'cancelled';
      if (r.exitCode === 1 || r.exitCode === 2) return 'failed';
      // 4: most often the action isn't installed (not the .deb); fall through to pkexec.
    }
    const pkexec = await this.has('pkexec');
    if (!pkexec) return 'unavailable';
    const r = await run(pkexec, ['--disable-internal-agent', '/bin/true']);
    if (r.exitCode === 0) return 'ok';
    if (/no authentication agent/i.test(r.stderr)) return 'unavailable';
    // 126: the dialog was dismissed; 127: authentication failed or not authorized.
    return r.exitCode === 126 ? 'cancelled' : 'failed';
  }
}

/** Test/dev provider (`STYX_MFA=auto|deny`). */
export class FakeMfaProvider implements MfaProvider {
  label = 'Touch ID';
  constructor(private readonly outcome: MfaResult = 'ok') {}
  async available(): Promise<boolean> {
    return this.outcome !== 'unavailable';
  }
  async verify(): Promise<MfaResult> {
    return this.outcome;
  }
}

/** The MFA gate. `requireMfa` is decided by GrantService from DB rows; this only performs the OS prompt. Results are never cached. */
export class MfaService {
  constructor(private readonly provider: MfaProvider) {}
  get label(): string {
    return this.provider.label;
  }
  available(): Promise<boolean> {
    return this.provider.available();
  }
  verify(reason: string): Promise<MfaResult> {
    return this.provider.verify(reason);
  }
}
